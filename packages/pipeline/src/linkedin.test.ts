/**
 * LinkedIn client against stubbed HTTP (no database).
 */
import { createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { linkedinWebhookSchema } from "@inbox/core"
import {
  createLinkedinReply,
  fetchNewLinkedinComments,
  LinkedinApiError,
  linkedinChallengeResponse,
  linkedinItemsFromNotifications,
  listAdministeredOrgs,
  restliEncode,
  signLinkedinBody,
  verifyLinkedinSignature,
} from "./linkedin"

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, `../../core/fixtures/linkedin/${name}`), "utf8"),
  )
const comments = fixture("comments.json") as Record<string, Record<string, unknown>>
const ORG = "urn:li:organization:2414183"
const ctx = { token: "tok", version: "202610" }

afterEach(() => vi.unstubAllGlobals())

/** Serves comments by id from the fixture; records every request. */
function stubApi(extra: (url: URL, init: RequestInit) => Response | null = () => null) {
  const calls: { url: URL; init: RequestInit }[] = []
  const byId = new Map(Object.values(comments).map((c) => [String(c.id), c]))
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input)
      calls.push({ url, init })
      const custom = extra(url, init)
      if (custom) return custom
      const m = /\/comments\/(\d+)$/.exec(url.pathname)
      if (m) {
        const c = byId.get(m[1]!)
        return c ? json(c) : json({ message: "Not found", status: 404 }, 404)
      }
      if (url.pathname.includes("/people/")) return json({ message: "Denied" }, 403)
      return json({ message: `unexpected ${url}` }, 500)
    }),
  )
  return calls
}

describe("LinkedIn webhook signatures", () => {
  it("answers the validation challenge with hex HMAC(challengeCode, secret)", () => {
    const code = "890e4665-4dfe-4ab1-b689-ed553bceeed0"
    expect(linkedinChallengeResponse(code, "secret")).toBe(
      createHmac("sha256", "secret").update(code).digest("hex"),
    )
  })

  it("X-LI-Signature is HMAC of 'hmacsha256=' + raw body", () => {
    const body = '{"type":"ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS","notifications":[]}'
    const sig = signLinkedinBody(body, "secret")
    expect(sig).toBe(createHmac("sha256", "secret").update(`hmacsha256=${body}`).digest("hex"))
    expect(verifyLinkedinSignature(Buffer.from(body), sig, "secret")).toBe(true)
    expect(verifyLinkedinSignature(body + " ", sig, "secret")).toBe(false)
    expect(verifyLinkedinSignature(body, sig, "other")).toBe(false)
    expect(verifyLinkedinSignature(body, `hmacsha256=${sig}`, "secret")).toBe(false)
  })

  it("Rest.li encoding escapes parentheses", () => {
    expect(restliEncode("urn:li:comment:(urn:li:activity:1,2)")).toBe(
      "urn%3Ali%3Acomment%3A%28urn%3Ali%3Aactivity%3A1%2C2%29",
    )
  })
})

