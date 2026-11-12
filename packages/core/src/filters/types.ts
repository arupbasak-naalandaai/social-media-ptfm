/**
 * Filter engine contract: rule, condition, action and input schemas.
 * Shared by the engine (pure), the api (validation), the worker (ingest/re-filter) and the
 * rule builder UI. Everything a user can edit is validated by these zod schemas.
 */
import { z } from "zod"

// ─── Domain enums ────────────────────────────────────────────────────────────

export const PLATFORMS = [
  "google_business",
  "facebook",
  "instagram",
  "youtube",
  "linkedin",
] as const
export const platformSchema = z.enum(PLATFORMS)
export type Platform = z.infer<typeof platformSchema>

export const ITEM_TYPES = ["review", "comment", "dm"] as const
export const itemTypeSchema = z.enum(ITEM_TYPES)
export type ItemType = z.infer<typeof itemTypeSchema>

export const PRIORITIES = ["low", "normal", "high", "urgent"] as const
export const prioritySchema = z.enum(PRIORITIES)
export type Priority = z.infer<typeof prioritySchema>
export const PRIORITY_RANK: Record<Priority, number> = { low: 0, normal: 1, high: 2, urgent: 3 }

/**
 * new: needs attention · pending: reply queued / awaiting approval · replied: we replied ·
 * resolved: done without replying · ignored · failed: reply failed ·
 * filtered: hidden by a rule · archived: hidden by a person.
 */
export const ITEM_STATUSES = [
  "new",
  "pending",
  "replied",
  "resolved",
  "ignored",
  "failed",
  "filtered",
  "archived",
] as const
export const itemStatusSchema = z.enum(ITEM_STATUSES)
export type ItemStatus = z.infer<typeof itemStatusSchema>

/**
 * What happened on the platform. Non-content kinds (reactions, receipts, typing) and our own
 * echoes are dropped by default rules; edits/deletions are archived.
 */
export const EVENT_KINDS = [
  "created",
  "edited",
  "deleted",
  "reaction",
  "like",
  "share",
  "echo",
  "read",
  "delivery",
  "typing",
  "story_mention",
  "story_reaction",
  "postback",
] as const
export const eventKindSchema = z.enum(EVENT_KINDS)
export type EventKind = z.infer<typeof eventKindSchema>

export const SENTIMENTS = ["positive", "neutral", "negative", "mixed"] as const
export type Sentiment = (typeof SENTIMENTS)[number]

// ─── Lists (blocklist / allowlist / keyword lists) ───────────────────────────

export const LIST_NAMES = [
  "blocklist",
  "allowlist",
  "spam_keywords",
  "trusted_domains",
  "low_value_phrases",
] as const
export const listNameSchema = z.enum(LIST_NAMES)
export type ListName = z.infer<typeof listNameSchema>

export const LIST_KINDS = ["author_id", "author_handle", "keyword", "domain"] as const
export const listKindSchema = z.enum(LIST_KINDS)
export type ListKind = z.infer<typeof listKindSchema>

/** One list entry as the engine sees it. `platform: null` applies to every platform. */
export const listEntrySchema = z.object({
  list: listNameSchema,
  kind: listKindSchema,
  value: z.string().trim().min(1).max(500),
  platform: platformSchema.nullable(),
})
export type ListEntry = z.infer<typeof listEntrySchema>

/** A condition can take its value from a list instead of a literal ("authorId in blocklist"). */
export const listRefSchema = z.object({ list: listNameSchema, kind: listKindSchema })
export type ListRef = z.infer<typeof listRefSchema>

// ─── Conditions ──────────────────────────────────────────────────────────────

export const CONDITION_FIELDS = [
  "text",
  "textLength",
  "wordCount",
  "rating",
  "language",
  "authorName",
  "authorHandle",
  "authorId",
  "isOwnAccount",
  "hasLink",
  "linkDomain",
  "mentionCount",
  "isEmojiOnly",
  "isMentionOnly",
  "isLowValue",
  "postId",
  "postAgeDays",
  "eventKind",
  "isReplyToOurReply",
  "receivedHour",
  "aiSpamScore",
  "aiSentiment",
  "aiToxicity",
] as const
export const conditionFieldSchema = z.enum(CONDITION_FIELDS)
export type ConditionField = z.infer<typeof conditionFieldSchema>

export const OPERATORS = [
  "contains",
  "notContains",
  "containsAny",
  "equals",
  "notEquals",
  "regex",
  "inList",
  "notInList",
  "gt",
  "gte",
  "lt",
  "lte",
  "isTrue",
  "isFalse",
  "isEmpty",
] as const
export const operatorSchema = z.enum(OPERATORS)
export type Operator = z.infer<typeof operatorSchema>

export const conditionValueSchema = z.union([
  z.string().max(2000),
  z.number(),
  z.boolean(),
  z.array(z.string().max(500)).max(500),
])
export type ConditionValue = z.infer<typeof conditionValueSchema>

/** Shape only; field/operator/value compatibility is checked by `validateCondition` (fields.ts). */
export const conditionBaseSchema = z.object({
  /** Stable id for UI keys and test-panel explanations. */
  id: z.string().min(1).max(64),
  kind: z.literal("condition"),
  field: conditionFieldSchema,
  operator: operatorSchema,
  value: conditionValueSchema.optional(),
  /** Use a list's entries as the value (inList / notInList / containsAny only). */
  listRef: listRefSchema.optional(),
  caseSensitive: z.boolean().optional(),
})
export type Condition = z.infer<typeof conditionBaseSchema>

