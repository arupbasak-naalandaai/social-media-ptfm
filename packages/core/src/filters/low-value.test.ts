import { describe, expect, it } from "vitest"
import { deriveFields } from "./derive"
import {
  compileLowValuePhrases,
  DEFAULT_LOW_VALUE_PHRASES,
  isLowValueText,
  learnLowValuePhrase,
  MAX_LEARNED_PHRASE_WORDS,
} from "./low-value"
import { makeCtx, makeInput } from "./testing"
import type { ListEntry } from "./types"

const DEFAULTS = compileLowValuePhrases(DEFAULT_LOW_VALUE_PHRASES)
const low = (text: string) => isLowValueText(text, DEFAULTS)

describe("isLowValueText with the default phrases", () => {
  it.each([
    "Good Content",
    "Good content bro, keep it up 👏",
    "Thanks for sharing!",
    "Great video sir, very informative 🙏",
    "Wow amazing work team!!",
    "Sooo goood 🔥🔥",
    "Nice one @priya.sharma",
    "Keep up the good work guys",
    "10/10 awesome",
    "thank u so much",
    "It's beautiful ❤️",
    "Congratulations to all of you!",
    "bahut badhiya bhai",
  ])("%j is low-value", (text) => {
    expect(low(text)).toBe(true)
  })

  it.each([
    "The new menu looks amazing, can't wait to try the duck!",
    "Can I use chicken feet instead of pork bones for the broth? Great video btw.",
    "Great video, which camera do you use?",
    "Great video! Recipe: https://example.com/ramen",
    "Thanks for the reply! The tip about skimming worked perfectly.",
    "Not good content",
    "Good food but slow service",
    "Love this color",
    "This tutorial saved me hours, thank you",
    "Congrats to the whole team on the launch",
    "🔥🔥",
    "@alice @bob",
    "bro",
    "",
  ])("%j is not low-value", (text) => {
    expect(low(text)).toBe(false)
  })

  it("needs at least one phrase: filler alone never matches", () => {
    expect(low("so so so")).toBe(false)
  })

  it("matches nothing without phrases", () => {
    expect(isLowValueText("Good content", [])).toBe(false)
  })
})

describe("deriveFields.isLowValue uses the low_value_phrases list", () => {
  const entry = (value: string, platform: ListEntry["platform"] = null): ListEntry => ({
    list: "low_value_phrases",
    kind: "keyword",
    value,
    platform,
  })

  it("reads phrases from the context, scoped by platform", () => {
    const ctx = makeCtx({ lists: [entry("superb content", "youtube")] })
    const yt = deriveFields(makeInput({ platform: "youtube", text: "Superb content bro" }), ctx)
    const ig = deriveFields(makeInput({ platform: "instagram", text: "Superb content bro" }), ctx)
    expect(yt.isLowValue).toBe(true)
    expect(ig.isLowValue).toBe(false)
  })

  it("ignores other lists", () => {
    const ctx = makeCtx({
      lists: [{ list: "spam_keywords", kind: "keyword", value: "good content", platform: null }],
    })
    expect(deriveFields(makeInput({ text: "good content" }), ctx).isLowValue).toBe(false)
  })
})

describe("learnLowValuePhrase", () => {
  it.each([
    ["Good content bro, keep it up 👏", "good content"],
    ["Thanks for sharing!!", "thanks for sharing"],
    ["Superb 🔥", "superb"],
    ["ok bro", "ok bro"],
    ["Mast hai yaar", "mast hai yaar"],
  ])("%j → %j", (text, phrase) => {
    expect(learnLowValuePhrase(text)).toEqual({ ok: true, phrase })
  })

  it("learned phrases match the text they came from", () => {
    for (const text of ["Good content bro, keep it up 👏", "Thanks a lot for this", "ok bro"]) {
      const r = learnLowValuePhrase(text)
      if (!r.ok) throw new Error("expected ok")
      expect(isLowValueText(text, compileLowValuePhrases([r.phrase]))).toBe(true)
    }
  })

  it.each([
    [null, "empty"],
    ["🔥🔥", "empty"],
    ["Nice, when do you open?", "question"],
    ["nice https://x.com", "link"],
    [
      Array.from({ length: MAX_LEARNED_PHRASE_WORDS + 1 }, (_, i) => `word${i}`).join(" "),
      "too_long",
    ],
  ] as const)("%j → %s", (text, reason) => {
    expect(learnLowValuePhrase(text)).toEqual({ ok: false, reason })
  })
})
