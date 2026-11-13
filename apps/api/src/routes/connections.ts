import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import {
  ACCOUNT_KINDS,
  SYNC_STREAMS,
  connectionPatchSchema,
  parseSectionSecrets,
  parseSectionValues,
  platformSchema,
  syncModeSchema,
  syncStreamKeyFor,
  type ConnectionDto,
  type ConnectionsResponse,
  type WebhookHealthDto,
  type WebhookSource,
} from "@inbox/core"
import type { Keyring } from "@inbox/core/crypto"
import type { PlatformAccount, PrismaClient } from "@inbox/db"
import {
  addYoutubeQuota,
  googleAccessToken,
  isDemoAccount,
  listGbpReviews,
  listMyYoutubeChannels,
  loadSettingsSection,
  markMetaReauth,
  metaContext,
  notifyInbox,
  testMetaAccount,
  v4LocationPath,
} from "@inbox/pipeline"
import { validate } from "../lib/validate"
import { requireAuth, requireRole } from "../middleware/session"
import type { AppEnv } from "../types"

const accountKindSchema = z.enum(ACCOUNT_KINDS)
const idParam = z.object({ id: z.string().min(1) })
const DAY_MS = 86_400_000

function str(meta: unknown, key: string): string | null {
  if (!meta || typeof meta !== "object") return null
  const v = (meta as Record<string, unknown>)[key]
  return typeof v === "string" && v ? v : null
}

/** "Open in …" link for an account. */
function accountUrl(a: Pick<PlatformAccount, "platform" | "externalId" | "meta">): string | null {
  switch (a.platform) {
    case "google_business":
      return str(a.meta, "mapsUri")
    case "facebook":
      return str(a.meta, "link") ?? `https://www.facebook.com/${encodeURIComponent(a.externalId)}`
    case "instagram": {
      const u = str(a.meta, "username")
      return u ? `https://www.instagram.com/${encodeURIComponent(u)}/` : null
    }
    case "youtube":
      return `https://www.youtube.com/channel/${encodeURIComponent(a.externalId)}`
    default:
      return null
  }
}

function parentName(a: Pick<PlatformAccount, "platform" | "meta">): string | null {
  if (a.platform === "instagram") {
    const page = str(a.meta, "pageName")
    return page ? `via Facebook Page “${page}”` : null
  }
  return str(a.meta, "accountDisplayName") ?? str(a.meta, "customUrl")
}

/**
 * One cheap read per platform proving the stored token works (refreshing Google tokens).
 * Returns a short human summary.
 */
async function testAccount(
  prisma: PrismaClient,
  keyring: Keyring,
  account: PlatformAccount,
): Promise<string> {
  switch (account.platform) {
    case "google_business": {
      const token = await googleAccessToken(prisma, keyring, account)
      const { google } = await loadSettingsSection(prisma, account.organizationId, "connections")
      const accountName = str(account.meta, "accountName")
      if (!accountName)
        throw new Error("Missing the Google account for this location: reconnect it")
      const list = await listGbpReviews(token, {
        baseUrl: google.reviewsBaseUrl,
        locationPath: v4LocationPath(accountName, account.externalId),
      })
      return `Connected. ${list.totalReviewCount ?? 0} reviews, average ${list.averageRating?.toFixed(1) ?? "–"}★.`
    }
    case "youtube": {
      const token = await googleAccessToken(prisma, keyring, account)
      const channels = await listMyYoutubeChannels(token)
      await addYoutubeQuota(prisma, account, 1)
      const ch = channels.find((c) => c.id === account.externalId)
      if (!ch) throw new Error("This Google account no longer owns the channel: reconnect")
      return `Connected. ${ch.statistics?.videoCount ?? "?"} videos, ${ch.statistics?.subscriberCount ?? "?"} subscribers.`
    }
    case "facebook":
    case "instagram": {
      const ctx = await metaContext(prisma, keyring, account)
      try {
        return await testMetaAccount(ctx)
      } catch (err) {
        await markMetaReauth(prisma, account, err)
        throw err
      }
    }
    default:
      throw new HTTPException(409, { message: "Testing this platform arrives with its phase" })
  }
}

