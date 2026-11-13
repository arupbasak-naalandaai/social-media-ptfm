/**
 * Meta and YouTube clients against stubbed HTTP (no database).
 */
import { readFileSync } from "node:fs"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { PlatformAccount } from "@inbox/db"
import {
  fetchNewFbComments,
  fetchNewMetaDms,
  MetaApiError,
  sendMetaMessage,
  signMetaBody,
  verifyMetaSignature,
  type MetaCallContext,
} from "./meta"
import { fetchNewYoutubeComments, insertYoutubeReply, YoutubeApiError } from "./youtube"

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

afterEach(() => vi.unstubAllGlobals())

function ctx(platform: "facebook" | "instagram", externalId: string): MetaCallContext {
  return {
    app: { appId: "1", appSecret: "s", version: "v26.0", loginConfigId: "" },
    token: "page-token",
    pageId: "page-1",
    account: { platform, externalId, organizationId: "o", meta: {} } as unknown as PlatformAccount,
  }
}

describe("Meta signature", () => {
  it("accepts the right HMAC only", () => {
    const body = '{"object":"page","entry":[]}'
    const sig = signMetaBody(body, "secret")
    expect(verifyMetaSignature(body, sig, "secret")).toBe(true)
    expect(verifyMetaSignature(Buffer.from(body), sig, "secret")).toBe(true)
    expect(verifyMetaSignature(body + " ", sig, "secret")).toBe(false)
    expect(verifyMetaSignature(body, sig, "other")).toBe(false)
    expect(verifyMetaSignature(body, "sha1=abc", "secret")).toBe(false)
    expect(verifyMetaSignature(body, undefined, "secret")).toBe(false)
  })
})

describe("Meta reconcile", () => {
  it("Facebook comments: only posts updated and comments created after the cursor", async () => {
    const seen: string[] = []
    vi.stubGlobal("fetch", async (input: URL) => {
      const u = new URL(String(input))
      seen.push(u.pathname)
      expect(u.searchParams.get("appsecret_proof")).toMatch(/^[0-9a-f]{64}$/)
      if (u.pathname === "/v26.0/page-1/feed") {
        return json({
          data: [
            {
              id: "page-1_new",
              updated_time: "2026-11-13T10:00:00+0000",
              permalink_url: "https://fb/p/new",
            },
            { id: "page-1_old", updated_time: "2026-11-01T10:00:00+0000" },
          ],
        })
      }
      if (u.pathname === "/v26.0/page-1_new/comments") {
        return json({
          data: [
            {
              id: "c3",
              message: "newest",
              created_time: "2026-11-13T10:00:00+0000",
              from: { id: "u1", name: "A" },
            },
            {
              id: "c2",
              message: "reply",
              created_time: "2026-11-13T09:00:00+0000",
              from: { id: "page-1" },
              parent: { id: "c1" },
            },
            { id: "c1", message: "old", created_time: "2026-11-10T09:00:00+0000" },
          ],
        })
      }
      return json({ error: { message: "unexpected" } }, 500)
    })
    const res = await fetchNewFbComments(ctx("facebook", "page-1"), {
      cursor: "2026-11-12T00:00:00.000Z",
      backfillDays: 30,
    })
    expect(seen).not.toContain("/v26.0/page-1_old/comments")
    expect(res.items.map((i) => [i.externalId, i.parentExternalId, i.isOwnAccount])).toEqual([
      ["c2", "c1", true],
      ["c3", null, false],
    ])
    expect(res.items[1]!.postUrl).toBe("https://fb/p/new")
    expect(res.cursor).toBe("2026-11-13T10:00:00.000Z")
  })

  it("Instagram DMs: conversations API with platform=instagram, customer from participants", async () => {
    vi.stubGlobal("fetch", async (input: URL) => {
      const u = new URL(String(input))
      expect(u.pathname).toBe("/v26.0/page-1/conversations")
      expect(u.searchParams.get("platform")).toBe("instagram")
      return json({
        data: [
          {
            id: "t1",
            updated_time: "2026-11-13T10:00:00+0000",
            participants: {
              data: [
                { id: "ig-1", username: "us" },
                { id: "cust-9", username: "fan" },
              ],
            },
            messages: {
              data: [
                {
                  id: "m2",
                  message: "Sure, see you!",
                  created_time: "2026-11-13T10:00:00+0000",
                  from: { id: "ig-1" },
                },
                {
                  id: "m1",
                  message: "Open late?",
                  created_time: "2026-11-13T09:00:00+0000",
                  from: { id: "cust-9", username: "fan" },
                },
              ],
            },
          },
        ],
      })
    })
    const res = await fetchNewMetaDms(ctx("instagram", "ig-1"), {
      cursor: null,
      backfillDays: 30,
      now: new Date("2026-11-13T12:00:00Z"),
    })
    expect(
      res.items.map((i) => [i.externalId, i.isOwnAccount, i.conversation?.customerId]),
    ).toEqual([
      ["m1", false, "cust-9"],
      ["m2", true, "cust-9"],
    ])
    expect(res.items[0]!.conversation?.customerName).toBe("@fan")
  })

  it("a closed messaging window is a final (non-retryable) error with a hint", async () => {
    vi.stubGlobal("fetch", async (_input: URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        recipient: { id: "cust-9" },
        messaging_type: "RESPONSE",
      })
      return json(
        {
          error: {
            message: "(#10) This message is sent outside of allowed window.",
            code: 10,
            error_subcode: 2018278,
          },
        },
        400,
      )
    })
    const err = await sendMetaMessage(ctx("facebook", "page-1"), "cust-9", "hi").catch((e) => e)
    expect(err).toBeInstanceOf(MetaApiError)
    expect(err).toMatchObject({ retryable: false, reauth: false, subcode: 2018278 })
    expect((err as Error).message).toMatch(/messaging window/)
  })

  it("rate limits retry; an invalid token asks to reconnect", async () => {
    vi.stubGlobal("fetch", async () => json({ error: { message: "Too many calls", code: 4 } }, 400))
    expect(await sendMetaMessage(ctx("facebook", "p"), "c", "x").catch((e) => e)).toMatchObject({
      retryable: true,
    })
    vi.stubGlobal("fetch", async () =>
      json({ error: { message: "Session has expired", code: 190 } }, 400),
    )
    expect(await sendMetaMessage(ctx("facebook", "p"), "c", "x").catch((e) => e)).toMatchObject({
      reauth: true,
      retryable: false,
    })
  })
})

