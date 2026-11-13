/**
 * Google Business Profile in the worker: reviews polling (reconcile), the reply sender and the
 * Pub/Sub push handler. Registered at startup.
 */
import {
  QUEUES,
  locationIdOf,
  parseGbpNotification,
  pubsubPushSchema,
  type PollJobData,
} from "@inbox/core"
import {
  claimSyncState,
  fetchNewGbpReviews,
  GoogleApiError,
  googleAccessToken,
  loadSettingsSection,
  putGbpReply,
  ReplySendError,
} from "@inbox/pipeline"
import { registerWebhookHandler } from "../jobs/ingest"
import { registerPollAdapter } from "../sync/adapters"
import { registerReplySender } from "../sync/senders"

export function registerGoogle(): void {
  // Reviews: newest first (the API can't sort ascending), back to the cursor.
  registerPollAdapter(
    "gbp_reviews",
    async ({ prisma, keyring, account, state, signal, logger }) => {
      const res = await fetchNewGbpReviews(prisma, keyring, {
        account,
        cursor: state.cursor,
        backfillDays: state.backfillDays,
        signal,
      })
      if (!res.complete) {
        logger.warn("gbp reviews: over 1,000 reviews since the cursor; older ones were skipped")
      }
      return { items: res.items, cursor: res.cursor }
    },
  )

  // Replies: PUT replaces the owner reply, so a retry can't double-post.
  registerReplySender("google_business", ({ prisma, keyring }) => ({
    idempotent: true,
    async send({ reply, item, account }) {
      const raw = item.raw as { name?: unknown } | null
      const reviewName = typeof raw?.name === "string" ? raw.name : null
      if (!reviewName) throw new ReplySendError("This review has no Google resource name", false)
      try {
        const token = await googleAccessToken(prisma, keyring, account)
        const { google } = await loadSettingsSection(prisma, account.organizationId, "connections")
        await putGbpReply(token, {
          baseUrl: google.reviewsBaseUrl,
          reviewName,
          comment: reply.text,
        })
        return { externalReplyId: `${reviewName}/reply` }
      } catch (err) {
        if (err instanceof GoogleApiError) throw new ReplySendError(err.message, err.retryable)
        throw err
      }
    },
  }))

  // Pub/Sub push: a hint that a location changed. Run its reviews sync now.
  registerWebhookHandler("google", async ({ prisma, boss, event, logger }) => {
    const push = pubsubPushSchema.safeParse(event.payload)
    if (!push.success) throw new Error("Not a Pub/Sub push body")
    const note = parseGbpNotification(push.data)
    const locationId = note?.locationName ? locationIdOf(note.locationName) : null
    if (!locationId) return { skipped: "no location in the notification", type: note?.type ?? null }

    const states = await prisma.syncState.findMany({
      where: {
        stream: "reviews",
        platformAccount: {
          platform: "google_business",
          externalId: locationId,
          included: true,
          ...(event.organizationId ? { organizationId: event.organizationId } : {}),
        },
      },
      select: { id: true, organizationId: true },
    })
    let queued = 0
    for (const s of states) {
      // A poll already running will see the change; otherwise lease and run now.
      if (!(await claimSyncState(prisma, s.id))) continue
      const data: PollJobData = {
        organizationId: s.organizationId,
        syncStateId: s.id,
        trigger: "webhook",
      }
      await boss.send(QUEUES.poll, data, { singletonKey: s.id })
      queued++
    }
    logger.debug({ locationId, type: note?.type, queued }, "gbp push handled")
    return { type: note?.type ?? null, location: locationId, polls: queued }
  })
}
