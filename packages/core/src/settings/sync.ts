/**
 * Sync streams, intervals and scheduler math (PLAN §12). Pure: shared by api, worker and web.
 */
import { z } from "zod"
import type { Platform } from "../filters/types"

export const SYNC_MODES = ["webhook_reconcile", "polling", "webhook"] as const
export const syncModeSchema = z.enum(SYNC_MODES)
export type SyncMode = z.infer<typeof syncModeSchema>

export const SYNC_MODE_LABELS: Record<SyncMode, string> = {
  webhook_reconcile: "Webhook + reconcile",
  polling: "Polling",
  webhook: "Webhook only",
}

export const ACCOUNT_KINDS = [
  "gbp_location",
  "fb_page",
  "ig_account",
  "yt_channel",
  "li_org",
] as const
export type AccountKind = (typeof ACCOUNT_KINDS)[number]

export type SyncStreamName = "reviews" | "comments" | "dms"

export interface SyncStreamDef {
  platform: Platform
  stream: SyncStreamName
  kind: AccountKind
  label: string
  /** First entry is the default. */
  modes: readonly SyncMode[]
  defaultMinutes: number
  minMinutes: number
  /** Where real-time events come from, for the UI. */
  realtime: string
}

/** Keys use underscores (not dots) so they work as form field paths. */
export const SYNC_STREAMS = {
  gbp_reviews: {
    platform: "google_business",
    stream: "reviews",
    kind: "gbp_location",
    label: "Google reviews",
    modes: ["webhook_reconcile", "polling", "webhook"],
    defaultMinutes: 30,
    minMinutes: 5,
    realtime: "Pub/Sub push",
  },
  fb_comments: {
    platform: "facebook",
    stream: "comments",
    kind: "fb_page",
    label: "Facebook comments",
    modes: ["webhook_reconcile", "polling", "webhook"],
    defaultMinutes: 60,
    minMinutes: 10,
    realtime: "Meta webhook (feed)",
  },
  fb_dms: {
    platform: "facebook",
    stream: "dms",
    kind: "fb_page",
    label: "Facebook DMs",
    modes: ["webhook_reconcile", "polling", "webhook"],
    defaultMinutes: 60,
    minMinutes: 10,
    realtime: "Meta webhook (messages)",
  },
  ig_comments: {
    platform: "instagram",
    stream: "comments",
    kind: "ig_account",
    label: "Instagram comments",
    modes: ["webhook_reconcile", "polling", "webhook"],
    defaultMinutes: 60,
    minMinutes: 10,
    realtime: "Meta webhook (comments)",
  },
  ig_dms: {
    platform: "instagram",
    stream: "dms",
    kind: "ig_account",
    label: "Instagram DMs",
    modes: ["webhook_reconcile", "polling", "webhook"],
    defaultMinutes: 60,
    minMinutes: 10,
    realtime: "Meta webhook (messages)",
  },
  yt_comments: {
    platform: "youtube",
    stream: "comments",
    kind: "yt_channel",
    label: "YouTube comments",
    modes: ["polling"],
    defaultMinutes: 5,
    minMinutes: 1,
    realtime: "None (polling only)",
  },
  li_comments: {
    platform: "linkedin",
    stream: "comments",
    kind: "li_org",
    label: "LinkedIn comments",
    modes: ["webhook_reconcile", "polling", "webhook"],
    defaultMinutes: 30,
    minMinutes: 5,
    realtime: "Organization social action webhook",
  },
} as const satisfies Record<string, SyncStreamDef>

export type SyncStreamKey = keyof typeof SYNC_STREAMS
export const SYNC_STREAM_KEYS = Object.keys(SYNC_STREAMS) as SyncStreamKey[]

export function syncStreamKeyFor(platform: string, stream: string): SyncStreamKey | null {
  for (const key of SYNC_STREAM_KEYS) {
    const def = SYNC_STREAMS[key]
    if (def.platform === platform && def.stream === stream) return key
  }
  return null
}

/** Streams that an account of this kind syncs. */
export function streamsForKind(kind: string): SyncStreamKey[] {
  return SYNC_STREAM_KEYS.filter((k) => SYNC_STREAMS[k].kind === kind)
}

/** Longest gap between runs while backing off after failures. */
export const MAX_BACKOFF_SECONDS = 6 * 60 * 60
/** Consecutive failures before the account is marked `error` in the UI. */
export const ACCOUNT_ERROR_AFTER_FAILURES = 3
/** How long a claimed sync state stays leased to one poll job. */
export const SYNC_LEASE_SECONDS = 5 * 60

/** `min(interval × 2^failures, 6 h)`, but never shorter than the interval itself. */
export function backoffSeconds(intervalSeconds: number, failures: number): number {
  if (failures <= 0) return intervalSeconds
  const backoff = Math.min(intervalSeconds * 2 ** failures, MAX_BACKOFF_SECONDS)
  return Math.max(intervalSeconds, backoff)
}

/**
 * When a stream should run next: `from` (its last run, or now if it never ran) plus the
 * interval, stretched by the failure backoff. A result in the past means "due now".
 */
export function computeNextRunAt(input: {
  lastRunAt: Date | null
  now: Date
  intervalSeconds: number
  failures: number
}): Date {
  const from = input.lastRunAt ?? input.now
  return new Date(from.getTime() + backoffSeconds(input.intervalSeconds, input.failures) * 1000)
}

// ─── YouTube quota ─────────────────────────────────────────────────────────────

/** `commentThreads.list` costs 1 unit per page. */
export const YOUTUBE_UNITS_PER_LIST_PAGE = 1
/** `comments.insert` (a reply) costs 50 units. */
export const YOUTUBE_UNITS_PER_REPLY = 50
export const YOUTUBE_DEFAULT_DAILY_QUOTA = 10_000
/** Saves that would use more than this share of the daily quota on polling are blocked. */
export const YOUTUBE_QUOTA_BLOCK_RATIO = 0.9

/** `(86400 / interval) × channels × pages × cost`: polling units per day. */
export function estimateYoutubeDailyUnits(input: {
  intervalMinutes: number
  channels: number
  pagesPerPoll: number
}): number {
  if (input.intervalMinutes <= 0 || input.channels <= 0) return 0
  const pollsPerDay = Math.ceil(1440 / input.intervalMinutes)
  return pollsPerDay * input.channels * input.pagesPerPoll * YOUTUBE_UNITS_PER_LIST_PAGE
}

/** YouTube quota resets at midnight Pacific time. Returns that day as YYYY-MM-DD. */
export function youtubeQuotaDay(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date)
}
