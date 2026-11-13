import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { itemLink } from "../../links"
import { normalizeYtComment } from "./normalize"
import { ytCommentThreadListSchema } from "./schemas"

const list = ytCommentThreadListSchema.parse(
  JSON.parse(
    readFileSync(
      path.resolve(import.meta.dirname, "../../../fixtures/youtube/comment-threads.json"),
      "utf8",
    ),
  ),
)

describe("YouTube comments → NormalizedItem", () => {
  const thread = list.items![0]!
  const top = thread.snippet.topLevelComment
  const ctx = { channelId: "UC-demo-channel", videoId: "vid123" }

  it("top-level comment", () => {
    const item = normalizeYtComment(top, ctx)
    expect(item).toMatchObject({
      platform: "youtube",
      type: "comment",
      eventKind: "created",
      externalId: "UgzThread2",
      parentExternalId: null,
      postId: "vid123",
      postUrl: "https://www.youtube.com/watch?v=vid123",
      authorName: "Meera K",
      authorHandle: "@meerak",
      authorId: "UCmeera",
      isOwnAccount: false,
      text: "Which pan did you use for the dosa?",
    })
    // "Open in YouTube" highlights the comment.
    expect(itemLink({ ...item, accountExternalId: "UC-demo-channel", type: "comment" })?.url).toBe(
      "https://www.youtube.com/watch?v=vid123&lc=UgzThread2",
    )
  })

  it("our own reply is marked as ours; a customer's reply under our comment is a follow-up", () => {
    const ours = normalizeYtComment(thread.replies!.comments[0]!, {
      ...ctx,
      parentId: top.id,
    })
    expect(ours).toMatchObject({
      externalId: "UgzThread2.reply1",
      parentExternalId: "UgzThread2",
      isOwnAccount: true,
      isReplyToOurReply: false,
      text: "A cast-iron tawa!",
    })
    const theirs = normalizeYtComment(
      {
        id: "x.r",
        snippet: {
          authorChannelId: { value: "UCfan" },
          parentId: "x",
          textDisplay: "thanks!",
          publishedAt: "2026-11-13T11:00:00Z",
        },
      },
      { ...ctx, parentIsOurs: true },
    )
    expect(theirs).toMatchObject({ isReplyToOurReply: true, postId: "vid123" })
  })
})
