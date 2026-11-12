/**
 * Field metadata: value type, allowed operators and UI hints for every condition field.
 * Single source of truth for validation (api) and the adaptive rule-builder inputs (web).
 */
import {
  EVENT_KINDS,
  SENTIMENTS,
  type Condition,
  type ConditionField,
  type ConditionGroup,
  type ConditionNode,
  type ListKind,
  type Operator,
  MAX_GROUP_DEPTH,
} from "./types"

/** string: single text value · number · boolean · stringList: multi-valued (e.g. link domains) */
export type FieldValueType = "string" | "number" | "boolean" | "stringList"

export interface FieldDef {
  field: ConditionField
  label: string
  description: string
  type: FieldValueType
  operators: readonly Operator[]
  /** Suggested fixed values (enum-like fields): the UI renders a select. */
  enumValues?: readonly string[]
  /** List kinds that make sense as a listRef for this field. */
  listKinds?: readonly ListKind[]
  /** Requires the AI classifier (computed only when AI checks are enabled). */
  ai?: boolean
  min?: number
  max?: number
  unit?: string
}

const STRING_OPS = [
  "contains",
  "notContains",
  "containsAny",
  "equals",
  "notEquals",
  "regex",
  "inList",
  "notInList",
  "isEmpty",
] as const satisfies readonly Operator[]
const ID_OPS = [
  "equals",
  "notEquals",
  "inList",
  "notInList",
  "isEmpty",
] as const satisfies readonly Operator[]
const ENUM_OPS = [
  "equals",
  "notEquals",
  "inList",
  "notInList",
  "isEmpty",
] as const satisfies readonly Operator[]
const NUMBER_OPS = [
  "equals",
  "notEquals",
  "gt",
  "gte",
  "lt",
  "lte",
  "isEmpty",
] as const satisfies readonly Operator[]
const BOOL_OPS = ["isTrue", "isFalse"] as const satisfies readonly Operator[]
const LIST_OPS = [
  "contains",
  "equals",
  "inList",
  "notInList",
  "isEmpty",
] as const satisfies readonly Operator[]

