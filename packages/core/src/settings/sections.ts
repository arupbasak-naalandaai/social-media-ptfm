/**
 * Settings → one zod schema per tab (PLAN §7 `Settings`). Each section is stored as a JSON
 * column. Secret fields are kept apart from the plain values:
 *
 *   stored JSON  = { ...values, secrets: { <key>: { enc: "v1:…", last4: "abcd" } } }
 *   API response = { values, secrets: { <key>: { set: true, last4: "abcd" } } }
 *   PUT body     = { version, values, secrets?: { <key>: "new value" | null (clear) } }
 *
 * Ciphertext never leaves the api; plaintext never comes back out of it.
 */
import { z } from "zod"
import { PLATFORM_VERSIONS } from "../config/platform-versions"
import { generalSettingsSchema } from "./general"
import {
  SYNC_STREAMS,
  YOUTUBE_DEFAULT_DAILY_QUOTA,
  type SyncMode,
  type SyncStreamDef,
  type SyncStreamKey,
} from "./sync"

// ─── Secrets ───────────────────────────────────────────────────────────────────

export const storedSecretSchema = z.object({
  enc: z.string().min(1),
  last4: z.string().max(4),
})
export type StoredSecret = z.infer<typeof storedSecretSchema>

/** What the browser sees for a secret field. */
export interface SecretStatus {
  set: boolean
  last4: string | null
}

/** A new secret value, or `null` to clear it. Omitted = keep. */
export const secretInputSchema = z.string().trim().min(1, "Enter a value").max(8192).nullable()

/** Last 4 characters shown in the UI to identify which secret is stored. */
export function secretLast4(value: string): string {
  return value.length <= 8 ? "" : value.slice(-4)
}

// ─── Sections ──────────────────────────────────────────────────────────────────

const optionalText = (max: number) => z.string().trim().max(max).default("")
const optionalUrl = (fallback: string) =>
  z
    .url({ protocol: /^https$/, message: "Enter an https:// URL" })
    .transform((u) => u.replace(/\/+$/, ""))
    .default(fallback)

export const connectionsSettingsSchema = z.object({
  meta: z
    .object({
      appId: z.string().trim().regex(/^\d*$/, "The Meta app ID is digits only").max(32).default(""),
      graphApiVersion: z
        .string()
        .trim()
        .regex(/^v\d{1,3}\.\d$/, "Use the form v26.0")
        .default(PLATFORM_VERSIONS.metaGraphApiVersion),
      /** Facebook Login for Business configuration ID. Empty = ask for permissions by scope. */
      loginConfigId: z
        .string()
        .trim()
        .regex(/^\d*$/, "The configuration ID is digits only")
        .max(32)
        .default(""),
    })
    .prefault({}),
  google: z
    .object({
      /** OAuth client for Google Business Profile + YouTube connections (not sign-in). */
      clientId: optionalText(200),
      /** Topic GBP publishes review notifications to: `projects/{project}/topics/{topic}`. */
      pubsubTopic: z
        .union([
          z.literal(""),
          z
            .string()
            .trim()
            .regex(
              /^projects\/[a-z][-a-z0-9]{4,28}[a-z0-9]\/topics\/[A-Za-z][-\w.~+%]{2,254}$/,
              "Use projects/<project-id>/topics/<topic>",
            ),
        ])
        .default(""),
      /** Pub/Sub push audience. Empty = `${API_PUBLIC_URL}/webhooks/google`. */
      pubsubAudience: optionalText(500),
      /** Service account the Pub/Sub push subscription signs its tokens with. */
      pushServiceAccountEmail: z.union([z.literal(""), z.email().trim()]).default(""),
      reviewsBaseUrl: optionalUrl(PLATFORM_VERSIONS.googleReviewsBaseUrl),
      notificationsBaseUrl: optionalUrl(PLATFORM_VERSIONS.googleNotificationsBaseUrl),
    })
    .prefault({}),
  linkedin: z
    .object({
      clientId: optionalText(100),
      apiVersion: z
        .string()
        .trim()
        .regex(/^\d{6}$/, "Use the form YYYYMM")
        .default(PLATFORM_VERSIONS.linkedinApiVersion),
    })
    .prefault({}),
})
export type ConnectionsSettings = z.infer<typeof connectionsSettingsSchema>

