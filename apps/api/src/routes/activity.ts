import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import {
  JOB_STATES,
  auditQuerySchema,
  activityQuerySchema,
  can,
  type Platform,
  jobsQuerySchema,
  type AuditEntryDto,
  type JobDto,
  type JobState,
  type Paged,
  type WebhookEventDto,
} from "@inbox/core"
import type { Prisma, PrismaClient } from "@inbox/db"
import type { JobSender } from "../lib/jobs"
import { validate } from "../lib/validate"
import { requireAuth, requirePermission, visiblePlatforms } from "../middleware/session"
import type { AppEnv } from "../types"

export interface ActivityRouteDeps {
  prisma: PrismaClient
  jobs: JobSender
}

interface JobRow {
  id: string
  name: string
  state: string
  data: unknown
  output: unknown
  retry_count: number
  retry_limit: number
  created_on: Date
  started_on: Date | null
  completed_on: Date | null
}

/** Strip server-internal ids before job data reaches the browser. */
function publicJobData(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object") return {}
  const { organizationId: _org, ...rest } = data as Record<string, unknown>
  return rest
}

/** pg-boss stores a thrown error as `{ name, message, stack }`; keep the message only. */
function publicJobOutput(output: unknown): unknown {
  if (output && typeof output === "object" && "message" in output) {
    const o = output as { name?: unknown; message?: unknown }
    return { error: String(o.message ?? ""), ...(o.name ? { name: String(o.name) } : {}) }
  }
  return output ?? null
}

function page<T>(rows: T[], offset: number, limit: number): Paged<T> {
  const more = rows.length > limit
  return {
    entries: more ? rows.slice(0, limit) : rows,
    nextCursor: more ? String(offset + limit) : null,
  }
}

/** Activity log: audit entries, background jobs (pg-boss) and webhook deliveries. */
export function activityRoutes({ prisma }: ActivityRouteDeps) {
  return new Hono<AppEnv>()
    .use("*", requireAuth, requirePermission({ activity: ["read"] }))

    .get("/audit", validate("query", auditQuerySchema), async (c) => {
      const org = c.get("org")!
      const q = c.req.valid("query")
      const offset = q.cursor ?? 0
      const rows = await prisma.auditLog.findMany({
        where: { organizationId: org.id, ...(q.entity ? { entity: q.entity } : {}) },
        orderBy: { createdAt: "desc" },
        skip: offset,
        take: q.limit + 1,
      })
      const actorIds = [...new Set(rows.map((r) => r.actorId).filter((id): id is string => !!id))]
      const users = actorIds.length
        ? await prisma.user.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, name: true, email: true },
          })
        : []
      const byId = new Map(users.map((u) => [u.id, u]))
      const entries: AuditEntryDto[] = rows.map((r) => {
        const u = r.actorId ? byId.get(r.actorId) : undefined
        return {
          id: r.id,
          action: r.action,
          entity: r.entity,
          entityId: r.entityId,
          actor: r.actorId
            ? {
                id: r.actorId,
                name: u?.name ?? (r.actorId === "dev-preview-user" ? "Preview (no login)" : null),
                email: u?.email ?? null,
              }
            : null,
          before: r.before,
          after: r.after,
          createdAt: r.createdAt.toISOString(),
        }
      })
      return c.json(page(entries, offset, q.limit))
    })

    .get("/jobs", validate("query", jobsQuerySchema), async (c) => {
      const org = c.get("org")!
      const q = c.req.valid("query")
      const offset = q.cursor ?? 0
      const params: unknown[] = [org.id]
      let where = `data->>'organizationId' = $1`
      if (q.state) {
        params.push(q.state)
        where += ` AND state::text = $${params.length}`
      }
      if (q.queue) {
        params.push(q.queue)
        where += ` AND name = $${params.length}`
      }
      params.push(q.limit + 1, offset)
      let rows: JobRow[] = []
      try {
        rows = await prisma.$queryRawUnsafe<JobRow[]>(
          `SELECT id::text, name, state::text AS state, data, output, retry_count, retry_limit,
                  created_on, started_on, completed_on
           FROM pgboss.job WHERE ${where}
           ORDER BY created_on DESC
           LIMIT $${params.length - 1}::int OFFSET $${params.length}::int`,
          ...params,
        )
      } catch (err) {
        // The pgboss schema appears once the worker has started; until then there are no jobs.
        if (!String((err as Error).message).includes("does not exist")) throw err
      }
      const entries: JobDto[] = rows.map((r) => ({
        id: r.id,
        queue: r.name,
        state: (JOB_STATES as readonly string[]).includes(r.state)
          ? (r.state as JobState)
          : "created",
        data: publicJobData(r.data),
        output: publicJobOutput(r.output),
        retryCount: r.retry_count,
        retryLimit: r.retry_limit,
        createdOn: r.created_on.toISOString(),
        startedOn: r.started_on?.toISOString() ?? null,
        completedOn: r.completed_on?.toISOString() ?? null,
      }))
      return c.json(page(entries, offset, q.limit))
    })

    .get("/webhooks", validate("query", activityQuerySchema), async (c) => {
      const org = c.get("org")!
      const q = c.req.valid("query")
      const offset = q.cursor ?? 0
      // Deliveries that couldn't be matched to an organization (e.g. a bad signature) are
      // shown to admins too: in a single-workspace install they're this workspace's.
      const sources = webhookSourcesFor(visiblePlatforms(org))
      const where: Prisma.WebhookEventWhereInput = {
        source: { in: sources },
        ...(can(org.permissions, { activity: ["replay"] })
          ? { OR: [{ organizationId: org.id }, { organizationId: null }] }
          : { organizationId: org.id }),
      }
      const rows = await prisma.webhookEvent.findMany({
        where,
        orderBy: { receivedAt: "desc" },
        skip: offset,
        take: q.limit + 1,
      })
      const entries: WebhookEventDto[] = rows.map((r) => ({
        id: r.id,
        source: r.source,
        dedupeKey: r.dedupeKey,
        signatureValid: r.signatureValid,
        receivedAt: r.receivedAt.toISOString(),
        processedAt: r.processedAt?.toISOString() ?? null,
        error: r.error,
        attempts: r.attempts,
        payload: r.payload,
      }))
      return c.json(page(entries, offset, q.limit))
    })
}