describe("LinkedIn comments", () => {
  it("webhook notifications → comments (skips non-comment actions)", async () => {
    const calls = stubApi()
    const body = linkedinWebhookSchema.parse(fixture("notifications.json"))
    const items = await linkedinItemsFromNotifications(ctx, {
      orgUrn: ORG,
      notifications: body.notifications,
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      platform: "linkedin",
      text: "Are you hiring interns this summer?",
      authorName: null, // the profile lookup was refused
      isOwnAccount: false,
    })
    const get = calls.find((c) => c.url.pathname.includes("/socialActions/"))!
    expect(get.url.href).toContain(
      "/rest/socialActions/urn%3Ali%3Aactivity%3A7100000000000000001/comments/7100000000000000101",
    )
    expect(get.init.headers).toMatchObject({
      "linkedin-version": "202610",
      "x-restli-protocol-version": "2.0.0",
    })
  })

  it("reconcile pulls notifications since the cursor and marks follow-ups", async () => {
    const at = (id: string) => `urn:li:comment:(urn:li:activity:7100000000000000001,${id})`
    const calls = stubApi((url) =>
      url.pathname.endsWith("/organizationalEntityNotifications")
        ? json({
            elements: [
              {
                notificationId: 2,
                organizationalEntity: ORG,
                action: "COMMENT",
                generatedActivity: at("7100000000000000103"),
                lastModifiedAt: 1763208000000,
              },
              {
                notificationId: 1,
                organizationalEntity: ORG,
                action: "ADMIN_COMMENT",
                generatedActivity: at("7100000000000000102"),
                lastModifiedAt: 1763200800000,
              },
              {
                notificationId: 3,
                organizationalEntity: ORG,
                action: "COMMENT",
                generatedActivity: at("999"), // deleted since
                lastModifiedAt: 1763208001000,
              },
            ],
          })
        : null,
    )
    const res = await fetchNewLinkedinComments(ctx, {
      orgUrn: ORG,
      cursor: "2025-11-15T09:00:00.000Z",
      backfillDays: 30,
      now: new Date("2025-11-15T12:00:00Z"),
    })
    const list = calls.find((c) => c.url.pathname.endsWith("/organizationalEntityNotifications"))!
    expect(list.url.search).toContain("actions=List(COMMENT,ADMIN_COMMENT,COMMENT_EDIT)")
    expect(list.url.search).toContain("organizationalEntity=urn%3Ali%3Aorganization%3A2414183")
    expect(list.url.search).toContain(
      `timeRange=(start:${new Date("2025-11-15T09:00:00.000Z").getTime() + 1})`,
    )
    expect(res.items.map((i) => [i.isOwnAccount, i.isReplyToOurReply])).toEqual([
      [true, false], // our reply (oldest first)
      [false, true], // the member answering it
    ])
    expect(res.cursor).toBe(new Date(1763208001000).toISOString())
  })

  it("replies as the Page under the top-level comment", async () => {
    const parent = "urn:li:comment:(urn:li:activity:7100000000000000001,7100000000000000101)"
    const calls = stubApi((url, init) =>
      init.method === "POST" ? json({ ...comments.ours, id: "555", commentUrn: undefined }) : null,
    )
    const res = await createLinkedinReply(ctx, {
      orgUrn: ORG,
      postUrn: "urn:li:activity:7100000000000000001",
      parentCommentUrn: parent,
      text: "Thanks!",
    })
    expect(res.commentUrn).toBe("urn:li:comment:(urn:li:activity:7100000000000000001,555)")
    expect(calls[0]!.url.pathname).toBe(`/rest/socialActions/${restliEncode(parent)}/comments`)
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      actor: ORG,
      object: "urn:li:activity:7100000000000000001",
      parentComment: parent,
      message: { text: "Thanks!" },
    })
  })

  it("lists administered Pages; 401 means reconnect, 429 is retryable", async () => {
    stubApi((url) =>
      url.pathname.endsWith("/organizationAcls")
        ? json({
            elements: [
              {
                role: "ADMINISTRATOR",
                state: "APPROVED",
                roleAssignee: "urn:li:person:me",
                organization: ORG,
              },
              {
                role: "ADMINISTRATOR",
                state: "APPROVED",
                roleAssignee: "urn:li:person:me",
                organizationTarget: "urn:li:organization:9",
              },
            ],
          })
        : null,
    )
    await expect(listAdministeredOrgs(ctx)).resolves.toEqual({
      orgIds: ["2414183", "9"],
      personUrn: "urn:li:person:me",
    })

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ message: "Expired", status: 401 }, 401)),
    )
    const e401 = await listAdministeredOrgs(ctx).catch((e: unknown) => e)
    expect(e401).toBeInstanceOf(LinkedinApiError)
    expect(e401).toMatchObject({ reauth: true, retryable: false })

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ message: "Slow down", status: 429 }, 429)),
    )
    await expect(listAdministeredOrgs(ctx)).rejects.toMatchObject({ retryable: true })
  })
})