/** GET /api/connections, PATCH /:id (include/exclude), POST /:id/{test,disconnect}. */
export function connectionRoutes({
  prisma,
  keyring,
  urls,
}: {
  prisma: PrismaClient
  keyring: Keyring
  urls: { apiPublicUrl: string; webUrl: string }
}) {
  async function audit(orgId: string, actorId: string, action: string, id: string, after?: object) {
    await prisma.auditLog.create({
      data: {
        organizationId: orgId,
        actorId,
        action,
        entity: "platform_account",
        entityId: id,
        ...(after ? { after } : {}),
      },
    })
  }

  async function webhookHealth(orgId: string, source: WebhookSource): Promise<WebhookHealthDto> {
    // Deliveries that failed verification have no organization: count them all (one app/org).
    const [last, lastValid, invalid, lastProcessed] = await Promise.all([
      prisma.webhookEvent.findFirst({
        where: { source, OR: [{ organizationId: orgId }, { organizationId: null }] },
        orderBy: { receivedAt: "desc" },
        select: { receivedAt: true },
      }),
      prisma.webhookEvent.findFirst({
        where: { source, organizationId: orgId, signatureValid: true },
        orderBy: { receivedAt: "desc" },
        select: { receivedAt: true },
      }),
      prisma.webhookEvent.count({
        where: {
          source,
          signatureValid: false,
          receivedAt: { gte: new Date(Date.now() - DAY_MS) },
        },
      }),
      prisma.webhookEvent.findFirst({
        where: { source, organizationId: orgId, attempts: { gt: 0 } },
        orderBy: { receivedAt: "desc" },
        select: { error: true },
      }),
    ])
    return {
      lastReceivedAt: last?.receivedAt.toISOString() ?? null,
      lastValidAt: lastValid?.receivedAt.toISOString() ?? null,
      invalidLast24h: invalid,
      lastError: lastProcessed?.error ?? null,
    }
  }

  return (
    new Hono<AppEnv>()
      .use("*", requireAuth)

      .get("/", async (c) => {
        const org = c.get("org")!
        const [rows, settings, meta, google] = await Promise.all([
          prisma.platformAccount.findMany({
            where: { organizationId: org.id },
            orderBy: [{ platform: "asc" }, { displayName: "asc" }],
            include: { syncStates: { orderBy: { stream: "asc" } } },
          }),
          prisma.settings.findUnique({
            where: { organizationId: org.id },
            select: { connections: true },
          }),
          webhookHealth(org.id, "meta"),
          webhookHealth(org.id, "google"),
        ])
        const values = parseSectionValues("connections", settings?.connections)
        const secrets = parseSectionSecrets("connections", settings?.connections)
        const accounts: ConnectionDto[] = rows.map((r) => ({
          id: r.id,
          platform: platformSchema.parse(r.platform),
          kind: accountKindSchema.parse(r.kind),
          displayName: r.displayName,
          avatarUrl: r.avatarUrl,
          parentName: parentName(r),
          status: r.status,
          included: r.included,
          lastError: r.lastError,
          lastErrorAt: r.lastErrorAt?.toISOString() ?? null,
          tokenExpiresAt: r.tokenExpiresAt?.toISOString() ?? null,
          demo: isDemoAccount(r),
          url: accountUrl(r),
          createdAt: r.createdAt.toISOString(),
          streams: r.syncStates.flatMap((s) => {
            const key = syncStreamKeyFor(r.platform, s.stream)
            if (!key) return []
            return [
              {
                syncStateId: s.id,
                key,
                label: SYNC_STREAMS[key].label,
                mode: syncModeSchema.parse(s.mode),
                lastRunAt: s.lastRunAt?.toISOString() ?? null,
                lastSuccessAt: s.lastSuccessAt?.toISOString() ?? null,
                nextRunAt: s.nextRunAt.toISOString(),
                lastError: s.lastError,
                consecutiveFailures: s.consecutiveFailures,
                quotaUsedToday: s.quotaUsedToday,
              },
            ]
          }),
        }))
        const googleConfigured = Boolean(values.google.clientId && secrets.googleClientSecret)
        const api = urls.apiPublicUrl
        const body: ConnectionsResponse = {
          accounts,
          configured: {
            google: googleConfigured,
            youtube: googleConfigured,
            meta: Boolean(values.meta.appId && secrets.metaAppSecret),
            linkedin: Boolean(values.linkedin.clientId && secrets.linkedinClientSecret),
          },
          webhooks: { meta, google },
          setup: {
            apiPublicUrl: api,
            publicUrlReachable: /^https:\/\//.test(api) && !/localhost|127\.0\.0\.1/.test(api),
            webhookUrls: { meta: `${api}/webhooks/meta`, google: `${api}/webhooks/google` },
            redirectUris: {
              google: `${urls.webUrl}/api/oauth/google/callback`,
              meta: `${urls.webUrl}/api/oauth/meta/callback`,
            },
            metaVerifyTokenSet: Boolean(secrets.metaVerifyToken),
            googlePubsubTopicSet: Boolean(values.google.pubsubTopic),
          },
        }
        return c.json(body)
      })

      .patch(
        "/:id",
        requireRole("admin"),
        validate("param", idParam),
        validate("json", connectionPatchSchema),
        async (c) => {
          const org = c.get("org")!
          const { id } = c.req.valid("param")
          const { included } = c.req.valid("json")
          const { count } = await prisma.platformAccount.updateMany({
            where: { id, organizationId: org.id },
            data: { included },
          })
          if (count === 0) throw new HTTPException(404, { message: "Connection not found" })
          await audit(org.id, c.get("user")!.id, "connection.update", id, { included })
          await notifyInbox(prisma, {
            type: "sync.changed",
            organizationId: org.id,
            syncStateIds: [],
          })
          return c.json({ ok: true })
        },
      )

      // Checks the stored token works (refreshing it if needed) with one cheap read.
      .post("/:id/test", requireRole("admin"), validate("param", idParam), async (c) => {
        const org = c.get("org")!
        const { id } = c.req.valid("param")
        const account = await prisma.platformAccount.findFirst({
          where: { id, organizationId: org.id },
        })
        if (!account) throw new HTTPException(404, { message: "Connection not found" })
        if (isDemoAccount(account))
          return c.json({ ok: true, message: "Demo account: nothing to test." })
        try {
          const message = await testAccount(prisma, keyring, account)
          if (account.status === "error") {
            await prisma.platformAccount.update({
              where: { id },
              data: { status: "connected", lastError: null },
            })
          }
          return c.json({ ok: true, message })
        } catch (err) {
          if (err instanceof HTTPException) throw err
          const message = err instanceof Error ? err.message : String(err)
          return c.json({ ok: false, message }, 200)
        } finally {
          await notifyInbox(prisma, {
            type: "sync.changed",
            organizationId: org.id,
            syncStateIds: [],
          })
        }
      })

      // Stops syncing and forgets the tokens. The platform grant itself isn't revoked (other
      // locations/Pages from the same sign-in keep working); remove it in the platform's settings.
      .post("/:id/disconnect", requireRole("admin"), validate("param", idParam), async (c) => {
        const org = c.get("org")!
        const { id } = c.req.valid("param")
        const { count } = await prisma.platformAccount.updateMany({
          where: { id, organizationId: org.id },
          data: {
            status: "disconnected",
            accessTokenEnc: null,
            refreshTokenEnc: null,
            tokenExpiresAt: null,
            lastError: null,
          },
        })
        if (count === 0) throw new HTTPException(404, { message: "Connection not found" })
        await audit(org.id, c.get("user")!.id, "connection.disconnect", id)
        await notifyInbox(prisma, {
          type: "sync.changed",
          organizationId: org.id,
          syncStateIds: [],
        })
        return c.json({ ok: true })
      })
  )
}
