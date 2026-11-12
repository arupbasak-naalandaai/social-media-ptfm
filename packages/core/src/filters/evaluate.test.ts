import { describe, expect, it } from "vitest"
import { evaluate, orderedApplicableRules, ruleApplies } from "./evaluate"
import { and, cond, makeCtx, makeInput, makeRule } from "./testing"
import type { FilterRule } from "./types"

const always = () => and()
const never = () => and(cond("text", "contains", "zzqx-never"))
const aiRule = (over: Partial<FilterRule> = {}) =>
  makeRule({
    conditions: and(cond("aiToxicity", "gte", 0.7)),
    actions: [{ type: "setPriority", value: "high" }],
    ...over,
  })

describe("ruleApplies", () => {
  const input = makeInput({ platform: "facebook", type: "comment" })
  it.each([
    ["enabled, all/all", {}, true],
    ["disabled", { enabled: false }, false],
    ["platform included", { platforms: ["facebook", "youtube"] as FilterRule["platforms"] }, true],
    ["platform excluded", { platforms: ["youtube"] as FilterRule["platforms"] }, false],
    ["type included", { itemTypes: ["comment"] as FilterRule["itemTypes"] }, true],
    ["type excluded", { itemTypes: ["review", "dm"] as FilterRule["itemTypes"] }, false],
  ])("%s → %s", (_n, over, expected) => {
    expect(
      ruleApplies(
        makeRule({ conditions: always(), actions: [{ type: "archive" }], ...over }),
        input,
      ),
    ).toBe(expected)
  })
})

