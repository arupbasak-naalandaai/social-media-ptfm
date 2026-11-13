import { PgBoss } from "pg-boss"
import {
  QUEUES,
  type AiDraftJobData,
  type FilterJobData,
  type IngestJobData,
  type PollJobData,
  type SendReplyJobData,
} from "@inbox/core"
import type { Logger } from "@inbox/core/logger"
import type { PrismaClient } from "@inbox/db"
import { loadSettingsSection } from "@inbox/pipeline"

/** Send-only side of the queues (the worker owns maintenance, scheduling and processing). */
export interface JobSender {
  enqueueRefilter(organizationId: string, requestId?: string): Promise<void>
  /** "Run now" for one sync state (already leased by the caller). */
  enqueuePoll(data: PollJobData): Promise<void>
  /** Replay a stored webhook event through the ingest queue. */
  enqueueIngest(data: IngestJobData): Promise<void>
  /** Draft replies for one item (deduplicated per item for a minute unless forced). */
  enqueueAiDraft(data: AiDraftJobData): Promise<void>
  /** Send a queued reply once the undo window has passed. */
  enqueueSendReply(data: SendReplyJobData, afterSeconds: number): Promise<void>
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
    async enqueuePoll(data) {
      await boss.send(QUEUES.poll, data, { singletonKey: data.syncStateId })
    },
    async enqueueIngest(data) {
      await boss.send(QUEUES.ingest, data)
    },
    async enqueueAiDraft(data) {
      await boss.send(
        QUEUES.aiDraft,
        data,
        data.force ? {} : { singletonKey: data.itemId, singletonSeconds: 60 },
      )
    },
    async enqueueSendReply(data, afterSeconds) {
      await boss.send(QUEUES.sendReply, data, {
        singletonKey: data.replyId,
        ...(afterSeconds > 0 ? { startAfter: afterSeconds } : {}),
      })
    },
    async stop() {
      await boss.stop({ graceful: false })
    },
  }
}

/** For tests and environments without a queue. */
export const noopJobSender: JobSender = {
  enqueueRefilter: async () => {},
  enqueuePoll: async () => {},
  enqueueIngest: async () => {},
  enqueueAiDraft: async () => {},
  enqueueSendReply: async () => {},
  stop: async () => {},
}

/** Settings → Filters → "Re-apply rules automatically" (default on). */
export async function autoRefilterEnabled(
  prisma: PrismaClient,
  organizationId: string,
): Promise<boolean> {
  const filters = await loadSettingsSection(prisma, organizationId, "filters")
  return filters.autoRefilter
}
