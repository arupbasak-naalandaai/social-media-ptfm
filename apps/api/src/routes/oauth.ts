/**
 * One-click platform connections (PLAN §5): our own OAuth flows, org-owned tokens.
 * Redirect URIs are on the web domain (`WEB_URL/api/oauth/<provider>/callback`, proxied to the
 * api) so the session cookie comes along and the callback is bound to the signed-in admin.
 * State (+ PKCE verifier for Google) lives server-side (Verification table), encrypted, single
 * use, 10 min.
 *
 * - Google Business Profile: `/google/start` → `/google/callback`
 * - YouTube: `/youtube/start` → the same Google callback
 *
 * Google's redirect URI is better-auth's own (`WEB_URL/api/auth/callback/google`), so one OAuth
 * client needs a single redirect URI for sign-in and connections. `app.ts` routes a callback to
 * `/google/callback` when its `state` is one of ours ({@link isGoogleConnectState}); everything
 * else goes to better-auth.
 * - Facebook Pages + linked Instagram accounts: `/meta/start` → `/meta/callback`
 * - LinkedIn Company Pages: `/linkedin/start` → `/linkedin/callback`
 */
import { randomBytes } from "node:crypto"
import { Hono, type Context } from "hono"
import { GBP_SCOPE, YOUTUBE_SCOPE } from "@inbox/core"
import { aadFor, type Keyring } from "@inbox/core/crypto"
import type { Logger } from "@inbox/core/logger"
import type { Prisma, PrismaClient } from "@inbox/db"
import {
  declinedMetaPermissions,
  encryptLinkedinTokens,
  encryptMetaToken,
  encryptTokens,
  ensureSyncStates,
  exchangeGoogleCode,
  exchangeLinkedinCode,
  exchangeMetaCode,
  GoogleApiError,
  getLinkedinOrganization,
  googleAuthUrl,
  LinkedinApiError,
  linkedinAuthUrl,
  linkedinPageUrl,
  listAdministeredOrgs,
  listGbpAccounts,
  listGbpLocations,
  listManagedPages,
  listMyYoutubeChannels,
  loadGoogleClient,
  loadLinkedinApp,
  loadMetaApp,
  loadSettingsSection,
  MetaApiError,
  metaAuthUrl,
  missingLinkedinScopes,
  notifyInbox,
  pkcePair,
  setGbpNotifications,
  subscribeLinkedinWebhook,
  subscribePage,
  YoutubeApiError,
} from "@inbox/pipeline"
import { requireAuth, requireRole } from "../middleware/session"
import type { AppEnv } from "../types"

export interface OAuthRouteDeps {
  prisma: PrismaClient
  keyring: Keyring
  urls: { apiPublicUrl: string; webUrl: string }
  logger: Logger
}

const STATE_TTL_MS = 10 * 60 * 1000

/** better-auth's Google callback, shared with the connect flow (one redirect URI). */
export const GOOGLE_CALLBACK_PATH = "/api/auth/callback/google"
export const googleRedirectUri = (webUrl: string) => `${webUrl}${GOOGLE_CALLBACK_PATH}`
/** LinkedIn's redirect URI (web domain, proxied to the api, like Meta's). */
export const linkedinRedirectUri = (webUrl: string) => `${webUrl}/api/oauth/linkedin/callback`

/** True when `state` was issued by `/google/start` or `/youtube/start` (not by better-auth). */
export async function isGoogleConnectState(prisma: PrismaClient, state: string | undefined) {
  if (!state) return false
  const row = await prisma.verification.findFirst({
    where: { identifier: `oauth:google:${state}` },
    select: { id: true },
  })
  return Boolean(row)
}
const stateAad = (state: string) => aadFor("-", "oauth_state", state)

type Product = "google_business" | "youtube" | "meta" | "linkedin"
type StateProvider = "google" | "meta" | "linkedin"

