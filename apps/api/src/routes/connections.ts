import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import {
  ACCOUNT_KINDS,
  connectionPatchSchema,
  parseSectionSecrets,
  parseSectionValues,
  platformSchema,
  type ConnectionDto,
  type ConnectionsResponse,
} from "@inbox/core"
import type { Keyring } from "@inbox/core/crypto"
import type { PrismaClient } from "@inbox/db"
import {
  GoogleApiError,
  googleAccessToken,
  isDemoAccount,
  listGbpReviews,
  loadSettingsSection,
  notifyInbox,
  v4LocationPath,
} from "@inbox/pipeline"
import { validate } from "../lib/validate"
import { requireAuth, requireRole } from "../middleware/session"
import type { AppEnv } from "../types"

const accountKindSchema = z.enum(ACCOUNT_KINDS)
const idParam = z.object({ id: z.string().min(1) })

function str(meta: unknown, key: string): string | null {
  if (!meta || typeof meta !== "object") return null
  const v = (meta as Record<string, unknown>)[key]
  return typeof v === "string" && v ? v : null
}

/** GET /api/connections, PATCH /:id (include/exclude), POST /:id/{test,disconnect}. */
export function connectionRoutes({ prisma, keyring }: { prisma: PrismaClient; keyring: Keyring }) {
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

  return (
    new Hono<AppEnv>()
      .use("*", requireAuth)

      .get("/", async (c) => {
        const org = c.get("org")!
        const [rows, settings] = await Promise.all([
          prisma.platformAccount.findMany({
            where: { organizationId: org.id },
            orderBy: [{ platform: "asc" }, { displayName: "asc" }],
          }),
          prisma.settings.findUnique({
            where: { organizationId: org.id },
            select: { connections: true },
          }),
        ])
        const values = parseSectionValues("connections", settings?.connections)
        const secrets = parseSectionSecrets("connections", settings?.connections)
        const accounts: ConnectionDto[] = rows.map((r) => ({
          id: r.id,
          platform: platformSchema.parse(r.platform),
          kind: accountKindSchema.parse(r.kind),
          displayName: r.displayName,
          parentName: str(r.meta, "accountDisplayName"),
          status: r.status,
          included: r.included,
          lastError: r.lastError,
          lastErrorAt: r.lastErrorAt?.toISOString() ?? null,
          tokenExpiresAt: r.tokenExpiresAt?.toISOString() ?? null,
          demo: isDemoAccount(r),
          url: str(r.meta, "mapsUri"),
          createdAt: r.createdAt.toISOString(),
        }))
        const body: ConnectionsResponse = {
          accounts,
          configured: {
            google: Boolean(values.google.clientId && secrets.googleClientSecret),
            meta: Boolean(values.meta.appId && secrets.metaAppSecret),
            linkedin: Boolean(values.linkedin.clientId && secrets.linkedinClientSecret),
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
        if (account.platform !== "google_business") {
          throw new HTTPException(409, { message: "Testing this platform arrives with its phase" })
        }
        try {
          const token = await googleAccessToken(prisma, keyring, account)
          const { google } = await loadSettingsSection(prisma, org.id, "connections")
          const accountName = str(account.meta, "accountName")
          if (!accountName)
            throw new Error("Missing the Google account for this location: reconnect it")
          const list = await listGbpReviews(token, {
            baseUrl: google.reviewsBaseUrl,
            locationPath: v4LocationPath(accountName, account.externalId),
          })
          if (account.status === "error") {
            await prisma.platformAccount.update({
              where: { id },
              data: { status: "connected", lastError: null },
            })
          }
          return c.json({
            ok: true,
            message: `Connected. ${list.totalReviewCount ?? 0} reviews, average ${list.averageRating?.toFixed(1) ?? "–"}★.`,
          })
        } catch (err) {
          const message =
            err instanceof GoogleApiError || err instanceof Error ? err.message : String(err)
          return c.json({ ok: false, message }, 200)
        }
      })

      // Stops syncing and forgets the tokens. Other locations from the same Google grant keep
      // working, so the grant itself isn't revoked here (remove access in the Google account).
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
