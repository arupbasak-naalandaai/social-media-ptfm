import { describe, expect, it } from "vitest"
import { createEvalEnv, evaluateCondition, evaluateGroup, type EvalTrace } from "./evaluate"
import { FIELD_DEFS } from "./fields"
import { and, cond, makeCtx, makeInput, NOW, or } from "./testing"
import type {
  AiSignals,
  ConditionField,
  ConditionValue,
  FilterContext,
  FilterInput,
  ListRef,
  Operator,
} from "./types"

interface Row {
  name: string
  field: ConditionField
  operator: Operator
  value?: ConditionValue
  listRef?: ListRef
  caseSensitive?: boolean
  input?: Partial<FilterInput>
  ctx?: Partial<FilterContext>
  expected: boolean
}

const AI: AiSignals = { spamScore: 0.5, sentiment: "negative", toxicity: 0.25 }

function check(row: Row): boolean {
  const env = createEvalEnv(makeInput(row.input), makeCtx(row.ctx))
  const extra: { listRef?: ListRef; caseSensitive?: boolean } = {}
  if (row.listRef) extra.listRef = row.listRef
  if (row.caseSensitive !== undefined) extra.caseSensitive = row.caseSensitive
  return evaluateCondition(cond(row.field, row.operator, row.value, extra), env)
}

// ─── Generators ──────────────────────────────────────────────────────────────

/** Rows for every string operator the field allows, derived from one sample value. */
function stringRows(
  field: ConditionField,
  sample: string,
  toInput: (v: string | null) => Partial<FilterInput>,
  opts: { nullable?: boolean; ctx?: Partial<FilterContext> } = {},
): Row[] {
  const nullable = opts.nullable ?? true
  const upper = sample.toUpperCase()
  const part = sample.slice(1, Math.max(3, sample.length - 1)).toUpperCase()
  const esc = sample.slice(0, 2).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const mk = (
    operator: Operator,
    value: ConditionValue | undefined,
    v: string | null,
    expected: boolean,
    note: string,
  ): Row => ({
    name: `${field} ${operator} ${note}`,
    field,
    operator,
    ...(value === undefined ? {} : { value }),
    input: toInput(v),
    ...(opts.ctx ? { ctx: opts.ctx } : {}),
    expected,
  })
  const all: Record<Operator, Row[]> = {
    contains: [
      mk("contains", part, sample, true, "substring, case-insensitive"),
      mk("contains", "zzqx", sample, false, "missing"),
    ],
    notContains: [
      mk("notContains", "zzqx", sample, true, "missing"),
      mk("notContains", part, sample, false, "present"),
    ],
    containsAny: [
      mk("containsAny", ["zzqx", part], sample, true, "one present"),
      mk("containsAny", ["zzqx", "qqzz"], sample, false, "none present"),
    ],
    equals: [
      mk("equals", upper, sample, true, "case-insensitive"),
      mk("equals", `${sample}x`, sample, false, "different"),
    ],
    notEquals: [
      mk("notEquals", `${sample}x`, sample, true, "different"),
      mk("notEquals", upper, sample, false, "same"),
    ],
    regex: [
      mk("regex", `^${esc}`, sample, true, "anchored match"),
      mk("regex", "^zzqx", sample, false, "no match"),
    ],
    inList: [
      mk("inList", ["zzqx", upper], sample, true, "in list"),
      mk("inList", ["zzqx"], sample, false, "not in list"),
    ],
    notInList: [
      mk("notInList", ["zzqx"], sample, true, "not in list"),
      mk("notInList", [upper], sample, false, "in list"),
    ],
    isEmpty: nullable
      ? [
          mk("isEmpty", undefined, null, true, "null"),
          mk("isEmpty", undefined, sample, false, "set"),
        ]
      : [mk("isEmpty", undefined, sample, false, "always set")],
    gt: [],
    gte: [],
    lt: [],
    lte: [],
    isTrue: [],
    isFalse: [],
  }
  return FIELD_DEFS[field].operators.flatMap((op) => all[op])
}

