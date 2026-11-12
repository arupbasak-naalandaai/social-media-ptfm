/**
 * Request/response contracts between apps/web and apps/api (JSON: dates are ISO strings).
 */
import { z } from "zod"
import {
  itemStatusSchema,
  itemTypeSchema,
  listKindSchema,
  listNameSchema,
  platformSchema,
  prioritySchema,
  eventKindSchema,
  filterRuleInputSchema,
  type Decision,
  type FilterRule,
  type ItemStatus,
  type ItemType,
  type ListKind,
  type ListName,
  type Platform,
  type Priority,
} from "./filters/types"
import type { ItemLink } from "./links"

/**
 * Statuses each inbox view shows by default. The inbox view also leaves out follow-ups
 * (new activity in threads you already engaged with): those live in the Follow-ups tab.
 */
export const VIEW_STATUSES = {
  inbox: ["new", "pending", "failed"],
  done: ["replied", "resolved", "ignored"],
  filtered: ["filtered", "archived"],
} as const satisfies Record<string, readonly ItemStatus[]>
export type InboxView = keyof typeof VIEW_STATUSES

/** Item statuses that need someone's attention. */
export const OPEN_STATUSES = VIEW_STATUSES.inbox
/** Statuses that mean "we engaged with this thread" (it shows up under Follow-ups). */
export const ENGAGED_STATUSES = ["replied", "resolved"] as const satisfies readonly ItemStatus[]

export type ItemCounts = Record<InboxView, number> & {
  /** Open items in threads you engaged with (new activity under Follow-ups). */
  followUps: number
}

/** Hours a business may reply to a DM after the customer's last message (platform policy). */
export const DM_REPLY_WINDOW_HOURS: Partial<Record<Platform, number>> = {
  facebook: 24,
  instagram: 24,
}

const csv = <T extends z.ZodType<string, string>>(item: T) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").filter(Boolean) : undefined))
    .pipe(z.array(item).optional())

export const itemListQuerySchema = z.object({
  view: z.enum(["inbox", "done", "filtered"]).default("inbox"),
  status: csv(itemStatusSchema),
  platform: csv(platformSchema),
  type: csv(itemTypeSchema),
  priority: csv(prioritySchema),
  tag: z.string().trim().max(40).optional(),
  since: z.enum(["24h", "7d", "30d", "all"]).default("all"),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(["newest", "oldest", "priority"]).default("newest"),
  cursor: z.string().max(20).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})
export type ItemListQuery = z.input<typeof itemListQuerySchema>

export interface ItemSummary {
  id: string
  platform: Platform
  type: ItemType
  status: ItemStatus
  priority: Priority
  eventKind: string
  authorName: string | null
  authorHandle: string | null
  authorAvatarUrl: string | null
  text: string | null
  rating: number | null
  language: string | null
  tags: string[]
  postTitle: string | null
  postUrl: string | null
  receivedAt: string
  filterReason: string | null
  manualOverride: boolean
  conversationId: string | null
  accountName: string
  /** New activity in a thread you already replied to or resolved (shown under Follow-ups). */
  isFollowUp: boolean
  /** "Open in <platform>" link, or null when the platform offers none. */
  link: ItemLink | null
}

export interface ItemListResponse {
  items: ItemSummary[]
  nextCursor: string | null
  counts: ItemCounts
}

// ─── Follow-ups ───────────────────────────────────────────────────────────────

export const followUpListQuerySchema = itemListQuerySchema
  .pick({ platform: true, type: true, q: true, since: true, cursor: true })
  .extend({ limit: z.coerce.number().int().min(1).max(100).default(30) })
export type FollowUpListQuery = z.input<typeof followUpListQuerySchema>

/** One conversation or comment thread you engaged with. */
export interface FollowUpThread {
  threadKey: string
  /** The item to open: the newest open follow-up if there is one, else the newest item. */
  item: ItemSummary
  /** Items stored in this thread (filtered/archived ones excluded). */
  itemCount: number
  /** Open follow-up items: the person wrote again after you engaged. */
  newCount: number
  /** When you last replied to or resolved something in this thread. */
  lastEngagedAt: string | null
  lastActivityAt: string
}

export interface FollowUpListResponse {
  threads: FollowUpThread[]
  nextCursor: string | null
  counts: ItemCounts
}

export interface MatchedRuleRef {
  id: string
  name: string
  dryRun: boolean
}

export interface ReplyWindow {
  hours: number
  expiresAt: string | null
  expired: boolean
}

