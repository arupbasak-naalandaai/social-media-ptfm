import type { NormalizedItem } from "../../normalized"
import { STAR_RATINGS, type GbpReview } from "./schemas"

/**
 * Google-translated reviews put both texts in `comment`:
 * "(Translated by Google) <translation>\n\n(Original)\n<original>", in either order and not
 * documented. We keep the customer's original words (what a reply should answer) and drop the
 * machine translation; when no original is present, the text stays as is.
 */
export function splitTranslatedComment(comment: string): { text: string; translated: boolean } {
  const original = /\(Original\)\s*([\s\S]*?)(?:\n\s*\(Translated by Google\)|$)/.exec(comment)
  if (comment.includes("(Translated by Google)") && original?.[1]?.trim()) {
    return { text: original[1].trim(), translated: true }
  }
  return { text: comment.trim(), translated: false }
}

export interface GbpNormalizeContext {
  /** Location `metadata.mapsUri`, for "Open in Google". */
  mapsUri?: string | null | undefined
  receivedAt?: Date
}

/** One v4 review → the pipeline's NormalizedItem. */
export function normalizeGbpReview(
  review: GbpReview,
  ctx: GbpNormalizeContext = {},
): NormalizedItem {
  const created = new Date(review.createTime)
  const updated = review.updateTime ? new Date(review.updateTime) : created
  const rating =
    review.starRating && review.starRating in STAR_RATINGS
      ? STAR_RATINGS[review.starRating as keyof typeof STAR_RATINGS]
      : null
  const comment = review.comment ? splitTranslatedComment(review.comment) : null
  const anonymous = review.reviewer?.isAnonymous === true
  // An edit moves updateTime well past createTime; a reply alone can touch it too, which is
  // harmless (the stored item is updated with the same text).
  const edited = updated.getTime() - created.getTime() > 60_000

  return {
    platform: "google_business",
    type: "review",
    eventKind: edited ? "edited" : "created",
    externalId: review.reviewId,
    parentExternalId: null,
    postId: null,
    postUrl: null,
    externalUrl: review.reviewReplyUrl ?? ctx.mapsUri ?? null,
    postTitle: null,
    postPublishedAt: null,
    authorName: anonymous ? "A Google user" : (review.reviewer?.displayName ?? null),
    authorHandle: null,
    authorId: null,
    authorAvatarUrl: anonymous ? null : (review.reviewer?.profilePhotoUrl ?? null),
    isOwnAccount: false,
    isReplyToOurReply: false,
    text: comment?.text || null,
    rating,
    language: null,
    platformCreatedAt: created,
    platformUpdatedAt: updated,
    receivedAt: ctx.receivedAt ?? new Date(),
    conversation: null,
    raw: {
      name: review.name,
      starRating: review.starRating ?? null,
      translated: comment?.translated ?? false,
      ...(review.reviewReply ? { reviewReply: review.reviewReply } : {}),
    },
  }
}
