/**
 * Google Business Profile client: OAuth (web-server flow with PKCE), token storage and refresh,
 * and the few API calls we use. Plain fetch + zod (PLAN §4: no googleapis SDK).
 * Facts re-verified 2026-11-13 (PLAN §11).
 */
import { createHash, randomBytes } from "node:crypto"
import type { z } from "zod"
import {
  GBP_SCOPE,
  normalizeGbpReview,
  type NormalizedItem,
  gbpAccountListSchema,
  gbpLocationListSchema,
  gbpReviewListSchema,
  gbpReviewReplySchema,
  googleErrorSchema,
  googleTokenSchema,
  type GbpLocation,
  type GoogleToken,
} from "@inbox/core"
import { aadFor, type Keyring } from "@inbox/core/crypto"
import type { PlatformAccount, PrismaClient } from "@inbox/db"
import { loadSettingsSection, loadSettingsSecret } from "./settings"

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
const TOKEN_URL = "https://oauth2.googleapis.com/token"
const REVOKE_URL = "https://oauth2.googleapis.com/revoke"
const ACCOUNTS_URL = "https://mybusinessaccountmanagement.googleapis.com/v1/accounts"
const LOCATIONS_URL = "https://mybusinessbusinessinformation.googleapis.com/v1"
const TIMEOUT_MS = 15_000
/** Refresh a little before Google's expiry. */
const EXPIRY_SKEW_MS = 60_000

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Retrying later may work (429, 5xx, network). */
    readonly retryable: boolean,
    /** The connection needs the user to sign in again (revoked/expired refresh token). */
    readonly reauth = false,
  ) {
    super(message)
    this.name = "GoogleApiError"
  }
}

async function call<T>(
  url: string,
  init: RequestInit,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      ...init,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
        : AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    throw new GoogleApiError(`Google didn't respond: ${(err as Error).message}`, 0, true)
  }
  const body: unknown = await res.json().catch(() => ({}))
  if (!res.ok) {
    const parsed = googleErrorSchema.safeParse(body)
    const e = parsed.success ? parsed.data : null
    const code = typeof e?.error === "string" ? e.error : (e?.error.status ?? "")
    const detail =
      typeof e?.error === "string" ? (e.error_description ?? e.error) : (e?.error.message ?? "")
    const reauth = code === "invalid_grant" || res.status === 401
    const quota0 = res.status === 429 && /quota|RESOURCE_EXHAUSTED/i.test(`${code} ${detail}`)
    const hint = quota0
      ? " (Google Business Profile API quota: request API access if it's 0)"
      : res.status === 403
        ? " (check that the Business Profile APIs are enabled and access is approved)"
        : ""
    throw new GoogleApiError(
      `Google ${res.status}${code ? ` ${code}` : ""}: ${detail || res.statusText}${hint}`.slice(
        0,
        500,
      ),
      res.status,
      res.status === 429 || res.status >= 500,
      reauth,
    )
  }
  return schema.parse(body)
}

// ─── OAuth ─────────────────────────────────────────────────────────────────────

export interface GoogleClient {
  clientId: string
  clientSecret: string
}

let signInClient: GoogleClient | null = null

/**
 * Registers the sign-in OAuth client (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) as the fallback
 * for Business Profile + YouTube connections, so one Google client covers everything. Call
 * once at startup in every process that talks to Google (api and worker).
 */
export function setSignInGoogleClient(clientId: string, clientSecret: string): void {
  signInClient = clientId && clientSecret ? { clientId, clientSecret } : null
}

/** Whether a sign-in client is registered (connections can work with no Settings input). */
export function hasSignInGoogleClient(): boolean {
  return signInClient !== null
}

/**
 * The OAuth client for Business Profile + YouTube: Settings → Connections → Google when both
 * fields are set, else the sign-in client, else null. Keep using the same one once accounts are
 * connected: refresh tokens only work with the client that issued them.
 */
export async function loadGoogleClient(
  prisma: PrismaClient,
  keyring: Keyring,
  organizationId: string,
): Promise<GoogleClient | null> {
  const connections = await loadSettingsSection(prisma, organizationId, "connections")
  const clientSecret = await loadSettingsSecret(
    prisma,
    keyring,
    organizationId,
    "connections",
    "googleClientSecret",
  )
  if (connections.google.clientId && clientSecret) {
    return { clientId: connections.google.clientId, clientSecret }
  }
  return signInClient
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

export function googleAuthUrl(args: {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
  /** Defaults to Business Profile; YouTube passes its own scope. */
  scope?: string
  loginHint?: string | undefined
}): string {
  const params = new URLSearchParams({
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    response_type: "code",
    scope: args.scope ?? GBP_SCOPE,
    access_type: "offline",
    // Without consent, a repeat connection gets no refresh token.
    prompt: "consent",
    include_granted_scopes: "true",
    state: args.state,
    code_challenge: args.codeChallenge,
    code_challenge_method: "S256",
    ...(args.loginHint ? { login_hint: args.loginHint } : {}),
  })
  return `${AUTH_URL}?${params}`
}

export function exchangeGoogleCode(
  client: GoogleClient,
  args: { code: string; redirectUri: string; codeVerifier: string },
): Promise<GoogleToken> {
  return call(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: args.code,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: args.redirectUri,
        grant_type: "authorization_code",
        code_verifier: args.codeVerifier,
      }),
    },
    googleTokenSchema,
  )
}

