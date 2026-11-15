import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import {
  ACCOUNT_KINDS,
  estimateYoutubeDailyUnits,
  parseSectionValues,
  platformSchema,
  syncModeSchema,
  syncStreamKeyFor,
  youtubeQuotaDay,
  type SyncListResponse,
  type SyncStateDto,
} from "@inbox/core"
import type { PrismaClient } from "@inbox/db"
import { claimSyncState, isSchedulable, notifyInbox } from "@inbox/pipeline"
import type { JobSender } from "../lib/jobs"
import { validate } from "../lib/validate"
import { requireAuth, requirePermission, visiblePlatforms } from "../middleware/session"
import type { AppEnv } from "../types"

export interface SyncRouteDeps {
  prisma: PrismaClient
  jobs: JobSender
}

const accountKindSchema = z.enum(ACCOUNT_KINDS)

function isDemo(meta: unknown): boolean {
  return Boolean(meta && typeof meta === "object" && (meta as { demo?: unknown }).demo === true)
}

/** GET /api/sync (status of every schedule), POST /api/sync/:id/run ("Run now"). */
export function syncRoutes({ prisma, jobs }: SyncRouteDeps) {
  return new Hono<AppEnv>()
    .use("*", requireAuth, requirePermission({ connection: ["read"] }))

    .get("/", async (c) => {
      const org = c.get("org")!
      const [settings, rows] = await Promise.all([
        prisma.settings.findUnique({ where: { organizationId: org.id }, select: { sync: true } }),
        prisma.syncState.findMany({
          where: {
            organizationId: org.id,
            platformAccount: { platform: { in: visiblePlatforms(org) } },
          },
          include: {
            platformAccount: {
              select: {
                id: true,
                displayName: true,
                platform: true,
                kind: true,
                status: true,
                included: true,
                meta: true,
              },
            },
          },
          orderBy: [{ platformAccount: { platform: "asc" } }, { stream: "asc" }],
        }),
      ])
      const sync = parseSectionValues("sync", settings?.sync)
      const now = new Date()
      const today = youtubeQuotaDay(now)

      const states: SyncStateDto[] = rows.flatMap((r) => {
        const stream = syncStreamKeyFor(r.platformAccount.platform, r.stream)
        if (!stream) return []
        const account = r.platformAccount
        const demo = isDemo(account.meta)
        return [
          {
            id: r.id,
            stream,
            account: {
              id: account.id,
              displayName: account.displayName,
              platform: platformSchema.parse(account.platform),
              kind: accountKindSchema.parse(account.kind),
              status: account.status,
              included: account.included,
              demo,
            },
            mode: syncModeSchema.parse(r.mode),
            intervalSeconds: r.intervalSeconds,
            lastRunAt: r.lastRunAt?.toISOString() ?? null,
            nextRunAt: r.nextRunAt.toISOString(),
            lastSuccessAt: r.lastSuccessAt?.toISOString() ?? null,
            consecutiveFailures: r.consecutiveFailures,
            lastError: r.lastError,
            quotaUsedToday: r.quotaDay?.toISOString().slice(0, 10) === today ? r.quotaUsedToday : 0,
            running: Boolean(r.lockedUntil && r.lockedUntil > now),
            scheduled: isSchedulable({
              mode: r.mode,
              included: account.included,
              status: account.status,
              demo,
              paused: sync.paused,
            }),
          },
        ]
      })

      const ytStates = states.filter((s) => s.stream === "yt_comments" && s.account.included)
      const body: SyncListResponse = {
        paused: sync.paused,
        states,
        youtube: {
          dailyQuota: sync.youtube.dailyQuota,
          estimatedDailyUnits: estimateYoutubeDailyUnits({
            intervalMinutes: sync.streams.yt_comments.intervalMinutes,
            channels: new Set(ytStates.map((s) => s.account.id)).size,
            pagesPerPoll: sync.youtube.pagesPerPoll,
          }),
          usedToday: ytStates.reduce((sum, s) => sum + s.quotaUsedToday, 0),
        },
      }
      return c.json(body)
    })

    .post(
      "/:id/run",
      requirePermission({ connection: ["manage"] }),
      validate("param", z.object({ id: z.string().min(1) })),
      async (c) => {
        const org = c.get("org")!
        const { id } = c.req.valid("param")
        const state = await prisma.syncState.findFirst({
          where: {
            id,
            organizationId: org.id,
            platformAccount: { platform: { in: visiblePlatforms(org) } },
          },
          include: { platformAccount: { select: { status: true, meta: true } } },
        })
        if (!state) throw new HTTPException(404, { message: "Sync schedule not found" })
        if (
          state.platformAccount.status === "disconnected" &&
          !isDemo(state.platformAccount.meta)
        ) {
          throw new HTTPException(409, { message: "Reconnect this account before syncing it" })
        }
        const settings = await prisma.settings.findUnique({
          where: { organizationId: org.id },
          select: { sync: true },
        })
        if (parseSectionValues("sync", settings?.sync).paused) {
          throw new HTTPException(409, { message: "Syncing is paused in Settings → Sync" })
        }
        if (!(await claimSyncState(prisma, id))) {
          throw new HTTPException(409, { message: "A sync is already running for this stream" })
        }
        await jobs.enqueuePoll({
          organizationId: org.id,
          syncStateId: id,
          trigger: "manual",
          requestId: c.get("requestId"),
        })
        await prisma.auditLog.create({
          data: {
            organizationId: org.id,
            actorId: c.get("user")!.id,
            action: "sync.run",
            entity: "sync_state",
            entityId: id,
          },
        })
        await notifyInbox(prisma, {
          type: "sync.changed",
          organizationId: org.id,
          syncStateIds: [id],
        })
        return c.json({ queued: true }, 202)
      },
    )
}