function streamSettingsSchema(def: SyncStreamDef) {
  return z
    .object({
      mode: z
        .enum(def.modes as unknown as [SyncMode, ...SyncMode[]], {
          message: `${def.label} supports: ${def.modes.join(", ")}`,
        })
        .default(def.modes[0]!),
      intervalMinutes: z
        .number({ message: "Enter a number of minutes" })
        .int("Whole minutes only")
        .min(def.minMinutes, `${def.label}: the minimum is ${def.minMinutes} min`)
        .max(1440, "The maximum is 1440 min (24 h)")
        .default(def.defaultMinutes),
    })
    .prefault({})
}

const streamsShape = Object.fromEntries(
  Object.entries(SYNC_STREAMS).map(([key, def]) => [key, streamSettingsSchema(def)]),
) as { [K in SyncStreamKey]: ReturnType<typeof streamSettingsSchema> }

export const syncSettingsSchema = z.object({
  /** Stops the scheduler for this workspace (webhooks are still received and stored). */
  paused: z.boolean().default(false),
  streams: z.object(streamsShape).prefault({}),
  tokenRefreshHours: z.number().int().min(1, "The minimum is 1 h").max(24).default(6),
  /** How far back the first sync of a newly connected account reaches. */
  backfillDays: z.number().int().min(1).max(60).default(30),
  youtube: z
    .object({
      dailyQuota: z.number().int().min(1000).max(10_000_000).default(YOUTUBE_DEFAULT_DAILY_QUOTA),
      /** Expected `commentThreads.list` pages per poll per channel (100 threads a page). */
      pagesPerPoll: z.number().int().min(1).max(20).default(1),
    })
    .prefault({}),
})
export type SyncSettings = z.infer<typeof syncSettingsSchema>

export const filtersSettingsSchema = z.object({
  /** Re-run rules over stored items right after a rule or list change. */
  autoRefilter: z.boolean().default(true),
  /** Second filter pass with the AI classifier (spam score, sentiment, toxicity). Phase 4. */
  aiChecks: z.boolean().default(false),
})
export type FiltersSettings = z.infer<typeof filtersSettingsSchema>

export const AI_PROVIDERS = ["anthropic", "openai", "google", "openrouter"] as const
export const aiProviderSchema = z.enum(AI_PROVIDERS)
export type AiProvider = z.infer<typeof aiProviderSchema>
export const AI_PROVIDER_LABELS: Record<AiProvider, string> = {
  anthropic: "Claude (Anthropic)",
  openai: "ChatGPT (OpenAI)",
  google: "Gemini (Google)",
  openrouter: "OpenRouter",
}
/** Which `ai` secret holds each provider's API key. */
export const AI_PROVIDER_SECRET = {
  anthropic: "anthropicApiKey",
  openai: "openaiApiKey",
  google: "googleApiKey",
  openrouter: "openrouterApiKey",
} as const satisfies Record<AiProvider, string>
/**
 * Default model ids: each provider's latest general model, checked 2026-11-13 against the
 * provider docs and OpenRouter's /api/v1/models. OpenRouter ids are `vendor/model`.
 */
export const AI_MODEL_SUGGESTIONS: Record<AiProvider, string> = {
  anthropic: "claude-fable-5-2",
  openai: "gpt-6.1-terra",
  google: "gemini-4-hydrogen",
  openrouter: "google/gemini-4-hydrogen",
}

/**
 * Each SDK's own default API endpoint (base URL, version path included). Model lists are at
 * `${baseUrl}/models` for all four.
 */
export const AI_DEFAULT_BASE_URLS: Record<AiProvider, string> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
  openrouter: "https://openrouter.ai/api/v1",
}

/** A provider endpoint override: "" = the provider's default. https only (it carries the key). */
export const aiBaseUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((v) => {
    if (v === "") return true
    try {
      return new URL(v).protocol === "https:"
    } catch {
      return false
    }
  }, "Enter an https:// URL, or leave it blank for the default")
  .transform((v) => v.replace(/\/+$/, ""))

