/**
 * Meta webhooks + connect flow and the YouTube connect flow, against a real database
 * (TEST_DATABASE_URL). Graph / Google endpoints are stubbed (fetch).
 */
import { effectivePermissions } from "@inbox/core"
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
const ORG = "meta-org"
const USER = "u-meta"
const API = "https://api.example.com"
const WEB = "https://app.example.com"
const APP_SECRET = "meta-app-secret"
const VERIFY = "verify-me-123"

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
        session: { id: "s-m", activeOrganizationId: ORG },
      }),
    },
    orgs: {
      resolve: async () => ({
        id: ORG,
        name: "M",
        role: "owner",
        permissions: effectivePermissions("owner", null),
      }),
    },
    logger,
    checkDb: async () => true,
    prisma: prisma!,
    jobs,
    keyring,
    urls: { apiPublicUrl: API, webUrl: WEB },
  })

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const secret = (key: string, value: string) => ({
  enc: keyring.encrypt(value, settingsSecretAad(ORG, "connections", key)),
  last4: "",
})

const sign = (body: string, key = APP_SECRET) =>
  `sha256=${createHmac("sha256", key).update(body).digest("hex")}`

const commentDelivery = JSON.stringify({
  object: "page",
  entry: [
    {
      id: "111",
      time: 1_763_000_000,
      changes: [
        {
          field: "feed",
          value: {
            item: "comment",
            verb: "add",
            comment_id: "111_222_333",
            post_id: "111_222",
            parent_id: "111_222",
            from: { id: "9", name: "Asha" },
            message: "Do you deliver on Sundays?",
            created_time: 1_763_000_000,
          },
        },
      ],
    },
  ],
})

