/**
 * YouTube in the worker (Phase 6): comment polling with quota counting, and the reply sender.
 * There is no push for comments, so polling is the only source.
 */
import { YOUTUBE_UNITS_PER_REPLY } from "@inbox/core"
import {
  addYoutubeQuota,
  fetchNewYoutubeComments,
  GoogleApiError,
  googleAccessToken,
  insertYoutubeReply,
  loadSettingsSection,
  ReplySendError,
  YoutubeApiError,
} from "@inbox/pipeline"
import { registerPollAdapter } from "../sync/adapters"
import { registerReplySender } from "../sync/senders"

export function registerYoutube(): void {
  registerPollAdapter("yt_comments", async ({ prisma, keyring, account, state, signal }) => {
    const token = await googleAccessToken(prisma, keyring, account)
    const sync = await loadSettingsSection(prisma, account.organizationId, "sync")
    const res = await fetchNewYoutubeComments(token, {
      channelId: account.externalId,
      cursor: state.cursor,
      backfillDays: state.backfillDays,
      pagesPerPoll: sync.youtube.pagesPerPoll,
      signal,
    })
    return { items: res.items, cursor: res.cursor, quotaUnits: res.quotaUnits }
  })

  registerReplySender("youtube", ({ prisma, keyring }) => ({
    // comments.insert creates a new comment each time: not idempotent.
    idempotent: false,
    async send({ reply, item, account }) {
      // Replies go under the top-level comment (YouTube threads are one level deep).
      const parentId = item.parentExternalId ?? item.externalId
      try {
        const token = await googleAccessToken(prisma, keyring, account)
        const res = await insertYoutubeReply(token, parentId, reply.text)
        await addYoutubeQuota(prisma, account, YOUTUBE_UNITS_PER_REPLY)
        return { externalReplyId: res.id }
      } catch (err) {
        if (err instanceof YoutubeApiError || err instanceof GoogleApiError) {
          throw new ReplySendError(err.message, err.retryable)
        }
        throw err
      }
    },
  }))
}
