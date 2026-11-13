import type { NormalizedItem } from "../../normalized"
import type { YtComment } from "./schemas"

export interface YtNormalizeContext {
  /** Our channel id: comments by it are our own. */
  channelId: string
  /** Video the thread belongs to (replies don't always carry it). */
  videoId: string | null
  /** Top-level comment id, for replies. */
  parentId?: string | null
  /** The top-level comment of this reply's thread was written by us. */
  parentIsOurs?: boolean
  receivedAt?: Date
}

/** One YouTube comment (top-level or reply) → NormalizedItem. */
export function normalizeYtComment(c: YtComment, ctx: YtNormalizeContext): NormalizedItem {
  const s = c.snippet
  const created = new Date(s.publishedAt)
  const updated = s.updatedAt ? new Date(s.updatedAt) : created
  const authorId = s.authorChannelId?.value ?? null
  const videoId = s.videoId ?? ctx.videoId
  const parentId = s.parentId ?? ctx.parentId ?? null
  const handle = s.authorChannelUrl?.match(/youtube\.com\/(@[^/?#]+)/)?.[1] ?? null
  return {
    platform: "youtube",
    type: "comment",
    eventKind: updated.getTime() - created.getTime() > 60_000 ? "edited" : "created",
    externalId: c.id,
    parentExternalId: parentId,
    postId: videoId,
    postUrl: videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` : null,
    externalUrl: null,
    postTitle: null,
    postPublishedAt: null,
    authorName: s.authorDisplayName ?? null,
    authorHandle: handle,
    authorId,
    authorAvatarUrl: s.authorProfileImageUrl ?? null,
    isOwnAccount: authorId === ctx.channelId,
    isReplyToOurReply: Boolean(parentId && ctx.parentIsOurs && authorId !== ctx.channelId),
    // textOriginal is only returned to the comment's author; textDisplay may hold HTML unless
    // the list is requested with textFormat=plainText (we do).
    text: s.textOriginal ?? s.textDisplay ?? null,
    rating: null,
    language: null,
    platformCreatedAt: created,
    platformUpdatedAt: updated,
    receivedAt: created,
    conversation: null,
    raw: { id: c.id, videoId, parentId, moderationStatus: s.moderationStatus ?? null },
  }
}
