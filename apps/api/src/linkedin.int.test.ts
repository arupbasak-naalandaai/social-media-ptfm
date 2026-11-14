/**
 * LinkedIn webhooks and the connect flow against a real database (TEST_DATABASE_URL).
 * LinkedIn endpoints are stubbed (fetch).
 */
import { createHmac, randomBytes } from "node:crypto"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ConnectionsResponse, IngestJobData } from "@inbox/core"
import { createKeyring } from "@inbox/core/crypto"
import { createLogger } from "@inbox/core/logger"
import { createPrismaClient, type Prisma } from "@inbox/db"
import { settingsSecretAad, tokenAad } from "@inbox/pipeline"
import { createApp } from "./app"
import type { JobSender } from "./lib/jobs"

const url = process.env.TEST_DATABASE_URL
const prisma = url ? createPrismaClient(url) : null
const logger = createLogger("test", { level: "silent", transport: undefined })
const keyring = createKeyring(randomBytes(32).toString("base64"))
const ORG = "li-org"
const USER = "u-li"
const API = "https://api.example.com"
const WEB = "https://app.example.com"
const CLIENT_SECRET = "li-client-secret"

const ingests: IngestJobData[] = []
const jobs: JobSender = {
  enqueueRefilter: async () => {},
  enqueuePoll: async () => {},
  enqueueIngest: async (d) => void ingests.push(d),
  enqueueAiDraft: async () => {},
  enqueueSendReply: async () => {},
  stop: async () => {},
}

const app = () =>
  createApp({
    auth: {
      handler: async () => new Response(null, { status: 404 }),
      getSession: async () => ({
        user: { id: USER, email: "owner@example.com", name: "Owner" },
        session: { id: "s-li", activeOrganizationId: ORG },
      }),
    },
    orgs: { resolve: async () => ({ id: ORG, name: "L", role: "owner" }) },
    logger,
    checkDb: async () => true,
    prisma: prisma!,
    jobs,
    keyring,
    urls: { apiPublicUrl: API, webUrl: WEB },
  })

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const sign = (body: string, key = CLIENT_SECRET) =>
  createHmac("sha256", key).update(`hmacsha256=${body}`).digest("hex")

const delivery = JSON.stringify({
  type: "ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS",
  notifications: [
    {
      notificationId: 4406004,
      organizationalEntity: "urn:li:organization:2414183",
      action: "COMMENT",
      sourcePost: "urn:li:activity:1",
      generatedActivity: "urn:li:comment:(urn:li:activity:1,2)",
      lastModifiedAt: 1763197200000,
      subscriber: "urn:li:person:me",
    },
  ],
})