export type ConditionGroup = {
  id: string
  kind: "group"
  combinator: "and" | "or"
  /** Inverts the group result ("none of"). */
  negate?: boolean | undefined
  children: (Condition | ConditionGroup)[]
}
export type ConditionNode = Condition | ConditionGroup

export const MAX_GROUP_DEPTH = 4
export const MAX_CONDITIONS_PER_RULE = 50

export const conditionGroupSchema: z.ZodType<ConditionGroup> = z.lazy(() =>
  z.object({
    id: z.string().min(1).max(64),
    kind: z.literal("group"),
    combinator: z.enum(["and", "or"]),
    negate: z.boolean().optional(),
    children: z
      .array(z.union([conditionBaseSchema, conditionGroupSchema]))
      .max(MAX_CONDITIONS_PER_RULE),
  }),
)

// ─── Actions ─────────────────────────────────────────────────────────────────

/** Sentinel channel id resolved from Slack settings → "priority channel". */
export const PRIORITY_SLACK_CHANNEL = "$priority"

export const ruleActionSchema = z.discriminatedUnion("type", [
  /** Do not store at all. Only for pure noise; the UI warns when chosen. */
  z.object({ type: z.literal("drop") }),
  /** Store, hide from the inbox (Filtered tab), no notification. */
  z.object({ type: z.literal("archive") }),
  /** Show, but no AI drafts. */
  z.object({ type: z.literal("notifyOnly") }),
  z.object({ type: z.literal("setPriority"), value: prioritySchema }),
  z.object({ type: z.literal("addTag"), value: z.string().trim().min(1).max(40) }),
  z.object({ type: z.literal("routeSlackChannel"), channelId: z.string().trim().min(1).max(100) }),
  z.object({ type: z.literal("skipSlack") }),
  z.object({ type: z.literal("requireApproval") }),
])
export type RuleAction = z.infer<typeof ruleActionSchema>
export type RuleActionType = RuleAction["type"]

// ─── Rules ───────────────────────────────────────────────────────────────────

export const filterRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).optional(),
  enabled: z.boolean(),
  /** Lower runs first. */
  priority: z.number().int().min(0).max(1_000_000),
  /** Stop evaluating later rules when this one matches (ignored for dry-run matches). */
  stopProcessing: z.boolean(),
  platforms: z.union([z.literal("all"), z.array(platformSchema).min(1)]),
  itemTypes: z.union([z.literal("all"), z.array(itemTypeSchema).min(1)]),
  conditions: conditionGroupSchema,
  actions: z.array(ruleActionSchema).min(1).max(10),
  /** Log matches without applying actions. */
  dryRun: z.boolean().default(false),
})
export type FilterRule = z.infer<typeof filterRuleSchema>

/** What an admin submits from the rule editor (id/priority are assigned by the api). */
export const filterRuleInputSchema = filterRuleSchema.omit({ id: true, priority: true }).extend({
  priority: z.number().int().min(0).max(1_000_000).optional(),
})
export type FilterRuleInput = z.infer<typeof filterRuleInputSchema>

// ─── Engine input / context / result ─────────────────────────────────────────

/** A normalized item before derived fields are computed. */
export interface FilterInput {
  platform: Platform
  type: ItemType
  eventKind: EventKind
  text: string | null
  rating: number | null
  language: string | null
  authorName: string | null
  authorHandle: string | null
  authorId: string | null
  /** Set by the normalizer (author is one of our connected accounts). */
  isOwnAccount: boolean
  /** Set by the normalizer (parent comment is one of our replies). */
  isReplyToOurReply: boolean
  postId: string | null
  postPublishedAt: Date | null
  receivedAt: Date
}

export interface AiSignals {
  /** 0..1 */
  spamScore: number
  sentiment: Sentiment
  /** 0..1 */
  toxicity: number
}

export interface FilterContext {
  lists: ListEntry[]
  /** Evaluation time (for postAgeDays). */
  now: Date
  /** IANA timezone for receivedHour (organization setting). */
  timezone: string
  /** Present only in the second pass, after the AI classifier ran. */
  ai?: AiSignals | undefined
}

export interface RuleMatchInfo {
  ruleId: string
  name: string
  dryRun: boolean
  actions: RuleAction[]
}

export type Decision = "drop" | "archive" | "show"

export interface FilterResult {
  decision: Decision
  /** Highest priority set by a matching rule; "normal" if none set one. */
  priority: Priority
  tags: string[]
  /** First routeSlackChannel action wins. */
  slackChannelId: string | null
  skipSlack: boolean
  aiDraftsAllowed: boolean
  requireApproval: boolean
  /** Every matching rule in evaluation order, including dry-run matches. */
  matched: RuleMatchInfo[]
  /** Human-readable reason when decision is drop/archive, e.g. 'Likely spam'. */
  filterReason: string | null
  /**
   * True when the item is still shown, AI signals were not provided, and at least one rule
   * that could still run references an ai* field. The pipeline then classifies and re-runs.
   */
  needsAi: boolean
}

/** Fields computed from the input by the engine (exported for the test panel / UI). */
export interface DerivedFields {
  text: string
  textLength: number
  wordCount: number
  hasLink: boolean
  linkDomains: string[]
  mentionCount: number
  isEmojiOnly: boolean
  isMentionOnly: boolean
  /** Only generic praise/thanks from the low_value_phrases list (see low-value.ts). */
  isLowValue: boolean
  postAgeDays: number | null
  receivedHour: number
}
