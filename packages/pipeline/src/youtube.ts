/**
 * YouTube Data API v3 (PLAN §11): channel lookup, comment polling with quota counting, and
 * replies. Uses the same Google OAuth client as Business Profile (Settings → Connections →
 * Google) and the same token refresh (`googleAccessToken`).
 */
import type { z } from "zod"
import {
  YOUTUBE_API_BASE,
  YOUTUBE_UNITS_PER_LIST_PAGE,
  googleErrorSchema,
  normalizeYtComment,
  youtubeQuotaDay,
  ytChannelListSchema,
  ytCommentListSchema,
  ytCommentSchema,
  ytCommentThreadListSchema,
  type NormalizedItem,
} from "@inbox/core"
import type { PlatformAccount, PrismaClient } from "@inbox/db"

const TIMEOUT_MS = 15_000
const DAY_MS = 86_400_000

export class YoutubeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly quotaExceeded = false,
  ) {
    super(message)
    this.name = "YoutubeApiError"
  }
}

async function call<T>(
  url: URL,
  token: string,
  schema: z.ZodType<T>,
  init: { method?: string; body?: unknown; signal?: AbortSignal | undefined } = {},
): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(TIMEOUT_MS)])
        : AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    throw new YoutubeApiError(`YouTube didn't respond: ${(err as Error).message}`, 0, true)
  }
  const body: unknown = await res.json().catch(() => ({}))
  if (!res.ok) {
    const parsed = googleErrorSchema.safeParse(body)
    const e = parsed.success && typeof parsed.data.error === "object" ? parsed.data.error : null
    const reason = JSON.stringify(body).match(/"reason"\s*:\s*"([^"]+)"/)?.[1] ?? ""
    const quota = reason === "quotaExceeded" || reason === "dailyLimitExceeded"
    const hint = quota
      ? " (daily quota used up: it resets at midnight Pacific time)"
      : reason === "commentsDisabled"
        ? " (comments are turned off on this video)"
        : res.status === 403
          ? " (check that the YouTube Data API is enabled and the channel granted access)"
          : ""
    throw new YoutubeApiError(
      `YouTube ${res.status}${reason ? ` ${reason}` : ""}: ${e?.message ?? res.statusText}${hint}`.slice(
        0,
        500,
      ),
      res.status,
      !quota && (res.status === 429 || res.status >= 500),
      quota,
    )
  }
  return schema.parse(body)
}

const api = (path: string) => new URL(`${YOUTUBE_API_BASE}/${path}`)

/** Channels the signed-in Google account owns (brand accounts: pick it on the consent screen). */
export async function listMyYoutubeChannels(token: string) {
  const url = api("channels")
  url.searchParams.set("part", "snippet,statistics")
  url.searchParams.set("mine", "true")
  url.searchParams.set("maxResults", "50")
  const res = await call(url, token, ytChannelListSchema)
  return res.items ?? []
}

const MAX_REPLY_PAGES = 3

/**
 * Comments and replies since the cursor, oldest first, and the quota units used.
 *
 * `commentThreads.list` (order=time) pages newest-first by top-level comment. Replies to older
 * threads are seen while their thread is within the pages read (`pagesPerPoll`); a thread with
 * more replies than are inlined is fetched with `comments.list` (1 unit each).
 */