/** Rows for every number operator, given an input that yields value n. */
function numberRows(
  field: ConditionField,
  n: number,
  step: number,
  input: Partial<FilterInput>,
  opts: {
    ctx?: Partial<FilterContext>
    nullInput?: Partial<FilterInput>
    nullCtx?: Partial<FilterContext>
  } = {},
): Row[] {
  const base = { field, input, ...(opts.ctx ? { ctx: opts.ctx } : {}) }
  const rows: Row[] = [
    { ...base, name: `${field} equals ${n}`, operator: "equals", value: n, expected: true },
    {
      ...base,
      name: `${field} equals other`,
      operator: "equals",
      value: n + step,
      expected: false,
    },
    {
      ...base,
      name: `${field} notEquals other`,
      operator: "notEquals",
      value: n + step,
      expected: true,
    },
    { ...base, name: `${field} notEquals same`, operator: "notEquals", value: n, expected: false },
    { ...base, name: `${field} gt lower`, operator: "gt", value: n - step, expected: true },
    { ...base, name: `${field} gt same`, operator: "gt", value: n, expected: false },
    { ...base, name: `${field} gte same`, operator: "gte", value: n, expected: true },
    { ...base, name: `${field} gte higher`, operator: "gte", value: n + step, expected: false },
    { ...base, name: `${field} lt higher`, operator: "lt", value: n + step, expected: true },
    { ...base, name: `${field} lt same`, operator: "lt", value: n, expected: false },
    { ...base, name: `${field} lte same`, operator: "lte", value: n, expected: true },
    { ...base, name: `${field} lte lower`, operator: "lte", value: n - step, expected: false },
    { ...base, name: `${field} isEmpty (set)`, operator: "isEmpty", expected: false },
  ]
  if (opts.nullInput || opts.nullCtx) {
    const nb = {
      field,
      input: opts.nullInput ?? input,
      ...(opts.nullCtx ? { ctx: opts.nullCtx } : opts.ctx ? { ctx: opts.ctx } : {}),
    }
    rows.push(
      { ...nb, name: `${field} isEmpty (null)`, operator: "isEmpty", expected: true },
      { ...nb, name: `${field} gt on null`, operator: "gt", value: -1000, expected: false },
      { ...nb, name: `${field} lte on null`, operator: "lte", value: 1000, expected: false },
      { ...nb, name: `${field} equals on null`, operator: "equals", value: n, expected: false },
      {
        ...nb,
        name: `${field} notEquals on null`,
        operator: "notEquals",
        value: n,
        expected: true,
      },
    )
  }
  return rows
}

function boolRows(
  field: ConditionField,
  whenTrue: Partial<FilterInput>,
  whenFalse: Partial<FilterInput>,
): Row[] {
  return [
    { name: `${field} isTrue (true)`, field, operator: "isTrue", input: whenTrue, expected: true },
    {
      name: `${field} isTrue (false)`,
      field,
      operator: "isTrue",
      input: whenFalse,
      expected: false,
    },
    {
      name: `${field} isFalse (false)`,
      field,
      operator: "isFalse",
      input: whenFalse,
      expected: true,
    },
    {
      name: `${field} isFalse (true)`,
      field,
      operator: "isFalse",
      input: whenTrue,
      expected: false,
    },
  ]
}

const receivedAt = new Date("2026-11-12T15:30:00Z")