interface PendingState {
  organizationId: string
  userId: string
  /** PKCE verifier (Google only). */
  verifier?: string
  /** Which connection a Google callback completes (Business Profile or YouTube). */
  product?: Product
}

type AppContext = Context<AppEnv>

export function oauthRoutes({ prisma, keyring, urls, logger }: OAuthRouteDeps) {
  const redirect = {
    google: googleRedirectUri(urls.webUrl),
    meta: `${urls.webUrl}/api/oauth/meta/callback`,
    linkedin: linkedinRedirectUri(urls.webUrl),
  }
  const back = (params: Record<string, string>) =>
    `${urls.webUrl}/connections?${new URLSearchParams(params)}`

  async function createState(provider: StateProvider, pending: PendingState) {
    const state = randomBytes(24).toString("base64url")
    await prisma.verification.create({
      data: {
        id: `oauth-${state}`,
        identifier: `oauth:${provider}:${state}`,
        value: keyring.encrypt(JSON.stringify(pending), stateAad(state)),
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      },
    })
    return state
  }

  /** The pending state for this callback, consumed (single use), or null when invalid. */
  async function consumeState(c: AppContext, provider: StateProvider) {
    const state = c.req.query("state") ?? ""
    const row = state
      ? await prisma.verification.findFirst({ where: { identifier: `oauth:${provider}:${state}` } })
      : null
    if (row) await prisma.verification.delete({ where: { id: row.id } })
    let pending: PendingState | null = null
    try {
      pending = row
        ? (JSON.parse(keyring.decrypt(row.value, stateAad(state))) as PendingState)
        : null
    } catch {
      pending = null
    }
    if (
      !row ||
      !pending ||
      row.expiresAt < new Date() ||
      pending.organizationId !== c.get("org")!.id ||
      pending.userId !== c.get("user")!.id
    ) {
      return null
    }
    return pending
  }

  async function finish(
    c: AppContext,
    args: {
      platform: string
      connected: string
      count: number
      detail: object
      warnings: string[]
    },
  ) {
    const org = c.get("org")!
    await ensureSyncStates(prisma, org.id)
    await prisma.auditLog.create({
      data: {
        organizationId: org.id,
        actorId: c.get("user")!.id,
        action: "connection.connect",
        entity: "platform_account",
        after: { platform: args.platform, ...args.detail },
      },
    })
    await notifyInbox(prisma, { type: "sync.changed", organizationId: org.id, syncStateIds: [] })
    return c.redirect(
      back({
        connected: args.connected,
        count: String(args.count),
        ...(args.warnings.length ? { warning: args.warnings.join(" ") } : {}),
      }),
    )
  }

  async function startGoogle(c: AppContext, product: "google_business" | "youtube") {
    const org = c.get("org")!
    const user = c.get("user")!
    const client = await loadGoogleClient(prisma, keyring, org.id)
    if (!client) {
      return c.redirect(
        back({
          error:
            "No Google OAuth client: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (the sign-in client), or add one in Settings → Connections.",
        }),
      )
    }
    const { verifier, challenge } = pkcePair()
    const state = await createState("google", {
      organizationId: org.id,
      userId: user.id,
      verifier,
      product,
    })
    return c.redirect(
      googleAuthUrl({
        clientId: client.clientId,
        redirectUri: redirect.google,
        state,
        codeChallenge: challenge,
        scope: product === "youtube" ? YOUTUBE_SCOPE : GBP_SCOPE,
        loginHint: user.email ?? undefined,
      }),
    )
  }

  return new Hono<AppEnv>()
    .use("*", requireAuth, requireRole("admin"))

    .get("/google/start", (c) => startGoogle(c, "google_business"))
    .get("/youtube/start", (c) => startGoogle(c, "youtube"))

    .get("/google/callback", async (c) => {
      const org = c.get("org")!
      const q = c.req.query()
      if (q.error) {
        return c.redirect(
          back({
            error:
              q.error === "access_denied"
                ? "Google access wasn't granted."
                : `Google said: ${q.error}`,
          }),
        )
      }
      const pending = await consumeState(c, "google")
      if (!pending?.verifier || !q.code) {
        return c.redirect(
          back({ error: "That sign-in link expired or was already used. Try Connect again." }),
        )
      }
      const product = pending.product ?? "google_business"

      try {
        const client = await loadGoogleClient(prisma, keyring, org.id)
        if (!client) throw new Error("The Google OAuth client was removed from Settings")
        const token = await exchangeGoogleCode(client, {
          code: q.code,
          redirectUri: redirect.google,
          codeVerifier: pending.verifier,
        })
        const scope = product === "youtube" ? YOUTUBE_SCOPE : GBP_SCOPE
        if (token.scope && !token.scope.split(" ").includes(scope)) {
          return c.redirect(
            back({
              error: `${product === "youtube" ? "YouTube" : "Google Business Profile"} access wasn't granted. Tick it on the consent screen.`,
            }),
          )
        }
        if (!token.refresh_token) {
          return c.redirect(
            back({
              error:
                "Google didn't return a refresh token. Remove the app's access in your Google account, then connect again.",
            }),
          )
        }
        return product === "youtube" ? await connectYoutube(c, token) : await connectGbp(c, token)
      } catch (err) {
        logger.warn({ err: (err as Error).message, product }, "google connect failed")
        const message =
          err instanceof GoogleApiError || err instanceof YoutubeApiError
            ? err.message
            : "Connecting Google failed. Try again."
        return c.redirect(back({ error: message }))
      }
    })

    .get("/meta/start", async (c) => {
      const org = c.get("org")!
      const app = await loadMetaApp(prisma, keyring, org.id)
      if (!app) {
        return c.redirect(
          back({ error: "Add the Meta app ID and app secret in Settings → Connections first." }),
        )
      }
      const state = await createState("meta", {
        organizationId: org.id,
        userId: c.get("user")!.id,
        product: "meta",
      })
      return c.redirect(metaAuthUrl(app, { redirectUri: redirect.meta, state }))
    })

    .get("/meta/callback", async (c) => {
      const org = c.get("org")!
      const q = c.req.query()
      if (q.error) {
        return c.redirect(
          back({
            error:
              q.error_reason === "user_denied" || q.error === "access_denied"
                ? "Facebook access wasn't granted."
                : `Facebook said: ${q.error_description ?? q.error}`,
          }),
        )
      }
      const pending = await consumeState(c, "meta")
      if (!pending || !q.code) {
        return c.redirect(
          back({ error: "That sign-in link expired or was already used. Try Connect again." }),
        )
      }
      try {
        const app = await loadMetaApp(prisma, keyring, org.id)
        if (!app) throw new Error("The Meta app was removed from Settings")
        const userToken = await exchangeMetaCode(app, { code: q.code, redirectUri: redirect.meta })
        const warnings: string[] = []
        const declined = await declinedMetaPermissions(app, userToken.access_token).catch(() => [])
        if (declined.length) {
          warnings.push(
            `Not granted: ${declined.join(", ")}. Some comments, DMs or replies won't work until you reconnect and allow them.`,
          )
        }

        const pages = await listManagedPages(app, userToken.access_token)
        let fb = 0
        let ig = 0
        for (const page of pages) {
          if (!page.access_token) {
            warnings.push(`${page.name}: no Page token (you need a task on this Page).`)
            continue
          }
          const pageKey = { platform: "facebook", externalId: page.id }
          const pageMeta = {
            ...(page.link ? { link: page.link } : {}),
            ...(page.category ? { category: page.category } : {}),
          } satisfies Prisma.InputJsonObject
          const pageRow = await prisma.platformAccount.upsert({
            where: {
              organizationId_platform_externalId: {
                organizationId: org.id,
                platform: "facebook",
                externalId: page.id,
              },
            },
            create: {
              organizationId: org.id,
              platform: "facebook",
              kind: "fb_page",
              externalId: page.id,
              displayName: page.name,
              avatarUrl: page.picture?.data.url ?? null,
              meta: pageMeta,
              status: "connected",
              scopes: [],
              ...encryptMetaToken(keyring, org.id, pageKey, page.access_token),
            },
            update: {
              displayName: page.name,
              avatarUrl: page.picture?.data.url ?? null,
              meta: pageMeta,
              status: "connected",
              lastError: null,
              lastErrorAt: null,
              ...encryptMetaToken(keyring, org.id, pageKey, page.access_token),
            },
          })
          fb++
          try {
            await subscribePage(app, page.id, page.access_token)
          } catch (err) {
            warnings.push(`Webhooks for ${page.name}: ${(err as Error).message}`)
          }

          const igAccount = page.instagram_business_account
          if (igAccount) {
            const igKey = { platform: "instagram", externalId: igAccount.id }
            const igMeta = {
              pageId: page.id,
              pageName: page.name,
              ...(igAccount.username ? { username: igAccount.username } : {}),
            } satisfies Prisma.InputJsonObject
            const name = igAccount.username
              ? `@${igAccount.username}`
              : (igAccount.name ?? igAccount.id)
            await prisma.platformAccount.upsert({
              where: {
                organizationId_platform_externalId: {
                  organizationId: org.id,
                  platform: "instagram",
                  externalId: igAccount.id,
                },
              },
              create: {
                organizationId: org.id,
                platform: "instagram",
                kind: "ig_account",
                externalId: igAccount.id,
                displayName: name,
                avatarUrl: igAccount.profile_picture_url ?? null,
                parentAccountId: pageRow.id,
                meta: igMeta,
                status: "connected",
                scopes: [],
                ...encryptMetaToken(keyring, org.id, igKey, page.access_token),
              },
              update: {
                displayName: name,
                avatarUrl: igAccount.profile_picture_url ?? null,
                parentAccountId: pageRow.id,
                meta: igMeta,
                status: "connected",
                lastError: null,
                lastErrorAt: null,
                ...encryptMetaToken(keyring, org.id, igKey, page.access_token),
              },
            })
            ig++
          }
        }
        if (fb === 0) {
          warnings.push(
            "No Facebook Pages came back. Pick your Pages (and their Instagram accounts) on the Facebook dialog.",
          )
        }
        return await finish(c, {
          platform: "meta",
          connected: "meta",
          count: fb + ig,
          detail: { pages: fb, instagram: ig },
          warnings,
        })
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "meta connect failed")
        const message =
          err instanceof MetaApiError ? err.message : "Connecting Facebook failed. Try again."
        return c.redirect(back({ error: message }))
      }
    })

    .get("/linkedin/start", async (c) => {
      const org = c.get("org")!
      const app = await loadLinkedinApp(prisma, keyring, org.id)
      if (!app) {
        return c.redirect(
          back({
            error: "Add the LinkedIn client ID and client secret in Settings → Connections first.",
          }),
        )
      }
      const state = await createState("linkedin", {
        organizationId: org.id,
        userId: c.get("user")!.id,
        product: "linkedin",
      })
      return c.redirect(linkedinAuthUrl(app, { redirectUri: redirect.linkedin, state }))
    })

    .get("/linkedin/callback", async (c) => {
      const org = c.get("org")!
      const q = c.req.query()
      if (q.error) {
        return c.redirect(
          back({
            error:
              q.error === "user_cancelled_login" || q.error === "user_cancelled_authorize"
                ? "LinkedIn access wasn't granted."
                : `LinkedIn said: ${q.error_description ?? q.error}`,
          }),
        )
      }
      const pending = await consumeState(c, "linkedin")
      if (!pending || !q.code) {
        return c.redirect(
          back({ error: "That sign-in link expired or was already used. Try Connect again." }),
        )
      }
      try {
        const app = await loadLinkedinApp(prisma, keyring, org.id)
        if (!app) throw new Error("The LinkedIn app was removed from Settings")
        const token = await exchangeLinkedinCode(app, {
          code: q.code,
          redirectUri: redirect.linkedin,
        })
        const warnings: string[] = []
        const missing = missingLinkedinScopes(token)
        if (missing.length) {
          warnings.push(
            `Not granted: ${missing.join(", ")}. Comments or replies won't work until the app has Community Management API access and you reconnect.`,
          )
        }
        if (!token.refresh_token) {
          warnings.push(
            "LinkedIn didn't issue a refresh token, so you'll need to reconnect before the token expires in about 60 days.",
          )
        }
        const ctx = { token: token.access_token, version: app.version }
        const { orgIds, personUrn } = await listAdministeredOrgs(ctx)
        const webhookUrl = `${urls.apiPublicUrl}/webhooks/linkedin`
        const canSubscribe =
          Boolean(app.appId && personUrn) &&
          /^https:\/\//.test(urls.apiPublicUrl) &&
          !/localhost|127\.0\.0\.1/.test(urls.apiPublicUrl)

        for (const id of orgIds) {
          const o = await getLinkedinOrganization(ctx, id).catch(() => null)
          const key = { platform: "linkedin", externalId: id }
          const meta = {
            ...(o?.vanityName ? { vanityName: o.vanityName } : {}),
            link: linkedinPageUrl({ id, vanityName: o?.vanityName }),
            ...(personUrn ? { connectedBy: personUrn } : {}),
          } satisfies Prisma.InputJsonObject
          const tokens = encryptLinkedinTokens(keyring, org.id, key, token)
          const displayName = o?.localizedName ?? `LinkedIn Page ${id}`
          await prisma.platformAccount.upsert({
            where: {
              organizationId_platform_externalId: {
                organizationId: org.id,
                platform: "linkedin",
                externalId: id,
              },
            },
            create: {
              organizationId: org.id,
              platform: "linkedin",
              kind: "li_org",
              externalId: id,
              displayName,
              meta,
              status: "connected",
              ...tokens,
            },
            update: {
              displayName,
              meta,
              status: "connected",
              lastError: null,
              lastErrorAt: null,
              ...tokens,
            },
          })
          if (canSubscribe) {
            try {
              await subscribeLinkedinWebhook(ctx, {
                appId: app.appId,
                personUrn: personUrn!,
                orgUrn: `urn:li:organization:${id}`,
                webhookUrl,
              })
            } catch (err) {
              warnings.push(`Webhook for ${displayName}: ${(err as Error).message}`)
            }
          }
        }
        if (orgIds.length === 0) {
          warnings.push(
            "This LinkedIn member isn't a super admin of any Company Page. Sign in as a Page admin.",
          )
        } else if (!canSubscribe) {
          warnings.push(
            app.appId
              ? "No public HTTPS API URL, so comments arrive on the reconcile schedule."
              : "No LinkedIn app ID in Settings → Connections, so webhooks aren't subscribed: comments arrive on the reconcile schedule.",
          )
        }
        return await finish(c, {
          platform: "linkedin",
          connected: "linkedin",
          count: orgIds.length,
          detail: { pages: orgIds.length, webhooks: canSubscribe },
          warnings,
        })
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "linkedin connect failed")
        const message =
          err instanceof LinkedinApiError ? err.message : "Connecting LinkedIn failed. Try again."
        return c.redirect(back({ error: message }))
      }
    })

  // ─── Google products ─────────────────────────────────────────────────────────

  async function connectYoutube(c: AppContext, token: Parameters<typeof encryptTokens>[3]) {
    const org = c.get("org")!
    const channels = await listMyYoutubeChannels(token.access_token)
    const warnings: string[] = []
    if (channels.length === 0) {
      warnings.push(
        "This Google account has no YouTube channel. For a brand channel, choose it on Google's account picker.",
      )
    }
    for (const ch of channels) {
      const key = { platform: "youtube", externalId: ch.id }
      const meta = {
        ...(ch.snippet?.customUrl ? { customUrl: ch.snippet.customUrl } : {}),
        link: `https://www.youtube.com/channel/${ch.id}`,
      } satisfies Prisma.InputJsonObject
      const tokens = encryptTokens(keyring, org.id, key, token)
      const displayName = ch.snippet?.title ?? ch.id
      const avatarUrl = ch.snippet?.thumbnails?.default?.url ?? null
      await prisma.platformAccount.upsert({
        where: {
          organizationId_platform_externalId: {
            organizationId: org.id,
            platform: "youtube",
            externalId: ch.id,
          },
        },
        create: {
          organizationId: org.id,
          platform: "youtube",
          kind: "yt_channel",
          externalId: ch.id,
          displayName,
          avatarUrl,
          meta,
          status: "connected",
          ...tokens,
        },
        update: {
          displayName,
          avatarUrl,
          meta,
          status: "connected",
          lastError: null,
          lastErrorAt: null,
          ...tokens,
        },
      })
    }
    return finish(c, {
      platform: "youtube",
      connected: "youtube",
      count: channels.length,
      detail: { channels: channels.length },
      warnings,
    })
  }

  async function connectGbp(c: AppContext, token: Parameters<typeof encryptTokens>[3]) {
    const org = c.get("org")!
    const accounts = await listGbpAccounts(token.access_token)
    const warnings: string[] = []
    const connections = await loadSettingsSection(prisma, org.id, "connections")
    let count = 0
    for (const account of accounts) {
      const locations = await listGbpLocations(token.access_token, account.name)
      for (const loc of locations) {
        const key = { platform: "google_business", externalId: loc.name }
        const meta = {
          accountName: account.name,
          accountDisplayName: account.accountName,
          ...(loc.storeCode ? { storeCode: loc.storeCode } : {}),
          ...(loc.metadata?.mapsUri ? { mapsUri: loc.metadata.mapsUri } : {}),
          ...(loc.metadata?.newReviewUri ? { newReviewUri: loc.metadata.newReviewUri } : {}),
          ...(loc.metadata?.placeId ? { placeId: loc.metadata.placeId } : {}),
        } satisfies Prisma.InputJsonObject
        const tokens = encryptTokens(keyring, org.id, key, token)
        await prisma.platformAccount.upsert({
          where: {
            organizationId_platform_externalId: {
              organizationId: org.id,
              platform: "google_business",
              externalId: loc.name,
            },
          },
          create: {
            organizationId: org.id,
            platform: "google_business",
            kind: "gbp_location",
            externalId: loc.name,
            displayName: loc.title ?? loc.name,
            meta,
            status: "connected",
            ...tokens,
          },
          update: {
            displayName: loc.title ?? loc.name,
            meta,
            status: "connected",
            lastError: null,
            lastErrorAt: null,
            ...tokens,
          },
        })
        count++
      }
      if (connections.google.pubsubTopic) {
        try {
          await setGbpNotifications(token.access_token, {
            baseUrl: connections.google.notificationsBaseUrl,
            accountName: account.name,
            topic: connections.google.pubsubTopic,
          })
        } catch (err) {
          warnings.push(
            `Review notifications for ${account.accountName ?? account.name}: ${(err as Error).message}`,
          )
        }
      }
    }
    if (!connections.google.pubsubTopic && count > 0) {
      warnings.push(
        "No Pub/Sub topic is set, so new reviews arrive on the reconcile schedule only.",
      )
    }
    return finish(c, {
      platform: "google_business",
      connected: "google",
      count,
      detail: { locations: count, accounts: accounts.length },
      warnings,
    })
  }
}
