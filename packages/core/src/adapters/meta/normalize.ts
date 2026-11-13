import type { EventKind } from "../../filters/types"
import type { NormalizedItem } from "../../normalized"
import type {
  FbCommentNode,
  FbFeedCommentValue,
  IgCommentNode,
  IgCommentValue,
  MetaConversationMessage,
  MetaMessagingEvent,
} from "./schemas"

/** Meta sends some times in seconds and some in milliseconds. */
export function metaTime(t: number | undefined, fallback: Date): Date {
  if (t === undefined || !Number.isFinite(t) || t <= 0) return fallback
  return new Date(t > 1e12 ? t : t * 1000)
}

function base(
  partial: Partial<NormalizedItem> &
    Pick<NormalizedItem, "platform" | "type" | "eventKind" | "externalId" | "receivedAt">,
): NormalizedItem {
  return {
    parentExternalId: null,
    postId: null,
    postUrl: null,
    externalUrl: null,
    postTitle: null,
    postPublishedAt: null,
    authorName: null,
    authorHandle: null,
    authorId: null,
    authorAvatarUrl: null,
    isOwnAccount: false,
    isReplyToOurReply: false,
    text: null,
    rating: null,
    language: null,
    platformCreatedAt: null,
    platformUpdatedAt: null,
    conversation: null,
    raw: {},
    ...partial,
  }
}

const VERB_KIND: Record<string, EventKind> = {
  add: "created",
  edited: "edited",
  edit: "edited",
  remove: "deleted",
  delete: "deleted",
  hide: "deleted",
}

export interface MetaAccountContext {
  /** Page id (Facebook) or Instagram account id: authored-by-us detection. */
  accountExternalId: string
  receivedAt?: Date
}

/** Facebook Page `feed` webhook change for a comment. */
export function normalizeFbFeedComment(
  v: FbFeedCommentValue,
  ctx: MetaAccountContext & { time?: number | undefined },
): NormalizedItem | null {
  const kind = VERB_KIND[v.verb]
  if (!kind) return null
  const receivedAt = ctx.receivedAt ?? new Date()
  const created = metaTime(v.created_time ?? ctx.time, receivedAt)
  const isReply = Boolean(v.parent_id && v.parent_id !== v.post_id)
  return base({
    platform: "facebook",
    type: "comment",
    eventKind: kind,
    externalId: v.comment_id,
    parentExternalId: isReply ? (v.parent_id ?? null) : null,
    postId: v.post_id,
    postUrl: v.post?.permalink_url ?? null,
    authorName: v.from?.name ?? null,
    authorId: v.from?.id ?? null,
    isOwnAccount: v.from?.id === ctx.accountExternalId,
    text: v.message ?? null,
    platformCreatedAt: created,
    platformUpdatedAt: kind === "created" ? created : receivedAt,
    receivedAt: kind === "created" ? created : receivedAt,
    raw: { source: "webhook", field: "feed", ...v },
  })
}

/** Facebook comment read from the Graph API (reconcile). */
export function normalizeFbCommentNode(
  c: FbCommentNode,
  ctx: MetaAccountContext & { postId: string; postUrl: string | null },
): NormalizedItem {
  const created = new Date(c.created_time)
  return base({
    platform: "facebook",
    type: "comment",
    eventKind: "created",
    externalId: c.id,
    parentExternalId: c.parent?.id ?? null,
    postId: ctx.postId,
    postUrl: ctx.postUrl,
    externalUrl: c.permalink_url ?? null,
    authorName: c.from?.name ?? null,
    authorId: c.from?.id ?? null,
    isOwnAccount: c.from?.id === ctx.accountExternalId,
    text: c.message ?? null,
    platformCreatedAt: created,
    platformUpdatedAt: created,
    receivedAt: created,
    raw: { source: "reconcile", ...c },
  })
}