/** Webhook sources whose deliveries can carry items from these platforms. */
function webhookSourcesFor(platforms: Platform[]): string[] {
  const has = (...p: Platform[]) => p.some((x) => platforms.includes(x))
  return [
    ...(has("facebook", "instagram") ? ["meta"] : []),
    ...(has("google_business", "youtube") ? ["google"] : []),
    ...(has("linkedin") ? ["linkedin"] : []),
  ]
}

/** POST /api/webhooks/:id/replay: re-run a stored delivery through the ingest queue. */
export function webhookAdminRoutes({ prisma, jobs }: ActivityRouteDeps) {
  return new Hono<AppEnv>().post(
    "/:id/replay",
    requireAuth,
    requirePermission({ activity: ["replay"] }),
    validate("param", z.object({ id: z.string().min(1) })),
    async (c) => {
      const org = c.get("org")!
      const { id } = c.req.valid("param")
      const event = await prisma.webhookEvent.findFirst({
        where: { id, OR: [{ organizationId: org.id }, { organizationId: null }] },
      })
      if (!event || !webhookSourcesFor(visiblePlatforms(org)).includes(event.source)) {
        throw new HTTPException(404, { message: "Webhook event not found" })
      }
      if (!event.signatureValid) {
        throw new HTTPException(409, {
          message: "This delivery failed signature verification, so it can't be replayed",
        })
      }
      await prisma.webhookEvent.update({
        where: { id },
        data: { error: null, processedAt: null },
      })
      await jobs.enqueueIngest({
        kind: "webhook",
        organizationId: event.organizationId ?? org.id,
        webhookEventId: id,
        replay: true,
        requestId: c.get("requestId"),
      })
      await prisma.auditLog.create({
        data: {
          organizationId: org.id,
          actorId: c.get("user")!.id,
          action: "webhook.replay",
          entity: "webhook_event",
          entityId: id,
          after: { source: event.source },
        },
      })
      return c.json({ queued: true }, 202)
    },
  )
}