export async function fetchNewYoutubeComments(
  token: string,
  args: {
    channelId: string
    cursor: string | null
    backfillDays: number
    pagesPerPoll: number
    signal?: AbortSignal
    now?: Date
  },
): Promise<{ items: NormalizedItem[]; cursor: string | undefined; quotaUnits: number }> {
  const since = args.cursor
    ? new Date(args.cursor)
    : new Date((args.now ?? new Date()).getTime() - args.backfillDays * DAY_MS)
  const items: NormalizedItem[] = []
  let units = 0
  let pageToken: string | undefined
  let pages = 0
  let newest = args.cursor ? new Date(args.cursor) : null
  const seen = (d: Date) => {
    if (!newest || d > newest) newest = d
  }

  do {
    const url = api("commentThreads")
    url.searchParams.set("part", "snippet,replies")
    url.searchParams.set("allThreadsRelatedToChannelId", args.channelId)
    url.searchParams.set("maxResults", "100")
    url.searchParams.set("order", "time")
    url.searchParams.set("textFormat", "plainText")
    if (pageToken) url.searchParams.set("pageToken", pageToken)
    const page = await call(url, token, ytCommentThreadListSchema, { signal: args.signal })
    units += YOUTUBE_UNITS_PER_LIST_PAGE
    pages++
    let olderThanCursor = false

    for (const thread of page.items ?? []) {
      const top = thread.snippet.topLevelComment
      const videoId = thread.snippet.videoId ?? top.snippet.videoId ?? null
      const topAt = new Date(top.snippet.publishedAt)
      const topIsOurs = top.snippet.authorChannelId?.value === args.channelId
      if (topAt > since) {
        items.push(normalizeYtComment(top, { channelId: args.channelId, videoId }))
        seen(topAt)
      } else {
        olderThanCursor = true
      }

      let replies = thread.replies?.comments ?? []
      const total = thread.snippet.totalReplyCount ?? replies.length
      if (total > replies.length) {
        replies = await listAllReplies(token, top.id, args.signal, () => units++)
      }
      for (const r of replies) {
        const at = new Date(r.snippet.publishedAt)
        if (at <= since) continue
        items.push(
          normalizeYtComment(r, {
            channelId: args.channelId,
            videoId,
            parentId: top.id,
            parentIsOurs: topIsOurs,
          }),
        )
        seen(at)
      }
    }
    pageToken = page.nextPageToken
    // Keep paging only while the page still had new top-level comments, within the budget.
    if (olderThanCursor) break
  } while (pageToken && pages < args.pagesPerPoll)

  items.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
  return { items, cursor: (newest as Date | null)?.toISOString(), quotaUnits: units }
}

async function listAllReplies(
  token: string,
  parentId: string,
  signal: AbortSignal | undefined,
  onPage: () => void,
) {
  const out: z.infer<typeof ytCommentSchema>[] = []
  let pageToken: string | undefined
  let pages = 0
  do {
    const url = api("comments")
    url.searchParams.set("part", "snippet")
    url.searchParams.set("parentId", parentId)
    url.searchParams.set("maxResults", "100")
    url.searchParams.set("textFormat", "plainText")
    if (pageToken) url.searchParams.set("pageToken", pageToken)
    const page = await call(url, token, ytCommentListSchema, { signal })
    onPage()
    out.push(...(page.items ?? []))
    pageToken = page.nextPageToken
  } while (pageToken && ++pages < MAX_REPLY_PAGES)
  return out
}

/** Reply under a top-level comment (`comments.insert`, 50 units). */
export async function insertYoutubeReply(token: string, parentId: string, text: string) {
  const url = api("comments")
  url.searchParams.set("part", "snippet")
  return call(url, token, ytCommentSchema, {
    method: "POST",
    body: { snippet: { parentId, textOriginal: text } },
  })
}

/** Counts units used outside polling (replies, tests) on the channel's comments stream. */
export async function addYoutubeQuota(
  prisma: PrismaClient,
  account: Pick<PlatformAccount, "id">,
  units: number,
  now = new Date(),
): Promise<void> {
  const state = await prisma.syncState.findFirst({
    where: { platformAccountId: account.id, stream: "comments" },
    select: { id: true, quotaUsedToday: true, quotaDay: true },
  })
  if (!state) return
  const today = youtubeQuotaDay(now)
  const sameDay = state.quotaDay?.toISOString().slice(0, 10) === today
  await prisma.syncState.update({
    where: { id: state.id },
    data: {
      quotaUsedToday: (sameDay ? state.quotaUsedToday : 0) + units,
      quotaDay: new Date(`${today}T00:00:00Z`),
    },
  })
}
