/**
 * The filter engine. Pure and synchronous: no I/O, no clock reads (time comes from the input
 * and the context). See docs/PLAN.md §8 for the semantics.
 */
import { deriveFields } from "./derive"
import { FIELD_DEFS, isSafeRegex, usesAiFields } from "./fields"
import {
  PRIORITY_RANK,
  type Condition,
  type ConditionField,
  type ConditionGroup,
  type Decision,
  type DerivedFields,
  type FilterContext,
  type FilterInput,
  type FilterResult,
  type FilterRule,
  type ListRef,
  type Priority,
  type RuleMatchInfo,
} from "./types"

type FieldValue = string | number | boolean | string[] | null

/** Everything a condition needs: the raw input, its derived fields and the context. */
export interface EvalEnv {
  input: FilterInput
  derived: DerivedFields
  ctx: FilterContext
}

export function createEvalEnv(input: FilterInput, ctx: FilterContext): EvalEnv {
  return { input, derived: deriveFields(input, ctx), ctx }
}

interface Resolved {
  value: FieldValue
  /** AI field without AI signals: the condition can't be decided yet. */
  unknown: boolean
}

export function resolveFieldValue(field: ConditionField, env: EvalEnv): Resolved {
  const { input, derived, ctx } = env
  const known = (value: FieldValue): Resolved => ({ value, unknown: false })
  switch (field) {
    case "text":
      return known(derived.text)
    case "textLength":
      return known(derived.textLength)
    case "wordCount":
      return known(derived.wordCount)
    case "hasLink":
      return known(derived.hasLink)
    case "linkDomain":
      return known(derived.linkDomains)
    case "mentionCount":
      return known(derived.mentionCount)
    case "isEmojiOnly":
      return known(derived.isEmojiOnly)
    case "isMentionOnly":
      return known(derived.isMentionOnly)
    case "isLowValue":
      return known(derived.isLowValue)
    case "postAgeDays":
      return known(derived.postAgeDays)
    case "receivedHour":
      return known(derived.receivedHour)
    case "rating":
      return known(input.rating)
    case "language":
      return known(input.language)
    case "authorName":
      return known(input.authorName)
    case "authorHandle":
      return known(input.authorHandle)
    case "authorId":
      return known(input.authorId)
    case "isOwnAccount":
      return known(input.isOwnAccount)
    case "postId":
      return known(input.postId)
    case "eventKind":
      return known(input.eventKind)
    case "isReplyToOurReply":
      return known(input.isReplyToOurReply)
    case "aiSpamScore":
      return ctx.ai ? known(ctx.ai.spamScore) : { value: null, unknown: true }
    case "aiSentiment":
      return ctx.ai ? known(ctx.ai.sentiment) : { value: null, unknown: true }
    case "aiToxicity":
      return ctx.ai ? known(ctx.ai.toxicity) : { value: null, unknown: true }
  }
}

/** List entry values for a listRef, scoped to the item's platform (null platform = all). */
export function resolveListValues(ref: ListRef, env: EvalEnv): string[] {
  return env.ctx.lists
    .filter(
      (e) =>
        e.list === ref.list &&
        e.kind === ref.kind &&
        (e.platform === null || e.platform === env.input.platform),
    )
    .map((e) => e.value)
}

function conditionValues(c: Condition, env: EvalEnv): string[] {
  if (c.listRef) return resolveListValues(c.listRef, env)
  if (Array.isArray(c.value)) return c.value
  if (c.value === undefined) return []
  return [String(c.value)]
}

function normalizeDomain(d: string): string {
  return d
    .trim()
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "")
}

/** "a.b.com" matches "b.com" and "a.b.com", but not "ab.com". */
function domainMatches(domain: string, entry: string): boolean {
  const e = normalizeDomain(entry)
  return e !== "" && (domain === e || domain.endsWith(`.${e}`))
}

function evalStringList(c: Condition, domains: string[], env: EvalEnv): boolean {
  const ds = domains.map(normalizeDomain)
  switch (c.operator) {
    case "isEmpty":
      return ds.length === 0
    case "contains": {
      const v = typeof c.value === "string" ? c.value.toLowerCase() : ""
      return v !== "" && ds.some((d) => d.includes(v))
    }
    case "equals": {
      const v = typeof c.value === "string" ? normalizeDomain(c.value) : ""
      return v !== "" && ds.some((d) => d === v)
    }
    case "inList": {
      const list = conditionValues(c, env)
      return ds.some((d) => list.some((e) => domainMatches(d, e)))
    }
    case "notInList": {
      const list = conditionValues(c, env)
      return ds.some((d) => !list.some((e) => domainMatches(d, e)))
    }
    default:
      return false
  }
}

function evalString(c: Condition, raw: string | null, env: EvalEnv): boolean {
  const isHandle = c.field === "authorHandle"
  const prep = (s: string): string => {
    const t = isHandle ? s.trim().replace(/^@/, "") : s
    return c.caseSensitive ? t : t.toLowerCase()
  }
  const empty = raw === null || raw === ""
  const fv = empty ? "" : prep(raw)

  switch (c.operator) {
    case "isEmpty":
      return empty
    case "contains": {
      if (empty || typeof c.value !== "string" || c.value === "") return false
      return fv.includes(prep(c.value))
    }
    case "notContains": {
      if (empty) return true
      if (typeof c.value !== "string" || c.value === "") return true
      return !fv.includes(prep(c.value))
    }
    case "containsAny": {
      if (empty) return false
      return conditionValues(c, env).some((v) => v !== "" && fv.includes(prep(v)))
    }
    case "equals": {
      if (empty || c.value === undefined || Array.isArray(c.value)) return false
      return fv === prep(String(c.value))
    }
    case "notEquals": {
      if (empty || c.value === undefined || Array.isArray(c.value)) return true
      return fv !== prep(String(c.value))
    }
    case "regex": {
      if (empty || typeof c.value !== "string" || !isSafeRegex(c.value)) return false
      try {
        return new RegExp(c.value, c.caseSensitive ? "u" : "iu").test(raw)
      } catch {
        return false
      }
    }
    case "inList": {
      if (empty) return false
      return conditionValues(c, env).some((v) => fv === prep(v))
    }
    case "notInList": {
      if (empty) return true
      return !conditionValues(c, env).some((v) => fv === prep(v))
    }
    default:
      return false
  }
}