describe.skipIf(!url)("LinkedIn webhooks + connect (integration)", () => {
  beforeEach(async () => {
    ingests.length = 0
    await prisma!.$executeRawUnsafe(
      'TRUNCATE "webhook_event", "sync_state", "platform_account", "verification", "audit_log", "settings", "organization" CASCADE',
    )
    await prisma!.organization.create({
      data: { id: ORG, name: "L", slug: "l", createdAt: new Date() },
    })
    await prisma!.settings.create({
      data: {
        organizationId: ORG,
        connections: {
          linkedin: { clientId: "86abc", appId: "222333" },
          secrets: {
            linkedinClientSecret: {
              enc: keyring.encrypt(
                CLIENT_SECRET,
                settingsSecretAad(ORG, "connections", "linkedinClientSecret"),
              ),
              last4: "",
            },
          },
        } as Prisma.InputJsonObject,
      },
    })
  })
  afterEach(() => vi.unstubAllGlobals())
  afterAll(async () => prisma?.$disconnect())

  it("answers LinkedIn's validation challenge with the HMAC of the code", async () => {
    const res = await app().request("/webhooks/linkedin?challengeCode=890e4665-4dfe")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(await res.json()).toEqual({
      challengeCode: "890e4665-4dfe",
      challengeResponse: createHmac("sha256", CLIENT_SECRET).update("890e4665-4dfe").digest("hex"),
    })
    expect((await app().request("/webhooks/linkedin")).status).toBe(400)
  })

  it("stores a signed delivery once and queues ingest; rejects bad signatures", async () => {
    const post = (body: string, signature?: string) =>
      app().request("/webhooks/linkedin", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(signature ? { "x-li-signature": signature } : {}),
        },
        body,
      })
    expect((await post(delivery, sign(delivery))).status).toBe(200)
    expect((await post(delivery, sign(delivery))).status).toBe(200) // redelivery
    const valid = await prisma!.webhookEvent.findMany({ where: { signatureValid: true } })
    expect(valid).toHaveLength(1)
    expect(valid[0]).toMatchObject({ organizationId: ORG, source: "linkedin" })
    expect(ingests).toEqual([
      expect.objectContaining({ organizationId: ORG, webhookEventId: valid[0]!.id }),
    ])

    expect((await post(delivery, sign(delivery, "wrong"))).status).toBe(401)
    expect((await post(delivery)).status).toBe(401)
    expect(ingests).toHaveLength(1)

    const list = (await (await app().request("/api/connections")).json()) as ConnectionsResponse
    expect(list.configured.linkedin).toBe(true)
    expect(list.webhooks.linkedin).toMatchObject({ invalidLast24h: 2 })
    expect(list.setup).toMatchObject({
      linkedinAppIdSet: true,
      webhookUrls: { linkedin: `${API}/webhooks/linkedin` },
      redirectUris: { linkedin: `${WEB}/api/oauth/linkedin/callback` },
    })
  })

  it("connects administered Pages, stores tokens and subscribes webhooks", async () => {
    const start = await app().request("/api/oauth/linkedin/start")
    expect(start.status).toBe(302)
    const to = new URL(start.headers.get("location")!)
    expect(to.origin + to.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization")
    expect(to.searchParams.get("redirect_uri")).toBe(`${WEB}/api/oauth/linkedin/callback`)
    expect(to.searchParams.get("scope")).toBe(
      "rw_organization_admin r_organization_social_feed w_organization_social_feed",
    )

    const calls: { url: string; method: string; body?: string }[] = []
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const u = String(input)
      calls.push({ url: u, method: init?.method ?? "GET", body: init?.body as string })
      if (u === "https://www.linkedin.com/oauth/v2/accessToken") {
        return json({
          access_token: "li-at",
          expires_in: 5_184_000,
          refresh_token: "li-rt",
          refresh_token_expires_in: 31_536_000,
          scope: "rw_organization_admin,r_organization_social_feed,w_organization_social_feed",
        })
      }
      if (u.includes("/rest/organizationAcls")) {
        return json({
          elements: [
            {
              role: "ADMINISTRATOR",
              state: "APPROVED",
              roleAssignee: "urn:li:person:me",
              organization: "urn:li:organization:2414183",
            },
          ],
        })
      }
      if (u.endsWith("/rest/organizations/2414183")) {
        return json({ id: 2414183, localizedName: "Devtestco", vanityName: "devtestco" })
      }
      if (u.includes("/rest/eventSubscriptions/")) return new Response(null, { status: 201 })
      return json({ message: "unexpected" }, 500)
    })
    const res = await app().request(
      `/api/oauth/linkedin/callback?code=abc&state=${to.searchParams.get("state")}`,
    )
    const back = new URL(res.headers.get("location")!)
    expect(Object.fromEntries(back.searchParams)).toEqual({ connected: "linkedin", count: "1" })

    const row = await prisma!.platformAccount.findFirstOrThrow({ where: { platform: "linkedin" } })
    expect(row).toMatchObject({
      kind: "li_org",
      externalId: "2414183",
      displayName: "Devtestco",
      meta: {
        link: "https://www.linkedin.com/company/devtestco/",
        connectedBy: "urn:li:person:me",
      },
    })
    expect(keyring.decrypt(row.refreshTokenEnc!, tokenAad(ORG, row, "refresh"))).toBe("li-rt")
    const sub = calls.find((c) => c.url.includes("/eventSubscriptions/"))!
    expect(sub.method).toBe("PUT")
    expect(sub.url).toContain(
      "developerApplication:urn%3Ali%3AdeveloperApplication%3A222333,user:urn%3Ali%3Aperson%3Ame,entity:urn%3Ali%3Aorganization%3A2414183,eventType:ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS",
    )
    expect(JSON.parse(sub.body!)).toEqual({ webhook: `${API}/webhooks/linkedin` })
    const states = await prisma!.syncState.findMany()
    expect(states.map((s) => [s.stream, s.mode])).toEqual([["comments", "webhook_reconcile"]])

    // The state is single use.
    const again = await app().request(
      `/api/oauth/linkedin/callback?code=abc&state=${to.searchParams.get("state")}`,
    )
    expect(new URL(again.headers.get("location")!).searchParams.get("error")).toMatch(/expired/)
  })
})
