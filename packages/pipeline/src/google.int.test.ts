/**
 * Google token refresh and review paging against a real database, with Google stubbed.
 */
import { randomBytes } from "node:crypto"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createKeyring } from "@inbox/core/crypto"
import { createPrismaClient, type PlatformAccount, type Prisma } from "@inbox/db"
import {
  encryptTokens,
  fetchNewGbpReviews,
  GoogleApiError,
  googleAccessToken,
  tokenAad,
} from "./google"
import { settingsSecretAad } from "./settings"

const url = process.env.TEST_DATABASE_URL
const prisma = url ? createPrismaClient(url) : null
const keyring = createKeyring(randomBytes(32).toString("base64"))
const ORG = "gp-org"

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const review = (id: string, updateTime: string, comment = `review ${id}`) => ({
  name: `accounts/1/locations/2/reviews/${id}`,
  reviewId: id,
  starRating: "FOUR",
  comment,
  createTime: updateTime,
  updateTime,
})

async function makeAccount(expiresInSec: number): Promise<PlatformAccount> {
  const key = { platform: "google_business", externalId: "locations/2" }
  return prisma!.platformAccount.create({
    data: {
      organizationId: ORG,
      platform: "google_business",
      kind: "gbp_location",
      externalId: "locations/2",
      displayName: "Downtown",
      status: "expiring",
      meta: { accountName: "accounts/1" },
      ...encryptTokens(keyring, ORG, key, {
        access_token: "at-old",
        refresh_token: "rt-1",
        expires_in: expiresInSec,
      }),
    },
  })
}

describe.skipIf(!url)("Google client (integration, stubbed Google)", () => {
  beforeEach(async () => {
    await prisma!.$executeRawUnsafe(
      'TRUNCATE "platform_account", "settings", "organization" CASCADE',
    )
    await prisma!.organization.create({
      data: { id: ORG, name: "GP", slug: "gp", createdAt: new Date() },
    })
    await prisma!.settings.create({
      data: {
        organizationId: ORG,
        connections: {
          google: { clientId: "cid" },
          secrets: {
            googleClientSecret: {
              enc: keyring.encrypt(
                "cs",
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

  it("uses a fresh token as is, and refreshes one about to expire", async () => {
    const fresh = await makeAccount(3600)
    vi.stubGlobal("fetch", async () => {
      throw new Error("should not call Google")
    })
    expect(await googleAccessToken(prisma!, keyring, fresh)).toBe("at-old")

    await prisma!.platformAccount.deleteMany()
    const stale = await makeAccount(30) // inside the 60 s skew
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => {
      expect(new URLSearchParams(String(init?.body)).get("grant_type")).toBe("refresh_token")
      return json({ access_token: "at-new", expires_in: 3599 })
    })
    expect(await googleAccessToken(prisma!, keyring, stale)).toBe("at-new")
    const row = await prisma!.platformAccount.findUniqueOrThrow({ where: { id: stale.id } })
    expect(keyring.decrypt(row.accessTokenEnc!, tokenAad(ORG, row, "access"))).toBe("at-new")
    expect(row.status).toBe("connected") // was "expiring"
    // The refresh token is kept (Google doesn't send a new one).
    expect(keyring.decrypt(row.refreshTokenEnc!, tokenAad(ORG, row, "refresh"))).toBe("rt-1")
  })

  it("a revoked grant marks the account for reconnecting", async () => {
    const stale = await makeAccount(0)
    vi.stubGlobal("fetch", async () =>
      json(
        { error: "invalid_grant", error_description: "Token has been expired or revoked." },
        400,
      ),
    )
    const err = await googleAccessToken(prisma!, keyring, stale).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GoogleApiError)
    expect((err as GoogleApiError).reauth).toBe(true)
    expect((err as GoogleApiError).retryable).toBe(false)
    const row = await prisma!.platformAccount.findUniqueOrThrow({ where: { id: stale.id } })
    expect(row.status).toBe("error")
    expect(row.lastError).toMatch(/Reconnect/)
  })

  it("pages newest-first down to the cursor and returns oldest-first with the new cursor", async () => {
    const account = await makeAccount(3600)
    const requested: string[] = []
    vi.stubGlobal("fetch", async (input: string) => {
      const u = new URL(input)
      requested.push(
        `${u.pathname}?${u.searchParams.get("pageToken") ?? ""}&${u.searchParams.get("orderBy")}`,
      )
      if (!u.searchParams.get("pageToken")) {
        return json({
          reviews: [review("r5", "2026-11-13T10:00:00Z"), review("r4", "2026-11-12T10:00:00Z")],
          nextPageToken: "p2",
        })
      }
      return json({
        reviews: [review("r3", "2026-11-11T10:00:00Z"), review("r2", "2026-11-10T10:00:00Z")],
        nextPageToken: "p3",
      })
    })
    const res = await fetchNewGbpReviews(prisma!, keyring, {
      account,
      cursor: "2026-11-10T10:00:00.000Z",
      backfillDays: 30,
    })
    expect(requested).toEqual([
      "/v4/accounts/1/locations/2/reviews?&updateTime desc",
      "/v4/accounts/1/locations/2/reviews?p2&updateTime desc",
    ])
    expect(res.items.map((i) => i.externalId)).toEqual(["r3", "r4", "r5"]) // r2 is at the cursor
    expect(res.cursor).toBe("2026-11-13T10:00:00.000Z")
    expect(res.complete).toBe(true)
  })

  it("first sync reaches back backfillDays; nothing new keeps the cursor", async () => {
    const account = await makeAccount(3600)
    const now = new Date("2026-11-13T12:00:00Z")
    vi.stubGlobal("fetch", async () =>
      json({
        reviews: [review("new", "2026-11-12T00:00:00Z"), review("old", "2026-09-01T00:00:00Z")],
      }),
    )
    const first = await fetchNewGbpReviews(prisma!, keyring, {
      account,
      cursor: null,
      backfillDays: 30,
      now,
    })
    expect(first.items.map((i) => i.externalId)).toEqual(["new"])
    expect(first.cursor).toBe("2026-11-12T00:00:00.000Z")

    const again = await fetchNewGbpReviews(prisma!, keyring, {
      account,
      cursor: first.cursor!,
      backfillDays: 30,
    })
    expect(again.items).toEqual([])
    expect(again.cursor).toBe(first.cursor)
  })

  it("explains a zero-quota 429 and treats it as retryable", async () => {
    const account = await makeAccount(3600)
    vi.stubGlobal("fetch", async () =>
      json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } }, 429),
    )
    const err = (await fetchNewGbpReviews(prisma!, keyring, {
      account,
      cursor: null,
      backfillDays: 30,
    }).catch((e: unknown) => e)) as GoogleApiError
    expect(err.retryable).toBe(true)
    expect(err.message).toMatch(/request API access/)
  })
})
