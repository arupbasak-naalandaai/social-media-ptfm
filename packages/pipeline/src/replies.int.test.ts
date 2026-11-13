/**
 * Reply pipeline against a real database (TEST_DATABASE_URL) with fake platform senders.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { createPrismaClient } from "@inbox/db"
import {
  cancelReply,
  queueReply,
  ReplyRejected,
  ReplySendError,
  sendQueuedReply,
  type ReplySender,
} from "./replies"

const url = process.env.TEST_DATABASE_URL
const prisma = url ? createPrismaClient(url) : null
const ORG = "reply-org"
const USER = "u-reply"

let reviewId = ""
let dmId = ""
let laterId = ""

async function seed() {
  await prisma!.organization.create({
    data: { id: ORG, name: "R", slug: "r", createdAt: new Date() },
  })
  await prisma!.settings.create({
    data: {
      organizationId: ORG,
      replies: { undoSeconds: 7, signature: "– Team Demo", signatureOn: { review: true } },
    },
  })
  const gbp = await prisma!.platformAccount.create({
    data: {
      organizationId: ORG,
      platform: "google_business",
      kind: "gbp_location",
      externalId: "locations/1",
      displayName: "Demo",
      accessTokenEnc: "v1:x",
    },
  })
  const ig = await prisma!.platformAccount.create({
    data: {
      organizationId: ORG,
      platform: "instagram",
      kind: "ig_account",
      externalId: "ig-1",
      displayName: "Demo IG",
      status: "disconnected",
      meta: { demo: true },
    },
  })
  const base = { organizationId: ORG, eventKind: "created", status: "new" as const, raw: {} }
  reviewId = (
    await prisma!.item.create({
      data: {
        ...base,
        platform: "google_business",
        platformAccountId: gbp.id,
        type: "review",
        externalId: "rev-1",
        receivedAt: new Date(Date.now() - 60_000),
        threadKey: "gbp:rev-1",
        text: "Great",
      },
    })
  ).id
  laterId = (
    await prisma!.item.create({
      data: {
        ...base,
        platform: "google_business",
        platformAccountId: gbp.id,
        type: "review",
        externalId: "rev-1-edit",
        receivedAt: new Date(),
        threadKey: "gbp:rev-1",
        text: "Edited: still great",
      },
    })
  ).id
  const conv = await prisma!.conversation.create({
    data: {
      organizationId: ORG,
      platform: "instagram",
      platformAccountId: ig.id,
      externalThreadId: "t1",
      customerId: "c1",
      customerLastMessageAt: new Date(Date.now() - 2 * 3_600_000),
      status: "new",
    },
  })
  dmId = (
    await prisma!.item.create({
      data: {
        ...base,
        platform: "instagram",
        platformAccountId: ig.id,
        type: "dm",
        externalId: "m1",
        receivedAt: new Date(),
        conversationId: conv.id,
        text: "Hi",
      },
    })
  ).id
}

const okSender = (calls: string[] = []): ReplySender => ({
  idempotent: true,
  async send({ reply }) {
    calls.push(reply.text)
    return { externalReplyId: `ext-${reply.id}` }
  },
})

describe.skipIf(!url)("reply pipeline (integration)", () => {
  beforeEach(async () => {
    await prisma!.$executeRawUnsafe(
      'TRUNCATE "reply", "ai_draft", "item", "conversation", "platform_account", "settings", "organization" CASCADE',
    )
    await seed()
  })
  afterAll(async () => prisma?.$disconnect())

  const queue = (itemId: string, text: string, draftId?: string) =>
    queueReply(prisma!, { organizationId: ORG, itemId, userId: USER, text, draftId })

  it("queues with the signature and undo window, marks the chosen draft, and blocks a second send", async () => {
    const draft = await prisma!.aiDraft.create({
      data: {
        organizationId: ORG,
        itemId: reviewId,
        text: "Thanks!",
        provider: "anthropic",
        model: "m",
      },
    })
    const q = await queue(reviewId, "Thanks!", draft.id)
    expect(q.reply.text).toBe("Thanks!\n\n– Team Demo")
    expect(q.reply.source).toBe("ai_draft")
    expect(q.reply.status).toBe("queued")
    expect(q.undoSeconds).toBe(7)
    expect((await prisma!.aiDraft.findUniqueOrThrow({ where: { id: draft.id } })).chosen).toBe(true)
    await expect(queue(reviewId, "Again")).rejects.toThrow(/already being sent/)
  })

  it("rejects replies over Google's 4096-byte limit", async () => {
    const err = await queue(reviewId, "€".repeat(1400)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ReplyRejected)
    expect((err as ReplyRejected).status).toBe(400)
    expect((err as Error).message).toMatch(/4096 bytes/)
  })

  it("enforces the DM reply window (Instagram 24 h) and allows demo accounts", async () => {
    // 2 h since the customer's last message: open. Demo account: allowed without a token.
    expect((await queue(dmId, "Hello")).reply.text).toBe("Hello") // no signature on DMs
    await prisma!.reply.deleteMany()
    await prisma!.conversation.updateMany({
      data: { customerLastMessageAt: new Date(Date.now() - 25 * 3_600_000) },
    })
    await expect(queue(dmId, "Hello")).rejects.toThrow(/24-hour reply window has closed/)
  })

  it("undo deletes a queued reply but not one already sending", async () => {
    const { reply } = await queue(reviewId, "Thanks")
    expect(await cancelReply(prisma!, ORG, reply.id)).toBe("Thanks\n\n– Team Demo")
    expect(await prisma!.reply.count()).toBe(0)
    // Sending a cancelled reply is a no-op.
    expect(
      await sendQueuedReply(prisma!, {
        replyId: reply.id,
        senderFor: () => okSender(),
        lastAttempt: false,
      }),
    ).toEqual({ outcome: "skipped", reason: "Reply was cancelled" })

    const second = await queue(reviewId, "Thanks again")
    await prisma!.reply.update({ where: { id: second.reply.id }, data: { status: "sending" } })
    expect(await cancelReply(prisma!, ORG, second.reply.id)).toBeNull()
  })

  it("sends: reply sent, item replied, later items in the thread become follow-ups", async () => {
    const calls: string[] = []
    const { reply } = await queue(reviewId, "Thanks")
    const res = await sendQueuedReply(prisma!, {
      replyId: reply.id,
      senderFor: () => okSender(calls),
      lastAttempt: false,
    })
    expect(res).toEqual({
      outcome: "sent",
      externalReplyId: `ext-${reply.id}`,
      itemIds: [reviewId, laterId],
    })
    expect(calls).toEqual(["Thanks\n\n– Team Demo"])
    const [r, item, later] = await Promise.all([
      prisma!.reply.findUniqueOrThrow({ where: { id: reply.id } }),
      prisma!.item.findUniqueOrThrow({ where: { id: reviewId } }),
      prisma!.item.findUniqueOrThrow({ where: { id: laterId } }),
    ])
    expect(r.status).toBe("sent")
    expect(r.sentAt).not.toBeNull()
    expect(item.status).toBe("replied")
    expect(item.resolvedById).toBe(USER)
    expect(later.isFollowUp).toBe(true)

    // A retried job never posts twice.
    expect(
      await sendQueuedReply(prisma!, {
        replyId: reply.id,
        senderFor: () => okSender(calls),
        lastAttempt: false,
      }),
    ).toEqual({ outcome: "skipped", reason: "Already sent" })
    expect(calls).toHaveLength(1)
  })

  it("retries retryable errors, then fails on the last attempt", async () => {
    const { reply } = await queue(reviewId, "Thanks")
    const flaky: ReplySender = {
      idempotent: true,
      async send() {
        throw new ReplySendError("HTTP 503", true)
      },
    }
    expect(
      await sendQueuedReply(prisma!, {
        replyId: reply.id,
        senderFor: () => flaky,
        lastAttempt: false,
      }),
    ).toEqual({ outcome: "failed", error: "HTTP 503", retry: true })
    expect((await prisma!.reply.findUniqueOrThrow({ where: { id: reply.id } })).status).toBe(
      "queued",
    )

    expect(
      await sendQueuedReply(prisma!, {
        replyId: reply.id,
        senderFor: () => flaky,
        lastAttempt: true,
      }),
    ).toEqual({ outcome: "failed", error: "HTTP 503", retry: false })
    expect((await prisma!.reply.findUniqueOrThrow({ where: { id: reply.id } })).status).toBe(
      "failed",
    )
    expect((await prisma!.item.findUniqueOrThrow({ where: { id: reviewId } })).status).toBe(
      "failed",
    )
  })

  it("never re-posts a non-idempotent reply interrupted mid-send", async () => {
    const { reply } = await queue(reviewId, "Thanks")
    await prisma!.reply.update({ where: { id: reply.id }, data: { status: "sending" } })
    const calls: string[] = []
    const comment: ReplySender = { ...okSender(calls), idempotent: false }
    const res = await sendQueuedReply(prisma!, {
      replyId: reply.id,
      senderFor: () => comment,
      lastAttempt: false,
    })
    expect(res).toMatchObject({ outcome: "failed", retry: false })
    expect(calls).toHaveLength(0)

    // …but one interrupted after the platform returned an id just finishes.
    const again = await prisma!.reply.create({
      data: {
        organizationId: ORG,
        itemId: laterId,
        text: "x",
        source: "manual_dashboard",
        status: "sending",
        externalReplyId: "ext-known",
        idempotencyKey: "k-1",
      },
    })
    expect(
      await sendQueuedReply(prisma!, {
        replyId: again.id,
        senderFor: () => comment,
        lastAttempt: false,
      }),
    ).toMatchObject({ outcome: "sent", externalReplyId: "ext-known" })
    expect(calls).toHaveLength(0)
  })
})
