/**
 * LinkedIn Community Management API (PLAN §11, Phase 9): OAuth, token storage and refresh,
 * Company Page lookup, comment sync and replies, webhook signatures. Plain fetch + zod.
 * Checked against the 202610 docs on 2026-11-15.
 *
 * Comments are found through the Page's social action notifications: pushed to
 * `/webhooks/linkedin`, or pulled from `organizationalEntityNotifications` (60-day lookback) on
 * the reconcile schedule. Each notification names a comment URN, which is then read with one
 * GET. This costs far fewer calls than listing every post's comments, which matters on the
 * Development tier (500 calls/app/day).
 */
import { createHmac, timingSafeEqual } from "node:crypto"
import type { z } from "zod"
import {
  LINKEDIN_API_BASE,
  LINKEDIN_AUTH_URL,
  LINKEDIN_COMMENT_ACTIONS,
  LINKEDIN_SCOPES,
  LINKEDIN_TOKEN_URL,
  commentUrnOf,
  linkedinCommentSchema,
  linkedinErrorSchema,
  linkedinNotificationListSchema,
  linkedinOrgAclListSchema,
  linkedinOrganizationSchema,
  linkedinPersonSchema,
  linkedinTokenSchema,
  normalizeLiComment,
  orgIdOf,
  orgUrn,
  parseCommentUrn,
  type LinkedinComment,
  type LinkedinNotification,
  type LinkedinToken,
  type NormalizedItem,
} from "@inbox/core"
import type { Keyring } from "@inbox/core/crypto"
import type { PlatformAccount, PrismaClient } from "@inbox/db"
import { tokenAad } from "./google"
import { loadSettingsSection, loadSettingsSecret } from "./settings"

const TIMEOUT_MS = 15_000
const DAY_MS = 86_400_000
/** LinkedIn keeps notifications for 60 days. */
const MAX_LOOKBACK_DAYS = 60
/** Refresh well before the 60-day access token runs out (and before the expiry warning). */
const REFRESH_BEFORE_MS = 14 * DAY_MS
const NOTIFICATION_PAGE = 100
const MAX_NOTIFICATION_PAGES = 5

export class LinkedinApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Retrying later may work (429, 5xx, network). */
    readonly retryable: boolean,
    /** The member must connect again (expired/revoked token). */
    readonly reauth = false,
  ) {
    super(message)
    this.name = "LinkedinApiError"
  }
}

// ─── App credentials ───────────────────────────────────────────────────────────

export interface LinkedinApp {
  clientId: string
  clientSecret: string
  /** `LinkedIn-Version` header (YYYYMM). */
  version: string
  /** Developer application ID, for webhook subscriptions. Empty = not set. */
  appId: string
}

/** Settings → Connections → LinkedIn, or null when the client ID or secret is missing. */
export async function loadLinkedinApp(
  prisma: PrismaClient,
  keyring: Keyring,
  organizationId: string,
): Promise<LinkedinApp | null> {
  const { linkedin } = await loadSettingsSection(prisma, organizationId, "connections")
  const clientSecret = await loadSettingsSecret(
    prisma,
    keyring,
    organizationId,
    "connections",
    "linkedinClientSecret",
  )
  if (!linkedin.clientId || !clientSecret) return null
  return {
    clientId: linkedin.clientId,
    clientSecret,
    version: linkedin.apiVersion,
    appId: linkedin.appId,
  }
}

// ─── HTTP ──────────────────────────────────────────────────────────────────────

function errorFrom(status: number, body: unknown, statusText: string): LinkedinApiError {
  const parsed = linkedinErrorSchema.safeParse(body)
  const e = parsed.success ? parsed.data : null
  const detail = e?.error_description ?? e?.message ?? e?.error ?? statusText
  const code = e?.code ?? e?.error ?? ""
  const reauth =
    status === 401 || /invalid_grant|expired|revoked/i.test(`${code} ${e?.error_description}`)
  const hint =
    status === 403
      ? " (check the app has Community Management API access and you're a Page super admin)"
      : status === 429
        ? " (LinkedIn rate limit: Development tier apps get 500 calls/day)"
        : status === 426 || /version/i.test(detail)
          ? " (check the LinkedIn API version in Settings → Connections)"
          : ""
  return new LinkedinApiError(
    `LinkedIn ${status}${code ? ` ${code}` : ""}: ${detail}${hint}`.slice(0, 500),
    status,
    status === 429 || status >= 500,
    reauth,
  )
}

