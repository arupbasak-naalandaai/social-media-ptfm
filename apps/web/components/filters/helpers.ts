import {
  FIELD_DEFS,
  LIST_KINDS_BY_LIST,
  LIST_NAMES,
  operatorValueKind,
  type Condition,
  type ConditionField,
  type ConditionGroup,
  type ConditionNode,
  type ConditionValue,
  type FilterRuleInput,
  type ListKind,
  type ListName,
  type Operator,
  type RuleAction,
  type RuleActionType,
  type RuleWithStats,
} from "@inbox/core"

/** Only call from event handlers / effects (never during render). */
export function newId(): string {
  return crypto.randomUUID()
}

export const FIELD_GROUPS: { label: string; fields: ConditionField[] }[] = [
  {
    label: "Content",
    fields: [
      "text",
      "textLength",
      "wordCount",
      "rating",
      "language",
      "hasLink",
      "linkDomain",
      "mentionCount",
      "isEmojiOnly",
      "isMentionOnly",
    ],
  },
  { label: "Author", fields: ["authorName", "authorHandle", "authorId", "isOwnAccount"] },
  {
    label: "Context",
    fields: ["postId", "postAgeDays", "eventKind", "isReplyToOurReply", "receivedHour"],
  },
  { label: "AI (needs AI checks)", fields: ["aiSpamScore", "aiSentiment", "aiToxicity"] },
]

export const LIST_LABELS: Record<ListName, string> = {
  blocklist: "Blocklist",
  allowlist: "Allowlist",
  spam_keywords: "Spam keywords",
  trusted_domains: "Trusted domains",
}

export const KIND_LABELS: Record<ListKind, string> = {
  author_handle: "Handles",
  author_id: "Author IDs",
  keyword: "Keywords",
  domain: "Domains",
}

/** Lists that hold entries of the given kind (for "Use list"). */
export function listsForKind(kind: ListKind): ListName[] {
  return LIST_NAMES.filter((l) => LIST_KINDS_BY_LIST[l].includes(kind))
}

export function defaultValueFor(
  field: ConditionField,
  operator: Operator,
): ConditionValue | undefined {
  const def = FIELD_DEFS[field]
  switch (operatorValueKind(field, operator)) {
    case "none":
      return undefined
    case "number":
      return def.min ?? 0
    case "stringArray":
      return []
    case "regex":
      return ""
    case "string":
      return def.enumValues?.[0] ?? ""
  }
}

export function makeCondition(field: ConditionField = "text"): Condition {
  const operator = FIELD_DEFS[field].operators[0]!
  const value = defaultValueFor(field, operator)
  return {
    id: newId(),
    kind: "condition",
    field,
    operator,
    ...(value !== undefined ? { value } : {}),
  }
}

export function makeGroup(withCondition = true): ConditionGroup {
  return {
    id: newId(),
    kind: "group",
    combinator: "and",
    children: withCondition ? [makeCondition()] : [],
  }
}

export function emptyRule(): FilterRuleInput {
  return {
    name: "",
    description: "",
    enabled: true,
    stopProcessing: false,
    dryRun: false,
    platforms: "all",
    itemTypes: "all",
    conditions: makeGroup(),
    actions: [{ type: "archive" }],
  }
}

export function ruleToInput(rule: RuleWithStats): FilterRuleInput {
  return {
    name: rule.name,
    description: rule.description ?? "",
    enabled: rule.enabled,
    stopProcessing: rule.stopProcessing,
    dryRun: rule.dryRun,
    platforms: rule.platforms,
    itemTypes: rule.itemTypes,
    conditions: structuredClone(rule.conditions),
    actions: structuredClone(rule.actions),
  }
}

/** Deep copy with fresh ids (for "Duplicate"). Handler-only. */
export function cloneWithNewIds(group: ConditionGroup): ConditionGroup {
  return {
    ...group,
    id: newId(),
    children: group.children.map((c) =>
      c.kind === "group" ? cloneWithNewIds(c) : { ...c, id: newId() },
    ),
  }
}

// ─── Tree updates (immutable, addressed by id) ───────────────────────────────

export function updateNode(
  group: ConditionGroup,
  id: string,
  update: (node: ConditionNode) => ConditionNode,
): ConditionGroup {
  if (group.id === id) return update(group) as ConditionGroup
  return {
    ...group,
    children: group.children.map((child) => {
      if (child.id === id) return update(child)
      return child.kind === "group" ? updateNode(child, id, update) : child
    }),
  }
}

export function removeNode(group: ConditionGroup, id: string): ConditionGroup {
  return {
    ...group,
    children: group.children
      .filter((c) => c.id !== id)
      .map((c) => (c.kind === "group" ? removeNode(c, id) : c)),
  }
}

export function countConditions(node: ConditionNode): number {
  return node.kind === "group" ? node.children.reduce((n, c) => n + countConditions(c), 0) : 1
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export interface ActionMeta {
  label: string
  description: string
  /** Can appear only once per rule. */
  single: boolean
  /** Hidden from the picker until Slack is enabled (Phase 8). */
  slack?: boolean
}

export const ACTION_META: Record<RuleActionType, ActionMeta> = {
  archive: {
    label: "Archive",
    description: "Store it, hide it from the inbox (Filtered tab), no notification.",
    single: true,
  },
  drop: { label: "Drop", description: "Don't store it at all. Only for pure noise.", single: true },
  setPriority: {
    label: "Set priority",
    description: "Highest priority set by any matching rule wins.",
    single: true,
  },
  addTag: { label: "Add tag", description: "Label the item.", single: false },
  notifyOnly: {
    label: "Notify only",
    description: "Show it, but don't generate AI drafts.",
    single: true,
  },
  requireApproval: {
    label: "Require approval",
    description: "Replies need an admin's approval.",
    single: true,
  },
  routeSlackChannel: {
    label: "Route to Slack channel",
    description: "Post to a specific Slack channel.",
    single: true,
    slack: true,
  },
  skipSlack: {
    label: "Skip Slack",
    description: "Don't post to Slack.",
    single: true,
    slack: true,
  },
}

export const PICKABLE_ACTIONS: RuleActionType[] = [
  "archive",
  "drop",
  "setPriority",
  "addTag",
  "notifyOnly",
  "requireApproval",
]

export function defaultAction(type: RuleActionType): RuleAction {
  switch (type) {
    case "setPriority":
      return { type, value: "high" }
    case "addTag":
      return { type, value: "" }
    case "routeSlackChannel":
      return { type, channelId: "$priority" }
    default:
      return { type }
  }
}

/** Pulls `{ conditionId, message }` issues out of an API 400. */
export function conditionIssuesFrom(
  issues: { conditionId?: string; message: string }[],
): Record<string, string> {
  const map: Record<string, string> = {}
  for (const i of issues) if (i.conditionId) map[i.conditionId] = i.message
  return map
}

/** Shallow copy without the given keys. */
export function omitKeys<T extends object, K extends keyof T>(obj: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...obj }
  for (const k of keys) delete copy[k]
  return copy
}
