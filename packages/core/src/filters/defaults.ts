/**
 * Default filter rules seeded for every organization. All are editable and can be disabled.
 * `defaultKey` is stable so later migrations can update defaults without clobbering user edits.
 */
import {
  PRIORITY_SLACK_CHANNEL,
  type Condition,
  type ConditionGroup,
  type FilterRule,
} from "./types"

export type DefaultRuleDef = Omit<FilterRule, "id"> & { defaultKey: string }

export const DEFAULT_SPAM_KEYWORDS = [
  "dm me",
  "promote",
  "followers",
  "crypto",
  "investment",
  "check my profile",
  "collab",
  "free followers",
  "whatsapp me",
  "earn money",
  "giveaway winner",
  "bitcoin",
  "forex",
] as const

export const DEFAULT_COMPLAINT_KEYWORDS = [
  "refund",
  "worst",
  "terrible",
  "scam",
  "never again",
  "complaint",
  "disappointed",
  "rude",
  "horrible",
  "awful",
  "not working",
  "broken",
  "waste of money",
] as const

export const DEFAULT_TRUSTED_DOMAINS = [
  "youtube.com",
  "youtu.be",
  "instagram.com",
  "facebook.com",
  "linkedin.com",
  "google.com",
  "maps.app.goo.gl",
  "g.page",
] as const

// ─── Builders (deterministic ids: `${key}-c1`, `${key}-g1`, …) ───────────────

function builder(key: string) {
  let c = 0
  let g = 0
  const cond = (spec: Omit<Condition, "id" | "kind">): Condition => ({
    id: `${key}-c${++c}`,
    kind: "condition",
    ...spec,
  })
  const group = (
    combinator: "and" | "or",
    children: ConditionGroup["children"],
  ): ConditionGroup => ({
    id: `${key}-g${++g}`,
    kind: "group",
    combinator,
    children,
  })
  return { cond, group }
}

function rule(
  key: string,
  def: Omit<DefaultRuleDef, "defaultKey" | "conditions" | "dryRun" | "stopProcessing"> & {
    stopProcessing?: boolean
  },
  conditions: (b: ReturnType<typeof builder>) => ConditionGroup,
): DefaultRuleDef {
  return {
    defaultKey: key,
    stopProcessing: false,
    dryRun: false,
    ...def,
    conditions: conditions(builder(key)),
  }
}

