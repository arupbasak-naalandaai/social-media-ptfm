/**
 * AI reply drafts (PLAN §2 ingest pipeline → ai-draft job). Claude, ChatGPT, Gemini and
 * OpenRouter behind the Vercel AI SDK; provider, model and key come from Settings → AI replies.
 */
import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogle } from "@ai-sdk/google"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { APICallError, generateText, Output, type LanguageModel } from "ai"
import {
  AI_PROVIDER_LABELS,
  AI_PROVIDER_SECRET,
  aiBaseUrl,
  buildDraftPrompt,
  cleanDrafts,
  draftsOutputSchema,
  parseSectionSecrets,
  parseSectionValues,
  platformSchema,
  type AiProvider,
  type AiSettings,
  type DraftContext,
  type DraftOptions,
  type ItemType,
} from "@inbox/core"
import type { Keyring } from "@inbox/core/crypto"
import type { PrismaClient } from "@inbox/db"
import { loadSettingsSection, loadSettingsSecret } from "./settings"

export const AI_KEY_FOR = AI_PROVIDER_SECRET

/** Why drafting can't run, in words for the UI. Null = ready. */
export type AiUnavailable = { reason: "disabled" | "no-key" | "no-model"; message: string }

export interface AiConfig {
  settings: AiSettings
  provider: AiProvider
  model: string
  apiKey: string
  /** The endpoint in use: the Settings override, else the provider's default. */
  baseUrl: string
}

export async function loadAiConfig(
  prisma: PrismaClient,
  keyring: Keyring,
  organizationId: string,
): Promise<AiConfig | AiUnavailable> {
  const settings = await loadSettingsSection(prisma, organizationId, "ai")
  if (!settings.enabled) {
    return { reason: "disabled", message: "AI drafts are off (Settings → AI replies)." }
  }
  const provider = settings.provider
  const model = settings.models[provider].trim()
  if (!model) {
    return {
      reason: "no-model",
      message: `Choose a ${AI_PROVIDER_LABELS[provider]} model in Settings → AI replies.`,
    }
  }
  const apiKey = await loadSettingsSecret(
    prisma,
    keyring,
    organizationId,
    "ai",
    AI_KEY_FOR[provider],
  )
  if (!apiKey) {
    return {
      reason: "no-key",
      message: `Add a ${AI_PROVIDER_LABELS[provider]} API key in Settings → AI replies.`,
    }
  }
  return {
    settings,
    provider,
    model,
    apiKey,
    baseUrl: aiBaseUrl(provider, settings.baseUrls[provider]),
  }
}

/**
 * Whether drafting could run, without decrypting anything (for the item page). Null = ready.
 */
export async function aiAvailability(
  prisma: PrismaClient,
  organizationId: string,
): Promise<AiUnavailable | null> {
  const row = await prisma.settings.findUnique({
    where: { organizationId },
    select: { ai: true },
  })
  const settings = parseSectionValues("ai", row?.ai)
  if (!settings.enabled) {
    return { reason: "disabled", message: "AI drafts are off (Settings → AI replies)." }
  }
  const provider = settings.provider
  if (!settings.models[provider].trim()) {
    return {
      reason: "no-model",
      message: `Choose a ${AI_PROVIDER_LABELS[provider]} model in Settings → AI replies.`,
    }
  }
  if (!parseSectionSecrets("ai", row?.ai)[AI_KEY_FOR[provider]]) {
    return {
      reason: "no-key",
      message: `Add a ${AI_PROVIDER_LABELS[provider]} API key in Settings → AI replies.`,
    }
  }
  return null
}

export function isAiConfig(c: AiConfig | AiUnavailable): c is AiConfig {
  return "apiKey" in c
}

export function languageModelFor(
  provider: AiProvider,
  model: string,
  apiKey: string,
  /** Endpoint override; "" or omitted = the provider's default. */
  baseUrl?: string | null,
): LanguageModel {
  const baseURL = aiBaseUrl(provider, baseUrl)
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey, baseURL })(model)
    case "openai":
      return createOpenAI({ apiKey, baseURL })(model)
    case "google":
      return createGoogle({ apiKey, baseURL })(model)
    case "openrouter":
      return createOpenRouter({ apiKey, baseURL }).chat(model)
  }
}

export interface GenerateDraftsArgs {
  model: LanguageModel
  context: DraftContext
  options: DraftOptions
  abortSignal?: AbortSignal | undefined
}

/** One model call returning up to `options.count` cleaned drafts. */
export async function generateDrafts({
  model,
  context,
  options,
  abortSignal,
}: GenerateDraftsArgs): Promise<string[]> {
  const { system, prompt } = buildDraftPrompt(context, options)
  const { output } = await generateText({
    model,
    system,
    prompt,
    output: Output.object({ schema: draftsOutputSchema }),
    maxRetries: 2,
    abortSignal,
  })
  const drafts = cleanDrafts(output?.drafts ?? [], options.count, context.platform, context.type)
  if (drafts.length === 0) throw new Error("The model returned no usable drafts")
  return drafts
}

