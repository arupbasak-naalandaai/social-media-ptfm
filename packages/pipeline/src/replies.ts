/**
 * Reply pipeline (PLAN §2): validate → Reply(queued) → send-reply job (after the undo window)
 * → platform sender → Reply(sent) + Item(replied) → NOTIFY.
 *
 * Double-post safety: a reply moves queued → sending before the platform call, and the
 * platform's reply id is stored before the job acknowledges. A retried job that finds the
 * reply already `sent` (or `sending` with an id) completes without calling the platform again.
 * A reply left `sending` without an id (crash mid-call) is only retried when the sender says
 * its call is idempotent (Google's PUT reply is; posting a comment isn't).
 */
import {
  DM_REPLY_WINDOW_HOURS,
  parseSectionValues,
  platformSchema,
  replyLengthError,
  type ItemType,
} from "@inbox/core"
import type { PlatformAccount, PrismaClient, Reply } from "@inbox/db"
import { markLaterItemsAsFollowUps } from "./threads"

export class ReplyRejected extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 400,
  ) {
    super(message)
    this.name = "ReplyRejected"
  }
}

export function isDemoAccount(account: Pick<PlatformAccount, "meta">): boolean {
  const meta = account.meta as { demo?: unknown } | null
  return Boolean(meta && typeof meta === "object" && meta.demo === true)
}

/** Whether replies can be sent for this account: it has a token, or it's a seeded demo. */
export function canSendFrom(account: Pick<PlatformAccount, "meta" | "accessTokenEnc" | "status">) {
  if (isDemoAccount(account)) return true
  return Boolean(account.accessTokenEnc) && account.status !== "disconnected"
}

/** Appends the Settings → Replies signature for this item type (once). */
export function withSignature(
  text: string,
  type: ItemType,
  replies: { signature: string; signatureOn: Record<ItemType, boolean> },
): string {
  const sig = replies.signature.trim()
  const body = text.trim()
  if (!sig || !replies.signatureOn[type] || body.endsWith(sig)) return body
  return `${body}\n\n${sig}`
}

export interface QueueReplyInput {
  organizationId: string
  itemId: string
  userId: string
  text: string
  /** The AI draft this reply started from, if any. */
  draftId?: string | null | undefined
  now?: Date
}

export interface QueuedReply {
  reply: Reply
  /** Seconds until it sends (Settings → Replies → undo window). */
  undoSeconds: number
  afterSend: "next" | "stay"
}

export async function queueReply(
  prisma: PrismaClient,
  input: QueueReplyInput,
): Promise<QueuedReply> {
  const now = input.now ?? new Date()
  const item = await prisma.item.findFirst({
    where: { id: input.itemId, organizationId: input.organizationId },
    select: {
      id: true,
      platform: true,
      type: true,
      isOwnAccount: true,
      status: true,
      platformAccount: { select: { meta: true, accessTokenEnc: true, status: true } },
      conversation: { select: { customerLastMessageAt: true } },
      replies: { where: { status: { in: ["queued", "sending"] } }, select: { id: true } },
    },
  })
  if (!item) throw new ReplyRejected("Item not found", 404)
  if (item.isOwnAccount) throw new ReplyRejected("This is our own message", 409)
  if (item.status === "filtered" || item.status === "archived") {
    throw new ReplyRejected("Restore this item before replying", 409)
  }
  if (!canSendFrom(item.platformAccount)) {
    throw new ReplyRejected("Connect this account before replying from here", 409)
  }
  if (item.replies.length > 0) {
    throw new ReplyRejected("A reply to this item is already being sent", 409)
  }
  const platform = platformSchema.parse(item.platform)
  const windowHours = item.type === "dm" ? DM_REPLY_WINDOW_HOURS[platform] : undefined
  const last = item.conversation?.customerLastMessageAt
  if (windowHours && last && last.getTime() + windowHours * 3_600_000 < now.getTime()) {
    throw new ReplyRejected(
      `The ${windowHours}-hour reply window has closed. Reply in the app instead.`,
      409,
    )
  }

  const settings = await prisma.settings.findUnique({
    where: { organizationId: input.organizationId },
    select: { replies: true },
  })
  const replies = parseSectionValues("replies", settings?.replies)
  const text = withSignature(input.text, item.type as ItemType, replies)
  if (!text) throw new ReplyRejected("Write a reply first", 400)
  const tooLong = replyLengthError(platform, text, item.type as ItemType)
  if (tooLong) throw new ReplyRejected(tooLong, 400)

  const draft = input.draftId
    ? await prisma.aiDraft.findFirst({
        where: { id: input.draftId, itemId: item.id },
        select: { id: true },
      })
    : null

  const reply = await prisma.$transaction(async (tx) => {
    if (draft) await tx.aiDraft.update({ where: { id: draft.id }, data: { chosen: true } })
    return tx.reply.create({
      data: {
        organizationId: input.organizationId,
        itemId: item.id,
        text,
        source: draft ? "ai_draft" : "manual_dashboard",
        sentById: input.userId,
        status: "queued",
        idempotencyKey: `reply:${item.id}:${now.getTime()}:${Math.random().toString(36).slice(2)}`,
      },
    })
  })
  return { reply, undoSeconds: replies.undoSeconds, afterSend: replies.afterSend }
}

