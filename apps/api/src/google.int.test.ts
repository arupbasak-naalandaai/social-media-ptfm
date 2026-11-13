/**
 * Google connection flow and Pub/Sub push against a real database (TEST_DATABASE_URL).
 * Google's endpoints are stubbed (fetch) and push tokens are signed with a local key.
 */
import { randomBytes } from "node:crypto"
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
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
const ORG = "google-org"
const USER = "u-google"
const PUSH_SA = "push@proj.iam.gserviceaccount.com"
const API = "https://api.example.com"
const WEB = "https://app.example.com"

const ingests: IngestJobData[] = []
const jobs: JobSender = {
  enqueueRefilter: async () => {},
  enqueuePoll: async () => {},
  enqueueIngest: async (d) => void ingests.push(d),
  enqueueAiDraft: async () => {},
  enqueueSendReply: async () => {},
  stop: async () => {},
}

let signer: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"]
let jwks: ReturnType<typeof createLocalJWKSet>

const app = () =>
  createApp({
    auth: {
      handler: async () => new Response(null, { status: 404 }),
      getSession: async () => ({
        user: { id: USER, email: "owner@example.com", name: "Owner" },
        session: { id: "s-g", activeOrganizationId: ORG },
      }),
    },
    orgs: { resolve: async () => ({ id: ORG, name: "G", role: "owner" }) },
    logger,
    checkDb: async () => true,
    prisma: prisma!,
    jobs,
    keyring,
    urls: { apiPublicUrl: API, webUrl: WEB },
    googleJwks: jwks,
  })

