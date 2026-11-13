/**
 * Meta Graph API client for Facebook Pages and the Instagram accounts linked to them
 * ("Instagram API with Facebook Login"): OAuth, Page tokens, webhook signatures, reconcile
 * reads, and replies. Plain fetch + zod. Facts re-verified 2026-11-13 (PLAN §11).
 *
 * Tokens: a long-lived user token yields Page tokens that don't expire. Each Page row and each
 * linked Instagram row stores its Page token (Instagram calls go through the Page).
 */
import { createHmac, timingSafeEqual } from "node:crypto"
import type { z } from "zod"
import {
  META_PAGE_FIELDS,
  META_SCOPES,
  fbCommentListSchema,
  fbPostListSchema,
  igCommentListSchema,
  igMediaListSchema,
  metaConversationListSchema,
  metaErrorSchema,
  metaIdSchema,
  metaPageListSchema,
  metaPermissionsSchema,
  metaProfileSchema,
  metaSendSchema,
  metaSubscribedAppsSchema,
  metaSuccessSchema,
  metaTokenSchema,
  normalizeFbCommentNode,
  normalizeIgCommentNode,
  normalizeMetaConversationMessage,
  type MetaPage,
  type MetaToken,
  type NormalizedItem,
} from "@inbox/core"
import type { Keyring } from "@inbox/core/crypto"
import type { PlatformAccount, PrismaClient } from "@inbox/db"
import { tokenAad } from "./google"
import { loadSettingsSection, loadSettingsSecret } from "./settings"

const GRAPH = "https://graph.facebook.com"
const DIALOG = "https://www.facebook.com"
const TIMEOUT_MS = 15_000
const DAY_MS = 86_400_000

export class MetaApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Retrying later may work (rate limits, 5xx, network). */
    readonly retryable: boolean,
    /** The token is invalid: reconnect. */
    readonly reauth = false,
    readonly code: number | null = null,
    readonly subcode: number | null = null,
  ) {
    super(message)
    this.name = "MetaApiError"
  }
}

/** Graph error codes for throttling (application, user, page, and per-call limits). */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001, 80002, 80005, 80006])

function hintFor(code: number | null, subcode: number | null): string {
  if (code === 190) return " (the access was revoked or expired: reconnect)"
  if (subcode === 2018278 || code === 551)
    return " (outside the messaging window, or the person can't be messaged)"
  if (code === 200 || code === 10 || (code !== null && code >= 200 && code < 300))
    return " (a permission is missing: check App Review / the permissions you granted)"
  if (code !== null && RATE_LIMIT_CODES.has(code)) return " (rate limited: it retries later)"
  return ""
}

export interface MetaApp {
  appId: string
  appSecret: string
  version: string
  /** Facebook Login for Business configuration id (optional; replaces `scope`). */
  loginConfigId: string
}