export interface ItemDetail extends ItemSummary {
  externalId: string
  postId: string | null
  isOwnAccount: boolean
  aiDraftsAllowed: boolean
  requireApproval: boolean
  resolvedAt: string | null
  matchedRules: MatchedRuleRef[]
  /**
   * The whole thread, oldest first: this item, the other stored items of the same DM
   * conversation or comment thread, and the replies we sent.
   */
  thread: ThreadEntry[]
  replyWindow: ReplyWindow | null
  aiDrafts: { id: string; text: string; model: string; createdAt: string }[]
  replies: {
    id: string
    text: string
    status: string
    source: string
    sentAt: string | null
    error: string | null
  }[]
  /** Whether replying can work yet (an account with tokens is connected). */
  canReply: boolean
}

export interface ThreadEntry {
  id: string
  kind: "item" | "reply"
  text: string | null
  at: string
  authorName: string | null
  eventKind: string
  /** Item status, or a reply's send status (queued, sent, failed…). */
  status: string
  /** Our side of the conversation (a reply we sent). */
  ours: boolean
}

export const restoreItemSchema = z.object({ addToAllowlist: z.boolean().default(false) })

/** POST /api/items/:id/hide-similar */
export interface HideSimilarResponse {
  item: ItemSummary
  /** The phrase added to the Low-value phrases list. */
  phrase: string
  /** The list entry (for Undo), or null when the phrase was already listed. */
  entryId: string | null
}

export const LEARN_PHRASE_ERRORS = {
  empty: "This item has no words to learn from.",
  question: "Questions are never hidden as low-value.",
  link: "Comments with links are handled by the spam rule, not as low-value.",
  too_long: "Too long to learn from. Add a short phrase under Filters → Lists instead.",
} as const

// ─── Filters ──────────────────────────────────────────────────────────────────

export interface RuleWithStats extends FilterRule {
  isDefault: boolean
  defaultKey: string | null
  matches7d: number
  dryRunMatches7d: number
  updatedAt: string
}

export const ruleTogglePatchSchema = z
  .object({ enabled: z.boolean(), dryRun: z.boolean(), stopProcessing: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")

export const reorderRulesSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) })

export const ruleSampleSchema = z.object({
  text: z.string().max(5000).default(""),
  platform: platformSchema.default("instagram"),
  type: itemTypeSchema.default("comment"),
  eventKind: eventKindSchema.default("created"),
  rating: z.number().int().min(1).max(5).nullable().default(null),
  authorName: z.string().max(200).nullable().default(null),
  authorHandle: z.string().max(200).nullable().default(null),
  isOwnAccount: z.boolean().default(false),
})
export type RuleSample = z.infer<typeof ruleSampleSchema>

export const ruleTestRequestSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("sample"),
    rule: filterRuleInputSchema,
    ruleId: z.string().optional(),
    sample: ruleSampleSchema,
  }),
  z.object({
    mode: z.literal("recent"),
    rule: filterRuleInputSchema,
    ruleId: z.string().optional(),
  }),
])
export type RuleTestRequest = z.input<typeof ruleTestRequestSchema>

export interface RuleTestOutcome {
  decision: Decision
  priority: Priority
  filterReason: string | null
}

export interface RuleTestRow {
  /** null for a pasted sample. */
  item: Pick<
    ItemSummary,
    "id" | "platform" | "type" | "authorName" | "text" | "rating" | "status" | "receivedAt"
  > | null
  /** Did this rule's conditions match (scope + conditions; ignores enabled/dry-run)? */
  matched: boolean
  /** Result with the current saved rules. */
  before: RuleTestOutcome
  /** Result if this draft were saved (and enabled). */
  after: RuleTestOutcome
  /** The rule uses AI fields that weren't available, so the result may differ in production. */
  aiUnknown: boolean
}

export interface RuleTestResponse {
  rows: RuleTestRow[]
  total: number
  matched: number
  wouldChange: number
}

// ─── Lists ────────────────────────────────────────────────────────────────────

export const createListEntrySchema = z.object({
  list: listNameSchema,
  kind: listKindSchema,
  value: z.string().trim().min(1).max(500),
  platform: platformSchema.nullable().default(null),
  note: z.string().trim().max(200).optional(),
})

export interface ListEntryDto {
  id: string
  list: ListName
  kind: ListKind
  value: string
  platform: Platform | null
  note: string | null
  createdAt: string
}

/** Which kinds each list accepts (drives the Lists UI). */
export const LIST_KINDS_BY_LIST: Record<ListName, readonly ListKind[]> = {
  blocklist: ["author_handle", "author_id", "keyword", "domain"],
  allowlist: ["author_handle", "author_id"],
  spam_keywords: ["keyword"],
  trusted_domains: ["domain"],
  low_value_phrases: ["keyword"],
}

// ─── Live events (SSE) ────────────────────────────────────────────────────────

export type InboxStreamEvent =
  | { type: "items.changed"; itemIds: string[]; reason: string }
  | { type: "items.refiltered"; changed: number; examined: number }
  | { type: "rules.changed" }
  | { type: "lists.changed" }