function evalNumber(c: Condition, fv: number | null): boolean {
  if (c.operator === "isEmpty") return fv === null
  if (c.operator === "notEquals")
    return fv === null || typeof c.value !== "number" || fv !== c.value
  if (fv === null || typeof c.value !== "number") return false
  switch (c.operator) {
    case "equals":
      return fv === c.value
    case "gt":
      return fv > c.value
    case "gte":
      return fv >= c.value
    case "lt":
      return fv < c.value
    case "lte":
      return fv <= c.value
    default:
      return false
  }
}

function evalBoolean(c: Condition, fv: boolean | null): boolean {
  if (c.operator === "isTrue") return fv === true
  if (c.operator === "isFalse") return fv === false
  return false
}

/** Mutable flags collected while evaluating (currently: whether an AI field was undecidable). */
export interface EvalTrace {
  aiUnknown: boolean
}

export function evaluateCondition(c: Condition, env: EvalEnv, trace?: EvalTrace): boolean {
  const def = FIELD_DEFS[c.field]
  if (!def.operators.includes(c.operator)) return false
  const resolved = resolveFieldValue(c.field, env)
  if (resolved.unknown) {
    if (trace) trace.aiUnknown = true
    return false
  }
  const fv = resolved.value
  switch (def.type) {
    case "boolean":
      return evalBoolean(c, typeof fv === "boolean" ? fv : null)
    case "number":
      return evalNumber(c, typeof fv === "number" && Number.isFinite(fv) ? fv : null)
    case "stringList":
      return evalStringList(c, Array.isArray(fv) ? fv : [], env)
    case "string":
      return evalString(c, typeof fv === "string" ? fv : null, env)
  }
}

export function evaluateGroup(group: ConditionGroup, env: EvalEnv, trace?: EvalTrace): boolean {
  const results = group.children.map((child) =>
    child.kind === "group"
      ? evaluateGroup(child, env, trace)
      : evaluateCondition(child, env, trace),
  )
  const matched = group.combinator === "and" ? results.every(Boolean) : results.some(Boolean)
  return group.negate ? !matched : matched
}

export function ruleApplies(rule: FilterRule, input: FilterInput): boolean {
  if (!rule.enabled) return false
  if (rule.platforms !== "all" && !rule.platforms.includes(input.platform)) return false
  if (rule.itemTypes !== "all" && !rule.itemTypes.includes(input.type)) return false
  return true
}

const DECISION_RANK: Record<Decision, number> = { show: 0, archive: 1, drop: 2 }

/** Rules that apply to this input, in evaluation order (priority asc, then original order). */
export function orderedApplicableRules(rules: FilterRule[], input: FilterInput): FilterRule[] {
  return rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => ruleApplies(rule, input))
    .sort((a, b) => a.rule.priority - b.rule.priority || a.index - b.index)
    .map(({ rule }) => rule)
}

export function evaluate(
  input: FilterInput,
  rules: FilterRule[],
  ctx: FilterContext,
): FilterResult {
  const env = createEvalEnv(input, ctx)
  const ordered = orderedApplicableRules(rules, input)

  let decision: Decision = "show"
  let priority: Priority | null = null
  const tags: string[] = []
  let slackChannelId: string | null = null
  let skipSlack = false
  let aiDraftsAllowed = true
  let requireApproval = false
  const matched: RuleMatchInfo[] = []
  const processed: FilterRule[] = []

  for (const rule of ordered) {
    processed.push(rule)
    if (!evaluateGroup(rule.conditions, env)) continue

    matched.push({ ruleId: rule.id, name: rule.name, dryRun: rule.dryRun, actions: rule.actions })
    if (rule.dryRun) continue

    for (const action of rule.actions) {
      switch (action.type) {
        case "drop":
        case "archive":
          if (DECISION_RANK[action.type] > DECISION_RANK[decision]) decision = action.type
          break
        case "notifyOnly":
          aiDraftsAllowed = false
          break
        case "setPriority":
          if (priority === null || PRIORITY_RANK[action.value] > PRIORITY_RANK[priority]) {
            priority = action.value
          }
          break
        case "addTag":
          if (!tags.includes(action.value)) tags.push(action.value)
          break
        case "routeSlackChannel":
          slackChannelId ??= action.channelId
          break
        case "skipSlack":
          skipSlack = true
          break
        case "requireApproval":
          requireApproval = true
          break
      }
    }

    if (decision === "drop" || rule.stopProcessing) break
  }

  let filterReason: string | null = null
  if (decision !== "show") {
    const names = matched
      .filter((m) => !m.dryRun && m.actions.some((a) => a.type === decision))
      .map((m) => m.name)
    filterReason = [...new Set(names)].join(", ") || null
  }

  const needsAi =
    ctx.ai === undefined &&
    decision === "show" &&
    processed.some((r) => !r.dryRun && usesAiFields(r.conditions))

  return {
    decision,
    priority: priority ?? "normal",
    tags,
    slackChannelId,
    skipSlack,
    aiDraftsAllowed,
    requireApproval,
    matched,
    filterReason,
    needsAi,
  }
}
