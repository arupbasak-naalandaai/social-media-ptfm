/**
 * LinkedIn Company Pages in the worker (Phase 9): comment notifications from the webhook,
 * reconcile polls from the notifications API, and the reply sender.
 */
import { linkedinWebhookSchema, orgUrn } from "@inbox/core"
import {
  createLinkedinReply,
  fetchNewLinkedinComments,
  LinkedinApiError,
  linkedinContext,
  linkedinItemsFromNotifications,
  markLinkedinReauth,
  ReplySendError,
} from "@inbox/pipeline"
import { registerWebhookHandler } from "../jobs/ingest"
import { ingestItems } from "../jobs/ingest-items"
import { registerPollAdapter } from "../sync/adapters"
import { registerReplySender } from "../sync/senders"

export function registerLinkedin(): void {
  registerPollAdapter("li_comments", async ({ prisma, keyring, account, state, signal }) => {
    try {
      const ctx = await linkedinContext(prisma, keyring, account)
      return await fetchNewLinkedinComments(ctx, {
        orgUrn: ctx.orgUrn,
        cursor: state.cursor,
        backfillDays: state.backfillDays,
        signal,
      })
    } catch (err) {
      await markLinkedinReauth(prisma, account, err)
      throw err
    }
  })

  registerReplySender("linkedin", ({ prisma, keyring }) => ({
    // Creating a comment isn't idempotent: an interrupted call may have posted.
    idempotent: false,
    async send({ reply, item, account }) {
      if (!item.postId) throw new ReplySendError("This comment has no post to reply on", false)
      try {
        const ctx = await linkedinContext(prisma, keyring, account)
        const res = await createLinkedinReply(ctx, {
          orgUrn: ctx.orgUrn,
          postUrn: item.postId,
          // One level of nesting: replies to a nested comment go under its top-level comment.
          parentCommentUrn: item.parentExternalId ?? item.externalId,
          text: reply.text,
        })
        return { externalReplyId: res.commentUrn }
      } catch (err) {
        if (err instanceof LinkedinApiError) {
          await markLinkedinReauth(prisma, account, err)
          throw new ReplySendError(err.message, err.retryable)
        }
        throw err
      }
    },
  }))

  // One delivery batches up to 10 notifications, possibly for several Pages.
  registerWebhookHandler("linkedin", async ({ prisma, boss, keyring, event, logger }) => {
    const parsed = linkedinWebhookSchema.safeParse(event.payload)
    if (!parsed.success) throw new Error("Not a LinkedIn notification body")
    const byOrg = new Map<string, typeof parsed.data.notifications>()
    for (const n of parsed.data.notifications) {
      byOrg.set(n.organizationalEntity, [...(byOrg.get(n.organizationalEntity) ?? []), n])
    }
    const totals = { created: 0, updated: 0, dropped: 0, duplicates: 0 }
    const skipped: string[] = []
    for (const [entity, notifications] of byOrg) {
      const orgId = /^urn:li:organization:(\d+)$/.exec(entity)?.[1]
      const account = orgId
        ? await prisma.platformAccount.findFirst({
            where: {
              platform: "linkedin",
              externalId: orgId,
              status: { not: "disconnected" },
              ...(event.organizationId ? { organizationId: event.organizationId } : {}),
            },
          })
        : null
      if (!account) {
        skipped.push(`no connected LinkedIn Page ${entity}`)
        continue
      }
      if (!account.included) {
        skipped.push(`${account.displayName} is excluded from sync`)
        continue
      }
      let items
      try {
        const ctx = await linkedinContext(prisma, keyring, account)
        items = await linkedinItemsFromNotifications(ctx, {
          orgUrn: orgUrn(account.externalId),
          notifications,
        })
      } catch (err) {
        await markLinkedinReauth(prisma, account, err)
        throw err
      }
      const res = await ingestItems(
        { boss, prisma, logger },
        { organizationId: account.organizationId, platformAccountId: account.id, items },
      )
      totals.created += res.created
      totals.updated += res.updated
      totals.dropped += res.dropped
      totals.duplicates += res.duplicates
    }
    logger.debug({ ...totals, skipped }, "linkedin webhook handled")
    return { ...totals, ...(skipped.length ? { skipped } : {}) }
  })
}
