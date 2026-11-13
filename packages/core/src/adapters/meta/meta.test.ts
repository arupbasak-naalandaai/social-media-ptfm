import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { replyLengthError } from "../../ai/drafts"
import {
  metaTime,
  normalizeFbCommentNode,
  normalizeFbFeedComment,
  normalizeIgCommentValue,
  normalizeMetaConversationMessage,
  normalizeMetaMessagingEvent,
} from "./normalize"
import {
  fbFeedCommentValueSchema,
  igCommentValueSchema,
  metaMessagingEventSchema,
  metaWebhookSchema,
} from "./schemas"

const fixture = (name: string) =>
  metaWebhookSchema.parse(
    JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, `../../../fixtures/meta/${name}`), "utf8"),
    ),
  )

describe("Meta webhooks → NormalizedItem", () => {
  it("Facebook feed comment", () => {
    const hook = fixture("fb-comment.json")
    const entry = hook.entry[0]!
    const value = fbFeedCommentValueSchema.parse(entry.changes![0]!.value)
    const item = normalizeFbFeedComment(value, { accountExternalId: entry.id, time: entry.time })!
    expect(item).toMatchObject({
      platform: "facebook",
      type: "comment",
      eventKind: "created",
      externalId: "1001_2002_3003",
      parentExternalId: null, // parent_id === post_id: a top-level comment
      postId: "1001_2002",
      postUrl: "https://www.facebook.com/1001/posts/2002",
      authorName: "Priya Sharma",
      authorId: "5551",
      isOwnAccount: false,
      text: "Do you have vegan options on the weekend menu?",
    })
    expect(item.platformCreatedAt?.toISOString()).toBe("2025-11-13T10:33:20.000Z")
  })

  it("Facebook reply, own comment, edit, removal and unknown verbs", () => {
    const base = {
      item: "comment" as const,
      verb: "add",
      comment_id: "c2",
      post_id: "p1",
      parent_id: "c1",
      from: { id: "page-1", name: "Us" },
      message: "Thanks!",
    }
    const reply = normalizeFbFeedComment(base, { accountExternalId: "page-1" })!
    expect(reply).toMatchObject({ parentExternalId: "c1", isOwnAccount: true })
    expect(
      normalizeFbFeedComment({ ...base, verb: "edited" }, { accountExternalId: "x" })!.eventKind,
    ).toBe("edited")
    expect(
      normalizeFbFeedComment({ ...base, verb: "remove" }, { accountExternalId: "x" })!.eventKind,
    ).toBe("deleted")
    expect(
      normalizeFbFeedComment({ ...base, verb: "block" }, { accountExternalId: "x" }),
    ).toBeNull()
    // Non-comment feed changes don't match the comment schema (skipped by the handler).
    expect(fbFeedCommentValueSchema.safeParse({ item: "reaction", verb: "add" }).success).toBe(
      false,
    )
  })

  it("Instagram comment", () => {
    const hook = fixture("ig-comment.json")
    const entry = hook.entry[0]!
    const value = igCommentValueSchema.parse(entry.changes![0]!.value)
    const item = normalizeIgCommentValue(value, { accountExternalId: entry.id, time: entry.time })
    expect(item).toMatchObject({
      platform: "instagram",
      type: "comment",
      externalId: "17890000000000001",
      postId: "17900000000000002",
      authorHandle: "rahul.eats",
      isOwnAccount: false,
      text: "What time do you open on Sundays?",
    })
  })

  it("Messenger DM: thread keyed by the customer, window from the message time", () => {
    const hook = fixture("fb-dm.json")
    const entry = hook.entry[0]!
    const event = metaMessagingEventSchema.parse(entry.messaging![0])
    const item = normalizeMetaMessagingEvent(event, {
      platform: "facebook",
      accountExternalId: entry.id,
      customerName: "Anil",
    })!
    expect(item).toMatchObject({
      type: "dm",
      eventKind: "created",
      externalId: "m_fbdm_0001",
      isOwnAccount: false,
      authorName: "Anil",
      conversation: { externalThreadId: "24000000000000001", customerId: "24000000000000001" },
    })
    expect(item.platformCreatedAt?.getTime()).toBe(1763030200000)
  })

  it("echoes keep the customer as the thread; receipts are ignored", () => {
    const echo = normalizeMetaMessagingEvent(
      {
        sender: { id: "page-1" },
        recipient: { id: "cust-1" },
        timestamp: 1,
        message: { mid: "m_echo", text: "On it!", is_echo: true },
      },
      { platform: "facebook", accountExternalId: "page-1" },
    )!
    expect(echo).toMatchObject({
      eventKind: "echo",
      isOwnAccount: true,
      conversation: { customerId: "cust-1" },
    })
    const read = normalizeMetaMessagingEvent(
      { sender: { id: "c" }, recipient: { id: "p" }, timestamp: 1 },
      { platform: "facebook", accountExternalId: "p" },
    )
    expect(read).toBeNull()
    const photo = normalizeMetaMessagingEvent(
      {
        sender: { id: "c" },
        recipient: { id: "p" },
        timestamp: 1,
        message: { mid: "m_img", attachments: [{ type: "image" }] },
      },
      { platform: "instagram", accountExternalId: "p" },
    )!
    expect(photo.text).toBe("[image]")
  })

  it("reconcile nodes match webhook ids (no duplicates across both paths)", () => {
    const fb = normalizeFbCommentNode(
      { id: "1001_2002_3003", created_time: "2026-11-13T10:00:00+0000", from: { id: "5" } },
      { accountExternalId: "1001", postId: "1001_2002", postUrl: null },
    )
    expect(fb.externalId).toBe("1001_2002_3003")
    const dm = normalizeMetaConversationMessage(
      { id: "m_fbdm_0001", created_time: "2026-11-13T10:00:00+0000", from: { id: "1001" } },
      { platform: "facebook", accountExternalId: "1001", customerId: "24" },
    )
    expect(dm).toMatchObject({ externalId: "m_fbdm_0001", isOwnAccount: true, eventKind: "echo" })
  })

  it("metaTime accepts seconds and milliseconds", () => {
    const fb = new Date(0)
    expect(metaTime(1_763_030_000, fb).getTime()).toBe(1_763_030_000_000)
    expect(metaTime(1_763_030_000_123, fb).getTime()).toBe(1_763_030_000_123)
    expect(metaTime(undefined, fb)).toBe(fb)
  })

  it("DM length limits differ from comment limits", () => {
    expect(replyLengthError("instagram", "x".repeat(1001), "dm")).toMatch(/1000 characters/)
    expect(replyLengthError("instagram", "x".repeat(1001), "comment")).toBeNull()
    expect(replyLengthError("facebook", "x".repeat(2001), "dm")).toMatch(/2000 characters/)
  })
})
