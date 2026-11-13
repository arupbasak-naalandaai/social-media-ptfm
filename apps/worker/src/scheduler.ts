/**
 * DB-driven scheduler (PLAN §12). Every tick:
 * 1. Lease due SyncState rows (`FOR UPDATE SKIP LOCKED`) and enqueue one `poll` job each.
 * 2. Enqueue each organization's periodic jobs (token check, data retention). pg-boss throttles
 *    them per organization (`singletonKey` + `singletonSeconds`), so any number of ticks, from
 *    any number of worker replicas, creates at most one job per window.
 *
 * Intervals live in the database (Settings → Sync), so a changed interval applies at the next
 * tick without a restart or redeploy.
 */
import type { PgBoss } from "pg-boss"
import {
  QUEUES,
  parseSectionValues,
  type MaintenanceJobData,
  type PollJobData,
  type TokenRefreshJobData,
} from "@inbox/core"
import type { Logger } from "@inbox/core/logger"
import type { PrismaClient } from "@inbox/db"
import { claimDueSyncStates } from "@inbox/pipeline"

export const TICK_MS = 30_000
const MAINTENANCE_EVERY_SECONDS = 24 * 60 * 60

export interface TickResult {
  polls: number
  periodic: number
}

export async function schedulerTick(
  boss: PgBoss,
  prisma: PrismaClient,
  logger: Logger,
): Promise<TickResult> {
  const due = await claimDueSyncStates(prisma)
  for (const s of due) {
    const data: PollJobData = {
      organizationId: s.organizationId,
      syncStateId: s.id,
      trigger: "schedule",
    }
    await boss.send(QUEUES.poll, data, { singletonKey: s.id })
  }

  let periodic = 0
  const orgs = await prisma.organization.findMany({
    select: { id: true, settings: { select: { sync: true } } },
  })
  for (const org of orgs) {
    const sync = parseSectionValues("sync", org.settings?.sync)
    const token: TokenRefreshJobData = { organizationId: org.id }
    if (
      await boss.send(QUEUES.tokenRefresh, token, {
        singletonKey: org.id,
        singletonSeconds: sync.tokenRefreshHours * 3600,
      })
    ) {
      periodic++
    }
    const maintenance: MaintenanceJobData = { organizationId: org.id, kind: "retention" }
    if (
      await boss.send(QUEUES.maintenance, maintenance, {
        singletonKey: org.id,
        singletonSeconds: MAINTENANCE_EVERY_SECONDS,
      })
    ) {
      periodic++
    }
  }

  if (due.length || periodic) logger.debug({ polls: due.length, periodic }, "scheduler tick")
  return { polls: due.length, periodic }
}