/** Statuses worth spending tokens on. Filtered/archived/ignored items don't get drafts. */
const DRAFTABLE = new Set(["new", "pending", "failed"])

export type DraftItemResult =
  | { outcome: "drafted"; count: number; provider: AiProvider; model: string }
  | { outcome: "skipped"; reason: string }

/**
 * Drafts replies for one item and stores them, replacing earlier drafts nobody picked.
 * `model` overrides the configured one (tests).
 */
export async function draftRepliesForItem(
  prisma: PrismaClient,
  keyring: Keyring,
  args: {
    organizationId: string
    itemId: string
    /** Regenerate: draft even when drafts already exist. */
    force?: boolean
    model?: LanguageModel
    abortSignal?: AbortSignal
  },
): Promise<DraftItemResult> {
  const { organizationId, itemId } = args
  const item = await prisma.item.findFirst({
    where: { id: itemId, organizationId },
    select: {
      id: true,
      platform: true,
      type: true,
      status: true,
      text: true,
      rating: true,
      postTitle: true,
      authorName: true,
      threadKey: true,
      receivedAt: true,
      aiDraftsAllowed: true,
      isOwnAccount: true,
      platformAccount: { select: { displayName: true } },
      _count: { select: { aiDrafts: true } },
    },
  })
  if (!item) return { outcome: "skipped", reason: "Item not found" }
  if (!item.aiDraftsAllowed) return { outcome: "skipped", reason: "A rule turned drafts off" }
  if (item.isOwnAccount) return { outcome: "skipped", reason: "Our own message" }
  if (!args.force && !DRAFTABLE.has(item.status)) {
    return { outcome: "skipped", reason: `Item is ${item.status}` }
  }
  if (!args.force && item._count.aiDrafts > 0) {
    return { outcome: "skipped", reason: "Already drafted" }
  }

  const config = await loadAiConfig(prisma, keyring, organizationId)
  if (!isAiConfig(config)) return { outcome: "skipped", reason: config.message }

  const replies = await loadSettingsSection(prisma, organizationId, "replies")
  const type = item.type as ItemType
  const thread = item.threadKey
    ? await prisma.item.findMany({
        where: {
          organizationId,
          threadKey: item.threadKey,
          id: { not: item.id },
          receivedAt: { lt: item.receivedAt },
        },
        orderBy: { receivedAt: "asc" },
        take: 12,
        select: {
          text: true,
          isOwnAccount: true,
          replies: { where: { status: "sent" }, select: { text: true } },
        },
      })
    : []

  const context: DraftContext = {
    platform: platformSchema.parse(item.platform),
    type,
    accountName: item.platformAccount.displayName,
    authorName: item.authorName,
    rating: item.rating,
    text: item.text,
    postTitle: item.postTitle,
    thread: thread.flatMap((t) => [
      ...(t.text
        ? [{ from: t.isOwnAccount ? ("us" as const) : ("customer" as const), text: t.text }]
        : []),
      ...t.replies.map((r) => ({ from: "us" as const, text: r.text })),
    ]),
  }
  const drafts = await generateDrafts({
    model:
      args.model ?? languageModelFor(config.provider, config.model, config.apiKey, config.baseUrl),
    context,
    options: {
      count: config.settings.draftsPerItem,
      brandVoice: config.settings.brandVoice,
      replyInCustomerLanguage: config.settings.replyInCustomerLanguage,
      signatureAdded: Boolean(replies.signature.trim()) && replies.signatureOn[type],
    },
    abortSignal: args.abortSignal,
  })

  await prisma.$transaction([
    prisma.aiDraft.deleteMany({ where: { itemId, chosen: false } }),
    prisma.aiDraft.createMany({
      data: drafts.map((text) => ({
        organizationId,
        itemId,
        text,
        provider: config.provider,
        model: config.model,
      })),
    }),
  ])
  return {
    outcome: "drafted",
    count: drafts.length,
    provider: config.provider,
    model: config.model,
  }
}

/** Settings → AI replies → "Test": one tiny call with the given (or saved) key. */
export async function testAiConnection(
  model: LanguageModel,
  abortSignal: AbortSignal = AbortSignal.timeout(20_000),
): Promise<string> {
  const { text } = await generateText({
    model,
    prompt: 'Reply with exactly the word "ok".',
    maxRetries: 0,
    abortSignal,
  })
  return text.trim().slice(0, 50)
}

/** Provider errors that retrying won't fix (bad key, unknown model, bad request). */
export function isPermanentAiError(err: unknown): boolean {
  if (!APICallError.isInstance(err)) return false
  const status = err.statusCode ?? 0
  return status >= 400 && status < 500 && status !== 408 && status !== 409 && status !== 429
}