export const DEFAULT_RULES: DefaultRuleDef[] = [
  rule(
    "drop_own_activity",
    {
      name: "Drop our own activity",
      description:
        "Comments and messages from our own pages/accounts, and Meta echoes of messages we sent.",
      enabled: true,
      priority: 10,
      platforms: "all",
      itemTypes: "all",
      actions: [{ type: "drop" }],
    },
    ({ cond, group }) =>
      group("or", [
        cond({ field: "isOwnAccount", operator: "isTrue" }),
        cond({ field: "eventKind", operator: "equals", value: "echo" }),
      ]),
  ),
  rule(
    "drop_non_content",
    {
      name: "Drop non-content events",
      description: "Likes, reactions, shares, read and delivery receipts, and typing indicators.",
      enabled: true,
      priority: 20,
      platforms: "all",
      itemTypes: "all",
      actions: [{ type: "drop" }],
    },
    ({ cond, group }) =>
      group("or", [
        cond({
          field: "eventKind",
          operator: "inList",
          value: ["reaction", "like", "share", "read", "delivery", "typing"],
        }),
      ]),
  ),
  rule(
    "archive_edits_deletions",
    {
      name: "Archive edits and deletions",
      description: "Edit and delete events; the stored item is updated in place instead.",
      enabled: true,
      priority: 30,
      platforms: "all",
      itemTypes: "all",
      actions: [{ type: "archive" }],
    },
    ({ cond, group }) =>
      group("and", [
        cond({ field: "eventKind", operator: "inList", value: ["edited", "deleted"] }),
      ]),
  ),
  rule(
    "allowlist_vip",
    {
      name: "Always show allowlisted people",
      description: "VIP customers and partners on the allowlist are always shown at high priority.",
      enabled: true,
      priority: 40,
      stopProcessing: true,
      platforms: "all",
      itemTypes: "all",
      actions: [
        { type: "setPriority", value: "high" },
        { type: "addTag", value: "vip" },
      ],
    },
    ({ cond, group }) =>
      group("or", [
        cond({
          field: "authorId",
          operator: "inList",
          listRef: { list: "allowlist", kind: "author_id" },
        }),
        cond({
          field: "authorHandle",
          operator: "inList",
          listRef: { list: "allowlist", kind: "author_handle" },
        }),
      ]),
  ),
  rule(
    "archive_blocklist",
    {
      name: "Archive blocklisted content",
      description:
        "Anything from a blocklisted author, or with a blocklisted keyword or link domain.",
      enabled: true,
      priority: 50,
      platforms: "all",
      itemTypes: "all",
      actions: [{ type: "archive" }],
    },
    ({ cond, group }) =>
      group("or", [
        cond({
          field: "authorId",
          operator: "inList",
          listRef: { list: "blocklist", kind: "author_id" },
        }),
        cond({
          field: "authorHandle",
          operator: "inList",
          listRef: { list: "blocklist", kind: "author_handle" },
        }),
        cond({
          field: "text",
          operator: "containsAny",
          listRef: { list: "blocklist", kind: "keyword" },
        }),
        cond({
          field: "linkDomain",
          operator: "inList",
          listRef: { list: "blocklist", kind: "domain" },
        }),
      ]),
  ),
  rule(
    "archive_emoji_short",
    {
      name: "Archive emoji-only and very short comments",
      description:
        "Comments like “nice” or “🔥🔥” (1–2 words). DMs and reviews are never affected.",
      enabled: true,
      priority: 60,
      platforms: "all",
      itemTypes: ["comment"],
      actions: [{ type: "archive" }],
    },
    ({ cond, group }) =>
      group("or", [
        cond({ field: "isEmojiOnly", operator: "isTrue" }),
        cond({ field: "wordCount", operator: "lte", value: 2 }),
      ]),
  ),
  rule(
    "archive_low_value",
    {
      name: "Archive low-value comments",
      description:
        "Generic praise and thanks like “Good content bro, keep it up 👏”. Uses the Low-value phrases list (“Hide similar” adds to it). Questions and links never match.",
      enabled: true,
      priority: 65,
      platforms: "all",
      itemTypes: ["comment"],
      actions: [{ type: "archive" }, { type: "addTag", value: "low-value" }],
    },
    ({ cond, group }) => group("and", [cond({ field: "isLowValue", operator: "isTrue" })]),
  ),
  rule(
    "archive_tag_only",
    {
      name: "Archive tag-only comments",
      description: "Comments that only @mention other people and say nothing else.",
      enabled: true,
      priority: 70,
      platforms: "all",
      itemTypes: ["comment"],
      actions: [{ type: "archive" }],
    },
    ({ cond, group }) => group("and", [cond({ field: "isMentionOnly", operator: "isTrue" })]),
  ),
  rule(
    "archive_spam",
    {
      name: "Archive likely spam",
      description:
        "Links to unknown domains, or spam phrases such as “check my profile” (editable keyword list).",
      enabled: true,
      priority: 80,
      platforms: "all",
      itemTypes: ["comment", "dm"],
      actions: [{ type: "archive" }, { type: "addTag", value: "spam" }],
    },
    ({ cond, group }) =>
      group("or", [
        group("and", [
          cond({ field: "hasLink", operator: "isTrue" }),
          cond({
            field: "linkDomain",
            operator: "notInList",
            listRef: { list: "trusted_domains", kind: "domain" },
          }),
        ]),
        cond({
          field: "text",
          operator: "containsAny",
          listRef: { list: "spam_keywords", kind: "keyword" },
        }),
      ]),
  ),
  rule(
    "urgent_low_reviews",
    {
      name: "Urgent: 1–3★ reviews",
      description: "Low-rated reviews go to the top of the inbox and the priority Slack channel.",
      enabled: true,
      priority: 90,
      platforms: "all",
      itemTypes: ["review"],
      actions: [
        { type: "setPriority", value: "urgent" },
        { type: "routeSlackChannel", channelId: PRIORITY_SLACK_CHANNEL },
        { type: "addTag", value: "low-rating" },
      ],
    },
    ({ cond, group }) => group("and", [cond({ field: "rating", operator: "lte", value: 3 })]),
  ),
  rule(
    "low_positive_no_text",
    {
      name: "Low priority: 4–5★ reviews without text",
      description: "Star-only positive reviews are shown at low priority without AI drafts.",
      enabled: true,
      priority: 100,
      platforms: "all",
      itemTypes: ["review"],
      actions: [{ type: "setPriority", value: "low" }, { type: "notifyOnly" }],
    },
    ({ cond, group }) =>
      group("and", [
        cond({ field: "rating", operator: "gte", value: 4 }),
        cond({ field: "text", operator: "isEmpty" }),
      ]),
  ),
  rule(
    "high_toxic_complaint",
    {
      name: "High priority: complaints and toxic content",
      description: "Public complaints are routed up, never dropped, so nobody misses them.",
      enabled: true,
      priority: 110,
      platforms: "all",
      itemTypes: "all",
      actions: [
        { type: "setPriority", value: "high" },
        { type: "addTag", value: "complaint" },
      ],
    },
    ({ cond, group }) =>
      group("or", [
        cond({ field: "aiToxicity", operator: "gte", value: 0.7 }),
        cond({ field: "aiSentiment", operator: "equals", value: "negative" }),
        cond({ field: "text", operator: "containsAny", value: [...DEFAULT_COMPLAINT_KEYWORDS] }),
      ]),
  ),
  rule(
    "archive_old_posts",
    {
      name: "Archive comments on old posts",
      description: "Comments on posts older than 30 days (change N in the condition).",
      enabled: false,
      priority: 120,
      platforms: "all",
      itemTypes: ["comment"],
      actions: [{ type: "archive" }],
    },
    ({ cond, group }) => group("and", [cond({ field: "postAgeDays", operator: "gt", value: 30 })]),
  ),
  rule(
    "archive_story_dms",
    {
      name: "Archive Instagram story mentions and reactions",
      description: "Story mentions and story reactions that arrive as Instagram DMs.",
      enabled: false,
      priority: 130,
      platforms: ["instagram"],
      itemTypes: ["dm"],
      actions: [{ type: "archive" }],
    },
    ({ cond, group }) =>
      group("and", [
        cond({
          field: "eventKind",
          operator: "inList",
          value: ["story_mention", "story_reaction"],
        }),
      ]),
  ),
]