const ROWS: Row[] = [
  // Strings
  ...stringRows("text", "Hello World", (v) => ({ text: v })),
  ...stringRows("authorName", "Jane Doe", (v) => ({ authorName: v })),
  ...stringRows("authorHandle", "jane_doe", (v) => ({ authorHandle: v })),
  ...stringRows("authorId", "u-12345", (v) => ({ authorId: v })),
  ...stringRows("postId", "post-777", (v) => ({ postId: v })),
  ...stringRows("language", "en", (v) => ({ language: v })),
  ...stringRows("eventKind", "created", () => ({ eventKind: "created" }), { nullable: false }),
  ...stringRows("aiSentiment", "negative", () => ({}), {
    nullable: false,
    ctx: { ai: AI },
  }),
  {
    name: "aiSentiment isEmpty without AI → unknown → false",
    field: "aiSentiment",
    operator: "isEmpty",
    expected: false,
  },

  // Numbers
  ...numberRows("textLength", 5, 1, { text: "hello" }),
  ...numberRows("wordCount", 3, 1, { text: "hello big world" }),
  ...numberRows("rating", 4, 1, { rating: 4 }, { nullInput: { rating: null } }),
  ...numberRows("mentionCount", 2, 1, { text: "@a @b hi" }),
  ...numberRows(
    "postAgeDays",
    10,
    1,
    { postPublishedAt: new Date(NOW.getTime() - 10 * 86_400_000) },
    { nullInput: { postPublishedAt: null } },
  ),
  ...numberRows("receivedHour", 15, 1, { receivedAt }),
  ...numberRows("aiSpamScore", 0.5, 0.1, {}, { ctx: { ai: AI } }),
  ...numberRows("aiToxicity", 0.25, 0.05, {}, { ctx: { ai: AI } }),

  // Booleans
  ...boolRows("isOwnAccount", { isOwnAccount: true }, { isOwnAccount: false }),
  ...boolRows("isReplyToOurReply", { isReplyToOurReply: true }, { isReplyToOurReply: false }),
  ...boolRows("hasLink", { text: "see https://x.com" }, { text: "no link" }),
  ...boolRows("isEmojiOnly", { text: "🔥🔥" }, { text: "🔥 nice" }),
  ...boolRows("isMentionOnly", { text: "@a @b" }, { text: "@a hi" }),

  // String list (link domains)
  {
    name: "linkDomain contains",
    field: "linkDomain",
    operator: "contains",
    value: "SPAM",
    input: { text: "go https://spam.biz" },
    expected: true,
  },
  {
    name: "linkDomain contains (no)",
    field: "linkDomain",
    operator: "contains",
    value: "zzqx",
    input: { text: "go https://spam.biz" },
    expected: false,
  },
  {
    name: "linkDomain equals",
    field: "linkDomain",
    operator: "equals",
    value: "www.Spam.biz",
    input: { text: "go https://spam.biz/x" },
    expected: true,
  },
  {
    name: "linkDomain equals is not subdomain-aware",
    field: "linkDomain",
    operator: "equals",
    value: "spam.biz",
    input: { text: "go https://a.spam.biz" },
    expected: false,
  },
  {
    name: "linkDomain inList (subdomain)",
    field: "linkDomain",
    operator: "inList",
    value: ["b.com"],
    input: { text: "https://a.b.com" },
    expected: true,
  },
  {
    name: "linkDomain inList (lookalike)",
    field: "linkDomain",
    operator: "inList",
    value: ["b.com"],
    input: { text: "https://ab.com" },
    expected: false,
  },
  {
    name: "linkDomain notInList (one unknown)",
    field: "linkDomain",
    operator: "notInList",
    value: ["youtube.com"],
    input: { text: "https://youtube.com/x https://spam.biz" },
    expected: true,
  },
  {
    name: "linkDomain notInList (all trusted)",
    field: "linkDomain",
    operator: "notInList",
    value: ["youtube.com"],
    input: { text: "https://m.youtube.com/x" },
    expected: false,
  },
  {
    name: "linkDomain notInList (no links)",
    field: "linkDomain",
    operator: "notInList",
    value: ["youtube.com"],
    input: { text: "no links" },
    expected: false,
  },
  {
    name: "linkDomain isEmpty",
    field: "linkDomain",
    operator: "isEmpty",
    input: { text: "no links" },
    expected: true,
  },
  {
    name: "linkDomain isEmpty (has link)",
    field: "linkDomain",
    operator: "isEmpty",
    input: { text: "https://x.com" },
    expected: false,
  },
]

describe("every field × operator", () => {
  it.each(ROWS.map((r) => [r.name, r] as const))("%s", (_name, row) => {
    expect(check(row)).toBe(row.expected)
  })

  it("covers every (field, operator) pair allowed by FIELD_DEFS", () => {
    const missing: string[] = []
    for (const def of Object.values(FIELD_DEFS)) {
      for (const op of def.operators) {
        if (!ROWS.some((r) => r.field === def.field && r.operator === op))
          missing.push(`${def.field}.${op}`)
      }
    }
    expect(missing).toEqual([])
  })

  it("rejects operators the field doesn't allow", () => {
    expect(
      check({
        name: "",
        field: "rating",
        operator: "contains",
        value: "4",
        input: { rating: 4 },
        expected: false,
      }),
    ).toBe(false)
    expect(
      check({ name: "", field: "hasLink", operator: "equals", value: "true", expected: false }),
    ).toBe(false)
  })
})

