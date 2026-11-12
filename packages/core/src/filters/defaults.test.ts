import { describe, expect, it } from "vitest"
import { DEFAULT_LOW_VALUE_PHRASES } from "./low-value"
import {
  DEFAULT_RULES,
  DEFAULT_SPAM_KEYWORDS,
  DEFAULT_TRUSTED_DOMAINS,
  type DefaultRuleDef,
} from "./defaults"
import { evaluate } from "./evaluate"
import { usesAiFields, validateConditionTree } from "./fields"
import { makeCtx, makeInput, NOW } from "./testing"
import {
  filterRuleSchema,
  PRIORITY_SLACK_CHANNEL,
  type FilterContext,
  type FilterInput,
  type FilterRule,
  type ListEntry,
} from "./types"

const toRule = (d: DefaultRuleDef): FilterRule => {
  const { defaultKey, ...rest } = d
  return { ...rest, id: defaultKey }
}

const LISTS: ListEntry[] = [
  ...DEFAULT_LOW_VALUE_PHRASES.map((value) => ({
    list: "low_value_phrases" as const,
    kind: "keyword" as const,
    value,
    platform: null,
  })),
  ...DEFAULT_SPAM_KEYWORDS.map((value) => ({
    list: "spam_keywords" as const,
    kind: "keyword" as const,
    value,
    platform: null,
  })),
  ...DEFAULT_TRUSTED_DOMAINS.map((value) => ({
    list: "trusted_domains" as const,
    kind: "domain" as const,
    value,
    platform: null,
  })),
  { list: "allowlist", kind: "author_handle", value: "vip_customer", platform: null },
  { list: "allowlist", kind: "author_id", value: "UCpartner", platform: "youtube" },
  { list: "blocklist", kind: "author_handle", value: "troll_42", platform: null },
  { list: "blocklist", kind: "author_id", value: "fb-999", platform: "facebook" },
  { list: "blocklist", kind: "keyword", value: "cheap pills", platform: null },
  { list: "blocklist", kind: "domain", value: "bad.example", platform: null },
]

function run(
  input: Partial<FilterInput>,
  opts: { rules?: FilterRule[]; ctx?: Partial<FilterContext> } = {},
) {
  return evaluate(
    makeInput(input),
    opts.rules ?? DEFAULT_RULES.map(toRule),
    makeCtx({ lists: LISTS, ...opts.ctx }),
  )
}

const matchedKeys = (r: ReturnType<typeof run>) => r.matched.map((m) => m.ruleId)

