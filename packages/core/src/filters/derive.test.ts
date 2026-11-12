import { describe, expect, it } from "vitest"
import { deriveFields } from "./derive"
import { makeCtx, makeInput, NOW } from "./testing"

const derive = (text: string | null, over: Parameters<typeof makeInput>[0] = {}, tz = "UTC") =>
  deriveFields(makeInput({ text, ...over }), makeCtx({ timezone: tz }))

describe("isEmojiOnly", () => {
  it.each([
    ["🔥🔥", true],
    ["❤️", true],
    ["👍🏽", true],
    ["🇮🇳", true],
    ["👨‍👩‍👧", true],
    ["  😂 😂  ", true],
    ["🔥 nice", false],
    ["nice", false],
    ["", false],
    ["123", false],
    ["#", false],
  ])("%j → %s", (text, expected) => {
    expect(derive(text).isEmojiOnly).toBe(expected)
  })
})

describe("isMentionOnly / mentionCount", () => {
  it.each([
    ["@alice", true, 1],
    ["@alice @bob", true, 2],
    ["@alice, @bob!", true, 2],
    ["@alice look at this", false, 1],
    ["@alice 🔥", false, 1],
    ["email me at a@b.com", false, 0],
    ["no mentions", false, 0],
    ["", false, 0],
  ])("%j → mentionOnly %s, count %i", (text, only, count) => {
    const d = derive(text)
    expect(d.isMentionOnly).toBe(only)
    expect(d.mentionCount).toBe(count)
  })
})

describe("wordCount / textLength", () => {
  it.each([
    ["nice", 1],
    ["very nice", 2],
    ["very nice product", 3],
    ["🔥🔥", 0],
    ["🔥 nice 🔥", 1],
    ["@alice @bob great", 1],
    ["see https://example.com/x now", 2],
    ["  spaced   out   words  ", 3],
    ["- — !!!", 0],
    ["5 stars", 2],
    ["बहुत अच्छा", 2],
    ["", 0],
  ])("%j → %i words", (text, words) => {
    expect(derive(text).wordCount).toBe(words)
  })

  it("trims and counts code points", () => {
    const d = derive("  héllo 🔥 ")
    expect(d.text).toBe("héllo 🔥")
    expect(d.textLength).toBe(7)
  })

  it("treats null text as empty", () => {
    const d = derive(null)
    expect(d).toMatchObject({
      text: "",
      textLength: 0,
      wordCount: 0,
      hasLink: false,
      isEmojiOnly: false,
    })
  })
})

describe("links", () => {
  it.each([
    ["visit https://www.Example.com/path?q=1", ["example.com"]],
    ["http://shop.example.org and https://youtu.be/abc", ["shop.example.org", "youtu.be"]],
    ["bare www.spam.biz/offer", ["spam.biz"]],
    ["dupe https://a.com https://www.a.com/x", ["a.com"]],
    ["no links here.com", []],
    ["", []],
  ])("%j → %j", (text, domains) => {
    const d = derive(text)
    expect(d.linkDomains).toEqual(domains)
    expect(d.hasLink).toBe(domains.length > 0)
  })
})

describe("postAgeDays", () => {
  it("is null without postPublishedAt", () => {
    expect(derive("x").postAgeDays).toBeNull()
  })
  it.each([
    [0, 0],
    [1, 1],
    [10.9, 10],
    [45, 45],
  ])("post published %s days before receipt → %i", (days, expected) => {
    const postPublishedAt = new Date(NOW.getTime() - days * 86_400_000)
    expect(derive("x", { postPublishedAt }).postAgeDays).toBe(expected)
  })
  it("uses receivedAt, not now", () => {
    const receivedAt = new Date("2026-01-11T00:00:00Z")
    const postPublishedAt = new Date("2026-01-01T00:00:00Z")
    expect(derive("x", { receivedAt, postPublishedAt }).postAgeDays).toBe(10)
  })
})

describe("receivedHour", () => {
  const receivedAt = new Date("2026-11-12T23:30:00Z")
  it.each([
    ["UTC", 23],
    ["Asia/Kolkata", 5], // +05:30 → 05:00 next day
    ["America/New_York", 18], // EST (-05:00)
    ["Not/AZone", 23], // invalid → UTC
  ])("%s → %i", (tz, hour) => {
    expect(derive("x", { receivedAt }, tz).receivedHour).toBe(hour)
  })
  it("midnight is 0, not 24", () => {
    expect(derive("x", { receivedAt: new Date("2026-11-12T00:15:00Z") }).receivedHour).toBe(0)
  })
})