describe("string semantics", () => {
  it.each<[string, Row]>([
    [
      "caseSensitive contains miss",
      {
        name: "",
        field: "text",
        operator: "contains",
        value: "hello",
        caseSensitive: true,
        input: { text: "Hello" },
        expected: false,
      },
    ],
    [
      "caseSensitive contains hit",
      {
        name: "",
        field: "text",
        operator: "contains",
        value: "Hello",
        caseSensitive: true,
        input: { text: "Hello" },
        expected: true,
      },
    ],
    [
      "caseSensitive equals",
      {
        name: "",
        field: "authorName",
        operator: "equals",
        value: "jane",
        caseSensitive: true,
        input: { authorName: "Jane" },
        expected: false,
      },
    ],
    [
      "caseSensitive regex",
      {
        name: "",
        field: "text",
        operator: "regex",
        value: "^hello",
        caseSensitive: true,
        input: { text: "Hello" },
        expected: false,
      },
    ],
    [
      "handle @ stripped on value",
      {
        name: "",
        field: "authorHandle",
        operator: "equals",
        value: "@Jane_Doe",
        input: { authorHandle: "jane_doe" },
        expected: true,
      },
    ],
    [
      "handle @ stripped on field",
      {
        name: "",
        field: "authorHandle",
        operator: "inList",
        value: ["jane_doe"],
        input: { authorHandle: "@jane_doe" },
        expected: true,
      },
    ],
    [
      "notContains on null → true",
      {
        name: "",
        field: "authorName",
        operator: "notContains",
        value: "x",
        input: { authorName: null },
        expected: true,
      },
    ],
    [
      "notEquals on null → true",
      {
        name: "",
        field: "authorId",
        operator: "notEquals",
        value: "x",
        input: { authorId: null },
        expected: true,
      },
    ],
    [
      "notInList on null → true",
      {
        name: "",
        field: "postId",
        operator: "notInList",
        value: ["x"],
        input: { postId: null },
        expected: true,
      },
    ],
    [
      "contains on null → false",
      {
        name: "",
        field: "authorName",
        operator: "contains",
        value: "x",
        input: { authorName: null },
        expected: false,
      },
    ],
    [
      "inList on null → false",
      {
        name: "",
        field: "authorId",
        operator: "inList",
        value: ["x"],
        input: { authorId: null },
        expected: false,
      },
    ],
    [
      "text null isEmpty",
      { name: "", field: "text", operator: "isEmpty", input: { text: null }, expected: true },
    ],
    [
      "text whitespace isEmpty",
      { name: "", field: "text", operator: "isEmpty", input: { text: "   " }, expected: true },
    ],
    [
      "unsafe regex → false",
      {
        name: "",
        field: "text",
        operator: "regex",
        value: "(a+)+$",
        input: { text: "aaaa" },
        expected: false,
      },
    ],
    [
      "invalid regex → false",
      {
        name: "",
        field: "text",
        operator: "regex",
        value: "([a-z",
        input: { text: "abc" },
        expected: false,
      },
    ],
    [
      "unicode regex",
      {
        name: "",
        field: "text",
        operator: "regex",
        value: "\\p{Emoji_Presentation}",
        input: { text: "hi 🔥" },
        expected: true,
      },
    ],
    [
      "containsAny ignores empty strings",
      {
        name: "",
        field: "text",
        operator: "containsAny",
        value: [""],
        input: { text: "hi" },
        expected: false,
      },
    ],
  ])("%s", (_n, row) => {
    expect(check(row)).toBe(row.expected)
  })
})