describe("evaluate", () => {
  it("defaults when nothing matches", () => {
    const r = evaluate(
      makeInput(),
      [makeRule({ conditions: never(), actions: [{ type: "archive" }] })],
      makeCtx(),
    )
    expect(r).toEqual({
      decision: "show",
      priority: "normal",
      tags: [],
      slackChannelId: null,
      skipSlack: false,
      aiDraftsAllowed: true,
      requireApproval: false,
      matched: [],
      filterReason: null,
      needsAi: false,
    })
  })

  it("runs rules by ascending priority, stable for ties", () => {
    const rules = [
      makeRule({
        id: "c",
        priority: 30,
        conditions: always(),
        actions: [{ type: "addTag", value: "c" }],
      }),
      makeRule({
        id: "a1",
        priority: 10,
        conditions: always(),
        actions: [{ type: "addTag", value: "a1" }],
      }),
      makeRule({
        id: "b",
        priority: 20,
        conditions: always(),
        actions: [{ type: "addTag", value: "b" }],
      }),
      makeRule({
        id: "a2",
        priority: 10,
        conditions: always(),
        actions: [{ type: "addTag", value: "a2" }],
      }),
    ]
    expect(orderedApplicableRules(rules, makeInput()).map((r) => r.id)).toEqual([
      "a1",
      "a2",
      "b",
      "c",
    ])
    const r = evaluate(makeInput(), rules, makeCtx())
    expect(r.matched.map((m) => m.ruleId)).toEqual(["a1", "a2", "b", "c"])
    expect(r.tags).toEqual(["a1", "a2", "b", "c"])
  })

  it("stopProcessing halts later rules", () => {
    const rules = [
      makeRule({
        id: "vip",
        priority: 1,
        stopProcessing: true,
        conditions: always(),
        actions: [{ type: "setPriority", value: "high" }],
      }),
      makeRule({ id: "spam", priority: 2, conditions: always(), actions: [{ type: "archive" }] }),
    ]
    const r = evaluate(makeInput(), rules, makeCtx())
    expect(r.decision).toBe("show")
    expect(r.priority).toBe("high")
    expect(r.matched.map((m) => m.ruleId)).toEqual(["vip"])
  })

  it("stopProcessing only applies when the rule matches", () => {
    const rules = [
      makeRule({
        priority: 1,
        stopProcessing: true,
        conditions: never(),
        actions: [{ type: "setPriority", value: "high" }],
      }),
      makeRule({ priority: 2, conditions: always(), actions: [{ type: "archive" }] }),
    ]
    expect(evaluate(makeInput(), rules, makeCtx()).decision).toBe("archive")
  })

  it("dry-run rules are recorded but apply nothing and never stop processing", () => {
    const rules = [
      makeRule({
        id: "dry",
        name: "Dry",
        priority: 1,
        dryRun: true,
        stopProcessing: true,
        conditions: always(),
        actions: [{ type: "drop" }],
      }),
      makeRule({
        id: "tag",
        priority: 2,
        conditions: always(),
        actions: [{ type: "addTag", value: "t" }],
      }),
    ]
    const r = evaluate(makeInput(), rules, makeCtx())
    expect(r.decision).toBe("show")
    expect(r.filterReason).toBeNull()
    expect(r.tags).toEqual(["t"])
    expect(r.matched).toEqual([
      { ruleId: "dry", name: "Dry", dryRun: true, actions: [{ type: "drop" }] },
      { ruleId: "tag", name: "tag", dryRun: false, actions: [{ type: "addTag", value: "t" }] },
    ])
  })

  it("decision strength: drop > archive > show", () => {
    const r1 = evaluate(
      makeInput(),
      [
        makeRule({ priority: 1, conditions: always(), actions: [{ type: "archive" }] }),
        makeRule({ priority: 2, conditions: always(), actions: [{ type: "drop" }] }),
      ],
      makeCtx(),
    )
    expect(r1.decision).toBe("drop")
    const r2 = evaluate(
      makeInput(),
      [
        makeRule({ priority: 1, conditions: always(), actions: [{ type: "archive" }] }),
        makeRule({
          priority: 2,
          conditions: always(),
          actions: [{ type: "setPriority", value: "urgent" }],
        }),
      ],
      makeCtx(),
    )
    expect(r2.decision).toBe("archive")
    expect(r2.priority).toBe("urgent")
  })

  it("drop short-circuits later rules", () => {
    const r = evaluate(
      makeInput(),
      [
        makeRule({
          id: "d",
          name: "Noise",
          priority: 1,
          conditions: always(),
          actions: [{ type: "drop" }],
        }),
        makeRule({
          id: "later",
          priority: 2,
          conditions: always(),
          actions: [{ type: "addTag", value: "x" }],
        }),
      ],
      makeCtx(),
    )
    expect(r.decision).toBe("drop")
    expect(r.matched.map((m) => m.ruleId)).toEqual(["d"])
    expect(r.tags).toEqual([])
    expect(r.filterReason).toBe("Noise")
  })

  it("the highest priority set by any rule wins; low applies when it is the only one", () => {
    const set = (v: "low" | "normal" | "high" | "urgent", p: number) =>
      makeRule({ priority: p, conditions: always(), actions: [{ type: "setPriority", value: v }] })
    expect(evaluate(makeInput(), [set("urgent", 1), set("high", 2)], makeCtx()).priority).toBe(
      "urgent",
    )
    expect(evaluate(makeInput(), [set("high", 1), set("urgent", 2)], makeCtx()).priority).toBe(
      "urgent",
    )
    expect(evaluate(makeInput(), [set("low", 1)], makeCtx()).priority).toBe("low")
    expect(evaluate(makeInput(), [set("low", 1), set("normal", 2)], makeCtx()).priority).toBe(
      "normal",
    )
  })

  it("tags are a union in first-seen order; first Slack channel wins; flags stick", () => {
    const r = evaluate(
      makeInput(),
      [
        makeRule({
          priority: 1,
          conditions: always(),
          actions: [
            { type: "addTag", value: "a" },
            { type: "routeSlackChannel", channelId: "C1" },
          ],
        }),
        makeRule({
          priority: 2,
          conditions: always(),
          actions: [
            { type: "addTag", value: "b" },
            { type: "addTag", value: "a" },
            { type: "routeSlackChannel", channelId: "C2" },
          ],
        }),
        makeRule({
          priority: 3,
          conditions: always(),
          actions: [{ type: "skipSlack" }, { type: "requireApproval" }, { type: "notifyOnly" }],
        }),
      ],
      makeCtx(),
    )
    expect(r.tags).toEqual(["a", "b"])
    expect(r.slackChannelId).toBe("C1")
    expect(r).toMatchObject({ skipSlack: true, requireApproval: true, aiDraftsAllowed: false })
  })

  it("filterReason lists the rules that produced the archive decision", () => {
    const r = evaluate(
      makeInput(),
      [
        makeRule({
          name: "Spam",
          priority: 1,
          conditions: always(),
          actions: [{ type: "archive" }],
        }),
        makeRule({
          name: "Tagger",
          priority: 2,
          conditions: always(),
          actions: [{ type: "addTag", value: "x" }],
        }),
        makeRule({
          name: "Short",
          priority: 3,
          conditions: always(),
          actions: [{ type: "archive" }],
        }),
        makeRule({
          name: "DryArchive",
          priority: 4,
          dryRun: true,
          conditions: always(),
          actions: [{ type: "archive" }],
        }),
      ],
      makeCtx(),
    )
    expect(r.filterReason).toBe("Spam, Short")
  })

  it("skips rules that don't apply to the platform or type", () => {
    const r = evaluate(
      makeInput({ platform: "youtube", type: "comment" }),
      [
        makeRule({
          platforms: ["instagram"],
          conditions: always(),
          actions: [{ type: "archive" }],
        }),
        makeRule({ itemTypes: ["review"], conditions: always(), actions: [{ type: "archive" }] }),
        makeRule({ enabled: false, conditions: always(), actions: [{ type: "archive" }] }),
      ],
      makeCtx(),
    )
    expect(r.decision).toBe("show")
    expect(r.matched).toEqual([])
  })
})

