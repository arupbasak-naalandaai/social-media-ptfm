import {
  eventKindSchema,
  type FilterInput,
  type FilterResult,
  type ItemStatus,
  type NormalizedItem,
} from "@inbox/core"
import type { Item } from "@inbox/db"

export function normalizedToFilterInput(n: NormalizedItem): FilterInput {
  return {
    platform: n.platform,
    type: n.type,
    eventKind: n.eventKind,
    text: n.text,
    rating: n.rating,
    language: n.language,
    authorName: n.authorName,
    authorHandle: n.authorHandle,
    authorId: n.authorId,
    isOwnAccount: n.isOwnAccount,
    isReplyToOurReply: n.isReplyToOurReply,
    postId: n.postId,
    postPublishedAt: n.postPublishedAt,
    receivedAt: n.receivedAt,
  }
}

export function itemToFilterInput(item: Item): FilterInput {
  const kind = eventKindSchema.safeParse(item.eventKind)
  return {
    platform: item.platform,
    type: item.type,
    eventKind: kind.success ? kind.data : "created",
    text: item.text,
    rating: item.rating,
    language: item.language,
    authorName: item.authorName,
    authorHandle: item.authorHandle,
    authorId: item.authorId,
    isOwnAccount: item.isOwnAccount,
    isReplyToOurReply: item.isReplyToOurReply,
    postId: item.postId,
    postPublishedAt: item.postPublishedAt,
    receivedAt: item.receivedAt,
  }
}

/** Stored status for an automatic filter decision. "drop" only reaches here for already-stored items. */
export function statusForDecision(result: FilterResult): Extract<ItemStatus, "new" | "filtered"> {
  return result.decision === "show" ? "new" : "filtered"
}

/** The Item columns a filter result controls. */
export function filterColumns(result: FilterResult) {
  const applied = result.matched.filter((m) => !m.dryRun)
  return {
    priority: result.priority,
    tags: result.tags,
    matchedRuleIds: applied.map((m) => m.ruleId),
    dryRunRuleIds: result.matched.filter((m) => m.dryRun).map((m) => m.ruleId),
    filterReason:
      result.decision === "drop"
        ? `${result.filterReason ?? "Dropped"} (already stored, so archived instead)`
        : result.filterReason,
    aiDraftsAllowed: result.aiDraftsAllowed,
    requireApproval: result.requireApproval,
    skipSlack: result.skipSlack,
    slackChannelId: result.slackChannelId,
  }
}
