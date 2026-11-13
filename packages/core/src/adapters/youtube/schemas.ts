/**
 * YouTube Data API v3 wire formats (PLAN §11). Comments are polling only: `commentThreads.list`
 * with `allThreadsRelatedToChannelId` (1 unit/page), replies with `comments.insert` (50 units).
 */
import { z } from "zod"

export const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl"
export const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3"

export const ytCommentSchema = z.looseObject({
  id: z.string(),
  snippet: z.looseObject({
    authorDisplayName: z.string().optional(),
    authorProfileImageUrl: z.string().optional(),
    authorChannelUrl: z.string().optional(),
    authorChannelId: z.looseObject({ value: z.string() }).optional(),
    channelId: z.string().optional(),
    videoId: z.string().optional(),
    textDisplay: z.string().optional(),
    textOriginal: z.string().optional(),
    parentId: z.string().optional(),
    publishedAt: z.string(),
    updatedAt: z.string().optional(),
    moderationStatus: z.string().optional(),
  }),
})
export type YtComment = z.infer<typeof ytCommentSchema>

export const ytCommentThreadSchema = z.looseObject({
  id: z.string(),
  snippet: z.looseObject({
    channelId: z.string().optional(),
    videoId: z.string().optional(),
    topLevelComment: ytCommentSchema,
    totalReplyCount: z.number().optional(),
    canReply: z.boolean().optional(),
  }),
  replies: z.looseObject({ comments: z.array(ytCommentSchema) }).optional(),
})
export type YtCommentThread = z.infer<typeof ytCommentThreadSchema>

export const ytCommentThreadListSchema = z.looseObject({
  items: z.array(ytCommentThreadSchema).optional(),
  nextPageToken: z.string().optional(),
})

export const ytCommentListSchema = z.looseObject({
  items: z.array(ytCommentSchema).optional(),
  nextPageToken: z.string().optional(),
})

export const ytChannelListSchema = z.looseObject({
  items: z
    .array(
      z.looseObject({
        id: z.string(),
        snippet: z
          .looseObject({
            title: z.string().optional(),
            customUrl: z.string().optional(),
            thumbnails: z
              .looseObject({ default: z.looseObject({ url: z.string() }).optional() })
              .optional(),
          })
          .optional(),
        statistics: z
          .looseObject({
            videoCount: z.string().optional(),
            subscriberCount: z.string().optional(),
          })
          .optional(),
      }),
    )
    .optional(),
})