async function call<T>(
  url: URL,
  init: RequestInit & { token?: string; app?: MetaApp | null },
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (init.token) {
    url.searchParams.set("access_token", init.token)
    // appsecret_proof: required when the app has "Require App Secret" on, harmless otherwise.
    if (init.app) url.searchParams.set("appsecret_proof", appSecretProof(init.token, init.app))
  }
  let res: Response
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      ...(init.headers ? { headers: init.headers } : {}),
      ...(init.body ? { body: init.body } : {}),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
        : AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    throw new MetaApiError(`Meta didn't respond: ${(err as Error).message}`, 0, true)
  }
  const body: unknown = await res.json().catch(() => ({}))
  if (!res.ok) {
    const parsed = metaErrorSchema.safeParse(body)
    const e = parsed.success ? parsed.data.error : null
    const code = e?.code ?? null
    const subcode = e?.error_subcode ?? null
    const retryable = res.status >= 500 || (code !== null && RATE_LIMIT_CODES.has(code))
    throw new MetaApiError(
      `Meta ${res.status}${code !== null ? ` (#${code}${subcode ? `/${subcode}` : ""})` : ""}: ${
        e?.message ?? res.statusText
      }${hintFor(code, subcode)}`.slice(0, 500),
      res.status,
      retryable,
      code === 190,
      code,
      subcode,
    )
  }
  return schema.parse(body)
}

const graph = (version: string, path: string) => new URL(`${GRAPH}/${version}/${path}`)

export function appSecretProof(token: string, app: Pick<MetaApp, "appSecret">): string {
  return createHmac("sha256", app.appSecret).update(token).digest("hex")
}

// ─── App credentials and webhooks ──────────────────────────────────────────────

/** Settings → Connections → Meta app, or null when it isn't set up. */
export async function loadMetaApp(
  prisma: PrismaClient,
  keyring: Keyring,
  organizationId: string,
): Promise<MetaApp | null> {
  const { meta } = await loadSettingsSection(prisma, organizationId, "connections")
  const appSecret = await loadSettingsSecret(
    prisma,
    keyring,
    organizationId,
    "connections",
    "metaAppSecret",
  )
  if (!meta.appId || !appSecret) return null
  return {
    appId: meta.appId,
    appSecret,
    version: meta.graphApiVersion,
    loginConfigId: meta.loginConfigId,
  }
}

/** `X-Hub-Signature-256: sha256=<hex HMAC of the raw body with the app secret>`. */
export function verifyMetaSignature(
  rawBody: string | Uint8Array,
  header: string | null | undefined,
  appSecret: string,
): boolean {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header ?? "")
  if (!m) return false
  const expected = createHmac("sha256", appSecret).update(rawBody).digest()
  const given = Buffer.from(m[1]!, "hex")
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export function signMetaBody(rawBody: string, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`
}

// ─── OAuth ─────────────────────────────────────────────────────────────────────

export function metaAuthUrl(app: MetaApp, args: { redirectUri: string; state: string }): string {
  const url = new URL(`${DIALOG}/${app.version}/dialog/oauth`)
  url.searchParams.set("client_id", app.appId)
  url.searchParams.set("redirect_uri", args.redirectUri)
  url.searchParams.set("state", args.state)
  url.searchParams.set("response_type", "code")
  if (app.loginConfigId) {
    url.searchParams.set("config_id", app.loginConfigId)
  } else {
    url.searchParams.set("scope", META_SCOPES.join(","))
    // Re-ask for permissions declined on an earlier attempt.
    url.searchParams.set("auth_type", "rerequest")
  }
  return url.toString()
}

/** Code → short-lived user token → long-lived user token (~60 days). */
export async function exchangeMetaCode(
  app: MetaApp,
  args: { code: string; redirectUri: string },
): Promise<MetaToken> {
  const url = graph(app.version, "oauth/access_token")
  url.searchParams.set("client_id", app.appId)
  url.searchParams.set("client_secret", app.appSecret)
  url.searchParams.set("redirect_uri", args.redirectUri)
  url.searchParams.set("code", args.code)
  const short = await call(url, {}, metaTokenSchema)
  const ll = graph(app.version, "oauth/access_token")
  ll.searchParams.set("grant_type", "fb_exchange_token")
  ll.searchParams.set("client_id", app.appId)
  ll.searchParams.set("client_secret", app.appSecret)
  ll.searchParams.set("fb_exchange_token", short.access_token)
  return call(ll, {}, metaTokenSchema)
}

/** Permissions the person declined on the consent screen. */
export async function declinedMetaPermissions(app: MetaApp, userToken: string) {
  const res = await call(
    graph(app.version, "me/permissions"),
    { token: userToken, app },
    metaPermissionsSchema,
  )
  const granted = new Set(res.data.filter((p) => p.status === "granted").map((p) => p.permission))
  return META_SCOPES.filter((s) => !granted.has(s))
}

/** Pages the person manages, with Page tokens and any linked Instagram professional account. */
export async function listManagedPages(app: MetaApp, userToken: string): Promise<MetaPage[]> {
  const pages: MetaPage[] = []
  let url: URL | null = graph(app.version, "me/accounts")
  url.searchParams.set(
    "fields",
    "id,name,access_token,category,link,picture{url},instagram_business_account{id,username,name,profile_picture_url}",
  )
  url.searchParams.set("limit", "100")
  while (url && pages.length < 1000) {
    const page: z.infer<typeof metaPageListSchema> = await call(
      url,
      { token: userToken, app },
      metaPageListSchema,
    )
    pages.push(...page.data)
    url = page.paging?.next ? new URL(page.paging.next) : null
  }
  return pages
}

/** Subscribes our app to the Page's webhooks (comments come as `feed`). */
export function subscribePage(app: MetaApp, pageId: string, pageToken: string) {
  const url = graph(app.version, `${pageId}/subscribed_apps`)
  url.searchParams.set("subscribed_fields", META_PAGE_FIELDS.join(","))
  return call(url, { method: "POST", token: pageToken, app }, metaSuccessSchema)
}

/** The webhook fields our app is subscribed to on this Page (empty = not subscribed). */
export async function pageSubscription(
  app: MetaApp,
  pageId: string,
  pageToken: string,
): Promise<string[]> {
  const res = await call(
    graph(app.version, `${pageId}/subscribed_apps`),
    { token: pageToken, app },
    metaSubscribedAppsSchema,
  )
  const ours = res.data.find((a) => a.id === app.appId) ?? null
  return ours?.subscribed_fields ?? []
}

// ─── Account helpers ───────────────────────────────────────────────────────────

export interface MetaAccountMeta {
  /** For Instagram rows: the Page whose token is used. */
  pageId?: string
  pageName?: string
  username?: string
  link?: string
  category?: string
}

export function metaMeta(meta: unknown): MetaAccountMeta {
  return meta && typeof meta === "object" ? (meta as MetaAccountMeta) : {}
}

/** The Page id that owns the API calls for this account (itself, or the IG account's Page). */
export function metaPageIdOf(account: Pick<PlatformAccount, "platform" | "externalId" | "meta">) {
  if (account.platform === "facebook") return account.externalId
  const pageId = metaMeta(account.meta).pageId
  if (!pageId) throw new MetaApiError("Missing the linked Facebook Page: reconnect", 0, false, true)
  return pageId
}

export function encryptMetaToken(
  keyring: Keyring,
  organizationId: string,
  account: { platform: string; externalId: string },
  pageToken: string,
) {
  return {
    accessTokenEnc: keyring.encrypt(pageToken, tokenAad(organizationId, account, "access")),
    refreshTokenEnc: null,
    // Page tokens from a long-lived user token don't expire.
    tokenExpiresAt: null,
  }
}

export interface MetaCallContext {
  app: MetaApp
  token: string
  pageId: string
  account: PlatformAccount
}

/** App credentials + the account's Page token, ready for calls. */
export async function metaContext(
  prisma: PrismaClient,
  keyring: Keyring,
  account: PlatformAccount,
): Promise<MetaCallContext> {
  const app = await loadMetaApp(prisma, keyring, account.organizationId)
  if (!app) throw new MetaApiError("The Meta app isn't set in Settings → Connections", 0, false)
  if (!account.accessTokenEnc) {
    throw new MetaApiError("No access token stored: reconnect this account", 401, false, true)
  }
  const token = keyring.decrypt(
    account.accessTokenEnc,
    tokenAad(account.organizationId, account, "access"),
  )
  return { app, token, pageId: metaPageIdOf(account), account }
}

/** Marks the account `error` when Meta says the token is no longer valid. */
export async function markMetaReauth(prisma: PrismaClient, account: PlatformAccount, err: unknown) {
  if (!(err instanceof MetaApiError && err.reauth)) return
  await prisma.platformAccount.update({
    where: { id: account.id },
    data: {
      status: "error",
      lastError: "Meta access was revoked or expired. Reconnect this account.",
      lastErrorAt: new Date(),
    },
  })
}

/** A cheap read that proves the token works, with a short summary. */
export async function testMetaAccount(ctx: MetaCallContext): Promise<string> {
  if (ctx.account.platform === "facebook") {
    const fields = await pageSubscription(ctx.app, ctx.pageId, ctx.token)
    const missing = META_PAGE_FIELDS.filter((f) => !fields.includes(f))
    if (missing.length) {
      await subscribePage(ctx.app, ctx.pageId, ctx.token)
      return `Connected. Webhooks were missing ${missing.join(", ")} and have been re-subscribed.`
    }
    return `Connected. Webhooks subscribed: ${fields.join(", ")}.`
  }
  const url = graph(ctx.app.version, ctx.account.externalId)
  url.searchParams.set("fields", "id,username,media_count")
  const ig = await call(url, { token: ctx.token, app: ctx.app }, metaProfileSchema)
  return `Connected as @${ig.username ?? ctx.account.displayName}.`
}

/** Display name for a Messenger PSID / Instagram IGSID (best effort). */
export async function metaCustomerName(
  ctx: MetaCallContext,
  customerId: string,
): Promise<string | null> {
  const url = graph(ctx.app.version, customerId)
  url.searchParams.set(
    "fields",
    ctx.account.platform === "facebook" ? "first_name,last_name" : "name,username",
  )
  try {
    const p = await call(url, { token: ctx.token, app: ctx.app }, metaProfileSchema)
    const full = [p.first_name, p.last_name].filter(Boolean).join(" ")
    return full || p.name || (p.username ? `@${p.username}` : null)
  } catch {
    return null
  }
}

// ─── Reconcile ─────────────────────────────────────────────────────────────────

const MAX_POSTS = 25
const MAX_COMMENT_PAGES = 5
const MAX_CONVERSATIONS = 50

export interface FetchArgs {
  cursor: string | null
  backfillDays: number
  signal?: AbortSignal
  now?: Date
}

function sinceOf(args: FetchArgs): Date {
  return args.cursor
    ? new Date(args.cursor)
    : new Date((args.now ?? new Date()).getTime() - args.backfillDays * DAY_MS)
}

function newestOf(items: NormalizedItem[], cursor: string | null): string | undefined {
  let newest = cursor ? new Date(cursor) : null
  for (const i of items) {
    const t = i.platformCreatedAt
    if (t && (!newest || t > newest)) newest = t
  }
  return newest?.toISOString()
}

/**
 * Facebook comments created since the cursor on the Page's recent posts. Webhooks are the
 * real-time path; this catches what they missed.
 */
export async function fetchNewFbComments(ctx: MetaCallContext, args: FetchArgs) {
  const since = sinceOf(args)
  const posts = graph(ctx.app.version, `${ctx.pageId}/feed`)
  posts.searchParams.set("fields", "id,created_time,updated_time,permalink_url")
  posts.searchParams.set("limit", String(MAX_POSTS))
  const feed = await call(posts, { token: ctx.token, app: ctx.app }, fbPostListSchema, args.signal)

  const items: NormalizedItem[] = []
  for (const post of feed.data) {
    if (post.updated_time && new Date(post.updated_time) <= since) continue
    let url: URL | null = graph(ctx.app.version, `${post.id}/comments`)
    url.searchParams.set("filter", "stream")
    url.searchParams.set("order", "reverse_chronological")
    url.searchParams.set("fields", "id,message,created_time,from,parent{id},permalink_url")
    url.searchParams.set("limit", "100")
    let pages = 0
    while (url && pages++ < MAX_COMMENT_PAGES) {
      const list: z.infer<typeof fbCommentListSchema> = await call(
        url,
        { token: ctx.token, app: ctx.app },
        fbCommentListSchema,
        args.signal,
      )
      let reached = false
      for (const c of list.data) {
        if (new Date(c.created_time) <= since) {
          reached = true
          break
        }
        items.push(
          normalizeFbCommentNode(c, {
            accountExternalId: ctx.pageId,
            postId: post.id,
            postUrl: post.permalink_url ?? null,
          }),
        )
      }
      url = !reached && list.paging?.next ? new URL(list.paging.next) : null
    }
  }
  items.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
  return { items, cursor: newestOf(items, args.cursor) }
}

/** Instagram comments (and replies) created since the cursor on recent media. */
export async function fetchNewIgComments(ctx: MetaCallContext, args: FetchArgs) {
  const since = sinceOf(args)
  const igId = ctx.account.externalId
  const media = graph(ctx.app.version, `${igId}/media`)
  media.searchParams.set("fields", "id,permalink,timestamp,comments_count")
  media.searchParams.set("limit", String(MAX_POSTS))
  const list = await call(media, { token: ctx.token, app: ctx.app }, igMediaListSchema, args.signal)

  const items: NormalizedItem[] = []
  for (const m of list.data) {
    if (!m.comments_count) continue
    const url = graph(ctx.app.version, `${m.id}/comments`)
    url.searchParams.set(
      "fields",
      "id,text,timestamp,username,from{id,username},replies{id,text,timestamp,username,from{id,username}}",
    )
    url.searchParams.set("limit", "50")
    const comments = await call(
      url,
      { token: ctx.token, app: ctx.app },
      igCommentListSchema,
      args.signal,
    )
    const base = { accountExternalId: igId, mediaId: m.id, permalink: m.permalink ?? null }
    for (const c of comments.data) {
      if (new Date(c.timestamp) > since) items.push(normalizeIgCommentNode(c, base))
      for (const r of c.replies?.data ?? []) {
        if (new Date(r.timestamp) > since) {
          items.push(normalizeIgCommentNode(r, { ...base, parentId: c.id }))
        }
      }
    }
  }
  items.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
  return { items, cursor: newestOf(items, args.cursor) }
}

/** DMs (Messenger or Instagram) in conversations updated since the cursor. */
export async function fetchNewMetaDms(ctx: MetaCallContext, args: FetchArgs) {
  const since = sinceOf(args)
  const platform = ctx.account.platform === "instagram" ? "instagram" : "facebook"
  const ownId = ctx.account.externalId
  const url = graph(ctx.app.version, `${ctx.pageId}/conversations`)
  if (platform === "instagram") url.searchParams.set("platform", "instagram")
  url.searchParams.set(
    "fields",
    "id,updated_time,participants,messages.limit(25){id,message,created_time,from}",
  )
  url.searchParams.set("limit", String(MAX_CONVERSATIONS))
  const list = await call(
    url,
    { token: ctx.token, app: ctx.app },
    metaConversationListSchema,
    args.signal,
  )

  const items: NormalizedItem[] = []
  for (const conv of list.data) {
    if (conv.updated_time && new Date(conv.updated_time) <= since) continue
    const customer = conv.participants?.data.find((p) => p.id !== ownId && p.id !== ctx.pageId)
    if (!customer) continue
    const customerName = customer.name ?? (customer.username ? `@${customer.username}` : null)
    for (const m of conv.messages?.data ?? []) {
      if (new Date(m.created_time) <= since) continue
      items.push(
        normalizeMetaConversationMessage(m, {
          platform,
          accountExternalId: m.from?.id === ctx.pageId ? ctx.pageId : ownId,
          customerId: customer.id,
          customerName,
        }),
      )
    }
  }
  items.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
  return { items, cursor: newestOf(items, args.cursor) }
}

// ─── Replies ───────────────────────────────────────────────────────────────────

/** Public reply under a Facebook comment. Replies to a reply go under its top-level comment. */
export function replyToFbComment(ctx: MetaCallContext, commentId: string, message: string) {
  const url = graph(ctx.app.version, `${commentId}/comments`)
  return call(
    url,
    {
      method: "POST",
      token: ctx.token,
      app: ctx.app,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    },
    metaIdSchema,
  )
}

/** Public reply under an Instagram comment. */
export function replyToIgComment(ctx: MetaCallContext, commentId: string, message: string) {
  const url = graph(ctx.app.version, `${commentId}/replies`)
  return call(
    url,
    {
      method: "POST",
      token: ctx.token,
      app: ctx.app,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    },
    metaIdSchema,
  )
}

/**
 * A DM reply (Messenger or Instagram) through the Page's messages edge, as a RESPONSE inside
 * the standard 24-hour window. No message tags (PLAN §11).
 */
export function sendMetaMessage(ctx: MetaCallContext, recipientId: string, text: string) {
  const url = graph(ctx.app.version, `${ctx.pageId}/messages`)
  return call(
    url,
    {
      method: "POST",
      token: ctx.token,
      app: ctx.app,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        messaging_type: "RESPONSE",
        message: { text },
      }),
    },
    metaSendSchema,
  )
}
