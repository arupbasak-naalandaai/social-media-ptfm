import type { PgBoss } from "pg-boss"
import { QUEUES, type AiDraftJobData } from "@inbox/core"
import type { Keyring } from "@inbox/core/crypto"
import type { Logger } from "@inbox/core/logger"
import type { PrismaClient } from "@inbox/db"
import {
  draftRepliesForItem,
  isPermanentAiError,
  loadSettingsSection,
  notifyInbox,
} from "@inbox/pipeline"

/**
 * `ai-draft` queue: draft replies for one item with the configured provider. Transient
 * provider errors (429, 5xx, timeouts) retry with backoff; a bad key or model fails at once.
 */
export async function registerAiDraftWorker(
  boss: PgBoss,
  prisma: PrismaClient,
  keyring: Keyring,
  logger: Logger,
) {
  await boss.work<AiDraftJobData>(
    QUEUES.aiDraft,
    { batchSize: 1, localConcurrency: 2, notifyPollingIntervalSeconds: 2 },
    async ([job]) => {
      if (!job) return
      const { organizationId, itemId } = job.data
      const log = logger.child({
        jobId: job.id,
        queue: QUEUES.aiDraft,
        orgId: organizationId,
        itemId,
        requestId: job.data.requestId,
      })
      try {
        const result = await draftRepliesForItem(prisma, keyring, {
          organizationId,
          itemId,
          force: job.data.force,
          abortSignal: job.signal,
        })
        if (result.outcome === "drafted") {
          await notifyInbox(prisma, {
            type: "items.changed",
            organizationId,
            itemIds: [itemId],
            reason: "drafted",
          })
        }
        log.debug(result, "ai draft")
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.warn({ err: message }, "ai draft failed")
        if (isPermanentAiError(err)) {
          // Retrying won't fix a bad key or model: finish with the reason (Activity → Jobs).
          return {
            outcome: "error",
            permanent: true,
            error: `Provider rejected the request: ${message}`,
          }
        }
        throw err
      }
    },
  )
}

/** Enqueue drafts for newly arrived items when Settings → AI replies drafts on arrival. */
export async function enqueueDraftsOnArrival(
  boss: PgBoss,
  prisma: PrismaClient,
  organizationId: string,
  itemIds: string[],
): Promise<number> {
  if (itemIds.length === 0) return 0
  const ai = await loadSettingsSection(prisma, organizationId, "ai")
  if (!ai.enabled || ai.generateOn !== "arrival") return 0
  const items = await prisma.item.findMany({
    where: {
      id: { in: itemIds },
      organizationId,
      status: { in: ["new", "pending"] },
      aiDraftsAllowed: true,
      isOwnAccount: false,
    },
    select: { id: true },
  })
  for (const { id } of items) {
    const data: AiDraftJobData = { organizationId, itemId: id }
    // One pending draft job per item.
    await boss.send(QUEUES.aiDraft, data, { singletonKey: id, singletonSeconds: 60 })
  }
  return items.length
}
