/**
 * Low-value detection: comments made only of generic praise or thanks, like
 * "Good content bro, keep it up 👏" or "Thanks for sharing!!". Pure and list-driven: the
 * phrases come from the editable `low_value_phrases` list, so "Hide similar" can teach it.
 *
 * A text is low-value when, after removing emoji, punctuation and @mentions, every word is
 * either part of a listed phrase or a filler word (bro, so, very, keep, it, up, …) and at least
 * one phrase matched. Questions ("?") and links never count, so nothing that needs an answer
 * is hidden.
 */

/** Words that carry no meaning on their own in a praise comment. Not user-editable. */
export const LOW_VALUE_FILLER_WORDS = [
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "is",
  "was",
  "are",
  "be",
  "so",
  "very",
  "really",
  "too",
  "such",
  "super",
  "just",
  "truly",
  "totally",
  "absolutely",
  "always",
  "again",
  "as",
  "usual",
  "much",
  "many",
  "lot",
  "lots",
  "of",
  "and",
  "n",
  "for",
  "to",
  "with",
  "on",
  "in",
  "at",
  "here",
  "you",
  "your",
  "u",
  "ur",
  "i",
  "im",
  "am",
  "me",
  "my",
  "we",
  "our",
  "all",
  "everyone",
  "team",
  "bro",
  "bruh",
  "brother",
  "bhai",
  "sis",
  "sister",
  "sir",
  "madam",
  "maam",
  "mam",
  "man",
  "dude",
  "guys",
  "guy",
  "buddy",
  "dear",
  "friend",
  "friends",
  "yes",
  "yeah",
  "yep",
  "ok",
  "okay",
  "oh",
  "omg",
  "wow",
  "haha",
  "lol",
  "keep",
  "up",
  "more",
  "look",
  "looks",
  "looking",
  "now",
  "today",
] as const

/** Default entries for the `low_value_phrases` list (seeded, editable). */
export const DEFAULT_LOW_VALUE_PHRASES = [
  // single praise words
  "nice",
  "good",
  "great",
  "awesome",
  "amazing",
  "superb",
  "excellent",
  "fantastic",
  "wonderful",
  "beautiful",
  "brilliant",
  "cool",
  "lovely",
  "perfect",
  "outstanding",
  "incredible",
  "impressive",
  "fabulous",
  "best",
  "informative",
  "helpful",
  "useful",
  "inspiring",
  "interesting",
  "yummy",
  "delicious",
  "tasty",
  "love",
  "loved",
  "loving",
  "fire",
  "legend",
  // content / post / video praise
  "good content",
  "great content",
  "nice content",
  "quality content",
  "great video",
  "amazing work",
  "awesome work",
  "nice video",
  "good video",
  "nice post",
  "great post",
  "nice info",
  "great info",
  "good one",
  "nice one",
  "great one",
  "great stuff",
  "good stuff",
  // thanks
  "thanks",
  "thank you",
  "thank u",
  "thx",
  "ty",
  "thanks for sharing",
  "thank you for sharing",
  "thanks for the info",
  // encouragement
  "keep it up",
  "keep going",
  "keep growing",
  "keep rocking",
  "keep up the good work",
  "well done",
  "great work",
  "good work",
  "nice work",
  "great job",
  "good job",
  "nice job",
  "hats off",
  "respect",
  "congrats",
  "congratulations",
  "kudos",
  "bravo",
  "well said",
  "well explained",
  "so true",
  "agreed",
  "first",
  // Hindi (romanized)
  "badhiya",
  "bahut badhiya",
  "zabardast",
  "mast",
] as const

/** Longest phrase "Hide similar" will learn; longer texts are too specific to generalize. */
export const MAX_LEARNED_PHRASE_WORDS = 8

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/iu
const MENTION_RE = /(^|\s)@[\w.]+/gu
const APOSTROPHE_RE = /['’`]/gu
/** Emoji joiners and variation selectors are combining marks (\p{M}): strip them first. */
const EMOJI_JOINERS_RE = /\u200d|\ufe0e|\ufe0f|\u20e3/gu
const NON_WORD_RE = /[^\p{L}\p{M}\p{N}]+/gu
const DIGITS_RE = /^\p{N}+$/u

/** "Sooo goood!!" and "so good" compare equal: repeated letters collapse to one. */
function squeeze(token: string): string {
  return token.replace(/(.)\1+/gu, "$1")
}

/** Lowercase word tokens without emoji, punctuation, apostrophes or @mentions. */
export function lowValueTokens(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(EMOJI_JOINERS_RE, " ")
    .replace(MENTION_RE, " ")
    .replace(APOSTROPHE_RE, "")
    .replace(NON_WORD_RE, " ")
    .split(/\s+/u)
    .filter(Boolean)
}

const FILLER = new Set(LOW_VALUE_FILLER_WORDS.map(squeeze))

/** Pre-tokenized phrases, longest first so "keep it up" wins over "keep". */
export function compileLowValuePhrases(phrases: readonly string[]): string[][] {
  const seen = new Set<string>()
  const out: string[][] = []
  for (const p of phrases) {
    const tokens = lowValueTokens(p).map(squeeze)
    const key = tokens.join(" ")
    if (tokens.length === 0 || seen.has(key)) continue
    seen.add(key)
    out.push(tokens)
  }
  return out.sort((a, b) => b.length - a.length)
}

export function isLowValueText(text: string, phrases: readonly string[][]): boolean {
  if (phrases.length === 0) return false
  const trimmed = text.trim()
  if (!trimmed || /[?？¿]/u.test(trimmed) || URL_RE.test(trimmed)) return false
  const tokens = lowValueTokens(trimmed).map(squeeze)
  if (tokens.length === 0) return false

  let matchedPhrase = false
  let i = 0
  outer: while (i < tokens.length) {
    for (const phrase of phrases) {
      if (phrase.length > tokens.length - i) continue
      if (phrase.every((t, k) => tokens[i + k] === t)) {
        matchedPhrase = true
        i += phrase.length
        continue outer
      }
    }
    const token = tokens[i]!
    if (FILLER.has(token) || DIGITS_RE.test(token)) {
      i++
      continue
    }
    return false
  }
  return matchedPhrase
}

export type LearnPhraseResult =
  { ok: true; phrase: string } | { ok: false; reason: "empty" | "question" | "link" | "too_long" }

/**
 * The phrase "Hide similar" adds for a text: its words without emoji, punctuation or leading
 * and trailing filler ("Good content bro, keep it up 👏" → "good content").
 */
export function learnLowValuePhrase(text: string | null): LearnPhraseResult {
  const trimmed = (text ?? "").trim()
  if (!trimmed) return { ok: false, reason: "empty" }
  if (/[?？¿]/u.test(trimmed)) return { ok: false, reason: "question" }
  if (URL_RE.test(trimmed)) return { ok: false, reason: "link" }
  const tokens = lowValueTokens(trimmed).filter((t) => !DIGITS_RE.test(t))
  if (tokens.length === 0) return { ok: false, reason: "empty" }
  // Trim filler at both ends ("good content bro keep it up" → "good content") but keep it in
  // the middle, so the phrase still matches the text it came from ("thanks for sharing").
  const isFiller = (t: string) => FILLER.has(squeeze(t))
  let start = 0
  let end = tokens.length
  while (start < end && isFiller(tokens[start]!)) start++
  while (end > start && isFiller(tokens[end - 1]!)) end--
  const words = start < end ? tokens.slice(start, end) : tokens
  if (words.length > MAX_LEARNED_PHRASE_WORDS) return { ok: false, reason: "too_long" }
  return { ok: true, phrase: words.join(" ") }
}
