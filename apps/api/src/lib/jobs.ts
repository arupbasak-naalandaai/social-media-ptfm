import { PgBoss } from "pg-boss"
import { QUEUES, type FilterJobData } from "@inbox/core"
import type { Logger } from "@inbox/core/logger"

/** Send-only side of the queues (the worker owns maintenance, scheduling and processing). */
export interface JobSender {
  enqueueRefilter(organizationId: string, requestId?: string): Promise<void>
  stop(): Promise<void>
}

export async function createJobSender(
  connectionString: string,
  logger: Logger,
): Promise<JobSender> {
  const boss = new PgBoss({ connectionString, schema: "pgboss", supervise: false, schedule: false })
  boss.on("error", (err) => logger.error({ err }, "pg-boss (api) error"))
  await boss.start()
  return {
    async enqueueRefilter(organizationId, requestId) {
      const data: FilterJobData = { kind: "refilter", organizationId, requestId }
      await boss.send(QUEUES.filter, data)
    },
    async stop() {
      await boss.stop({ graceful: false })
    },
  }
}

/** For tests and environments without a queue. */
export const noopJobSender: JobSender = { enqueueRefilter: async () => {}, stop: async () => {} }
