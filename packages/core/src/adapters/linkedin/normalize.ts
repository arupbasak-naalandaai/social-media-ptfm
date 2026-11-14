import type { NormalizedItem } from "../../normalized"
import { commentUrnOf, type LinkedinComment } from "./schemas"

export interface LiNormalizeContext {
  /** Our organization URN: comments by it are our own. */
  orgUrn: string
  authorName?: string | null
  authorHandle?: string | null
  /** The parent comment (for replies) was written by us. */
  parentIsOurs?: boolean
}

export const linkedinPostUrl = (thread: string) =>
  `https://www.linkedin.com/feed/update/${encodeURI(thread)}/`

/** One LinkedIn comment (top-level or nested) → NormalizedItem. */
export function normalizeLiComment(c: LinkedinComment, ctx: LiNormalizeContext): NormalizedItem {
  const created = new Date(c.created.time)
  const updated = new Date(c.lastModified?.time ?? c.created.time)
  const ours = c.actor === ctx.orgUrn
  const parentId = c.parentComment ?? null
  return {
    platform: "linkedin",
    type: "comment",
    eventKind: updated.getTime() - created.getTime() > 60_000 ? "edited" : "created",
    externalId: commentUrnOf(c),
    parentExternalId: parentId,
    postId: c.object,
    postUrl: linkedinPostUrl(c.object),
    externalUrl: null,
    postTitle: null,
    postPublishedAt: null,
    authorName: ours ? null : (ctx.authorName ?? null),
    authorHandle: ctx.authorHandle ?? null,
    authorId: c.actor,
    authorAvatarUrl: null,
    isOwnAccount: ours,
    isReplyToOurReply: Boolean(parentId && ctx.parentIsOurs && !ours),
    text: c.message?.text ?? null,
    rating: null,
    language: null,
    platformCreatedAt: created,
    platformUpdatedAt: updated,
    receivedAt: created,
    conversation: null,
    raw: { id: c.id, object: c.object, actor: c.actor, agent: c.agent ?? null, parentId },
  }
}