export const FIELD_DEFS: Record<ConditionField, FieldDef> = {
  text: {
    field: "text",
    label: "Text",
    description: "The review, comment or message text.",
    type: "string",
    operators: STRING_OPS,
    listKinds: ["keyword"],
  },
  textLength: {
    field: "textLength",
    label: "Text length",
    description: "Number of characters (trimmed).",
    type: "number",
    operators: NUMBER_OPS,
    min: 0,
    unit: "chars",
  },
  wordCount: {
    field: "wordCount",
    label: "Word count",
    description: "Number of words, ignoring emoji and @mentions.",
    type: "number",
    operators: NUMBER_OPS,
    min: 0,
    unit: "words",
  },
  rating: {
    field: "rating",
    label: "Star rating",
    description: "1–5 stars (reviews only). Empty for comments and DMs.",
    type: "number",
    operators: NUMBER_OPS,
    min: 1,
    max: 5,
    unit: "★",
  },
  language: {
    field: "language",
    label: "Language",
    description: "Detected language code, e.g. en, es, hi.",
    type: "string",
    operators: ENUM_OPS,
  },
  authorName: {
    field: "authorName",
    label: "Author name",
    description: "Display name of the author.",
    type: "string",
    operators: STRING_OPS,
  },
  authorHandle: {
    field: "authorHandle",
    label: "Author handle",
    description: "Username / handle, without @.",
    type: "string",
    operators: STRING_OPS,
    listKinds: ["author_handle"],
  },
  authorId: {
    field: "authorId",
    label: "Author ID",
    description: "The platform's stable user ID.",
    type: "string",
    operators: ID_OPS,
    listKinds: ["author_id"],
  },
  isOwnAccount: {
    field: "isOwnAccount",
    label: "Is our own account",
    description: "Written by one of our connected pages/accounts.",
    type: "boolean",
    operators: BOOL_OPS,
  },
  hasLink: {
    field: "hasLink",
    label: "Has a link",
    description: "Text contains a URL.",
    type: "boolean",
    operators: BOOL_OPS,
  },
  linkDomain: {
    field: "linkDomain",
    label: "Link domain",
    description: "Domains of links in the text (www. stripped). Matches if any link matches.",
    type: "stringList",
    operators: LIST_OPS,
    listKinds: ["domain"],
  },
  mentionCount: {
    field: "mentionCount",
    label: "@mention count",
    description: "Number of @mentions in the text.",
    type: "number",
    operators: NUMBER_OPS,
    min: 0,
  },
  isEmojiOnly: {
    field: "isEmojiOnly",
    label: "Emoji only",
    description: "Text has emoji and nothing else.",
    type: "boolean",
    operators: BOOL_OPS,
  },
  isMentionOnly: {
    field: "isMentionOnly",
    label: "@mentions only",
    description: "Text is only @mentions of other people (tag-only comments).",
    type: "boolean",
    operators: BOOL_OPS,
  },
  postId: {
    field: "postId",
    label: "Post / video ID",
    description: "The post, video or location the item belongs to.",
    type: "string",
    operators: ID_OPS,
  },
  postAgeDays: {
    field: "postAgeDays",
    label: "Post age",
    description: "Days since the post was published when the item arrived.",
    type: "number",
    operators: NUMBER_OPS,
    min: 0,
    unit: "days",
  },
  eventKind: {
    field: "eventKind",
    label: "Event kind",
    description: "created, edited, deleted, reaction, echo, story_mention, …",
    type: "string",
    operators: ENUM_OPS,
    enumValues: EVENT_KINDS,
  },
  isReplyToOurReply: {
    field: "isReplyToOurReply",
    label: "Reply to our reply",
    description: "The comment answers one of our own replies.",
    type: "boolean",
    operators: BOOL_OPS,
  },
  receivedHour: {
    field: "receivedHour",
    label: "Received hour",
    description: "Hour of day (0–23) in the workspace timezone.",
    type: "number",
    operators: NUMBER_OPS,
    min: 0,
    max: 23,
  },
  aiSpamScore: {
    field: "aiSpamScore",
    label: "AI spam score",
    description: "0–1 likelihood of spam (AI checks must be on).",
    type: "number",
    operators: NUMBER_OPS,
    min: 0,
    max: 1,
    ai: true,
  },
  aiSentiment: {
    field: "aiSentiment",
    label: "AI sentiment",
    description: "positive, neutral, negative or mixed (AI checks must be on).",
    type: "string",
    operators: ENUM_OPS,
    enumValues: SENTIMENTS,
    ai: true,
  },
  aiToxicity: {
    field: "aiToxicity",
    label: "AI toxicity",
    description: "0–1 toxicity score (AI checks must be on).",
    type: "number",
    operators: NUMBER_OPS,
    min: 0,
    max: 1,
    ai: true,
  },
}

export const OPERATOR_LABELS: Record<Operator, string> = {
  contains: "contains",
  notContains: "does not contain",
  containsAny: "contains any of",
  equals: "is",
  notEquals: "is not",
  regex: "matches regex",
  inList: "is one of",
  notInList: "is not one of",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  isTrue: "is true",
  isFalse: "is false",
  isEmpty: "is empty",
}

/** What kind of value an operator needs (drives the UI input). */
export type OperatorValueKind = "none" | "string" | "number" | "stringArray" | "regex"

export function operatorValueKind(field: ConditionField, operator: Operator): OperatorValueKind {
  switch (operator) {
    case "isTrue":
    case "isFalse":
    case "isEmpty":
      return "none"
    case "containsAny":
    case "inList":
    case "notInList":
      return "stringArray"
    case "regex":
      return "regex"
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return "number"
    case "equals":
    case "notEquals":
      return FIELD_DEFS[field].type === "number" ? "number" : "string"
    case "contains":
    case "notContains":
      return "string"
  }
}

