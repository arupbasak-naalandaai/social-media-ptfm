import type { PgBoss } from "pg-boss"
import { QUEUES, type SendReplyJobData } from "@inbox/core"
import type { Keyring } from "@inbox/core/crypto"
import type { Logger } from "@inbox/core/logger"
import type { PrismaClient } from "@inbox/db"
import { notifyInbox, sendQueuedReply } from "@inbox/pipeline"
import { senderResolver } from "../sync/senders"

/**
 * `send-reply` queue: post one reply to its platform. The job starts after the undo window
 * (`startAfter`); a reply cancelled in that window no longer exists and is skipped.
 * See `sendQueuedReply` for the double-post rules.
 */
export async function registerSendReplyWorker(
  boss: PgBoss,
  prisma: PrismaClient,
  keyring: Keyring,
  logger: Logger,
) {
  const senderFor = senderResolver({ prisma, keyring })
  // Metadata gives retryCount/retryLimit, so the last attempt can mark the reply failed.
  const options = {
    batchSize: 1,
    includeMetadata: true,
    localConcurrency: 2,
    notifyPollingIntervalSeconds: 2,
  } as const
  await boss.work<SendReplyJobData, unknown, typeof options>(
    QUEUES.sendReply,
    options,
    async ([job]) => {
      if (!job) return
      const { organizationId, replyId } = job.data
      const log = logger.child({
        jobId: job.id,
        queue: QUEUES.sendReply,
        orgId: organizationId,
        replyId,
        requestId: job.data.requestId,
      })
      const result = await sendQueuedReply(prisma, {
        replyId,
        senderFor,
        lastAttempt: job.retryCount >= job.retryLimit,
      })
      if (result.outcome === "skipped") {
        log.debug({ reason: result.reason }, "reply skipped")
        return result
      }
      const reply = await prisma.reply.findUnique({
        where: { id: replyId },
        select: { itemId: true },
      })
      if (reply) {
        await notifyInbox(prisma, {
          type: "items.changed",
          organizationId,
          itemIds: result.outcome === "sent" ? result.itemIds : [reply.itemId],
          reason: result.outcome === "sent" ? "replied" : "reply_failed",
        })
      }
      if (result.outcome === "failed") {
        log.warn({ error: result.error, retry: result.retry }, "reply failed")
        if (result.retry) throw new Error(result.error)
        return result
      }
      log.info({ externalReplyId: result.externalReplyId }, "reply sent")
      return result
    },
  )
}