describe("default rules are valid", () => {
  it.each(DEFAULT_RULES.map((d) => [d.defaultKey, d] as const))(
    "%s passes schema + condition validation",
    (_k, d) => {
      expect(() => filterRuleSchema.parse(toRule(d))).not.toThrow()
      expect(validateConditionTree(d.conditions)).toEqual([])
    },
  )

  it("has unique keys, unique priorities and unique condition ids", () => {
    const keys = DEFAULT_RULES.map((d) => d.defaultKey)
    expect(new Set(keys).size).toBe(keys.length)
    const prios = DEFAULT_RULES.map((d) => d.priority)
    expect(new Set(prios).size).toBe(prios.length)
    const ids: string[] = []
    const walk = (
      n: DefaultRuleDef["conditions"] | DefaultRuleDef["conditions"]["children"][number],
    ): void => {
      ids.push(n.id)
      if (n.kind === "group") n.children.forEach(walk)
    }
    DEFAULT_RULES.forEach((d) => walk(d.conditions))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("only the complaint rule uses AI fields, and it never drops or archives", () => {
    const ai = DEFAULT_RULES.filter((d) => usesAiFields(d.conditions)).map((d) => d.defaultKey)
    expect(ai).toEqual(["high_toxic_complaint"])
    const complaint = DEFAULT_RULES.find((d) => d.defaultKey === "high_toxic_complaint")!
    expect(complaint.actions.some((a) => a.type === "drop" || a.type === "archive")).toBe(false)
  })

  it("old-post and story rules are off by default", () => {
    const off = DEFAULT_RULES.filter((d) => !d.enabled).map((d) => d.defaultKey)
    expect(off.sort()).toEqual(["archive_old_posts", "archive_story_dms"])
  })
})

describe("drop_own_activity", () => {
  it.each([
    ["FB comment from our page", { platform: "facebook", isOwnAccount: true }],
    ["IG reply from our account", { platform: "instagram", isOwnAccount: true }],
    ["YT comment from our channel", { platform: "youtube", isOwnAccount: true }],
    ["Meta echo of a DM we sent", { platform: "facebook", type: "dm", eventKind: "echo" }],
  ] as const)("%s → drop", (_n, input) => {
    const r = run(input)
    expect(r.decision).toBe("drop")
    expect(matchedKeys(r)).toEqual(["drop_own_activity"])
    expect(r.filterReason).toBe("Drop our own activity")
  })
})

describe("drop_non_content", () => {
  it.each(["reaction", "like", "share", "read", "delivery", "typing"] as const)(
    "%s → drop",
    (eventKind) => {
      const r = run({ platform: "linkedin", eventKind, text: null })
      expect(r.decision).toBe("drop")
      expect(matchedKeys(r)).toEqual(["drop_non_content"])
    },
  )
})

describe("archive_edits_deletions", () => {
  it.each(["edited", "deleted"] as const)("%s → archive", (eventKind) => {
    const r = run({
      platform: "google_business",
      type: "review",
      rating: 5,
      text: "Great place to visit",
      eventKind,
    })
    expect(r.decision).toBe("archive")
    expect(matchedKeys(r)).toContain("archive_edits_deletions")
  })
})

describe("archive_emoji_short", () => {
  it.each(["nice", "🔥🔥", "so good", "❤️❤️❤️", "Wow!!"])("comment %j → archive", (text) => {
    const r = run({ platform: "instagram", type: "comment", text })
    expect(r.decision).toBe("archive")
    expect(matchedKeys(r)).toContain("archive_emoji_short")
  })

  it.each([
    ["dm", "instagram", null],
    ["review", "google_business", 5],
  ] as const)("same short text as a %s is shown", (type, platform, rating) => {
    const r = run({ platform, type, text: "nice", rating })
    expect(r.decision).toBe("show")
  })

  it("three-word comment is shown", () => {
    expect(run({ text: "love this color" }).decision).toBe("show")
  })
})

describe("archive_low_value", () => {
  it.each([
    ["instagram", "Good content bro, keep it up 👏"],
    ["facebook", "Thanks for sharing!"],
    ["youtube", "Great video sir, very informative 🙏"],
    ["linkedin", "Congratulations to the team!!"],
  ] as const)("%s comment %j → archive + low-value tag", (platform, text) => {
    const r = run({ platform, type: "comment", text })
    expect(r.decision).toBe("archive")
    expect(matchedKeys(r)).toContain("archive_low_value")
    expect(r.tags).toContain("low-value")
  })

  it.each([
    "Great video! Which pot do you use?",
    "The new menu looks amazing, can't wait to try the duck!",
    "Thanks for the reply! The tip about skimming worked perfectly.",
  ])("comment %j is shown", (text) => {
    expect(run({ platform: "youtube", text }).decision).toBe("show")
  })

  it.each([
    ["dm", "instagram", null],
    ["review", "google_business", 5],
  ] as const)("generic praise as a %s is shown", (type, platform, rating) => {
    const r = run({ platform, type, text: "Thanks for sharing, great work team", rating })
    expect(matchedKeys(r)).not.toContain("archive_low_value")
  })

  it("allowlisted authors are never archived as low-value", () => {
    const r = run({ authorHandle: "vip_customer", text: "Good content bro" })
    expect(r.decision).toBe("show")
  })
})

describe("archive_tag_only", () => {
  it("'@a @b' comment → archive", () => {
    const r = run({ platform: "facebook", text: "@maria_k @john.smith" })
    expect(r.decision).toBe("archive")
    expect(matchedKeys(r)).toContain("archive_tag_only")
  })
  it("mention plus a question is shown", () => {
    expect(run({ text: "@maria_k do you think this ships to India?" }).decision).toBe("show")
  })
})

describe("archive_spam", () => {
  it("unknown link → archive + spam tag", () => {
    const r = run({
      platform: "youtube",
      text: "Win big today at https://free-prizes.biz/claim now",
    })
    expect(r.decision).toBe("archive")
    expect(r.tags).toContain("spam")
    expect(r.filterReason).toBe("Archive likely spam")
  })
  it("spam phrase without link → archive", () => {
    const r = run({ platform: "instagram", text: "Amazing page! Check my profile for a collab" })
    expect(r.decision).toBe("archive")
    expect(matchedKeys(r)).toContain("archive_spam")
  })
  it("spam DM → archive", () => {
    expect(
      run({
        platform: "instagram",
        type: "dm",
        text: "Hi dear, we promote pages, 10k followers cheap",
      }).decision,
    ).toBe("archive")
  })
  it("trusted YouTube link is not spam", () => {
    const r = run({
      platform: "youtube",
      text: "You explained this better in https://www.youtube.com/watch?v=abc thanks a lot",
    })
    expect(r.decision).toBe("show")
    expect(matchedKeys(r)).not.toContain("archive_spam")
  })
  it("reviews are never spam-archived by this rule", () => {
    expect(
      run({
        platform: "google_business",
        type: "review",
        rating: 4,
        text: "Follow us https://spam.biz great service",
      }).decision,
    ).toBe("show")
  })
})

describe("archive_blocklist", () => {
  it.each([
    [
      "blocklisted handle",
      {
        platform: "instagram",
        authorHandle: "@Troll_42",
        text: "this brand is a joke and everyone knows it",
      },
    ],
    [
      "blocklisted id on its platform",
      { platform: "facebook", authorId: "fb-999", text: "posting again under a new name today" },
    ],
    [
      "blocklisted keyword",
      { platform: "linkedin", text: "Get cheap pills delivered to your office" },
    ],
    [
      "blocklisted domain",
      { platform: "youtube", text: "watch the full version at https://sub.bad.example/v" },
    ],
  ] as const)("%s → archive", (_n, input) => {
    const r = run(input)
    expect(r.decision).toBe("archive")
    expect(matchedKeys(r)).toContain("archive_blocklist")
  })
  it("platform-scoped blocklist entry doesn't apply elsewhere", () => {
    expect(
      run({ platform: "youtube", authorId: "fb-999", text: "a perfectly normal comment here" })
        .decision,
    ).toBe("show")
  })
})

describe("allowlist_vip", () => {
  it("allowlisted handle is shown high + vip even with spam and short text", () => {
    const r = run({ platform: "instagram", authorHandle: "vip_customer", text: "collab?" })
    expect(r.decision).toBe("show")
    expect(r.priority).toBe("high")
    expect(r.tags).toEqual(["vip"])
    expect(matchedKeys(r)).toEqual(["allowlist_vip"])
  })
  it("platform-scoped allowlist id applies only on its platform", () => {
    expect(run({ platform: "youtube", authorId: "UCpartner", text: "🔥" }).tags).toEqual(["vip"])
    expect(run({ platform: "facebook", authorId: "UCpartner", text: "🔥" }).decision).toBe(
      "archive",
    )
  })
  it("allowlist does not override dropping our own activity", () => {
    expect(run({ authorHandle: "vip_customer", isOwnAccount: true }).decision).toBe("drop")
  })
})

describe("urgent_low_reviews", () => {
  it.each([1, 2, 3])("%i★ review → urgent + priority channel + tag", (rating) => {
    const r = run({
      platform: "google_business",
      type: "review",
      rating,
      text: "Waited an hour for a table",
    })
    expect(r.decision).toBe("show")
    expect(r.priority).toBe("urgent")
    expect(r.slackChannelId).toBe(PRIORITY_SLACK_CHANNEL)
    expect(r.tags).toContain("low-rating")
  })
  it("1★ review with complaint keywords stays urgent (highest wins)", () => {
    const r = run({
      platform: "google_business",
      type: "review",
      rating: 1,
      text: "Worst service, I want a refund",
    })
    expect(r.priority).toBe("urgent")
    expect(r.tags).toEqual(["low-rating", "complaint"])
  })
  it("4★ review is not urgent", () => {
    expect(
      run({
        platform: "google_business",
        type: "review",
        rating: 4,
        text: "Good food, slow service",
      }).priority,
    ).toBe("normal")
  })
})

describe("low_positive_no_text", () => {
  it.each([4, 5])("%i★ review without text → low, no AI drafts", (rating) => {
    const r = run({ platform: "google_business", type: "review", rating, text: null })
    expect(r.decision).toBe("show")
    expect(r.priority).toBe("low")
    expect(r.aiDraftsAllowed).toBe(false)
  })
  it("5★ review with text keeps AI drafts", () => {
    const r = run({ platform: "google_business", type: "review", rating: 5, text: "Lovely staff" })
    expect(r).toMatchObject({ priority: "normal", aiDraftsAllowed: true })
  })
})

describe("high_toxic_complaint", () => {
  it.each([
    [
      "FB comment",
      { platform: "facebook", text: "Still no refund after two weeks, terrible support" },
    ],
    [
      "LinkedIn comment",
      { platform: "linkedin", text: "Disappointed with how you treat candidates" },
    ],
    ["IG DM", { platform: "instagram", type: "dm", text: "My order arrived broken. What now?" }],
  ] as const)("%s with complaint keywords → high + complaint", (_n, input) => {
    const r = run(input)
    expect(r.decision).toBe("show")
    expect(r.priority).toBe("high")
    expect(r.tags).toContain("complaint")
  })

  it("needs AI when there are no keywords and AI signals are missing", () => {
    const r = run({ platform: "youtube", text: "Your new video is honestly pretty misleading" })
    expect(r.decision).toBe("show")
    expect(r.needsAi).toBe(true)
  })

  it("with AI signals: toxicity or negative sentiment raises priority", () => {
    const text = "Your new video is honestly pretty misleading"
    const toxic = run(
      { text },
      { ctx: { ai: { spamScore: 0.1, sentiment: "neutral", toxicity: 0.8 } } },
    )
    expect(toxic).toMatchObject({ priority: "high", needsAi: false })
    const negative = run(
      { text },
      { ctx: { ai: { spamScore: 0.1, sentiment: "negative", toxicity: 0.1 } } },
    )
    expect(negative.priority).toBe("high")
    const fine = run(
      { text },
      { ctx: { ai: { spamScore: 0.1, sentiment: "positive", toxicity: 0.1 } } },
    )
    expect(fine.priority).toBe("normal")
  })

  it("archived items don't need AI", () => {
    expect(run({ text: "nice" }).needsAi).toBe(false)
  })
})

describe("disabled defaults", () => {
  const enable = (key: string) =>
    DEFAULT_RULES.map(toRule).map((r) => (r.id === key ? { ...r, enabled: true } : r))

  it("archive_old_posts fires only when enabled", () => {
    const input = {
      platform: "facebook" as const,
      text: "Is this still available in blue?",
      postPublishedAt: new Date(NOW.getTime() - 45 * 86_400_000),
    }
    expect(run(input).decision).toBe("show")
    const r = run(input, { rules: enable("archive_old_posts") })
    expect(r.decision).toBe("archive")
    expect(matchedKeys(r)).toContain("archive_old_posts")
    const recent = { ...input, postPublishedAt: new Date(NOW.getTime() - 3 * 86_400_000) }
    expect(run(recent, { rules: enable("archive_old_posts") }).decision).toBe("show")
  })

  it("archive_story_dms fires only when enabled, and only for Instagram DMs", () => {
    const input = {
      platform: "instagram" as const,
      type: "dm" as const,
      eventKind: "story_mention" as const,
      text: "mentioned you in their story",
    }
    expect(run(input).decision).toBe("show")
    expect(run(input, { rules: enable("archive_story_dms") }).decision).toBe("archive")
    expect(
      run({ ...input, platform: "facebook" }, { rules: enable("archive_story_dms") }).decision,
    ).toBe("show")
  })
})

describe("realistic items across platforms", () => {
  it.each([
    [
      "GBP 5★ with text",
      {
        platform: "google_business",
        type: "review",
        rating: 5,
        text: "Best coffee in town, friendly staff!",
      },
      "show",
      "normal",
    ],
    [
      "FB question comment",
      { platform: "facebook", text: "Do you deliver to Pune on weekends?" },
      "show",
      "normal",
    ],
    [
      "IG DM order question",
      { platform: "instagram", type: "dm", text: "Hi! Is the medium size back in stock?" },
      "show",
      "normal",
    ],
    [
      "YT praise",
      { platform: "youtube", text: "This tutorial saved me hours, thank you" },
      "show",
      "normal",
    ],
    [
      "LinkedIn comment",
      { platform: "linkedin", text: "Congrats to the whole team on the launch" },
      "show",
      "normal",
    ],
    ["YT emoji", { platform: "youtube", text: "👏👏👏" }, "archive", "normal"],
  ] as const)("%s → %s / %s", (_n, input, decision, priority) => {
    const r = run(input)
    expect(r.decision).toBe(decision)
    expect(r.priority).toBe(priority)
  })
})