function refreshGoogleToken(client: GoogleClient, refreshToken: string): Promise<GoogleToken> {
  return call(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        grant_type: "refresh_token",
      }),
    },
    googleTokenSchema,
  )
}

/** Best effort: revoking a token that's already invalid is fine. */
export async function revokeGoogleToken(token: string): Promise<void> {
  await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => undefined)
}

// ─── Token storage ─────────────────────────────────────────────────────────────

/** AAD binds a token to its org, platform and account (known before the row exists). */
export function tokenAad(
  organizationId: string,
  account: { platform: string; externalId: string },
  kind: "access" | "refresh",
): string {
  return aadFor(
    organizationId,
    "platform_account",
    `${account.platform}:${account.externalId}:${kind}`,
  )
}

export function encryptTokens(
  keyring: Keyring,
  organizationId: string,
  account: { platform: string; externalId: string },
  token: GoogleToken,
  now = new Date(),
) {
  return {
    accessTokenEnc: keyring.encrypt(
      token.access_token,
      tokenAad(organizationId, account, "access"),
    ),
    ...(token.refresh_token
      ? {
          refreshTokenEnc: keyring.encrypt(
            token.refresh_token,
            tokenAad(organizationId, account, "refresh"),
          ),
        }
      : {}),
    tokenExpiresAt: new Date(now.getTime() + token.expires_in * 1000),
    scopes: token.scope ? token.scope.split(" ") : [],
  }
}

/**
 * A valid access token for a Google account row, refreshing (and storing) it when it's about
 * to expire. A revoked/expired refresh token marks the account `error` ("reconnect").
 */
export async function googleAccessToken(
  prisma: PrismaClient,
  keyring: Keyring,
  account: PlatformAccount,
  now = new Date(),
): Promise<string> {
  const org = account.organizationId
  if (
    account.accessTokenEnc &&
    account.tokenExpiresAt &&
    account.tokenExpiresAt.getTime() - EXPIRY_SKEW_MS > now.getTime()
  ) {
    return keyring.decrypt(account.accessTokenEnc, tokenAad(org, account, "access"))
  }
  if (!account.refreshTokenEnc) {
    throw new GoogleApiError("No refresh token stored: reconnect this account", 401, false, true)
  }
  const client = await loadGoogleClient(prisma, keyring, org)
  if (!client) {
    throw new GoogleApiError(
      "No Google OAuth client: set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET or add one in Settings → Connections",
      0,
      false,
    )
  }
  const refreshToken = keyring.decrypt(account.refreshTokenEnc, tokenAad(org, account, "refresh"))
  let token: GoogleToken
  try {
    token = await refreshGoogleToken(client, refreshToken)
  } catch (err) {
    if (err instanceof GoogleApiError && err.reauth) {
      await prisma.platformAccount.update({
        where: { id: account.id },
        data: {
          status: "error",
          lastError: "Google access was revoked or expired. Reconnect this account.",
          lastErrorAt: now,
        },
      })
    }
    throw err
  }
  const data = encryptTokens(keyring, org, account, token, now)
  await prisma.platformAccount.update({
    where: { id: account.id },
    data: {
      accessTokenEnc: data.accessTokenEnc,
      tokenExpiresAt: data.tokenExpiresAt,
      ...(account.status === "expiring" ? { status: "connected" } : {}),
    },
  })
  return token.access_token
}

// ─── API calls ─────────────────────────────────────────────────────────────────

const auth = (token: string) => ({ authorization: `Bearer ${token}` })

export async function listGbpAccounts(token: string) {
  const accounts: { name: string; accountName: string | null }[] = []
  let pageToken: string | undefined
  do {
    const url = new URL(ACCOUNTS_URL)
    url.searchParams.set("pageSize", "20")
    if (pageToken) url.searchParams.set("pageToken", pageToken)
    const page = await call(url.toString(), { headers: auth(token) }, gbpAccountListSchema)
    for (const a of page.accounts ?? []) {
      accounts.push({ name: a.name, accountName: a.accountName ?? null })
    }
    pageToken = page.nextPageToken
  } while (pageToken && accounts.length < 500)
  return accounts
}