/** Instagram `comments` webhook change. Its payload has no timestamp: the entry time is used. */
export function normalizeIgCommentValue(
  v: IgCommentValue,
  ctx: MetaAccountContext & { time?: number | undefined },
): NormalizedItem {
  const receivedAt = ctx.receivedAt ?? new Date()
  const created = metaTime(ctx.time, receivedAt)
  return base({
    platform: "instagram",
    type: "comment",
    eventKind: "created",
    externalId: v.id,
    parentExternalId: v.parent_id ?? null,
    postId: v.media?.id ?? null,
    authorName: v.from?.username ?? null,
    authorHandle: v.from?.username ?? null,
    authorId: v.from?.id ?? null,
    isOwnAccount: v.from?.id === ctx.accountExternalId,
    text: v.text ?? null,
    platformCreatedAt: created,
    platformUpdatedAt: created,
    receivedAt: created,
    raw: { source: "webhook", field: "comments", ...v },
  })
}

/** Instagram comment read from the Graph API (reconcile). */
export function normalizeIgCommentNode(
  c: IgCommentNode,
  ctx: MetaAccountContext & { mediaId: string; permalink: string | null; parentId?: string },
): NormalizedItem {
  const created = new Date(c.timestamp)
  const handle = c.from?.username ?? c.username ?? null
  return base({
    platform: "instagram",
    type: "comment",
    eventKind: "created",
    externalId: c.id,
    parentExternalId: ctx.parentId ?? c.parent_id ?? null,
    postId: ctx.mediaId,
    postUrl: ctx.permalink,
    authorName: handle,
    authorHandle: handle,
    authorId: c.from?.id ?? null,
    isOwnAccount: (c.from?.id ?? null) === ctx.accountExternalId,
    text: c.text ?? null,
    platformCreatedAt: created,
    platformUpdatedAt: created,
    receivedAt: created,
    raw: { source: "reconcile", ...c },
  })
}

export interface MetaDmContext extends MetaAccountContext {
  platform: "facebook" | "instagram"
  /** Display name for the customer, when already known or looked up. */
  customerName?: string | null | undefined
}

/**
 * One Messenger / Instagram DM event. The thread is keyed by the customer's scoped id (PSID or
 * IGSID), which is also who a reply goes to. Echoes (our own messages) keep the customer as
 * the thread owner. Read/delivery/reaction events return null.
 */
export function normalizeMetaMessagingEvent(
  e: MetaMessagingEvent,
  ctx: MetaDmContext,
): NormalizedItem | null {
  const msg = e.message
  const edit = e.message_edit
  if (!msg && !edit) return null
  const echo = msg?.is_echo === true || e.sender.id === ctx.accountExternalId
  const customerId = echo ? e.recipient.id : e.sender.id
  const at = metaTime(e.timestamp, ctx.receivedAt ?? new Date())
  const kind: EventKind = edit ? "edited" : msg?.is_deleted ? "deleted" : echo ? "echo" : "created"
  const attachments = msg?.attachments?.map((a) => a.type ?? "file") ?? []
  const text =
    edit?.text ?? msg?.text ?? (attachments.length ? `[${attachments.join(", ")}]` : null)
  return base({
    platform: ctx.platform,
    type: "dm",
    eventKind: kind,
    externalId: edit?.mid ?? msg!.mid,
    authorName: echo ? null : (ctx.customerName ?? null),
    authorId: e.sender.id,
    isOwnAccount: echo,
    text,
    platformCreatedAt: at,
    platformUpdatedAt: at,
    receivedAt: at,
    conversation: {
      externalThreadId: customerId,
      customerId,
      customerName: ctx.customerName ?? null,
    },
    raw: { source: "webhook", ...e },
  })
}

/** A DM read from the Conversations API (reconcile). */
export function normalizeMetaConversationMessage(
  m: MetaConversationMessage,
  ctx: MetaDmContext & { customerId: string },
): NormalizedItem {
  const at = new Date(m.created_time)
  const own = m.from?.id === ctx.accountExternalId
  const name = ctx.customerName ?? (own ? null : (m.from?.name ?? m.from?.username ?? null))
  return base({
    platform: ctx.platform,
    type: "dm",
    eventKind: own ? "echo" : "created",
    externalId: m.id,
    authorName: own ? null : name,
    authorHandle: own ? null : (m.from?.username ?? null),
    authorId: m.from?.id ?? null,
    isOwnAccount: own,
    text: m.message || null,
    platformCreatedAt: at,
    platformUpdatedAt: at,
    receivedAt: at,
    conversation: {
      externalThreadId: ctx.customerId,
      customerId: ctx.customerId,
      customerName: name,
    },
    raw: { source: "reconcile", ...m },
  })
}