describe.skipIf(!url)("Meta webhooks + Meta/YouTube connect (integration)", () => {
  beforeEach(async () => {
    ingests.length = 0
    await prisma!.$executeRawUnsafe(
      'TRUNCATE "webhook_event", "sync_state", "platform_account", "verification", "audit_log", "settings", "organization" CASCADE',
    )
    await prisma!.organization.create({
      data: { id: ORG, name: "M", slug: "m", createdAt: new Date() },
    })
    await prisma!.settings.create({
      data: {
        organizationId: ORG,
        connections: {
          meta: { appId: "1234567890" },
          google: { clientId: "cid.apps.googleusercontent.com" },
          secrets: {
            metaAppSecret: secret("metaAppSecret", APP_SECRET),
            metaVerifyToken: secret("metaVerifyToken", VERIFY),
            googleClientSecret: secret("googleClientSecret", "csecret"),
          },
        } as Prisma.InputJsonObject,
      },
    })
  })
  afterEach(() => vi.unstubAllGlobals())
  afterAll(async () => prisma?.$disconnect())

  // ─── Webhooks ─────────────────────────────────────────────────────────────

  it("answers Meta's subscription handshake only with the right verify token", async () => {
    const ok = await app().request(
      `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=abc123`,
    )
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe("abc123")
    const bad = await app().request(
      "/webhooks/meta?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc123",
    )
    expect(bad.status).toBe(403)
  })

  it("accepts the generated verify token when none is typed, and shows it to admins", async () => {
    await prisma!.settings.update({
      where: { organizationId: ORG },
      data: {
        connections: {
          meta: { appId: "1234567890" },
          secrets: { metaAppSecret: secret("metaAppSecret", APP_SECRET) },
        } as Prisma.InputJsonObject,
      },
    })
    const list = (await (await app().request("/api/connections")).json()) as ConnectionsResponse
    const generated = list.setup.metaVerifyToken.generated
    expect(list.setup.metaVerifyToken.custom).toBe(false)
    expect(generated).toMatch(/^[\w-]{32}$/)
    const ok = await app().request(
      `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${generated}&hub.challenge=xyz`,
    )
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe("xyz")
  })

  it("stores a signed delivery once and queues ingest; rejects bad signatures", async () => {
    const post = (body: string, signature?: string) =>
      app().request("/webhooks/meta", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(signature ? { "x-hub-signature-256": signature } : {}),
        },
        body,
      })
    expect((await post(commentDelivery, sign(commentDelivery))).status).toBe(200)
    expect((await post(commentDelivery, sign(commentDelivery))).status).toBe(200) // Meta retry
    const valid = await prisma!.webhookEvent.findMany({ where: { signatureValid: true } })
    expect(valid).toHaveLength(1)
    expect(valid[0]).toMatchObject({ organizationId: ORG, source: "meta" })
    expect(ingests).toEqual([
      expect.objectContaining({ organizationId: ORG, webhookEventId: valid[0]!.id }),
    ])

    expect((await post(commentDelivery, sign(commentDelivery, "wrong"))).status).toBe(401)
    expect((await post(commentDelivery)).status).toBe(401)
    expect((await post("not json", sign("not json"))).status).toBe(400)
    expect(await prisma!.webhookEvent.count({ where: { signatureValid: false } })).toBe(2)
    expect(ingests).toHaveLength(1)

    const list = (await (await app().request("/api/connections")).json()) as ConnectionsResponse
    expect(list.webhooks.meta).toMatchObject({ invalidLast24h: 2, lastError: null })
    expect(list.webhooks.meta.lastValidAt).not.toBeNull()
    expect(list.setup).toMatchObject({
      publicUrlReachable: true,
      metaVerifyToken: { custom: true, generated: null },
      webhookUrls: { meta: `${API}/webhooks/meta` },
      redirectUris: { meta: `${WEB}/api/oauth/meta/callback` },
    })
  })

  // ─── Meta OAuth ───────────────────────────────────────────────────────────

  it("connects Pages and their Instagram accounts with Page tokens and subscribes webhooks", async () => {
    const start = await app().request("/api/oauth/meta/start")
    expect(start.status).toBe(302)
    const to = new URL(start.headers.get("location")!)
    expect(to.origin + to.pathname).toBe("https://www.facebook.com/v26.0/dialog/oauth")
    expect(to.searchParams.get("redirect_uri")).toBe(`${WEB}/api/oauth/meta/callback`)
    expect(to.searchParams.get("scope")).toContain("pages_messaging")
    const state = to.searchParams.get("state")!

    const calls: string[] = []
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const u = new URL(String(input))
      calls.push(`${init?.method ?? "GET"} ${u.pathname}`)
      if (u.pathname === "/v26.0/oauth/access_token") {
        if (u.searchParams.get("grant_type") === "fb_exchange_token") {
          expect(u.searchParams.get("fb_exchange_token")).toBe("short")
          return json({ access_token: "long-user", expires_in: 5_184_000 })
        }
        expect(u.searchParams.get("client_secret")).toBe(APP_SECRET)
        return json({ access_token: "short", expires_in: 3600 })
      }
      if (u.pathname === "/v26.0/me/permissions") {
        expect(u.searchParams.get("appsecret_proof")).toMatch(/^[0-9a-f]{64}$/)
        return json({
          data: [
            { permission: "pages_show_list", status: "granted" },
            { permission: "pages_messaging", status: "declined" },
          ],
        })
      }
      if (u.pathname === "/v26.0/me/accounts") {
        return json({
          data: [
            {
              id: "111",
              name: "Demo Bistro",
              access_token: "page-token-111",
              link: "https://www.facebook.com/demobistro",
              instagram_business_account: { id: "178", username: "demobistro" },
            },
            { id: "222", name: "No Token Page" },
          ],
        })
      }
      if (u.pathname === "/v26.0/111/subscribed_apps") {
        expect(u.searchParams.get("subscribed_fields")).toBe("feed,messages,message_echoes")
        expect(u.searchParams.get("access_token")).toBe("page-token-111")
        return json({ success: true })
      }
      return json({ error: { message: "unexpected", code: 1 } }, 500)
    })

    const res = await app().request(`/api/oauth/meta/callback?code=c0de&state=${state}`)
    const back = new URL(res.headers.get("location")!)
    expect(back.searchParams.get("connected")).toBe("meta")
    expect(back.searchParams.get("count")).toBe("2")
    expect(back.searchParams.get("warning")).toMatch(/pages_messaging/)
    expect(back.searchParams.get("warning")).toMatch(/No Token Page/)
    expect(calls).toContain("POST /v26.0/111/subscribed_apps")

    const rows = await prisma!.platformAccount.findMany({ orderBy: { platform: "asc" } })
    expect(rows.map((r) => [r.platform, r.kind, r.externalId, r.displayName])).toEqual([
      ["facebook", "fb_page", "111", "Demo Bistro"],
      ["instagram", "ig_account", "178", "@demobistro"],
    ])
    const ig = rows[1]!
    expect(ig.parentAccountId).toBe(rows[0]!.id)
    expect(ig.meta).toMatchObject({ pageId: "111", username: "demobistro" })
    expect(keyring.decrypt(ig.accessTokenEnc!, tokenAad(ORG, ig, "access"))).toBe("page-token-111")
    expect(ig.tokenExpiresAt).toBeNull()
    // FB: comments + DMs, IG: comments + DMs.
    expect(await prisma!.syncState.count()).toBe(4)

    const list = (await (await app().request("/api/connections")).json()) as ConnectionsResponse
    expect(list.configured.meta).toBe(true)
    const igDto = list.accounts.find((a) => a.platform === "instagram")!
    expect(igDto).toMatchObject({
      parentName: "via Facebook Page “Demo Bistro”",
      url: "https://www.instagram.com/demobistro/",
    })
    expect(igDto.streams.map((s) => s.key).sort()).toEqual(["ig_comments", "ig_dms"])
    expect(JSON.stringify(list)).not.toContain("page-token")
  })

  it("Meta errors come back as a readable message", async () => {
    const to = new URL((await app().request("/api/oauth/meta/start")).headers.get("location")!)
    vi.stubGlobal("fetch", async () =>
      json({ error: { message: "Invalid verification code format.", code: 100 } }, 400),
    )
    const res = await app().request(
      `/api/oauth/meta/callback?code=x&state=${to.searchParams.get("state")}`,
    )
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toMatch(
      /Invalid verification code/,
    )
    const denied = await app().request(
      "/api/oauth/meta/callback?error=access_denied&error_reason=user_denied",
    )
    expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe(
      "Facebook access wasn't granted.",
    )
  })

  // ─── YouTube OAuth ────────────────────────────────────────────────────────

  it("connects YouTube channels through the Google callback with the YouTube scope", async () => {
    const to = new URL((await app().request("/api/oauth/youtube/start")).headers.get("location")!)
    expect(to.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/youtube.force-ssl")
    expect(to.searchParams.get("redirect_uri")).toBe(`${WEB}/api/auth/callback/google`)

    vi.stubGlobal("fetch", async (input: string | URL) => {
      const u = String(input)
      if (u.startsWith("https://oauth2.googleapis.com/token")) {
        return json({
          access_token: "yt-at",
          refresh_token: "yt-rt",
          expires_in: 3599,
          scope: "https://www.googleapis.com/auth/youtube.force-ssl",
        })
      }
      if (u.startsWith("https://www.googleapis.com/youtube/v3/channels")) {
        return json({
          items: [{ id: "UC123", snippet: { title: "Demo Kitchen", customUrl: "@demokitchen" } }],
        })
      }
      return json({ error: { message: "unexpected" } }, 500)
    })
    const res = await app().request(
      `/api/auth/callback/google?code=abc&state=${to.searchParams.get("state")}`,
    )
    const back = new URL(res.headers.get("location")!)
    expect(Object.fromEntries(back.searchParams)).toEqual({ connected: "youtube", count: "1" })
    const row = await prisma!.platformAccount.findFirstOrThrow({ where: { platform: "youtube" } })
    expect(row).toMatchObject({
      kind: "yt_channel",
      externalId: "UC123",
      displayName: "Demo Kitchen",
    })
    expect(keyring.decrypt(row.refreshTokenEnc!, tokenAad(ORG, row, "refresh"))).toBe("yt-rt")
    const states = await prisma!.syncState.findMany()
    expect(states.map((s) => [s.stream, s.mode])).toEqual([["comments", "polling"]])
  })
})
