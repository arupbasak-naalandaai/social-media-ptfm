/**
 * Google Business Profile wire formats (PLAN §11, re-verified 2026-11-13). Parsed with zod so
 * an API change fails loudly at the edge instead of deep in the pipeline. Unknown fields pass
 * through (`looseObject`) because Google adds fields over time.
 */
import { z } from "zod"

export const STAR_RATINGS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 } as const

export const gbpReviewSchema = z.looseObject({
  /** `accounts/{a}/locations/{l}/reviews/{r}` */
  name: z.string().min(1),
  reviewId: z.string().min(1),
  reviewer: z
    .looseObject({
      displayName: z.string().optional(),
      profilePhotoUrl: z.string().optional(),
      isAnonymous: z.boolean().optional(),
    })
    .optional(),
  starRating: z.string().optional(),
  /** Absent on rating-only reviews. */
  comment: z.string().optional(),
  createTime: z.string(),
  updateTime: z.string().optional(),
  reviewReply: z
    .looseObject({
      comment: z.string().optional(),
      updateTime: z.string().optional(),
      reviewReplyState: z.string().optional(),
    })
    .optional(),
  reviewReplyUrl: z.string().optional(),
})
export type GbpReview = z.infer<typeof gbpReviewSchema>

export const gbpReviewListSchema = z.looseObject({
  reviews: z.array(gbpReviewSchema).optional(),
  averageRating: z.number().optional(),
  totalReviewCount: z.number().optional(),
  nextPageToken: z.string().optional(),
})
export type GbpReviewList = z.infer<typeof gbpReviewListSchema>

export const gbpReviewReplySchema = z.looseObject({
  comment: z.string().optional(),
  updateTime: z.string().optional(),
})

/** Account Management API v1 `accounts.list`. */
export const gbpAccountListSchema = z.looseObject({
  accounts: z
    .array(
      z.looseObject({
        /** `accounts/{a}` */
        name: z.string(),
        accountName: z.string().optional(),
        type: z.string().optional(),
        role: z.string().optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
})

/** Business Information API v1 `accounts.locations.list` (readMask=name,title,storeCode,metadata). */
export const gbpLocationListSchema = z.looseObject({
  locations: z
    .array(
      z.looseObject({
        /** `locations/{l}` */
        name: z.string(),
        title: z.string().optional(),
        storeCode: z.string().optional(),
        metadata: z
          .looseObject({
            mapsUri: z.string().optional(),
            newReviewUri: z.string().optional(),
            placeId: z.string().optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
})
export type GbpLocation = NonNullable<z.infer<typeof gbpLocationListSchema>["locations"]>[number]

/** OAuth token endpoint response (code exchange and refresh). */
export const googleTokenSchema = z.looseObject({
  access_token: z.string().min(1),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  token_type: z.string().optional(),
})
export type GoogleToken = z.infer<typeof googleTokenSchema>

export const googleErrorSchema = z.looseObject({
  error: z.union([
    z.string(),
    z.looseObject({
      code: z.number().optional(),
      message: z.string().optional(),
      status: z.string().optional(),
    }),
  ]),
  error_description: z.string().optional(),
})

export const GBP_SCOPE = "https://www.googleapis.com/auth/business.manage"

// ─── Pub/Sub push ──────────────────────────────────────────────────────────────

export const pubsubPushSchema = z.looseObject({
  message: z.looseObject({
    data: z.string().optional(),
    attributes: z.record(z.string(), z.string()).optional(),
    messageId: z.string().optional(),
    message_id: z.string().optional(),
    publishTime: z.string().optional(),
  }),
  subscription: z.string().optional(),
})
export type PubsubPush = z.infer<typeof pubsubPushSchema>

export interface GbpNotification {
  type: string | null
  /** `accounts/{a}/locations/{l}/reviews/{r}` when given. */
  reviewName: string | null
  /** `accounts/{a}/locations/{l}` or `locations/{l}` when given. */
  locationName: string | null
}

function pick(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === "string" && v) return v
  }
  return null
}

/**
 * The decoded GBP notification isn't documented. Accept every spelling seen in Google's prose
 * and treat it only as a hint: the handler refetches reviews for the location.
 */
export function parseGbpNotification(push: PubsubPush): GbpNotification | null {
  const data = push.message.data
  if (!data) return null
  let decoded: unknown
  try {
    // atob + TextDecoder: works in Node and the browser (this package is shared with web).
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
    decoded = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return null
  }
  if (!decoded || typeof decoded !== "object") return null
  const o = decoded as Record<string, unknown>
  const reviewName = pick(o, ["review", "reviewName", "review_name"])
  let locationName = pick(o, ["location", "locationName", "location_name"])
  if (!locationName && reviewName) {
    const m = /^(accounts\/[^/]+\/locations\/[^/]+)\//.exec(reviewName)
    locationName = m?.[1] ?? null
  }
  return {
    type: pick(o, ["type", "notificationType", "notification_type"]),
    reviewName,
    locationName,
  }
}

/** `locations/{l}` from either `locations/{l}` or `accounts/{a}/locations/{l}…`. */
export function locationIdOf(name: string): string | null {
  const m = /(?:^|\/)locations\/([^/]+)/.exec(name)
  return m ? `locations/${m[1]}` : null
}
