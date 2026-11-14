/**
 * Public platform webhooks (api public domain). Fast path only (PLAN §2): verify, store a
 * WebhookEvent, enqueue `ingest`, acknowledge. Everything else happens in the worker.
 */
import { createHash } from "node:crypto"
import { Hono } from "hono"
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose"
import { pubsubPushSchema } from "@inbox/core"
import type { Keyring } from "@inbox/core/crypto"
import type { Logger } from "@inbox/core/logger"
import type { Prisma, PrismaClient } from "@inbox/db"
import {
  generatedMetaVerifyTokens,
  loadSettingsSecret,
  loadSettingsSection,
  verifyMetaSignature,
} from "@inbox/pipeline"
import type { JobSender } from "../lib/jobs"
import type { AppEnv } from "../types"

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"]
const MAX_BODY_BYTES = 256 * 1024

export interface WebhookDeps {
  prisma: PrismaClient
  jobs: JobSender
  logger: Logger
  /** Decrypts the Meta app secret / verify token from Settings. Meta webhooks need it. */
  keyring?: Keyring | undefined
  apiPublicUrl: string
  /** Override for tests (a local JWKS). */
  googleJwks?: JWTVerifyGetKey
}

/** Headers worth keeping for debugging, never credentials. */
function safeHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of h) {
    if (k === "authorization" || k === "cookie") continue
    if (k.startsWith("x-") || k === "content-type" || k === "user-agent") out[k] = v
  }
  return out
}

