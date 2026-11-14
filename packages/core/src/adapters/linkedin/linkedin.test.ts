import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { itemLink } from "../../links"
import { normalizeLiComment } from "./normalize"
import {
  LINKEDIN_COMMENT_ACTIONS,
  linkedinCommentSchema,
  linkedinWebhookSchema,
  orgIdOf,
  parseCommentUrn,
} from "./schemas"

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, `../../../fixtures/linkedin/${name}`), "utf8"),
  )
const comments = fixture("comments.json") as Record<string, unknown>
const comment = (k: string) => linkedinCommentSchema.parse(comments[k])
const ORG = "urn:li:organization:2414183"

describe("LinkedIn URNs", () => {
  it("splits comment URNs, including the docs' short form", () => {
    expect(
      parseCommentUrn("urn:li:comment:(urn:li:activity:7100000000000000001,7100000000000000101)"),
    ).toEqual({ thread: "urn:li:activity:7100000000000000001", id: "7100000000000000101" })
    expect(parseCommentUrn("urn:li:comment:(activity:63434434348, 12345)")).toEqual({
      thread: "urn:li:activity:63434434348",
      id: "12345",
    })
    expect(parseCommentUrn("urn:li:share:1")).toBeNull()
    expect(orgIdOf(ORG)).toBe("2414183")
  })

  it("reads webhook deliveries; only comment actions carry comments", () => {
    const body = linkedinWebhookSchema.parse(fixture("notifications.json"))
    const commentish = body.notifications.filter((n) =>
      (LINKEDIN_COMMENT_ACTIONS as readonly string[]).includes(n.action),
    )
    expect(commentish).toHaveLength(1)
    expect(commentish[0]!.generatedActivity).toMatch(/^urn:li:comment:/)
  })
})

describe("LinkedIn comments → NormalizedItem", () => {
  it("top-level comment from a member", () => {
    const item = normalizeLiComment(comment("top"), { orgUrn: ORG, authorName: "Meera K" })
    expect(item).toMatchObject({
      platform: "linkedin",
      type: "comment",
      eventKind: "created",
      externalId: "urn:li:comment:(urn:li:activity:7100000000000000001,7100000000000000101)",
      parentExternalId: null,
      postId: "urn:li:activity:7100000000000000001",
      postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001/",
      authorName: "Meera K",
      authorId: "urn:li:person:meeraK1",
      isOwnAccount: false,
      text: "Are you hiring interns this summer?",
    })
    expect(itemLink({ ...item, accountExternalId: "2414183" })).toMatchObject({
      target: "item",
      url: `https://www.linkedin.com/feed/update/urn:li:activity:7100000000000000001/?commentUrn=${encodeURIComponent(item.externalId)}`,
    })
  })

  it("our Page's reply is ours; a member's reply under it is a follow-up", () => {
    const ours = normalizeLiComment(comment("ours"), { orgUrn: ORG })
    expect(ours).toMatchObject({ isOwnAccount: true, authorName: null, isReplyToOurReply: false })

    const follow = normalizeLiComment(comment("followUp"), { orgUrn: ORG, parentIsOurs: true })
    expect(follow).toMatchObject({
      // No commentUrn in the response: built from object + id.
      externalId: "urn:li:comment:(urn:li:activity:7100000000000000001,7100000000000000103)",
      parentExternalId: ours.externalId,
      isReplyToOurReply: true,
      eventKind: "edited",
    })
  })
})
