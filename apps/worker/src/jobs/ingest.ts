import type { PgBoss } from "pg-boss"
import { QUEUES, type IngestJobData } from "@inbox/core"
import type { Logger } from "@inbox/core/logger"
import type { PrismaClient, WebhookEvent } from "@inbox/db"
import { BURSTY_QUEUE_WORK } from "../boss"

/**
 * Turns one stored webhook delivery into inbox items. Registered per source as each platform
 * phase lands (Google in Phase 4, Meta in 5 and 7, LinkedIn in 9).
 */
export type WebhookHandler = (ctx: {
  prisma: PrismaClient
  boss: PgBoss
  logger: Logger
  event: WebhookEvent
}) => Promise<Record<string, unknown>>

const PHASE_FOR_SOURCE: Record<string, number> = { google: 4, meta: 5, linkedin: 9, slack: 8 }
const handlers = new Map<string, WebhookHandler>()

export function registerWebhookHandler(source: string, handler: WebhookHandler): void {
  handlers.set(source, handler)
}

/**
 * `ingest` queue: process a stored WebhookEvent (new deliveries and "Replay" from the
 * Activity log). The outcome is recorded on the event so the Activity log shows it.
 */
export async function registerIngestWorker(boss: PgBoss, prisma: PrismaClient, logger: Logger) {
  await boss.work<IngestJobData>(QUEUES.ingest, BURSTY_QUEUE_WORK, async ([job]) => {
    if (!job) return
    const log = logger.child({
      jobId: job.id,
      queue: QUEUES.ingest,
      webhookEventId: job.data.webhookEventId,
      requestId: job.data.requestId,
    })
    const event = await prisma.webhookEvent.findUnique({ where: { id: job.data.webhookEventId } })
    if (!event) {
      log.warn("webhook event no longer exists; skipping")
      return { skipped: "deleted" }
    }

    const handler = handlers.get(event.source)
    if (!handler) {
      const phase = PHASE_FOR_SOURCE[event.source]
      const error = `No handler for ${event.source} webhooks yet${phase ? ` (arrives in Phase ${phase})` : ""}`
      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: { attempts: { increment: 1 }, error },
      })
      log.warn({ source: event.source }, error)
      return { skipped: "no-handler", error }
    }

    try {
      const result = await handler({ prisma, boss, logger: log, event })
      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: { attempts: { increment: 1 }, processedAt: new Date(), error: null },
      })
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: { attempts: { increment: 1 }, error: message.slice(0, 1000) },
      })
      throw err
    }
  })
}