export function webhookRoutes(deps: WebhookDeps) {
  const jwks: JWTVerifyGetKey =
    deps.googleJwks ?? createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"))

  /**
   * Finds the organization this push belongs to: one whose Settings → Connections → Google
   * push service account and audience match the verified token.
   */
  async function verifyGooglePush(bearer: string): Promise<{ organizationId: string } | null> {
    const candidates = await deps.prisma.settings.findMany({ select: { organizationId: true } })
    for (const { organizationId } of candidates) {
      const { google } = await loadSettingsSection(deps.prisma, organizationId, "connections")
      if (!google.pushServiceAccountEmail) continue
      const audience = google.pubsubAudience || `${deps.apiPublicUrl}/webhooks/google`
      let payload: JWTPayload
      try {
        ;({ payload } = await jwtVerify(bearer, jwks, { issuer: GOOGLE_ISSUERS, audience }))
      } catch {
        continue
      }
      if (payload.email === google.pushServiceAccountEmail && payload.email_verified === true) {
        return { organizationId }
      }
    }
    return null
  }

  /** Organizations with a Meta secret set in Settings → Connections (few: usually one). */
  async function metaSecrets(key: "metaAppSecret" | "metaVerifyToken") {
    if (!deps.keyring) return []
    const orgs = await deps.prisma.settings.findMany({ select: { organizationId: true } })
    const out: { organizationId: string; secret: string }[] = []
    for (const { organizationId } of orgs) {
      const secret = await loadSettingsSecret(
        deps.prisma,
        deps.keyring,
        organizationId,
        "connections",
        key,
      ).catch(() => null)
      if (secret) out.push({ organizationId, secret })
    }
    return out
  }

  return (
    new Hono<AppEnv>()
      // Meta's subscription handshake: echo hub.challenge when the verify token matches.
      .get("/meta", async (c) => {
        const mode = c.req.query("hub.mode")
        const token = c.req.query("hub.verify_token") ?? ""
        const challenge = c.req.query("hub.challenge") ?? ""
        if (mode !== "subscribe" || !token)
          return c.json({ error: "Not a subscription check" }, 400)
        // A token typed in Settings, else the one the app generated for that workspace.
        let match: { organizationId: string } | undefined = (
          await metaSecrets("metaVerifyToken")
        ).find((s) => s.secret === token)
        if (!match && deps.keyring) {
          const keyring = deps.keyring
          const orgs = await deps.prisma.settings.findMany({ select: { organizationId: true } })
          match = orgs.find(({ organizationId }) =>
            generatedMetaVerifyTokens(keyring, organizationId).includes(token),
          )
        }
        if (!match) {
          deps.logger.warn("meta webhook verification: verify token didn't match any workspace")
          return c.json({ error: "Verify token doesn't match" }, 403)
        }
        deps.logger.info({ orgId: match.organizationId }, "meta webhook verified")
        return c.text(challenge, 200)
      })

      // Deliveries: verify X-Hub-Signature-256 against the raw body, store, queue, ack fast.
      .post("/meta", async (c) => {
        const buf = Buffer.from(await c.req.arrayBuffer())
        if (buf.length > MAX_BODY_BYTES) return c.json({ error: "Too large" }, 413)
        const text = buf.toString("utf8")
        let json: unknown
        try {
          json = JSON.parse(text)
        } catch {
          return c.json({ error: "Invalid JSON" }, 400)
        }
        const header = c.req.header("x-hub-signature-256")
        const match = header
          ? (await metaSecrets("metaAppSecret")).find((s) =>
              verifyMetaSignature(buf, header, s.secret),
            )
          : undefined

        let event
        try {
          event = await deps.prisma.webhookEvent.create({
            data: {
              organizationId: match?.organizationId ?? null,
              source: "meta",
              // Meta has no delivery id; a retry resends the same bytes, so hash them.
              dedupeKey: match ? createHash("sha256").update(buf).digest("hex") : null,
              headers: safeHeaders(c.req.raw.headers),
              payload: json as Prisma.InputJsonValue,
              signatureValid: Boolean(match),
            },
          })
        } catch (err) {
          if ((err as { code?: string }).code === "P2002") return c.text("EVENT_RECEIVED", 200)
          throw err
        }
        if (!match) {
          deps.logger.warn({ webhookEventId: event.id }, "meta webhook failed signature check")
          return c.json({ error: "Bad signature" }, 401)
        }
        await deps.jobs.enqueueIngest({
          kind: "webhook",
          organizationId: match.organizationId,
          webhookEventId: event.id,
          requestId: c.get("requestId"),
        })
        return c.text("EVENT_RECEIVED", 200)
      })

      .post("/google", async (c) => {
        const text = await c.req.text()
        if (text.length > MAX_BODY_BYTES) return c.json({ error: "Too large" }, 413)
        let json: unknown
        try {
          json = JSON.parse(text)
        } catch {
          return c.json({ error: "Invalid JSON" }, 400)
        }
        const push = pubsubPushSchema.safeParse(json)
        if (!push.success) return c.json({ error: "Not a Pub/Sub push" }, 400)

        const bearer = /^Bearer (.+)$/i.exec(c.req.header("authorization") ?? "")?.[1]
        const match = bearer ? await verifyGooglePush(bearer) : null
        const messageId = push.data.message.messageId ?? push.data.message.message_id ?? null

        let event
        try {
          event = await deps.prisma.webhookEvent.create({
            data: {
              organizationId: match?.organizationId ?? null,
              source: "google",
              dedupeKey: match && messageId ? messageId : null,
              headers: safeHeaders(c.req.raw.headers),
              payload: json as Prisma.InputJsonValue,
              signatureValid: Boolean(match),
            },
          })
        } catch (err) {
          // Same messageId again (Pub/Sub redelivery): already stored, just acknowledge.
          if ((err as { code?: string }).code === "P2002") return c.body(null, 204)
          throw err
        }
        if (!match) {
          deps.logger.warn({ webhookEventId: event.id }, "google push failed verification")
          return c.json({ error: "Unauthorized" }, 401)
        }
        await deps.jobs.enqueueIngest({
          kind: "webhook",
          organizationId: match.organizationId,
          webhookEventId: event.id,
          requestId: c.get("requestId"),
        })
        return c.body(null, 204)
      })
  )
}
