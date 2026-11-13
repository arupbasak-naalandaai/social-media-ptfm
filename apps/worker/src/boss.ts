import { PgBoss } from "pg-boss"
import { QUEUE_CONFIG, deadLetterQueueName } from "@inbox/core"
import type { Logger } from "@inbox/core/logger"

/** Starts pg-boss (creates/migrates its own `pgboss` schema) and ensures every queue exists. */
export async function startBoss(connectionString: string, logger: Logger): Promise<PgBoss> {
  // LISTEN/NOTIFY wakes workers as soon as a job is sent (polling stays as a backstop).
  const boss = new PgBoss({ connectionString, schema: "pgboss", useListenNotify: true })
  boss.on("error", (err) => logger.error({ err }, "pg-boss error"))
  boss.on("warning", (warning) => logger.warn({ warning }, "pg-boss warning"))
  await boss.start()

  for (const q of QUEUE_CONFIG) {
    const dlq = deadLetterQueueName(q.name)
    await upsertQueue(boss, dlq, {})
    await upsertQueue(boss, q.name, {
      policy: q.policy,
      retryLimit: q.retryLimit,
      retryDelay: q.retryDelay,
      retryBackoff: true,
      retryDelayMax: q.retryDelayMax,
      deadLetter: dlq,
      notify: true,
    })
  }
  logger.info({ queues: QUEUE_CONFIG.map((q) => q.name) }, "pg-boss started; queues ready")
  return boss
}

type QueueOptions = Parameters<PgBoss["createQueue"]>[1]

async function upsertQueue(boss: PgBoss, name: string, options: QueueOptions): Promise<void> {
  const existing = await boss.getQueue(name)
  if (existing) {
    // Policy can't change after creation; retry settings can.
    const { policy: _policy, ...updatable } = options ?? {}
    if (Object.keys(updatable).length > 0) await boss.updateQueue(name, updatable)
  } else {
    await boss.createQueue(name, options)
  }
}

/**
 * Worker options for queues that get many jobs at once (the scheduler leases up to 50 polls per
 * tick). A NOTIFY wakes each worker for a single fetch and the backstop poll defaults to 30 s,
 * so without these a backlog drains at about one job per wake.
 */
export const BURSTY_QUEUE_WORK = {
  batchSize: 1,
  localConcurrency: 4,
  notifyPollingIntervalSeconds: 2,
} as const