describe("listRef", () => {
  const lists: FilterContext["lists"] = [
    { list: "blocklist", kind: "author_handle", value: "spammer", platform: null },
    { list: "blocklist", kind: "author_handle", value: "ig_only", platform: "instagram" },
    { list: "blocklist", kind: "keyword", value: "buy now", platform: null },
    { list: "trusted_domains", kind: "domain", value: "youtube.com", platform: null },
    { list: "allowlist", kind: "author_handle", value: "spammer", platform: null },
  ]
  const ref = (list: ListRef["list"], kind: ListRef["kind"]): ListRef => ({ list, kind })

  it.each<[string, Row]>([
    [
      "global entry matches",
      {
        name: "",
        field: "authorHandle",
        operator: "inList",
        listRef: ref("blocklist", "author_handle"),
        input: { authorHandle: "@Spammer" },
        ctx: { lists },
        expected: true,
      },
    ],
    [
      "platform entry matches its platform",
      {
        name: "",
        field: "authorHandle",
        operator: "inList",
        listRef: ref("blocklist", "author_handle"),
        input: { authorHandle: "ig_only", platform: "instagram" },
        ctx: { lists },
        expected: true,
      },
    ],
    [
      "platform entry ignored elsewhere",
      {
        name: "",
        field: "authorHandle",
        operator: "inList",
        listRef: ref("blocklist", "author_handle"),
        input: { authorHandle: "ig_only", platform: "facebook" },
        ctx: { lists },
        expected: false,
      },
    ],
    [
      "other list kind ignored",
      {
        name: "",
        field: "authorHandle",
        operator: "inList",
        listRef: ref("blocklist", "author_id"),
        input: { authorHandle: "spammer" },
        ctx: { lists },
        expected: false,
      },
    ],
    [
      "keyword containsAny",
      {
        name: "",
        field: "text",
        operator: "containsAny",
        listRef: ref("blocklist", "keyword"),
        input: { text: "BUY NOW cheap" },
        ctx: { lists },
        expected: true,
      },
    ],
    [
      "listRef takes precedence over value",
      {
        name: "",
        field: "text",
        operator: "containsAny",
        value: ["cheap"],
        listRef: ref("blocklist", "keyword"),
        input: { text: "cheap" },
        ctx: { lists },
        expected: false,
      },
    ],
    [
      "domain notInList trusted",
      {
        name: "",
        field: "linkDomain",
        operator: "notInList",
        listRef: ref("trusted_domains", "domain"),
        input: { text: "https://www.youtube.com/watch" },
        ctx: { lists },
        expected: false,
      },
    ],
    [
      "empty list: inList → false",
      {
        name: "",
        field: "authorId",
        operator: "inList",
        listRef: ref("allowlist", "author_id"),
        input: { authorId: "u-1" },
        ctx: { lists },
        expected: false,
      },
    ],
    [
      "empty list: containsAny → false",
      {
        name: "",
        field: "text",
        operator: "containsAny",
        listRef: ref("spam_keywords", "keyword"),
        input: { text: "anything" },
        ctx: { lists },
        expected: false,
      },
    ],
    [
      "empty list: notInList → true",
      {
        name: "",
        field: "authorId",
        operator: "notInList",
        listRef: ref("allowlist", "author_id"),
        input: { authorId: "u-1" },
        ctx: { lists },
        expected: true,
      },
    ],
    [
      "empty list: linkDomain notInList → true",
      {
        name: "",
        field: "linkDomain",
        operator: "notInList",
        listRef: ref("blocklist", "domain"),
        input: { text: "https://x.com" },
        ctx: { lists },
        expected: true,
      },
    ],
  ])("%s", (_n, row) => {
    expect(check(row)).toBe(row.expected)
  })
})

describe("AI fields without AI signals", () => {
  it("are unknown: false, and flagged in the trace", () => {
    const env = createEvalEnv(makeInput(), makeCtx())
    const trace: EvalTrace = { aiUnknown: false }
    expect(evaluateCondition(cond("aiToxicity", "gte", 0), env, trace)).toBe(false)
    expect(evaluateCondition(cond("aiSpamScore", "notEquals", 1), env, trace)).toBe(false)
    expect(trace.aiUnknown).toBe(true)
  })

  it("non-AI conditions don't flag the trace", () => {
    const env = createEvalEnv(makeInput(), makeCtx())
    const trace: EvalTrace = { aiUnknown: false }
    evaluateCondition(cond("text", "contains", "love"), env, trace)
    expect(trace.aiUnknown).toBe(false)
  })
})

describe("groups", () => {
  const env = createEvalEnv(makeInput({ text: "hello world", rating: 2 }), makeCtx())
  const T = () => cond("text", "contains", "hello")
  const F = () => cond("text", "contains", "zzqx")

  it.each([
    ["and all true", and(T(), T()), true],
    ["and one false", and(T(), F()), false],
    ["or one true", or(F(), T()), true],
    ["or all false", or(F(), F()), false],
    ["empty and → true", and(), true],
    ["empty or → false", or(), false],
    ["negate and", { ...and(T(), T()), negate: true }, false],
    ["negate or (none of)", { ...or(F(), F()), negate: true }, true],
    ["nested: and(or(F,T), T)", and(or(F(), T()), T()), true],
    ["nested: or(and(T,F), and(F,T))", or(and(T(), F()), and(F(), T())), false],
    ["deep nesting", and(or(and(or(T())))), true],
  ] as const)("%s → %s", (_n, group, expected) => {
    expect(evaluateGroup(group, env)).toBe(expected)
  })
})