async function pushToken(claims: Record<string, unknown>) {
  return new SignJWT({ email: PUSH_SA, email_verified: true, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer("https://accounts.google.com")
    .setAudience(`${API}/webhooks/google`)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(signer)
}

function pushBody(messageId: string) {
  const data = Buffer.from(
    JSON.stringify({ type: "NEW_REVIEW", review: "accounts/1/locations/2/reviews/3" }),
  ).toString("base64")
  return JSON.stringify({
    message: { data, messageId },
    subscription: "projects/p/subscriptions/s",
  })
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe.skipIf(!url)("Google connect + Pub/Sub (integration)", () => {
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256")
    signer = pair.privateKey
    jwks = createLocalJWKSet({
      keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }],
    })
  })
  beforeEach(async () => {
    ingests.length = 0
    await prisma!.$executeRawUnsafe(
      'TRUNCATE "webhook_event", "sync_state", "platform_account", "verification", "audit_log", "settings", "organization" CASCADE',
    )
    await prisma!.organization.create({
      data: { id: ORG, name: "G", slug: "g", createdAt: new Date() },
    })
    await prisma!.settings.create({
      data: {
        organizationId: ORG,
        connections: {
          google: {
            clientId: "cid.apps.googleusercontent.com",
            pushServiceAccountEmail: PUSH_SA,
            pubsubTopic: "projects/my-proj/topics/reviews",
          },
          secrets: {
            googleClientSecret: {
              enc: keyring.encrypt(
                "csecret",
                settingsSecretAad(ORG, "connections", "googleClientSecret"),
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

  // ─── Pub/Sub ──────────────────────────────────────────────────────────────

  it("accepts a verified push once, stores it and queues ingest", async () => {
    const post = async (token: string, id: string) =>
      app().request("/webhooks/google", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: pushBody(id),
      })
    const token = await pushToken({})
    expect((await post(token, "m-1")).status).toBe(204)
    expect((await post(token, "m-1")).status).toBe(204) // redelivery
    const events = await prisma!.webhookEvent.findMany()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ organizationId: ORG, signatureValid: true, dedupeKey: "m-1" })
    expect(JSON.stringify(events[0]!.headers)).not.toContain("Bearer")
    expect(ingests).toEqual([
      expect.objectContaining({ organizationId: ORG, webhookEventId: events[0]!.id }),
    ])
  })

  it("rejects pushes with the wrong audience, sender or no token", async () => {
    const bad = [
      await new SignJWT({ email: PUSH_SA, email_verified: true })
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer("https://accounts.google.com")
        .setAudience("https://evil.example.com")
        .setExpirationTime("10m")
        .sign(signer),
      await pushToken({ email: "someone@else.iam.gserviceaccount.com" }),
      await pushToken({ email_verified: false }),
    ]
    for (const [i, token] of bad.entries()) {
      const res = await app().request("/webhooks/google", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: pushBody(`bad-${i}`),
      })
      expect(res.status).toBe(401)
    }
    const none = await app().request("/webhooks/google", { method: "POST", body: pushBody("x") })
    expect(none.status).toBe(401)
    expect(await prisma!.webhookEvent.count({ where: { signatureValid: false } })).toBe(4)
    expect(ingests).toHaveLength(0)
    expect((await app().request("/webhooks/google", { method: "POST", body: "{}" })).status).toBe(
      400,
    )
  })

  // ─── OAuth ────────────────────────────────────────────────────────────────

  async function start() {
    const res = await app().request("/api/oauth/google/start")
    expect(res.status).toBe(302)
    const to = new URL(res.headers.get("location")!)
    return to
  }

  it("start redirects to Google with offline access, consent and PKCE", async () => {
    const to = await start()
    expect(to.origin + to.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth")
    expect(Object.fromEntries(to.searchParams)).toMatchObject({
      client_id: "cid.apps.googleusercontent.com",
      redirect_uri: `${WEB}/api/oauth/google/callback`,
      scope: "https://www.googleapis.com/auth/business.manage",
      access_type: "offline",
      prompt: "consent",
      code_challenge_method: "S256",
    })
    expect(await prisma!.verification.count()).toBe(1)
  })

  it("callback stores encrypted tokens per location, sets up sync and notifications", async () => {
    const state = (await start()).searchParams.get("state")!
    const calls: string[] = []
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const u = String(input)
      calls.push(`${init?.method ?? "GET"} ${u.split("?")[0]}`)
      if (u.startsWith("https://oauth2.googleapis.com/token")) {
        const body = new URLSearchParams(String(init?.body))
        expect(body.get("code_verifier")).toBeTruthy()
        expect(body.get("client_secret")).toBe("csecret")
        return json({
          access_token: "at-1",
          refresh_token: "rt-1",
          expires_in: 3599,
          scope: "https://www.googleapis.com/auth/business.manage",
        })
      }
      if (u.startsWith("https://mybusinessaccountmanagement.googleapis.com/v1/accounts")) {
        return json({ accounts: [{ name: "accounts/1", accountName: "Demo Group" }] })
      }
      if (u.includes("/accounts/1/locations")) {
        return json({
          locations: [
            {
              name: "locations/2",
              title: "Downtown",
              metadata: { mapsUri: "https://maps.google.com/?cid=2" },
            },
            { name: "locations/3", title: "Airport" },
          ],
        })
      }
      if (u.includes("/notificationSetting")) return json({})
      return json({ error: { message: "unexpected" } }, 500)
    })

    const res = await app().request(`/api/oauth/google/callback?code=abc&state=${state}`)
    expect(res.status).toBe(302)
    const back = new URL(res.headers.get("location")!)
    expect(back.pathname).toBe("/connections")
    expect(Object.fromEntries(back.searchParams)).toEqual({ connected: "google", count: "2" })
    expect(calls).toContain(
      "PATCH https://mybusinessnotifications.googleapis.com/v1/accounts/1/notificationSetting",
    )

    const rows = await prisma!.platformAccount.findMany({ orderBy: { externalId: "asc" } })
    expect(rows.map((r) => [r.externalId, r.displayName, r.status])).toEqual([
      ["locations/2", "Downtown", "connected"],
      ["locations/3", "Airport", "connected"],
    ])
    expect(rows[0]!.accessTokenEnc).not.toContain("at-1")
    expect(keyring.decrypt(rows[0]!.refreshTokenEnc!, tokenAad(ORG, rows[0]!, "refresh"))).toBe(
      "rt-1",
    )
    expect(rows[0]!.meta).toMatchObject({
      accountName: "accounts/1",
      mapsUri: "https://maps.google.com/?cid=2",
    })
    expect(await prisma!.syncState.count()).toBe(2)
    // The state is single-use.
    expect(await prisma!.verification.count()).toBe(0)
    const replay = await app().request(`/api/oauth/google/callback?code=abc&state=${state}`)
    expect(new URL(replay.headers.get("location")!).searchParams.get("error")).toMatch(
      /expired or was already used/,
    )

    const list = (await (await app().request("/api/connections")).json()) as ConnectionsResponse
    expect(list.configured.google).toBe(true)
    expect(list.accounts.map((a) => [a.displayName, a.parentName, a.url])).toEqual([
      ["Airport", "Demo Group", null],
      ["Downtown", "Demo Group", "https://maps.google.com/?cid=2"],
    ])
    expect(JSON.stringify(list)).not.toContain("v1:")
  })

  it("callback reports a missing refresh token and a denied consent", async () => {
    const state = (await start()).searchParams.get("state")!
    vi.stubGlobal("fetch", async () =>
      json({
        access_token: "at",
        expires_in: 3599,
        scope: "https://www.googleapis.com/auth/business.manage",
      }),
    )
    const res = await app().request(`/api/oauth/google/callback?code=abc&state=${state}`)
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toMatch(/refresh token/)
    const denied = await app().request(`/api/oauth/google/callback?error=access_denied`)
    expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe(
      "Google access wasn't granted.",
    )
  })

  it("include toggle and disconnect wipe tokens", async () => {
    const acc = await prisma!.platformAccount.create({
      data: {
        organizationId: ORG,
        platform: "google_business",
        kind: "gbp_location",
        externalId: "locations/9",
        displayName: "X",
        accessTokenEnc: "v1:a",
        refreshTokenEnc: "v1:b",
      },
    })
    const patch = await app().request(`/api/connections/${acc.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ included: false }),
    })
    expect(patch.status).toBe(200)
    expect(
      (await app().request(`/api/connections/${acc.id}/disconnect`, { method: "POST" })).status,
    ).toBe(200)
    const after = await prisma!.platformAccount.findUniqueOrThrow({ where: { id: acc.id } })
    expect(after).toMatchObject({
      included: false,
      status: "disconnected",
      accessTokenEnc: null,
      refreshTokenEnc: null,
    })
  })
})
