import type { PgBoss } from "pg-boss"
import { QUEUES, type MaintenanceJobData, type TokenRefreshJobData } from "@inbox/core"
import type { Logger } from "@inbox/core/logger"
import type { PrismaClient } from "@inbox/db"
import { applyRetention, checkTokenExpiry, ensureSyncStates, notifyInbox } from "@inbox/pipeline"

/**
 * `token-refresh` queue: flags connections whose tokens are about to expire (or have), and
 * creates any missing sync schedules. Platform-specific token renewal is added per platform.
 */
export async function registerTokenRefreshWorker(
  boss: PgBoss,
  prisma: PrismaClient,
  logger: Logger,
) {
  await boss.work<TokenRefreshJobData>(QUEUES.tokenRefresh, { batchSize: 1 }, async ([job]) => {
    if (!job) return
    const { organizationId } = job.data
    const log = logger.child({ jobId: job.id, queue: QUEUES.tokenRefresh, orgId: organizationId })
    const created = await ensureSyncStates(prisma, organizationId)
    const result = await checkTokenExpiry(prisma, organizationId)
    if (created) {
      const ids = await prisma.syncState.findMany({
        where: { organizationId },
        select: { id: true },
      })
      await notifyInbox(prisma, {
        type: "sync.changed",
        organizationId,
        syncStateIds: ids.map((s) => s.id),
      })
    }
    log.debug({ syncStatesCreated: created, ...result }, "token check done")
    return {
      syncStatesCreated: created,
      expiring: result.expiring.length,
      expired: result.expired.length,
    }
  })
}

/** `maintenance` queue: data retention (Settings → Data). */
export async function registerMaintenanceWorker(
  boss: PgBoss,
  prisma: PrismaClient,
  logger: Logger,
) {
  await boss.work<MaintenanceJobData>(QUEUES.maintenance, { batchSize: 1 }, async ([job]) => {
    if (!job) return
    const { organizationId } = job.data
    const result = await applyRetention(prisma, organizationId)
    logger.info(
      { jobId: job.id, queue: QUEUES.maintenance, orgId: organizationId, ...result },
      "retention applied",
    )
    return result
  })
}
