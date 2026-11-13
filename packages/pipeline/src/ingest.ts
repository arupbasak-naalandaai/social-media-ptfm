import { evaluate, type FilterResult, type NormalizedItem } from "@inbox/core"
import type { Logger } from "@inbox/core/logger"
import type { Prisma, PrismaClient } from "@inbox/db"
import type { OrgFilterSetup } from "./context"
import { filterColumns, normalizedToFilterInput, statusForDecision } from "./mapping"
import { isEngagedThread, threadKeyFor } from "./threads"

export type IngestOutcome =
  | { outcome: "created"; itemId: string; result: FilterResult }
  | { outcome: "updated"; itemId: string }
  | { outcome: "duplicate"; itemId: string }
  | { outcome: "dropped"; result: FilterResult }

export interface IngestArgs {
  organizationId: string
  platformAccountId: string
  item: NormalizedItem
  setup: OrgFilterSetup
  logger?: Logger | undefined
}

/**
 * Stores one normalized item, idempotently:
 * - already stored + edited/deleted → update the stored item (no new row)
 * - already stored otherwise (webhook + reconcile overlap) → duplicate, no-op
 * - new → run the filter engine; drop → not stored; else create with the rule outcome.
 *   A new item in a thread we already engaged with (or a reply to our reply) is a follow-up.
 */
export async function ingestNormalizedItem(
  prisma: PrismaClient,
  args: IngestArgs,
): Promise<IngestOutcome> {
  const { organizationId, platformAccountId, item, setup } = args
  const key = {
    organizationId_platform_platformAccountId_externalId: {
      organizationId,
      platform: item.platform,
      platformAccountId,
      externalId: item.externalId,
    },
  }
  const existing = await prisma.item.findUnique({ where: key, select: { id: true } })

  if (existing) {
    if (item.eventKind === "edited") {
      await prisma.item.update({
        where: { id: existing.id },
        data: {
          text: item.text,
          // Reviews can change their star rating when edited.
          ...(item.rating !== null ? { rating: item.rating } : {}),
          platformUpdatedAt: item.platformUpdatedAt ?? item.receivedAt,
        },
      })
      return { outcome: "updated", itemId: existing.id }
    }
    if (item.eventKind === "deleted") {
      await prisma.item.update({
        where: { id: existing.id },
        data: {
          status: "archived",
          manualOverride: true,
          filterReason: "Deleted on the platform",
          platformUpdatedAt: item.platformUpdatedAt ?? item.receivedAt,
        },
      })
      return { outcome: "updated", itemId: existing.id }
    }
    return { outcome: "duplicate", itemId: existing.id }
  }

  const result = evaluate(normalizedToFilterInput(item), setup.rules, setup.context)
  if (result.decision === "drop") {
    args.logger?.debug(
      { externalId: item.externalId, reason: result.filterReason },
      "ingest: dropped by rule",
    )
    return { outcome: "dropped", result }
  }

  const conversationId = item.conversation
    ? await upsertConversation(prisma, organizationId, platformAccountId, item)
    : null

  const threadKey = threadKeyFor({
    platformAccountId,
    type: item.type,
    externalId: item.externalId,
    parentExternalId: item.parentExternalId,
    conversationId,
  })
  const isFollowUp =
    item.isReplyToOurReply || (await isEngagedThread(prisma, organizationId, threadKey))

  const created = await prisma.item.create({
    data: {
      organizationId,
      platformAccountId,
      platform: item.platform,
      type: item.type,
      externalId: item.externalId,
      parentExternalId: item.parentExternalId,
      conversationId,
      threadKey,
      isFollowUp,
      postId: item.postId,
      postUrl: item.postUrl,
      externalUrl: item.externalUrl,
      postTitle: item.postTitle,
      postPublishedAt: item.postPublishedAt,
      authorName: item.authorName,
      authorHandle: item.authorHandle,
      authorId: item.authorId,
      authorAvatarUrl: item.authorAvatarUrl,
      isOwnAccount: item.isOwnAccount,
      isReplyToOurReply: item.isReplyToOurReply,
      text: item.text,
      rating: item.rating,
      language: item.language,
      eventKind: item.eventKind,
      receivedAt: item.receivedAt,
      platformCreatedAt: item.platformCreatedAt,
      platformUpdatedAt: item.platformUpdatedAt,
      status: statusForDecision(result),
      lastFilteredAt: setup.context.now,
      raw: item.raw as Prisma.InputJsonObject,
      ...filterColumns(result),
    },
    select: { id: true, receivedAt: true },
  })

  await writeRuleMatches(prisma, organizationId, created.id, created.receivedAt, result)
  return { outcome: "created", itemId: created.id, result }
}

async function upsertConversation(
  prisma: PrismaClient,
  organizationId: string,
  platformAccountId: string,
  item: NormalizedItem,
): Promise<string> {
  const c = item.conversation!
  const fromCustomer = !item.isOwnAccount
  // The reply window runs from the customer's message time, not when we fetched it.
  const at = item.platformCreatedAt ?? item.receivedAt
  const conv = await prisma.conversation.upsert({
    where: {
      organizationId_platform_platformAccountId_externalThreadId: {
        organizationId,
        platform: item.platform,
        platformAccountId,
        externalThreadId: c.externalThreadId,
      },
    },
    create: {
      organizationId,
      platform: item.platform,
      platformAccountId,
      externalThreadId: c.externalThreadId,
      customerId: c.customerId,
      customerName: c.customerName,
      customerLastMessageAt: fromCustomer ? at : null,
    },
    update: fromCustomer ? { customerName: c.customerName ?? undefined } : {},
    select: { id: true, customerLastMessageAt: true },
  })
  // Keep the latest customer message time (events can arrive out of order).
  if (fromCustomer && (!conv.customerLastMessageAt || conv.customerLastMessageAt < at)) {
    await prisma.conversation.update({
      where: { id: conv.id },
      data: { customerLastMessageAt: at },
    })
  }
  return conv.id
}

/**
 * Replaces an item's rule matches. matchedAt = the item's receivedAt, so re-filtering doesn't
 * inflate "matches in the last 7 days".
 */
export async function writeRuleMatches(
  prisma: Pick<PrismaClient, "ruleMatch">,
  organizationId: string,
  itemId: string,
  receivedAt: Date,
  result: FilterResult,
): Promise<void> {
  await prisma.ruleMatch.deleteMany({ where: { itemId } })
  if (result.matched.length === 0) return
  await prisma.ruleMatch.createMany({
    data: result.matched.map((m) => ({
      organizationId,
      ruleId: m.ruleId,
      itemId,
      dryRun: m.dryRun,
      matchedAt: receivedAt,
    })),
    skipDuplicates: true,
  })
}