export async function listGbpLocations(token: string, accountName: string): Promise<GbpLocation[]> {
  const locations: GbpLocation[] = []
  let pageToken: string | undefined
  do {
    const url = new URL(`${LOCATIONS_URL}/${accountName}/locations`)
    url.searchParams.set("readMask", "name,title,storeCode,metadata")
    url.searchParams.set("pageSize", "100")
    if (pageToken) url.searchParams.set("pageToken", pageToken)
    const page = await call(url.toString(), { headers: auth(token) }, gbpLocationListSchema)
    locations.push(...(page.locations ?? []))
    pageToken = page.nextPageToken
  } while (pageToken && locations.length < 2000)
  return locations
}

/** v4 path for a location: `accounts/{a}/locations/{l}`. */
export function v4LocationPath(accountName: string, locationName: string): string {
  return `${accountName}/${locationName}`
}

export function listGbpReviews(
  token: string,
  args: {
    baseUrl: string
    locationPath: string
    pageToken?: string | undefined
    signal?: AbortSignal
  },
) {
  const url = new URL(`${args.baseUrl}/${args.locationPath}/reviews`)
  url.searchParams.set("pageSize", "50")
  url.searchParams.set("orderBy", "updateTime desc")
  if (args.pageToken) url.searchParams.set("pageToken", args.pageToken)
  return call(url.toString(), { headers: auth(token) }, gbpReviewListSchema, args.signal)
}

/** Creates or replaces the owner reply (idempotent). */
export function putGbpReply(
  token: string,
  args: { baseUrl: string; reviewName: string; comment: string },
) {
  return call(
    `${args.baseUrl}/${args.reviewName}/reply`,
    {
      method: "PUT",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({ comment: args.comment }),
    },
    gbpReviewReplySchema,
  )
}

/** Turns on NEW_REVIEW / UPDATED_REVIEW notifications to a Pub/Sub topic for one account. */
export function setGbpNotifications(
  token: string,
  args: { baseUrl: string; accountName: string; topic: string },
) {
  const url = new URL(`${args.baseUrl}/${args.accountName}/notificationSetting`)
  url.searchParams.set("updateMask", "pubsubTopic,notificationTypes")
  return call(
    url.toString(),
    {
      method: "PATCH",
      headers: { ...auth(token), "content-type": "application/json" },
      body: JSON.stringify({
        name: `${args.accountName}/notificationSetting`,
        pubsubTopic: args.topic,
        notificationTypes: ["NEW_REVIEW", "UPDATED_REVIEW"],
      }),
    },
    gbpReviewReplySchema.partial().loose(),
  )
}

// ─── Reviews sync ──────────────────────────────────────────────────────────────

const MAX_REVIEW_PAGES = 20
const DAY_MS = 86_400_000

function gbpMeta(meta: unknown): { accountName?: string; mapsUri?: string } {
  return meta && typeof meta === "object"
    ? (meta as { accountName?: string; mapsUri?: string })
    : {}
}

/**
 * Reviews updated since the cursor (or `backfillDays` on the first run), oldest first, and the
 * new cursor. The API only sorts newest-first, so it pages down until it reaches the cursor.
 */
export async function fetchNewGbpReviews(
  prisma: PrismaClient,
  keyring: Keyring,
  args: {
    account: PlatformAccount
    cursor: string | null
    backfillDays: number
    signal?: AbortSignal
    now?: Date
  },
): Promise<{ items: NormalizedItem[]; cursor: string | undefined; complete: boolean }> {
  const { account } = args
  const meta = gbpMeta(account.meta)
  if (!meta.accountName)
    throw new Error("Missing the Google account for this location: reconnect it")
  const token = await googleAccessToken(prisma, keyring, account)
  const { google } = await loadSettingsSection(prisma, account.organizationId, "connections")
  const since = args.cursor
    ? new Date(args.cursor)
    : new Date((args.now ?? new Date()).getTime() - args.backfillDays * DAY_MS)

  const items: NormalizedItem[] = []
  let newest = args.cursor ? new Date(args.cursor) : null
  let pageToken: string | undefined
  let pages = 0
  let reachedCursor = false
  do {
    const page = await listGbpReviews(token, {
      baseUrl: google.reviewsBaseUrl,
      locationPath: v4LocationPath(meta.accountName, account.externalId),
      pageToken,
      ...(args.signal ? { signal: args.signal } : {}),
    })
    pages++
    for (const review of page.reviews ?? []) {
      const updated = new Date(review.updateTime ?? review.createTime)
      if (updated <= since) {
        reachedCursor = true
        break
      }
      if (!newest || updated > newest) newest = updated
      items.push(normalizeGbpReview(review, { mapsUri: meta.mapsUri }))
    }
    pageToken = page.nextPageToken
  } while (pageToken && !reachedCursor && pages < MAX_REVIEW_PAGES)

  // Pages run newest-first, so an early stop (over 1,000 reviews since the cursor, i.e. a huge
  // first backfill) leaves only *older* reviews unseen: skip those rather than refetch forever.
  const complete = !pageToken || reachedCursor
  items.reverse()
  return {
    items,
    cursor: newest?.toISOString(),
    complete,
  }
}
