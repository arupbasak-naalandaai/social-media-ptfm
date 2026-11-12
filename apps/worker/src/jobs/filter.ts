import type { PgBoss } from "pg-boss"
import { QUEUES, type FilterJobData } from "@inbox/core"
import type { Logger } from "@inbox/core/logger"
import type { PrismaClient } from "@inbox/db"
import { notifyInbox, refilterOrganization } from "@inbox/pipeline"

/**
 * `filter` queue: re-run the rules over an organization's stored items after a rule or list
 * change. Idempotent (re-running yields the same state), processed one job at a time.
 */
export async function registerFilterWorker(boss: PgBoss, prisma: PrismaClient, logger: Logger) {
  await boss.work<FilterJobData>(QUEUES.filter, { batchSize: 1 }, async ([job]) => {
    if (!job) return
    const log = logger.child({ jobId: job.id, queue: QUEUES.filter, requestId: job.data.requestId })
    const { organizationId } = job.data
    const result = await refilterOrganization(prisma, organizationId, log)
    await notifyInbox(prisma, {
      type: "items.refiltered",
      organizationId,
      changed: result.changed,
      examined: result.examined,
    })
    if (result.changed > 0) {
      await notifyInbox(prisma, {
        type: "items.changed",
        organizationId,
        itemIds: result.changedIds,
        reason: "refiltered",
      })
    }
  })
}