async function send(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
        : AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    throw new LinkedinApiError(`LinkedIn didn't respond: ${(err as Error).message}`, 0, true)
  }
}

export interface LinkedinCallContext {
  token: string
  version: string
}

/**
 * Rest.li 2.0 wants URNs in paths and query values fully encoded, parentheses included
 * (`encodeURIComponent` leaves `(` `)` alone).
 */
export const restliEncode = (s: string) =>
  encodeURIComponent(s).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

async function rest<T>(
  ctx: LinkedinCallContext,
  /** Path and query under `/rest`, already encoded. */
  path: string,
  schema: z.ZodType<T>,
  init: { method?: string; body?: unknown; signal?: AbortSignal | undefined } = {},
): Promise<T> {
  const res = await send(
    `${LINKEDIN_API_BASE}/${path}`,
    {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${ctx.token}`,
        "linkedin-version": ctx.version,
        "x-restli-protocol-version": "2.0.0",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    },
    init.signal,
  )
  const body: unknown = await res.json().catch(() => ({}))
  if (!res.ok) throw errorFrom(res.status, body, res.statusText)
  return schema.parse(body)
}

// ─── OAuth ─────────────────────────────────────────────────────────────────────

export function linkedinAuthUrl(
  app: Pick<LinkedinApp, "clientId">,
  args: { redirectUri: string; state: string },
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: app.clientId,
    redirect_uri: args.redirectUri,
    state: args.state,
    scope: LINKEDIN_SCOPES.join(" "),
  })
  return `${LINKEDIN_AUTH_URL}?${params}`
}

async function tokenRequest(params: Record<string, string>): Promise<LinkedinToken> {
  const res = await send(LINKEDIN_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  })
  const body: unknown = await res.json().catch(() => ({}))
  if (!res.ok) throw errorFrom(res.status, body, res.statusText)
  return linkedinTokenSchema.parse(body)
}

export function exchangeLinkedinCode(
  app: LinkedinApp,
  args: { code: string; redirectUri: string },
): Promise<LinkedinToken> {
  return tokenRequest({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: app.clientId,
    client_secret: app.clientSecret,
  })
}

/** Scopes from LINKEDIN_SCOPES missing from what the member granted. */
export function missingLinkedinScopes(token: Pick<LinkedinToken, "scope">): string[] {
  if (!token.scope) return []
  const granted = new Set(token.scope.split(/[\s,]+/))
  return LINKEDIN_SCOPES.filter((s) => !granted.has(s))
}

// ─── Token storage ─────────────────────────────────────────────────────────────

export function encryptLinkedinTokens(
  keyring: Keyring,
  organizationId: string,
  account: { platform: string; externalId: string },
  token: LinkedinToken,
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
    scopes: token.scope ? token.scope.split(/[\s,]+/).filter(Boolean) : [],
  }
}

/** Marks the account `error` when LinkedIn says the grant is gone. */
export async function markLinkedinReauth(
  prisma: PrismaClient,
  account: Pick<PlatformAccount, "id">,
  err: unknown,
) {
  if (!(err instanceof LinkedinApiError && err.reauth)) return
  await prisma.platformAccount.update({
    where: { id: account.id },
    data: {
      status: "error",
      lastError: "LinkedIn access was revoked or expired. Reconnect this Page.",
      lastErrorAt: new Date(),
    },
  })
}

/**
 * A call context for a LinkedIn Page row: its access token, refreshed (and stored) when it
 * expires within two weeks and the app has programmatic refresh tokens. Without a refresh
 * token, the 60-day token is used until it expires (the expiry check warns before that).
 */
export async function linkedinContext(
  prisma: PrismaClient,
  keyring: Keyring,
  account: PlatformAccount,
  now = new Date(),
): Promise<LinkedinCallContext & { app: LinkedinApp; orgUrn: string }> {
  const org = account.organizationId
  const app = await loadLinkedinApp(prisma, keyring, org)
  if (!app) {
    throw new LinkedinApiError(
      "The LinkedIn client ID or secret was removed from Settings → Connections",
      0,
      false,
    )
  }
  if (!account.accessTokenEnc) {
    throw new LinkedinApiError("No token stored: reconnect this Page", 401, false, true)
  }
  const base = { app, version: app.version, orgUrn: orgUrn(account.externalId) }
  const fresh =
    !account.tokenExpiresAt || account.tokenExpiresAt.getTime() - REFRESH_BEFORE_MS > now.getTime()
  if (fresh || !account.refreshTokenEnc) {
    if (account.tokenExpiresAt && account.tokenExpiresAt <= now) {
      const err = new LinkedinApiError(
        "The LinkedIn token expired: reconnect this Page",
        401,
        false,
        true,
      )
      await markLinkedinReauth(prisma, account, err)
      throw err
    }
    return {
      ...base,
      token: keyring.decrypt(account.accessTokenEnc, tokenAad(org, account, "access")),
    }
  }

  const refreshToken = keyring.decrypt(account.refreshTokenEnc, tokenAad(org, account, "refresh"))
  let token: LinkedinToken
  try {
    token = await tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: app.clientId,
      client_secret: app.clientSecret,
    })
  } catch (err) {
    // LinkedIn reports an expired refresh token as 400 invalid_request.
    if (err instanceof LinkedinApiError && err.status === 400) {
      const reauth = new LinkedinApiError(err.message, 401, false, true)
      await markLinkedinReauth(prisma, account, reauth)
      throw reauth
    }
    throw err
  }
  const data = encryptLinkedinTokens(keyring, org, account, token, now)
  await prisma.platformAccount.update({
    where: { id: account.id },
    data: {
      accessTokenEnc: data.accessTokenEnc,
      ...(data.refreshTokenEnc ? { refreshTokenEnc: data.refreshTokenEnc } : {}),
      tokenExpiresAt: data.tokenExpiresAt,
      ...(account.status === "expiring" ? { status: "connected" } : {}),
    },
  })
  return { ...base, token: token.access_token }
}

// ─── Pages ─────────────────────────────────────────────────────────────────────

/**
 * Company Pages the member administers (approved ADMINISTRATOR role), and the member's own
 * person URN (needed to subscribe webhooks).
 */
export async function listAdministeredOrgs(
  ctx: LinkedinCallContext,
): Promise<{ orgIds: string[]; personUrn: string | null }> {
  const orgIds = new Set<string>()
  let personUrn: string | null = null
  for (let start = 0, page = 0; page < 10; page++, start += 100) {
    const res = await rest(
      ctx,
      `organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&start=${start}&count=100`,
      linkedinOrgAclListSchema,
    )
    for (const el of res.elements) {
      const id = orgIdOf(el.organization ?? el.organizationTarget ?? "")
      if (id) orgIds.add(id)
      personUrn ??= el.roleAssignee ?? null
    }
    if (res.elements.length < 100) break
  }
  return { orgIds: [...orgIds], personUrn }
}

export function getLinkedinOrganization(ctx: LinkedinCallContext, id: string) {
  return rest(ctx, `organizations/${encodeURIComponent(id)}`, linkedinOrganizationSchema)
}

export const linkedinPageUrl = (o: { id: string | number; vanityName?: string | undefined }) =>
  o.vanityName
    ? `https://www.linkedin.com/company/${encodeURIComponent(o.vanityName)}/`
    : `https://www.linkedin.com/company/${encodeURIComponent(String(o.id))}/`

/** A cheap read that proves the token and Page access work. */
export async function testLinkedinAccount(
  ctx: LinkedinCallContext,
  orgId: string,
): Promise<string> {
  const o = await getLinkedinOrganization(ctx, orgId)
  await rest(
    ctx,
    `organizationalEntityNotifications?q=criteria&actions=List(COMMENT)&organizationalEntity=${restliEncode(orgUrn(orgId))}&count=1`,
    linkedinNotificationListSchema,
  )
  return `Connected to ${o.localizedName ?? `Page ${orgId}`}. Comment notifications are readable.`
}

// ─── Comments ──────────────────────────────────────────────────────────────────

/** Comment notifications for a Page since `since` (inclusive), oldest first. */
export async function listLinkedinCommentNotifications(
  ctx: LinkedinCallContext,
  args: { orgUrn: string; since: Date; signal?: AbortSignal | undefined },
): Promise<LinkedinNotification[]> {
  const out: LinkedinNotification[] = []
  const actions = `List(${LINKEDIN_COMMENT_ACTIONS.join(",")})`
  const range = `(start:${args.since.getTime()})`
  for (let page = 0; page < MAX_NOTIFICATION_PAGES; page++) {
    const res = await rest(
      ctx,
      `organizationalEntityNotifications?q=criteria&actions=${actions}` +
        `&organizationalEntity=${restliEncode(args.orgUrn)}&timeRange=${range}` +
        `&start=${page * NOTIFICATION_PAGE}&count=${NOTIFICATION_PAGE}`,
      linkedinNotificationListSchema,
      { signal: args.signal },
    )
    out.push(...res.elements)
    if (res.elements.length < NOTIFICATION_PAGE) break
  }
  return out
    .filter((n) => n.lastModifiedAt >= args.since.getTime())
    .sort((a, b) => a.lastModifiedAt - b.lastModifiedAt)
}

/** One comment by URN, or null when it was deleted. */
export async function getLinkedinComment(
  ctx: LinkedinCallContext,
  commentUrn: string,
  signal?: AbortSignal,
): Promise<LinkedinComment | null> {
  const parts = parseCommentUrn(commentUrn)
  if (!parts) return null
  try {
    return await rest(
      ctx,
      `socialActions/${restliEncode(parts.thread)}/comments/${parts.id}`,
      linkedinCommentSchema,
      { signal },
    )
  } catch (err) {
    if (err instanceof LinkedinApiError && err.status === 404) return null
    throw err
  }
}

/**
 * Member display names. LinkedIn only returns other members' profiles to some apps, so this
 * is best effort: after one refusal it stops asking for an hour.
 */
const nameCache = new Map<string, string | null>()
let profilesRefusedAt = 0

async function memberName(ctx: LinkedinCallContext, personUrn: string): Promise<string | null> {
  if (nameCache.has(personUrn)) return nameCache.get(personUrn) ?? null
  const id = /^urn:li:person:(.+)$/.exec(personUrn)?.[1]
  if (!id || Date.now() - profilesRefusedAt < 3_600_000) return null
  let name: string | null = null
  try {
    const p = await rest(ctx, `people/(id:${restliEncode(id)})`, linkedinPersonSchema)
    name = [p.localizedFirstName, p.localizedLastName].filter(Boolean).join(" ") || null
  } catch (err) {
    if (err instanceof LinkedinApiError && (err.status === 403 || err.status === 401)) {
      profilesRefusedAt = Date.now()
      return null
    }
    if (err instanceof LinkedinApiError && err.retryable) return null
  }
  if (nameCache.size > 5000) nameCache.clear()
  nameCache.set(personUrn, name)
  return name
}

/**
 * Reads the comments behind a batch of notifications (from the webhook or the pull API) and
 * normalizes them. Deleted comments are skipped; a reply's parent is read (once) to tell
 * whether it answers one of our own comments.
 */
export async function linkedinItemsFromNotifications(
  ctx: LinkedinCallContext,
  args: { orgUrn: string; notifications: LinkedinNotification[]; signal?: AbortSignal },
): Promise<NormalizedItem[]> {
  const comments = new Map<string, LinkedinComment | null>()
  const load = async (urn: string) => {
    if (!comments.has(urn)) comments.set(urn, await getLinkedinComment(ctx, urn, args.signal))
    return comments.get(urn) ?? null
  }

  const items: NormalizedItem[] = []
  const done = new Set<string>()
  for (const n of args.notifications) {
    if (!(LINKEDIN_COMMENT_ACTIONS as readonly string[]).includes(n.action)) continue
    if (n.organizationalEntity !== args.orgUrn) continue
    const urn = n.generatedActivity
    if (!urn || done.has(urn)) continue
    done.add(urn)
    const c = await load(urn)
    if (!c) continue
    const ours = c.actor === args.orgUrn
    const parent = c.parentComment ? await load(c.parentComment) : null
    items.push(
      normalizeLiComment(c, {
        orgUrn: args.orgUrn,
        authorName: ours ? null : await memberName(ctx, c.actor),
        parentIsOurs: parent?.actor === args.orgUrn,
      }),
    )
  }
  return items
}

/** Reconcile: comments whose notifications arrived after the cursor (or the backfill window). */
export async function fetchNewLinkedinComments(
  ctx: LinkedinCallContext,
  args: {
    orgUrn: string
    cursor: string | null
    backfillDays: number
    signal?: AbortSignal
    now?: Date
  },
): Promise<{ items: NormalizedItem[]; cursor: string | undefined }> {
  const now = args.now ?? new Date()
  const floor = new Date(now.getTime() - MAX_LOOKBACK_DAYS * DAY_MS + 60_000)
  const fromCursor = args.cursor ? new Date(new Date(args.cursor).getTime() + 1) : null
  const since = new Date(
    Math.max(
      (fromCursor ?? new Date(now.getTime() - args.backfillDays * DAY_MS)).getTime(),
      floor.getTime(),
    ),
  )
  const notifications = await listLinkedinCommentNotifications(ctx, {
    orgUrn: args.orgUrn,
    since,
    signal: args.signal,
  })
  const items = await linkedinItemsFromNotifications(ctx, {
    orgUrn: args.orgUrn,
    notifications,
    ...(args.signal ? { signal: args.signal } : {}),
  })
  const newest = notifications.at(-1)?.lastModifiedAt
  return { items, cursor: newest ? new Date(newest).toISOString() : undefined }
}

/**
 * Replies as the Page. LinkedIn nests one level: a reply to a nested comment goes under its
 * top-level comment (`parentComment` must be a first-level comment).
 */
export async function createLinkedinReply(
  ctx: LinkedinCallContext,
  args: { orgUrn: string; postUrn: string; parentCommentUrn: string; text: string },
): Promise<{ commentUrn: string }> {
  const res = await rest(
    ctx,
    `socialActions/${restliEncode(args.parentCommentUrn)}/comments`,
    linkedinCommentSchema,
    {
      method: "POST",
      body: {
        actor: args.orgUrn,
        object: args.postUrn,
        parentComment: args.parentCommentUrn,
        message: { text: args.text },
      },
    },
  )
  return { commentUrn: commentUrnOf(res) }
}

// ─── Webhooks ──────────────────────────────────────────────────────────────────

/** Subscribes the member's Page notifications to our webhook (needs the developer app ID). */
export async function subscribeLinkedinWebhook(
  ctx: LinkedinCallContext,
  args: { appId: string; personUrn: string; orgUrn: string; webhookUrl: string },
): Promise<void> {
  const key =
    `(developerApplication:${restliEncode(`urn:li:developerApplication:${args.appId}`)},` +
    `user:${restliEncode(args.personUrn)},entity:${restliEncode(args.orgUrn)},` +
    `eventType:ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS)`
  const res = await send(`${LINKEDIN_API_BASE}/eventSubscriptions/${key}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${ctx.token}`,
      "linkedin-version": ctx.version,
      "x-restli-protocol-version": "2.0.0",
      "content-type": "application/json",
    },
    body: JSON.stringify({ webhook: args.webhookUrl }),
  })
  if (!res.ok) {
    throw errorFrom(res.status, await res.json().catch(() => ({})), res.statusText)
  }
}

/** Validation GET: hex(HMAC-SHA256(challengeCode, clientSecret)). */
export function linkedinChallengeResponse(challengeCode: string, clientSecret: string): string {
  return createHmac("sha256", clientSecret).update(challengeCode).digest("hex")
}

/** `X-LI-Signature` = hex(HMAC-SHA256("hmacsha256=" + rawBody, clientSecret)). */
export function signLinkedinBody(rawBody: string | Uint8Array, clientSecret: string): string {
  return createHmac("sha256", clientSecret).update("hmacsha256=").update(rawBody).digest("hex")
}

export function verifyLinkedinSignature(
  rawBody: string | Uint8Array,
  header: string | null | undefined,
  clientSecret: string,
): boolean {
  if (!header || !/^[0-9a-f]{64}$/i.test(header)) return false
  const expected = Buffer.from(signLinkedinBody(rawBody, clientSecret), "hex")
  const given = Buffer.from(header, "hex")
  return given.length === expected.length && timingSafeEqual(given, expected)
}