/** The endpoint actually used: the override, else the provider's default. */
export function aiBaseUrl(provider: AiProvider, override: string | null | undefined): string {
  const v = override?.trim().replace(/\/+$/, "")
  return v || AI_DEFAULT_BASE_URLS[provider]
}

/** One entry of Settings → AI replies → model list (fetched live from the provider). */
export interface AiModelOption {
  id: string
  /** Display name when the provider gives one. */
  name: string | null
  /** ISO date the model was published, when the provider says. */
  created: string | null
}

const modelId = z
  .string()
  .trim()
  .max(100)
  .regex(/^[\w.:/-]*$/, "Model ids use letters, digits, - _ . : /")

export const aiSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  provider: aiProviderSchema.default("anthropic"),
  models: z
    .object({
      anthropic: modelId.default(AI_MODEL_SUGGESTIONS.anthropic),
      openai: modelId.default(AI_MODEL_SUGGESTIONS.openai),
      google: modelId.default(AI_MODEL_SUGGESTIONS.google),
      openrouter: modelId.default(AI_MODEL_SUGGESTIONS.openrouter),
    })
    .prefault({}),
  /** API endpoint per provider ("" = default), e.g. a proxy or an AI gateway. */
  baseUrls: z
    .object({
      anthropic: aiBaseUrlSchema.default(""),
      openai: aiBaseUrlSchema.default(""),
      google: aiBaseUrlSchema.default(""),
      openrouter: aiBaseUrlSchema.default(""),
    })
    .prefault({}),
  draftsPerItem: z.number().int().min(1).max(3).default(2),
  /** Draft as soon as an item arrives, or only when someone opens it (cheaper). */
  generateOn: z.enum(["arrival", "open"]).default("arrival"),
  brandVoice: z.string().trim().max(2000).default(""),
  replyInCustomerLanguage: z.boolean().default(true),
})
export type AiSettings = z.infer<typeof aiSettingsSchema>

export const repliesSettingsSchema = z.object({
  /** Seconds a sent reply can still be undone before it posts. */
  undoSeconds: z.number().int().min(0).max(30).default(5),
  signature: z.string().trim().max(200).default(""),
  signatureOn: z
    .object({
      review: z.boolean().default(true),
      comment: z.boolean().default(false),
      dm: z.boolean().default(false),
    })
    .prefault({}),
  /** After sending from the item page: open the next item, or stay. */
  afterSend: z.enum(["next", "stay"]).default("next"),
  /** Master switch for rules marked "auto-reply". Off = those rules only draft. */
  allowAutoReplyRules: z.boolean().default(false),
})
export type RepliesSettings = z.infer<typeof repliesSettingsSchema>

const slackChannelId = z
  .string()
  .trim()
  .regex(/^([CGD][A-Z0-9]{6,})?$/, "Use a channel ID like C0123456789")
  .default("")

export const slackSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  defaultChannelId: slackChannelId,
  priorityChannelId: slackChannelId,
  sendPrefix: z.string().trim().min(1).max(20).default("send:"),
})
export type SlackSettings = z.infer<typeof slackSettingsSchema>

export const notificationsSettingsSchema = z.object({
  /** Desktop notifications for new inbox items while the app is open. */
  browser: z.enum(["off", "urgent", "all"]).default("urgent"),
  sound: z.boolean().default(false),
  /** Connections whose token expires within this many days are marked "expiring". */
  tokenExpiryWarningDays: z.number().int().min(1).max(30).default(7),
})
export type NotificationsSettings = z.infer<typeof notificationsSettingsSchema>

/** Filtered-item retention: 0 keeps them forever; otherwise at least 90 days. */
const retentionDays = z
  .number()
  .int()
  .min(0)
  .max(3650)
  .refine((d) => d === 0 || d >= 90, "Use 0 (keep forever) or at least 90 days")

export const dataSettingsSchema = z.object({
  filteredRetentionDays: retentionDays.default(0),
  webhookRetentionDays: z.number().int().min(1).max(365).default(30),
  auditRetentionDays: z.number().int().min(30).max(3650).default(365),
})
export type DataSettings = z.infer<typeof dataSettingsSchema>

// ─── Registry ──────────────────────────────────────────────────────────────────

