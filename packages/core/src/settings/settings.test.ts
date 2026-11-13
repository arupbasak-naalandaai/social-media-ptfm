import { describe, expect, it } from "vitest"
import {
  SECTION_SCHEMAS,
  SECTION_SECRETS,
  SETTINGS_SECTIONS,
  parseSectionSecrets,
  parseSectionValues,
  secretLast4,
  secretStatuses,
  settingsUpdateSchema,
  syncSettingsSchema,
} from "./sections"
import {
  SYNC_STREAMS,
  SYNC_STREAM_KEYS,
  backoffSeconds,
  computeNextRunAt,
  estimateYoutubeDailyUnits,
  streamsForKind,
  syncStreamKeyFor,
  youtubeQuotaDay,
} from "./sync"

describe("section schemas", () => {
  it.each(SETTINGS_SECTIONS)("%s parses {} into complete defaults", (section) => {
    const values = SECTION_SCHEMAS[section].parse({})
    // Round-trips: defaults are themselves valid input.
    expect(SECTION_SCHEMAS[section].parse(values)).toEqual(values)
  })

  it("fills nested defaults", () => {
    const sync = syncSettingsSchema.parse({ streams: { yt_comments: { intervalMinutes: 15 } } })
    expect(sync.streams.yt_comments).toEqual({ mode: "polling", intervalMinutes: 15 })
    expect(sync.streams.gbp_reviews).toEqual({ mode: "webhook_reconcile", intervalMinutes: 30 })
    expect(sync.youtube.dailyQuota).toBe(10_000)
  })

  it("parseSectionValues falls back to defaults for invalid stored JSON", () => {
    expect(parseSectionValues("data", { webhookRetentionDays: -1 })).toEqual(
      SECTION_SCHEMAS.data.parse({}),
    )
    expect(parseSectionValues("data", null)).toEqual(SECTION_SCHEMAS.data.parse({}))
  })

  it("general rejects unknown time zones", () => {
    expect(SECTION_SCHEMAS.general.safeParse({ timezone: "Asia/Kolkata" }).success).toBe(true)
    expect(SECTION_SCHEMAS.general.safeParse({ timezone: "Mars/Olympus" }).success).toBe(false)
  })

  it("connections validates formats", () => {
    const s = SECTION_SCHEMAS.connections
    expect(s.safeParse({ meta: { appId: "123abc" } }).success).toBe(false)
    expect(s.safeParse({ meta: { graphApiVersion: "26" } }).success).toBe(false)
    expect(s.safeParse({ linkedin: { apiVersion: "2026-10" } }).success).toBe(false)
    expect(s.safeParse({ google: { reviewsBaseUrl: "http://insecure.example" } }).success).toBe(
      false,
    )
    expect(
      s.parse({ google: { reviewsBaseUrl: "https://mybusiness.googleapis.com/v4/" } }).google
        .reviewsBaseUrl,
    ).toBe("https://mybusiness.googleapis.com/v4")
  })

  it("data retention: 0 or ≥ 90 days for filtered items", () => {
    const s = SECTION_SCHEMAS.data
    expect(s.safeParse({ filteredRetentionDays: 0 }).success).toBe(true)
    expect(s.safeParse({ filteredRetentionDays: 30 }).success).toBe(false)
    expect(s.safeParse({ filteredRetentionDays: 90 }).success).toBe(true)
  })
})

describe("sync minimums (PLAN §12)", () => {
  const minimums: Record<string, number> = {
    gbp_reviews: 5,
    fb_comments: 10,
    fb_dms: 10,
    ig_comments: 10,
    ig_dms: 10,
    yt_comments: 1,
    li_comments: 5,
  }

  it.each(SYNC_STREAM_KEYS)("%s enforces its minimum interval", (key) => {
    const min = minimums[key]!
    expect(SYNC_STREAMS[key].minMinutes).toBe(min)
    const below = syncSettingsSchema.safeParse({ streams: { [key]: { intervalMinutes: min - 1 } } })
    expect(below.success).toBe(false)
    if (!below.success) expect(below.error.issues[0]!.message).toMatch(`minimum is ${min} min`)
    expect(
      syncSettingsSchema.safeParse({ streams: { [key]: { intervalMinutes: min } } }).success,
    ).toBe(true)
  })

  it("rejects fractional and over-24h intervals", () => {
    expect(
      syncSettingsSchema.safeParse({ streams: { gbp_reviews: { intervalMinutes: 7.5 } } }).success,
    ).toBe(false)
    expect(
      syncSettingsSchema.safeParse({ streams: { gbp_reviews: { intervalMinutes: 1441 } } }).success,
    ).toBe(false)
  })

  it("YouTube is polling only", () => {
    expect(
      syncSettingsSchema.safeParse({ streams: { yt_comments: { mode: "webhook_reconcile" } } })
        .success,
    ).toBe(false)
  })

  it("token refresh is at least hourly", () => {
    expect(syncSettingsSchema.parse({}).tokenRefreshHours).toBe(6)
    expect(syncSettingsSchema.safeParse({ tokenRefreshHours: 0 }).success).toBe(false)
  })
})

