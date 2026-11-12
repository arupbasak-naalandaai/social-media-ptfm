/**
 * Threads and follow-ups.
 *
 * A thread is a DM conversation, a top-level comment with its replies, or a single review.
 * Once we reply to or resolve something in a thread, later items in it are follow-ups: they
 * skip the main inbox and show under Follow-ups, so a person you already talked to doesn't
 * get lost among first-time comments.
 */
import { ENGAGED_STATUSES, OPEN_STATUSES, type ItemType } from "@inbox/core"
import type { PrismaClient } from "@inbox/db"

export interface ThreadKeyInput {
  platformAccountId: string
  type: ItemType
  externalId: string
  parentExternalId: string | null
  conversationId: string | null
}

/**
 * Stable thread id. Comment replies are one level deep on Facebook, Instagram and YouTube (a
 * reply's parent is the top-level comment), so parent ?? self is the root. The migration
 * `item_threads_followups_links` backfills with the same format.
 */
export function threadKeyFor(i: ThreadKeyInput): string {
  if (i.conversationId) return `c:${i.conversationId}`
  if (i.type === "comment") return `p:${i.platformAccountId}:${i.parentExternalId ?? i.externalId}`
  return `i:${i.platformAccountId}:${i.externalId}`
}

/** Did we already reply to or resolve something in this thread? */
export async function isEngagedThread(
  prisma: Pick<PrismaClient, "item">,
  organizationId: string,
  threadKey: string,
): Promise<boolean> {
  const engaged = await prisma.item.findFirst({
    where: { organizationId, threadKey, status: { in: [...ENGAGED_STATUSES] } },
    select: { id: true },
  })
  return engaged !== null
}

/**
 * After someone replies to or resolves an item: newer open items in the same thread become
 * follow-ups (they move from the inbox to Follow-ups). Returns the ids that changed.
 */
export async function markLaterItemsAsFollowUps(
  prisma: Pick<PrismaClient, "item">,
  item: { id: string; organizationId: string; threadKey: string | null; receivedAt: Date },
): Promise<string[]> {
  if (!item.threadKey) return []
  const later = await prisma.item.findMany({
    where: {
      organizationId: item.organizationId,
      threadKey: item.threadKey,
      id: { not: item.id },
      isFollowUp: false,
      status: { in: [...OPEN_STATUSES] },
      receivedAt: { gt: item.receivedAt },
    },
    select: { id: true },
  })
  if (later.length === 0) return []
  const ids = later.map((l) => l.id)
  await prisma.item.updateMany({ where: { id: { in: ids } }, data: { isFollowUp: true } })
  return ids
}
