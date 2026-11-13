import type { PgBoss } from "pg-boss"
import { QUEUES, syncStreamKeyFor, type PollJobData } from "@inbox/core"
import type { Keyring } from "@inbox/core/crypto"
import type { Logger } from "@inbox/core/logger"
import type { PrismaClient } from "@inbox/db"
import {
  ingestNormalizedItem,
  loadFilterSetup,
  notifyInbox,
  recordPollResult,
} from "@inbox/pipeline"
import { BURSTY_QUEUE_WORK } from "../boss"
import { pollAdapterFor } from "../sync/adapters"
import { enqueueDraftsOnArrival } from "./ai-draft"

/**
 * `poll` queue: fetch new items for one SyncState, ingest them, and record the result
 * (lease cleared, next run scheduled with backoff). A failure is recorded on the SyncState
 * and rethrown so the job shows as failed in the Activity log; the scheduler (not pg-boss)
 * retries it, with backoff.
 */
export async function registerPollWorker(
  boss: PgBoss,
  prisma: PrismaClient,
  keyring: Keyring,
  logger: Logger,
) {
  await boss.work<PollJobData>(QUEUES.poll, BURSTY_QUEUE_WORK, async ([job]) => {
    if (!job) return
    const { organizationId, syncStateId } = job.data
    const log = logger.child({
      jobId: job.id,
      queue: QUEUES.poll,
      orgId: organizationId,
      syncStateId,
      requestId: job.data.requestId,
    })

    const state = await prisma.syncState.findFirst({
      where: { id: syncStateId, organizationId },
      include: { platformAccount: true },
    })
    if (!state) {
      log.warn("sync state no longer exists; skipping")
      return { skipped: "deleted" }
    }
    const stream = syncStreamKeyFor(state.platformAccount.platform, state.stream)

    let outcome: Parameters<typeof recordPollResult>[2]
    let created = 0
    try {
      if (!stream)
        throw new Error(`Unknown stream ${state.platformAccount.platform}/${state.stream}`)
      const adapter = pollAdapterFor(state.platformAccount, stream)
      const { platformAccount: account, ...syncState } = state
      const result = await adapter({
        prisma,
        keyring,
        logger: log,
        account,
        state: syncState,
        stream,
        signal: job.signal,
      })

      const itemIds: string[] = []
      const createdIds: string[] = []
      if (result.items.length) {
        const setup = await loadFilterSetup(prisma, organizationId, log)
        for (const item of result.items) {
          const res = await ingestNormalizedItem(prisma, {
            organizationId,
            platformAccountId: account.id,
            item,
            setup,
          })
          if (res.outcome === "created" || res.outcome === "updated") itemIds.push(res.itemId)
          if (res.outcome === "created") {
            created++
            createdIds.push(res.itemId)
          }
        }
      }
      if (itemIds.length) {
        await notifyInbox(prisma, {
          type: "items.changed",
          organizationId,
          itemIds,
          reason: "synced",
        })
      }
      await enqueueDraftsOnArrival(boss, prisma, organizationId, createdIds)
      outcome = { ok: true, cursor: result.cursor, quotaUnits: result.quotaUnits }
    } catch (err) {
      outcome = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    await recordPollResult(prisma, syncStateId, outcome)
    await notifyInbox(prisma, {
      type: "sync.changed",
      organizationId,
      syncStateIds: [syncStateId],
    })

    if (!outcome.ok) {
      log.warn({ error: outcome.error }, "poll failed")
      throw new Error(outcome.error)
    }
    log.debug({ created, trigger: job.data.trigger }, "poll done")
    return { created, fetched: created }
  })
}
