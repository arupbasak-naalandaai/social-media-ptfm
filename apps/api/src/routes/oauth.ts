/**
 * One-click platform connections (PLAN §5): our own OAuth flows, org-owned tokens.
 * The redirect URI is on the web domain (`WEB_URL/api/oauth/<platform>/callback`, proxied to
 * the api) so the session cookie comes along and the callback is bound to the signed-in admin.
 * State + PKCE verifier live server-side (Verification table), encrypted, single use, 10 min.
 */
import { randomBytes } from "node:crypto"
import { Hono } from "hono"
import { GBP_SCOPE } from "@inbox/core"
import { aadFor, type Keyring } from "@inbox/core/crypto"
import type { Logger } from "@inbox/core/logger"
import type { Prisma, PrismaClient } from "@inbox/db"
import {
  encryptTokens,
  ensureSyncStates,
  exchangeGoogleCode,
  GoogleApiError,
  googleAuthUrl,
  listGbpAccounts,
  listGbpLocations,
  loadGoogleClient,
  loadSettingsSection,
  notifyInbox,
  pkcePair,
  setGbpNotifications,
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
const stateAad = (state: string) => aadFor("-", "oauth_state", state)

interface PendingState {
  organizationId: string
  userId: string
  verifier: string
}

export function oauthRoutes({ prisma, keyring, urls, logger }: OAuthRouteDeps) {
  const redirectUri = `${urls.webUrl}/api/oauth/google/callback`
  const back = (params: Record<string, string>) =>
    `${urls.webUrl}/connections?${new URLSearchParams(params)}`

  return new Hono<AppEnv>()
    .use("*", requireAuth, requireRole("admin"))

    .get("/google/start", async (c) => {
      const org = c.get("org")!
      const user = c.get("user")!
      const client = await loadGoogleClient(prisma, keyring, org.id)
      if (!client) {
        return c.redirect(
          back({
            error: "Add the Google OAuth client ID and secret in Settings → Connections first.",
          }),
        )
      }
      const state = randomBytes(24).toString("base64url")
      const { verifier, challenge } = pkcePair()
      const pending: PendingState = { organizationId: org.id, userId: user.id, verifier }
      await prisma.verification.create({
        data: {
          id: `oauth-${state}`,
          identifier: `oauth:google:${state}`,
          value: keyring.encrypt(JSON.stringify(pending), stateAad(state)),
          expiresAt: new Date(Date.now() + STATE_TTL_MS),
        },
      })
      return c.redirect(
        googleAuthUrl({
          clientId: client.clientId,
          redirectUri,
          state,
          codeChallenge: challenge,
          loginHint: user.email ?? undefined,
        }),
      )
    })

    .get("/google/callback", async (c) => {
      const org = c.get("org")!
      const user = c.get("user")!
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
      const state = q.state ?? ""
      const row = state
        ? await prisma.verification.findFirst({ where: { identifier: `oauth:google:${state}` } })
        : null
      if (row) await prisma.verification.delete({ where: { id: row.id } }) // single use
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
        pending.organizationId !== org.id ||
        pending.userId !== user.id ||
        !q.code
      ) {
        return c.redirect(
          back({ error: "That sign-in link expired or was already used. Try Connect again." }),
        )
      }

      try {
        const client = await loadGoogleClient(prisma, keyring, org.id)
        if (!client) throw new Error("The Google OAuth client was removed from Settings")
        const token = await exchangeGoogleCode(client, {
          code: q.code,
          redirectUri,
          codeVerifier: pending.verifier,
        })
        if (token.scope && !token.scope.split(" ").includes(GBP_SCOPE)) {
          return c.redirect(
            back({
              error:
                "Google Business Profile access wasn't granted. Tick it on the consent screen.",
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
        await ensureSyncStates(prisma, org.id)
        await prisma.auditLog.create({
          data: {
            organizationId: org.id,
            actorId: user.id,
            action: "connection.connect",
            entity: "platform_account",
            after: { platform: "google_business", locations: count, accounts: accounts.length },
          },
        })
        await notifyInbox(prisma, {
          type: "sync.changed",
          organizationId: org.id,
          syncStateIds: [],
        })
        return c.redirect(
          back({
            connected: "google",
            count: String(count),
            ...(warnings.length ? { warning: warnings.join(" ") } : {}),
          }),
        )
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "google connect failed")
        const message =
          err instanceof GoogleApiError ? err.message : "Connecting Google failed. Try again."
        return c.redirect(back({ error: message }))
      }
    })
}