export const SETTINGS_SECTIONS = [
  "general",
  "connections",
  "sync",
  "filters",
  "ai",
  "replies",
  "slack",
  "notifications",
  "data",
] as const
export const settingsSectionSchema = z.enum(SETTINGS_SECTIONS)
export type SettingsSection = z.infer<typeof settingsSectionSchema>

export const SECTION_SCHEMAS = {
  general: generalSettingsSchema,
  connections: connectionsSettingsSchema,
  sync: syncSettingsSchema,
  filters: filtersSettingsSchema,
  ai: aiSettingsSchema,
  replies: repliesSettingsSchema,
  slack: slackSettingsSchema,
  notifications: notificationsSettingsSchema,
  data: dataSettingsSchema,
} as const satisfies Record<SettingsSection, z.ZodType>

export type SettingsValues = { [S in SettingsSection]: z.infer<(typeof SECTION_SCHEMAS)[S]> }
export type SettingsInputValues = { [S in SettingsSection]: z.input<(typeof SECTION_SCHEMAS)[S]> }

export const SECTION_SECRETS = {
  general: [],
  connections: ["metaAppSecret", "metaVerifyToken", "googleClientSecret", "linkedinClientSecret"],
  sync: [],
  filters: [],
  ai: ["anthropicApiKey", "openaiApiKey", "googleApiKey", "openrouterApiKey"],
  replies: [],
  slack: ["botToken", "signingSecret"],
  notifications: [],
  data: [],
} as const satisfies Record<SettingsSection, readonly string[]>

export type SecretKey<S extends SettingsSection> = (typeof SECTION_SECRETS)[S][number]
export type AnySecretKey = SecretKey<SettingsSection>

/** Parses a stored section, filling defaults. Invalid stored values fall back to defaults. */
export function parseSectionValues<S extends SettingsSection>(
  section: S,
  stored: unknown,
): SettingsValues[S] {
  const schema = SECTION_SCHEMAS[section] as unknown as z.ZodType<SettingsValues[S]>
  const raw = stored && typeof stored === "object" ? stored : {}
  const parsed = schema.safeParse(raw)
  return parsed.success ? parsed.data : schema.parse({})
}

/** The stored ciphertexts of a section, keyed by secret name (unknown keys dropped). */
export function parseSectionSecrets<S extends SettingsSection>(
  section: S,
  stored: unknown,
): Partial<Record<SecretKey<S>, StoredSecret>> {
  const out: Partial<Record<SecretKey<S>, StoredSecret>> = {}
  const secrets =
    stored && typeof stored === "object" ? (stored as { secrets?: unknown }).secrets : undefined
  if (!secrets || typeof secrets !== "object") return out
  for (const key of SECTION_SECRETS[section] as readonly SecretKey<S>[]) {
    const parsed = storedSecretSchema.safeParse((secrets as Record<string, unknown>)[key])
    if (parsed.success) out[key] = parsed.data
  }
  return out
}

/** Secret status for the browser: never the ciphertext. */
export function secretStatuses<S extends SettingsSection>(
  section: S,
  stored: Partial<Record<SecretKey<S>, StoredSecret>>,
): Record<SecretKey<S>, SecretStatus> {
  const out = {} as Record<SecretKey<S>, SecretStatus>
  for (const key of SECTION_SECRETS[section] as readonly SecretKey<S>[]) {
    const s = stored[key]
    out[key] = { set: Boolean(s), last4: s?.last4 || null }
  }
  return out
}

/** zod schema for `PUT /api/settings/:section`. */
export function settingsUpdateSchema<S extends SettingsSection>(section: S) {
  const keys = SECTION_SECRETS[section] as readonly string[]
  const secrets = keys.length
    ? z.partialRecord(z.enum(keys as [string, ...string[]]), secretInputSchema)
    : z.object({}).strict()
  return z.object({
    version: z.number().int().min(1),
    values: SECTION_SCHEMAS[section],
    secrets: secrets.optional(),
  })
}

export type SettingsUpdateBody<S extends SettingsSection> = {
  version: number
  values: SettingsInputValues[S]
  secrets?: Partial<Record<SecretKey<S>, string | null>>
}