/** Undo: deletes a reply that hasn't started sending. Returns its text, or null if too late. */
export async function cancelReply(
  prisma: PrismaClient,
  organizationId: string,
  replyId: string,
): Promise<string | null> {
  const reply = await prisma.reply.findFirst({
    where: { id: replyId, organizationId },
    select: { text: true },
  })
  if (!reply) return null
  const { count } = await prisma.reply.deleteMany({
    where: { id: replyId, organizationId, status: "queued" },
  })
  return count === 1 ? reply.text : null
}

// ─── Sending (worker) ──────────────────────────────────────────────────────────

export class ReplySendError extends Error {
  constructor(
    message: string,
    /** True when the platform certainly didn't post it (e.g. 4xx validation, 429). */
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = "ReplySendError"
  }
}

export interface ReplySender {
  /** Re-sending the same reply can't create a second public post (e.g. Google's PUT). */
  idempotent: boolean
  send(ctx: {
    reply: Reply
    item: {
      id: string
      externalId: string
      parentExternalId: string | null
      /** The post/video the comment is on (LinkedIn replies name it). */
      postId: string | null
      type: string
      platform: string
      raw: unknown
      /** DMs: who the reply goes to (Messenger PSID / Instagram IGSID). */
      conversation: { customerId: string; externalThreadId: string } | null
    }
    account: PlatformAccount
  }): Promise<{ externalReplyId: string | null }>
}

export type SendOutcome =
  | { outcome: "sent"; externalReplyId: string | null; itemIds: string[] }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; error: string; retry: boolean }

/**
 * Sends one queued reply. `lastAttempt`: no retries left, so a retryable error is final.
 * Returns `retry: true` when the caller should throw to let pg-boss retry.
 */
export async function sendQueuedReply(
  prisma: PrismaClient,
  args: {
    replyId: string
    senderFor: (account: PlatformAccount) => ReplySender
    lastAttempt: boolean
    now?: () => Date
  },
): Promise<SendOutcome> {
  const now = args.now ?? (() => new Date())
  const reply = await prisma.reply.findUnique({
    where: { id: args.replyId },
    include: {
      item: {
        select: {
          id: true,
          organizationId: true,
          externalId: true,
          parentExternalId: true,
          postId: true,
          type: true,
          platform: true,
          raw: true,
          conversation: { select: { customerId: true, externalThreadId: true } },
          threadKey: true,
          receivedAt: true,
          platformAccount: true,
        },
      },
    },
  })
  if (!reply) return { outcome: "skipped", reason: "Reply was cancelled" }
  if (reply.status === "sent") return { outcome: "skipped", reason: "Already sent" }
  if (reply.status === "failed") return { outcome: "skipped", reason: "Already failed" }

  const account = reply.item.platformAccount
  const sender = args.senderFor(account)
  if (reply.status === "sending") {
    if (reply.externalReplyId) {
      // Posted before a crash; just finish the bookkeeping.
      return finish(prisma, reply, reply.externalReplyId, now())
    }
    if (!sender.idempotent) {
      return fail(
        prisma,
        reply,
        "Sending was interrupted and may have posted. Check the platform, then send again if needed.",
        false,
      )
    }
  }

  // queued → sending (only one worker can win this).
  const claimed = await prisma.reply.updateMany({
    where: { id: reply.id, status: { in: ["queued", "sending"] } },
    data: { status: "sending", error: null },
  })
  if (claimed.count === 0) return { outcome: "skipped", reason: "Reply changed while sending" }

  try {
    const { externalReplyId } = await sender.send({ reply, item: reply.item, account })
    return finish(prisma, reply, externalReplyId, now())
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const retryable = err instanceof ReplySendError ? err.retryable : sender.idempotent
    if (retryable && !args.lastAttempt) {
      await prisma.reply.update({
        where: { id: reply.id },
        data: { status: "queued", error: message.slice(0, 1000) },
      })
      return { outcome: "failed", error: message, retry: true }
    }
    return fail(prisma, reply, message, false)
  }
}

async function finish(
  prisma: PrismaClient,
  reply: Reply & {
    item: { id: string; organizationId: string; threadKey: string | null; receivedAt: Date }
  },
  externalReplyId: string | null,
  at: Date,
): Promise<SendOutcome> {
  const followUps = await prisma.$transaction(async (tx) => {
    await tx.reply.update({
      where: { id: reply.id },
      data: { status: "sent", externalReplyId, sentAt: at, error: null },
    })
    await tx.item.update({
      where: { id: reply.item.id },
      data: {
        status: "replied",
        resolvedAt: at,
        resolvedById: reply.sentById,
        manualOverride: true,
      },
    })
    return markLaterItemsAsFollowUps(tx, reply.item)
  })
  return { outcome: "sent", externalReplyId, itemIds: [reply.item.id, ...followUps] }
}

async function fail(
  prisma: PrismaClient,
  reply: Reply & { item: { id: string } },
  error: string,
  retry: boolean,
): Promise<SendOutcome> {
  await prisma.$transaction([
    prisma.reply.update({
      where: { id: reply.id },
      data: { status: "failed", error: error.slice(0, 1000) },
    }),
    prisma.item.update({ where: { id: reply.item.id }, data: { status: "failed" } }),
  ])
  return { outcome: "failed", error, retry }
}