describe("scheduler math", () => {
  const now = new Date("2026-11-13T12:00:00Z")

  it("backoff doubles per failure, capped at 6 h, never below the interval", () => {
    expect(backoffSeconds(300, 0)).toBe(300)
    expect(backoffSeconds(300, 1)).toBe(600)
    expect(backoffSeconds(300, 3)).toBe(2400)
    expect(backoffSeconds(300, 20)).toBe(6 * 3600)
    expect(backoffSeconds(12 * 3600, 2)).toBe(12 * 3600)
  })

  it("computeNextRunAt counts from the last run, or from now", () => {
    const last = new Date("2026-11-13T11:50:00Z")
    expect(
      computeNextRunAt({ lastRunAt: last, now, intervalSeconds: 1800, failures: 0 }).toISOString(),
    ).toBe("2026-11-13T12:20:00.000Z")
    expect(
      computeNextRunAt({ lastRunAt: null, now, intervalSeconds: 300, failures: 0 }).toISOString(),
    ).toBe("2026-11-13T12:05:00.000Z")
    // Shortening the interval can make it due right away (in the past).
    expect(
      computeNextRunAt({ lastRunAt: last, now, intervalSeconds: 60, failures: 0 }).getTime(),
    ).toBeLessThan(now.getTime())
  })

  it("estimates YouTube polling units per day", () => {
    expect(estimateYoutubeDailyUnits({ intervalMinutes: 5, channels: 1, pagesPerPoll: 1 })).toBe(
      288,
    )
    expect(estimateYoutubeDailyUnits({ intervalMinutes: 1, channels: 3, pagesPerPoll: 2 })).toBe(
      8640,
    )
    expect(estimateYoutubeDailyUnits({ intervalMinutes: 7, channels: 1, pagesPerPoll: 1 })).toBe(
      206,
    )
    expect(estimateYoutubeDailyUnits({ intervalMinutes: 5, channels: 0, pagesPerPoll: 1 })).toBe(0)
  })

  it("YouTube quota day is Pacific time", () => {
    expect(youtubeQuotaDay(new Date("2026-11-13T07:59:00Z"))).toBe("2026-11-12")
    expect(youtubeQuotaDay(new Date("2026-11-13T08:01:00Z"))).toBe("2026-11-13")
  })

  it("maps platforms, streams and account kinds", () => {
    expect(syncStreamKeyFor("facebook", "dms")).toBe("fb_dms")
    expect(syncStreamKeyFor("youtube", "dms")).toBeNull()
    expect(streamsForKind("ig_account")).toEqual(["ig_comments", "ig_dms"])
    expect(streamsForKind("gbp_location")).toEqual(["gbp_reviews"])
  })
})

describe("secrets", () => {
  it("statuses never include ciphertext", () => {
    const stored = parseSectionSecrets("ai", {
      provider: "openai",
      secrets: {
        openaiApiKey: { enc: "v1:k:iv:tag:ct", last4: "wxyz" },
        bogusKey: { enc: "v1:x", last4: "" },
        anthropicApiKey: { enc: "" },
      },
    })
    expect(Object.keys(stored)).toEqual(["openaiApiKey"])
    const statuses = secretStatuses("ai", stored)
    expect(statuses).toEqual({
      anthropicApiKey: { set: false, last4: null },
      openaiApiKey: { set: true, last4: "wxyz" },
      googleApiKey: { set: false, last4: null },
    })
    expect(JSON.stringify(statuses)).not.toContain("v1:")
  })

  it("only shows last4 for long values", () => {
    expect(secretLast4("sk-ant-0123456789abcd")).toBe("abcd")
    expect(secretLast4("short")).toBe("")
  })

  it("update schema accepts known secret keys only", () => {
    const schema = settingsUpdateSchema("connections")
    expect(
      schema.safeParse({ version: 1, values: {}, secrets: { metaAppSecret: "abc" } }).success,
    ).toBe(true)
    expect(
      schema.safeParse({ version: 1, values: {}, secrets: { metaAppSecret: null } }).success,
    ).toBe(true)
    expect(schema.safeParse({ version: 1, values: {}, secrets: { nope: "abc" } }).success).toBe(
      false,
    )
    expect(
      settingsUpdateSchema("data").safeParse({ version: 1, values: {}, secrets: { x: "y" } })
        .success,
    ).toBe(false)
  })

  it("every section with secrets lists them", () => {
    expect(SECTION_SECRETS.ai).toHaveLength(3)
    expect(SECTION_SECRETS.slack).toEqual(["botToken", "signingSecret"])
  })
})
