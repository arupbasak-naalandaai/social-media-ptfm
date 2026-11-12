/** Test helpers for the filter engine (not exported from the package index). */
import type {
  Condition,
  ConditionField,
  ConditionGroup,
  ConditionNode,
  ConditionValue,
  FilterContext,
  FilterInput,
  FilterRule,
  ListRef,
  Operator,
} from "./types"

export const NOW = new Date("2026-11-12T12:00:00Z")

export function makeInput(over: Partial<FilterInput> = {}): FilterInput {
  return {
    platform: "instagram",
    type: "comment",
    eventKind: "created",
    text: "Love this product, thanks!",
    rating: null,
    language: "en",
    authorName: "Jane Doe",
    authorHandle: "jane_doe",
    authorId: "u-123",
    isOwnAccount: false,
    isReplyToOurReply: false,
    postId: "post-1",
    postPublishedAt: null,
    receivedAt: NOW,
    ...over,
  }
}

export function makeCtx(over: Partial<FilterContext> = {}): FilterContext {
  return { lists: [], now: NOW, timezone: "UTC", ...over }
}

let seq = 0
export function cond(
  field: ConditionField,
  operator: Operator,
  value?: ConditionValue,
  extra: { listRef?: ListRef; caseSensitive?: boolean } = {},
): Condition {
  return {
    id: `t-c${++seq}`,
    kind: "condition",
    field,
    operator,
    ...(value === undefined ? {} : { value }),
    ...extra,
  }
}

export function and(...children: ConditionNode[]): ConditionGroup {
  return { id: `t-g${++seq}`, kind: "group", combinator: "and", children }
}

export function or(...children: ConditionNode[]): ConditionGroup {
  return { id: `t-g${++seq}`, kind: "group", combinator: "or", children }
}

export function makeRule(
  over: Partial<FilterRule> & Pick<FilterRule, "conditions" | "actions">,
): FilterRule {
  const id = over.id ?? `rule-${++seq}`
  return {
    id,
    name: over.name ?? id,
    enabled: true,
    priority: 100,
    stopProcessing: false,
    platforms: "all",
    itemTypes: "all",
    dryRun: false,
    ...over,
  }
}