describe("needsAi", () => {
  it("true when shown, no AI signals, and an AI rule could run", () => {
    expect(evaluate(makeInput(), [aiRule()], makeCtx()).needsAi).toBe(true)
  })

  it("false once AI signals are provided (pass 2) and the AI rule then decides", () => {
    const r = evaluate(
      makeInput(),
      [aiRule()],
      makeCtx({ ai: { spamScore: 0, sentiment: "neutral", toxicity: 0.9 } }),
    )
    expect(r.needsAi).toBe(false)
    expect(r.priority).toBe("high")
  })

  it("false when the item is already archived or dropped", () => {
    const rules = [
      makeRule({ priority: 1, conditions: always(), actions: [{ type: "archive" }] }),
      aiRule({ priority: 2 }),
    ]
    expect(evaluate(makeInput(), rules, makeCtx()).needsAi).toBe(false)
  })

  it("false when stopProcessing ends evaluation before the AI rule", () => {
    const rules = [
      makeRule({
        priority: 1,
        stopProcessing: true,
        conditions: always(),
        actions: [{ type: "setPriority", value: "high" }],
      }),
      aiRule({ priority: 2 }),
    ]
    expect(evaluate(makeInput(), rules, makeCtx()).needsAi).toBe(false)
  })

  it("false when the AI rule is disabled, dry-run, or out of scope", () => {
    expect(evaluate(makeInput(), [aiRule({ enabled: false })], makeCtx()).needsAi).toBe(false)
    expect(evaluate(makeInput(), [aiRule({ dryRun: true })], makeCtx()).needsAi).toBe(false)
    expect(
      evaluate(makeInput({ type: "dm" }), [aiRule({ itemTypes: ["review"] })], makeCtx()).needsAi,
    ).toBe(false)
  })

  it("false when no rule uses AI fields", () => {
    expect(
      evaluate(
        makeInput(),
        [makeRule({ conditions: never(), actions: [{ type: "archive" }] })],
        makeCtx(),
      ).needsAi,
    ).toBe(false)
  })
})