describe("YouTube polling", () => {
  const fixture = JSON.parse(
    readFileSync(
      path.resolve(import.meta.dirname, "../../core/fixtures/youtube/comment-threads.json"),
      "utf8",
    ),
  ) as unknown

  it("reads comments + replies newer than the cursor and counts quota units", async () => {
    const calls: string[] = []
    vi.stubGlobal("fetch", async (input: URL) => {
      const u = new URL(String(input))
      calls.push(u.pathname)
      expect(u.searchParams.get("allThreadsRelatedToChannelId")).toBe("UC-demo-channel")
      expect(u.searchParams.get("textFormat")).toBe("plainText")
      return json(fixture)
    })
    const res = await fetchNewYoutubeComments("tok", {
      channelId: "UC-demo-channel",
      cursor: "2026-11-05T00:00:00.000Z",
      backfillDays: 30,
      pagesPerPoll: 3,
    })
    expect(res.items.map((i) => [i.externalId, i.isOwnAccount])).toEqual([
      ["UgzThread2", false],
      ["UgzThread2.reply1", true],
    ])
    // The page reached the cursor (an older thread), so it stopped after 1 page = 1 unit.
    expect(res.quotaUnits).toBe(1)
    expect(calls).toEqual(["/youtube/v3/commentThreads"])
    expect(res.cursor).toBe("2026-11-13T10:30:00.000Z")
  })

  it("fetches all replies when more exist than are inlined (1 unit per page)", async () => {
    vi.stubGlobal("fetch", async (input: URL) => {
      const u = new URL(String(input))
      if (u.pathname.endsWith("/commentThreads")) {
        return json({
          items: [
            {
              id: "t",
              snippet: {
                videoId: "v",
                totalReplyCount: 7,
                topLevelComment: {
                  id: "t",
                  snippet: {
                    publishedAt: "2026-11-13T00:00:00Z",
                    authorChannelId: { value: "UCus" },
                  },
                },
              },
              replies: { comments: [] },
            },
          ],
        })
      }
      expect(u.searchParams.get("parentId")).toBe("t")
      return json({
        items: [
          {
            id: "t.1",
            snippet: {
              publishedAt: "2026-11-13T01:00:00Z",
              authorChannelId: { value: "UCfan" },
              textDisplay: "hey",
            },
          },
        ],
      })
    })
    const res = await fetchNewYoutubeComments("tok", {
      channelId: "UCus",
      cursor: null,
      backfillDays: 30,
      pagesPerPoll: 1,
      now: new Date("2026-11-13T12:00:00Z"),
    })
    expect(res.quotaUnits).toBe(2)
    expect(res.items.find((i) => i.externalId === "t.1")).toMatchObject({
      parentExternalId: "t",
      isReplyToOurReply: true,
    })
  })

  it("quota exhaustion is a final error with a reset hint", async () => {
    vi.stubGlobal("fetch", async () =>
      json(
        {
          error: {
            code: 403,
            message: "The request cannot be completed because you have exceeded your quota.",
            errors: [{ reason: "quotaExceeded" }],
          },
        },
        403,
      ),
    )
    const err = await insertYoutubeReply("tok", "t", "hi").catch((e) => e)
    expect(err).toBeInstanceOf(YoutubeApiError)
    expect(err).toMatchObject({ quotaExceeded: true, retryable: false })
    expect((err as Error).message).toMatch(/midnight Pacific/)
  })
})
