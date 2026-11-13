import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { normalizeGbpReview, splitTranslatedComment } from "./normalize"
import {
  gbpReviewListSchema,
  locationIdOf,
  parseGbpNotification,
  pubsubPushSchema,
} from "./schemas"

const fixture = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, "../../../fixtures/google_business/reviews-list.json"),
    "utf8",
  ),
) as unknown

describe("Google reviews: list + normalize", () => {
  const list = gbpReviewListSchema.parse(fixture)
  const [edited, ratingOnly, replied] = list.reviews!.map((r) =>
    normalizeGbpReview(r, { mapsUri: "https://maps.google.com/?cid=1", receivedAt: new Date(0) }),
  )

  it("parses the list (unknown fields kept) with paging", () => {
    expect(list.reviews).toHaveLength(3)
    expect(list.nextPageToken).toBe("page-2")
    expect((list.reviews![2] as Record<string, unknown>).someNewField).toEqual({ kept: true })
  })

  it("maps rating, author, text and times; keeps the original language over Google's translation", () => {
    expect(edited).toMatchObject({
      platform: "google_business",
      type: "review",
      externalId: "rev-edited",
      eventKind: "edited",
      rating: 2,
      authorName: "Ana Souza",
      authorAvatarUrl: "https://lh3.googleusercontent.com/a/ana",
      text: "A massa estava fria.",
      externalUrl: "https://business.google.com/reviews/reply/rev-edited",
    })
    expect(edited!.platformCreatedAt?.toISOString()).toBe("2026-11-10T09:00:00.000Z")
    expect(edited!.raw).toMatchObject({ translated: true })
  })

  it("handles anonymous rating-only reviews", () => {
    expect(ratingOnly).toMatchObject({
      eventKind: "created",
      rating: 5,
      text: null,
      authorName: "A Google user",
      authorAvatarUrl: null,
      externalUrl: "https://maps.google.com/?cid=1",
    })
  })

  it("treats a small updateTime bump as created and keeps the owner's reply in raw", () => {
    expect(replied!.eventKind).toBe("created")
    expect(replied!.raw).toMatchObject({ reviewReply: { comment: "Thanks Tom!" } })
  })
})

describe("splitTranslatedComment", () => {
  it("handles both orders and plain text", () => {
    expect(
      splitTranslatedComment("(Original)\nSehr gut!\n\n(Translated by Google) Very good!"),
    ).toEqual({ text: "Sehr gut!", translated: true })
    expect(splitTranslatedComment("  Just great  ")).toEqual({
      text: "Just great",
      translated: false,
    })
    // Translation without an original: keep what we have.
    expect(splitTranslatedComment("(Translated by Google) Nice").translated).toBe(false)
  })
})

describe("Pub/Sub notifications", () => {
  const push = (payload: unknown) =>
    pubsubPushSchema.parse({
      message: {
        data: Buffer.from(JSON.stringify(payload)).toString("base64"),
        messageId: "m-1",
        publishTime: "2026-11-13T10:00:00Z",
      },
      subscription: "projects/p/subscriptions/s",
    })

  it("accepts every field spelling and derives the location from the review name", () => {
    expect(
      parseGbpNotification(
        push({
          type: "NEW_REVIEW",
          review: "accounts/1/locations/2/reviews/3",
          location: "accounts/1/locations/2",
        }),
      ),
    ).toEqual({
      type: "NEW_REVIEW",
      reviewName: "accounts/1/locations/2/reviews/3",
      locationName: "accounts/1/locations/2",
    })
    expect(
      parseGbpNotification(
        push({
          notificationType: "UPDATED_REVIEW",
          review_name: "accounts/1/locations/2/reviews/3",
        }),
      ),
    ).toEqual({
      type: "UPDATED_REVIEW",
      reviewName: "accounts/1/locations/2/reviews/3",
      locationName: "accounts/1/locations/2",
    })
  })

  it("returns null for empty or garbage data", () => {
    expect(parseGbpNotification(pubsubPushSchema.parse({ message: {} }))).toBeNull()
    expect(
      parseGbpNotification(pubsubPushSchema.parse({ message: { data: "!!!not-base64" } })),
    ).toBeNull()
  })

  it("locationIdOf normalises both name forms", () => {
    expect(locationIdOf("accounts/1/locations/2/reviews/3")).toBe("locations/2")
    expect(locationIdOf("locations/9")).toBe("locations/9")
    expect(locationIdOf("accounts/1")).toBeNull()
  })
})
