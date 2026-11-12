/**
 * Derived fields computed from a normalized item: text stats, links, mentions, emoji,
 * post age and received hour. Pure: depends only on the input and the context.
 */
import type { DerivedFields, FilterContext, FilterInput } from "./types"

const DAY_MS = 24 * 60 * 60 * 1000

/** http(s):// URLs and bare www. URLs. */
const URL_RE = /\b(?:https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/giu
/** @handle tokens at the start or after whitespace. */
const MENTION_RE = /(^|\s)@[\w.]+/gu
/** Emoji and emoji components (ZWJ, variation selectors, skin tones, regional indicators, keycaps). */
const EMOJI_RE = new RegExp(
  "(?:\\p{Extended_Pictographic}|\\p{Regional_Indicator}|\\p{Emoji_Modifier}|\\u200d|\\ufe0e|\\ufe0f|\\u20e3)",
  "gu",
)
const HAS_EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u
const WORDISH_RE = /[\p{L}\p{N}]/u

function extractDomains(text: string): string[] {
  const domains: string[] = []
  for (const match of text.matchAll(URL_RE)) {
    const raw = match[0]
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
    let host: string
    try {
      host = new URL(withScheme).hostname.toLowerCase()
    } catch {
      continue
    }
    host = host.replace(/^www\./, "").replace(/\.$/, "")
    if (host && !domains.includes(host)) domains.push(host)
  }
  return domains
}

function hourIn(date: Date, timezone: string): number {
  const format = (timeZone: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" })
  let formatter: Intl.DateTimeFormat
  try {
    formatter = format(timezone)
  } catch {
    formatter = format("UTC")
  }
  const hour = Number(formatter.formatToParts(date).find((p) => p.type === "hour")?.value)
  return Number.isFinite(hour) ? hour % 24 : date.getUTCHours()
}

export function deriveFields(input: FilterInput, ctx: FilterContext): DerivedFields {
  const text = (input.text ?? "").trim()
  const linkDomains = extractDomains(text)
  const mentionCount = [...text.matchAll(MENTION_RE)].length

  const withoutUrls = text.replace(URL_RE, " ")
  const withoutMentions = withoutUrls.replace(MENTION_RE, " ")
  const withoutEmoji = withoutMentions.replace(EMOJI_RE, " ")
  const wordCount = withoutEmoji.split(/\s+/u).filter((t) => WORDISH_RE.test(t)).length

  const isEmojiOnly =
    text.length > 0 && HAS_EMOJI_RE.test(text) && text.replace(EMOJI_RE, "").trim() === ""

  const isMentionOnly =
    mentionCount > 0 &&
    text
      .replace(MENTION_RE, " ")
      .replace(/[\s\p{P}]/gu, "")
      .trim() === ""

  const postAgeDays =
    input.postPublishedAt === null
      ? null
      : Math.floor((input.receivedAt.getTime() - input.postPublishedAt.getTime()) / DAY_MS)

  return {
    text,
    textLength: [...text].length,
    wordCount,
    hasLink: linkDomains.length > 0,
    linkDomains,
    mentionCount,
    isEmojiOnly,
    isMentionOnly,
    postAgeDays,
    receivedHour: hourIn(input.receivedAt, ctx.timezone),
  }
}
