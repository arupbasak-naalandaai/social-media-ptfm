/**
 * Facebook Pages + Instagram in the worker (Phases 5 and 7): webhook ingest (comments and DMs),
 * reconcile polls, and reply senders. Registered at startup.
 */
import {
  fbFeedCommentValueSchema,
  igCommentValueSchema,
  metaMessagingEventSchema,
  metaWebhookSchema,
  normalizeFbFeedComment,
  normalizeIgCommentValue,
  normalizeMetaMessagingEvent,
  type NormalizedItem,
} from "@inbox/core"
import type { Keyring } from "@inbox/core/crypto"
import type { PlatformAccount, PrismaClient } from "@inbox/db"
import {
  fetchNewFbComments,
  fetchNewIgComments,
  fetchNewMetaDms,
  isDemoAccount,
  markMetaReauth,
  MetaApiError,
  metaContext,
  metaCustomerName,
  replyToFbComment,
  replyToIgComment,
  ReplySendError,
  sendMetaMessage,
  type MetaCallContext,
} from "@inbox/pipeline"
import { registerWebhookHandler } from "../jobs/ingest"
import { ingestItems } from "../jobs/ingest-items"
import { registerPollAdapter, type PollAdapter } from "../sync/adapters"
import { registerReplySender, type SenderFactory } from "../sync/senders"

type Fetcher = (
  ctx: MetaCallContext,
  args: { cursor: string | null; backfillDays: number; signal?: AbortSignal },
) => Promise<{ items: NormalizedItem[]; cursor: string | undefined }>

function reconcile(fetcher: Fetcher): PollAdapter {
  return async ({ prisma, keyring, account, state, signal }) => {
    try {
      const ctx = await metaContext(prisma, keyring, account)
      return await fetcher(ctx, { cursor: state.cursor, backfillDays: state.backfillDays, signal })
    } catch (err) {
      await markMetaReauth(prisma, account, err)
      throw err
    }
  }
}

const sender: SenderFactory = ({ prisma, keyring }) => ({
  // Posting a comment or a message isn't idempotent: an interrupted call may have posted.
  idempotent: false,
  async send({ reply, item, account }) {
    try {
      const ctx = await metaContext(prisma, keyring, account)
      if (item.type === "dm") {
        const recipient = item.conversation?.customerId
        if (!recipient) throw new ReplySendError("This DM has no conversation to reply in", false)
        const res = await sendMetaMessage(ctx, recipient, reply.text)
        return { externalReplyId: res.message_id }
      }
      // Both platforms nest replies one level: a reply to a reply goes under the top comment.
      const target = item.parentExternalId ?? item.externalId
      const res =
        account.platform === "instagram"
          ? await replyToIgComment(ctx, target, reply.text)
          : await replyToFbComment(ctx, target, reply.text)
      return { externalReplyId: res.id }
    } catch (err) {
      if (err instanceof MetaApiError) {
        await markMetaReauth(prisma, account, err)
        throw new ReplySendError(err.message, err.retryable)
      }
      throw err
    }
  },
})

/** Customer display name for a DM thread: the stored one, else a profile lookup. */
async function customerNameFor(
  prisma: PrismaClient,
  keyring: Keyring,
  account: PlatformAccount,
  customerId: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  if (cache.has(customerId)) return cache.get(customerId) ?? null
  const conv = await prisma.conversation.findFirst({
    where: { platformAccountId: account.id, externalThreadId: customerId },
    select: { customerName: true },
  })
  let name = conv?.customerName ?? null
  if (!name && !isDemoAccount(account) && account.accessTokenEnc) {
    const ctx = await metaContext(prisma, keyring, account).catch(() => null)
    name = ctx ? await metaCustomerName(ctx, customerId) : null
  }
  cache.set(customerId, name)
  return name
}

export function registerMeta(): void {
  registerPollAdapter("fb_comments", reconcile(fetchNewFbComments))
  registerPollAdapter("ig_comments", reconcile(fetchNewIgComments))
  registerPollAdapter("fb_dms", reconcile(fetchNewMetaDms))
  registerPollAdapter("ig_dms", reconcile(fetchNewMetaDms))
  registerReplySender("facebook", sender)
  registerReplySender("instagram", sender)

  // One delivery can batch several entries (accounts) and changes/messages.
  registerWebhookHandler("meta", async ({ prisma, boss, keyring, event, logger }) => {
    const parsed = metaWebhookSchema.safeParse(event.payload)
    if (!parsed.success) throw new Error("Not a Meta webhook body")
    const { object, entry } = parsed.data
    const platform = object === "page" ? "facebook" : object === "instagram" ? "instagram" : null
    if (!platform) return { skipped: `object "${object}" isn't handled` }

    const totals = { created: 0, updated: 0, dropped: 0, duplicates: 0 }
    const skipped: string[] = []
    const names = new Map<string, string | null>()
    for (const e of entry) {
      const account = await prisma.platformAccount.findFirst({
        where: {
          platform,
          externalId: e.id,
          // Seeded demo accounts stay "disconnected" but accept simulated deliveries.
          OR: [{ status: { not: "disconnected" } }, { meta: { path: ["demo"], equals: true } }],
          ...(event.organizationId ? { organizationId: event.organizationId } : {}),
        },
      })
      if (!account) {
        skipped.push(`no connected ${platform} account ${e.id}`)
        continue
      }
      if (!account.included) {
        skipped.push(`${account.displayName} is excluded from sync`)
        continue
      }
      const ctx = {
        accountExternalId: account.externalId,
        time: e.time,
        receivedAt: event.receivedAt,
      }
      const items: NormalizedItem[] = []

      for (const change of e.changes ?? []) {
        if (platform === "facebook" && change.field === "feed") {
          const v = fbFeedCommentValueSchema.safeParse(change.value)
          if (!v.success) continue // posts, reactions, shares: not inbox items
          const item = normalizeFbFeedComment(v.data, ctx)
          if (item) items.push(item)
        } else if (platform === "instagram" && change.field === "comments") {
          const v = igCommentValueSchema.safeParse(change.value)
          if (v.success) items.push(normalizeIgCommentValue(v.data, ctx))
          else skipped.push(`unreadable comments change on ${e.id}`)
        } else {
          skipped.push(`field "${change.field}"`)
        }
      }

      for (const raw of e.messaging ?? []) {
        const m = metaMessagingEventSchema.safeParse(raw)
        if (!m.success) continue // read receipts, reactions, postbacks without a message
        const echo = m.data.message?.is_echo === true || m.data.sender.id === account.externalId
        const customerId = echo ? m.data.recipient.id : m.data.sender.id
        const customerName = await customerNameFor(prisma, keyring, account, customerId, names)
        const item = normalizeMetaMessagingEvent(m.data, { ...ctx, platform, customerName })
        if (item) items.push(item)
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
    logger.debug({ object, ...totals, skipped }, "meta webhook handled")
    return { object, ...totals, ...(skipped.length ? { skipped } : {}) }
  })
}
