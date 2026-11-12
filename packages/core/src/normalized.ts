/**
 * The adapter → pipeline contract: what every platform adapter's normalize() returns,
 * and what the seed script generates.
 */
import type { EventKind, ItemType, Platform } from "./filters/types"

export interface NormalizedConversation {
  externalThreadId: string
  customerId: string
  customerName: string | null
}

export interface NormalizedItem {
  platform: Platform
  type: ItemType
  eventKind: EventKind
  /** Unique per platform + account. */
  externalId: string
  parentExternalId: string | null
  postId: string | null
  postUrl: string | null
  /** The platform's permalink to this item, when its API returns one (e.g. FB `permalink_url`). */
  externalUrl: string | null
  postTitle: string | null
  postPublishedAt: Date | null
  authorName: string | null
  authorHandle: string | null
  authorId: string | null
  authorAvatarUrl: string | null
  isOwnAccount: boolean
  isReplyToOurReply: boolean
  text: string | null
  rating: number | null
  language: string | null
  platformCreatedAt: Date | null
  platformUpdatedAt: Date | null
  receivedAt: Date
  conversation: NormalizedConversation | null
  /** Original payload (or a trimmed copy) for debugging. */
  raw: Record<string, unknown>
}