/** Operators that may take their value from a list (listRef). */
export const LIST_REF_OPERATORS: readonly Operator[] = ["inList", "notInList", "containsAny"]

export const REGEX_MAX_LENGTH = 200

/**
 * Conservative check for catastrophic backtracking: rejects nested quantifiers such as
 * (a+)+, (a*)*, (a|aa)+ and (.*){n}, plus backreferences and lookbehinds.
 */
export function isSafeRegex(pattern: string): boolean {
  if (pattern.length > REGEX_MAX_LENGTH) return false
  if (/\\[1-9]/.test(pattern)) return false // backreferences
  if (/\(\?<[=!]/.test(pattern)) return false // lookbehind
  // A quantified group whose body itself contains a quantifier or alternation.
  if (/\((?:[^()\\]|\\.)*[+*?}|](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,?\d*\})/.test(pattern))
    return false
  try {
    new RegExp(pattern)
  } catch {
    return false
  }
  return true
}

export interface ConditionIssue {
  conditionId: string
  message: string
}

/** Field/operator/value compatibility for one condition. Returns null when valid. */
export function validateCondition(c: Condition): string | null {
  const def = FIELD_DEFS[c.field]
  if (!def.operators.includes(c.operator)) {
    return `"${OPERATOR_LABELS[c.operator]}" can't be used with ${def.label}`
  }
  if (c.listRef) {
    if (!LIST_REF_OPERATORS.includes(c.operator))
      return "A list can only be used with “is one of”, “is not one of” or “contains any of”"
    if (def.listKinds && !def.listKinds.includes(c.listRef.kind)) {
      return `${def.label} can't be compared with ${c.listRef.kind.replace("_", " ")} entries`
    }
    return null
  }
  const kind = operatorValueKind(c.field, c.operator)
  const v = c.value
  switch (kind) {
    case "none":
      return null
    case "number":
      if (typeof v !== "number" || Number.isNaN(v)) return `${def.label} needs a number`
      if (def.min !== undefined && v < def.min) return `${def.label} must be ≥ ${def.min}`
      if (def.max !== undefined && v > def.max) return `${def.label} must be ≤ ${def.max}`
      return null
    case "string":
      if (typeof v !== "string" || v.trim() === "") return "Enter a value"
      return null
    case "stringArray":
      if (!Array.isArray(v) || v.length === 0) return "Add at least one value"
      return null
    case "regex":
      if (typeof v !== "string" || v === "") return "Enter a regular expression"
      if (!isSafeRegex(v))
        return "This pattern is invalid or could be very slow (nested quantifiers, backreferences)"
      return null
  }
}

/** Validates every condition in a tree (depth, count, compatibility). */
export function validateConditionTree(root: ConditionGroup): ConditionIssue[] {
  const issues: ConditionIssue[] = []
  let count = 0
  const walk = (node: ConditionNode, depth: number) => {
    if (node.kind === "group") {
      if (depth > MAX_GROUP_DEPTH) {
        issues.push({
          conditionId: node.id,
          message: `Groups can be nested at most ${MAX_GROUP_DEPTH} levels`,
        })
        return
      }
      for (const child of node.children) walk(child, depth + 1)
      return
    }
    count++
    const message = validateCondition(node)
    if (message) issues.push({ conditionId: node.id, message })
  }
  walk(root, 1)
  if (count > 50)
    issues.push({ conditionId: root.id, message: "A rule can have at most 50 conditions" })
  return issues
}

/** True if any condition in the tree uses an AI field. */
export function usesAiFields(root: ConditionGroup): boolean {
  const walk = (node: ConditionNode): boolean =>
    node.kind === "group" ? node.children.some(walk) : FIELD_DEFS[node.field].ai === true
  return walk(root)
}
