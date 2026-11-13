/**
 * Settings → AI replies → model picker: the provider's live model list, fetched with the
 * org's key from `${baseUrl}/models` (every provider we support serves it there).
 * Only text-generation models are kept; anything else can still be typed in by hand.
 */
import { z } from "zod"
import { aiBaseUrl, type AiModelOption, type AiProvider } from "@inbox/core"

export class AiModelListError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message)
    this.name = "AiModelListError"
  }
}

const MAX_PAGES = 10
/** OpenAI also lists embedding, audio, image and moderation models; drafts need text ones. */
const OPENAI_NON_TEXT =
  /(embed|tts|whisper|dall-e|moderation|transcri|realtime|audio|image|sora|davinci|babbage)/i

/** The provider's own error message out of a JSON or text body, clipped. */
function errorMessage(body: string): string | null {
  try {
    const j = JSON.parse(body) as { error?: unknown; message?: unknown }
    const e = j.error
    if (typeof e === "string") return e.slice(0, 200)
    if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
      return (e as { message: string }).message.slice(0, 200)
    }
    if (typeof j.message === "string") return j.message.slice(0, 200)
  } catch {
    // not JSON
  }
  return body.trim().slice(0, 200) || null
}

async function getJson<T>(
  url: string,
  headers: Record<string, string>,
  schema: z.ZodType<T>,
  signal: AbortSignal,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, { headers: { accept: "application/json", ...headers }, signal })
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    throw new AiModelListError(`Couldn't reach ${new URL(url).host}: ${why}`, null)
  }
  if (!res.ok) {
    const msg = errorMessage(await res.text().catch(() => ""))
    throw new AiModelListError(`${res.status}${msg ? ` ${msg}` : ` ${res.statusText}`}`, res.status)
  }
  const parsed = schema.safeParse(await res.json().catch(() => null))
  if (!parsed.success) {
    throw new AiModelListError("The endpoint didn't return a model list", res.status)
  }
  return parsed.data
}

const isoFromSeconds = (s: number | null | undefined) =>
  typeof s === "number" && s > 0 ? new Date(s * 1000).toISOString() : null

const anthropicPage = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      display_name: z.string().nullish(),
      created_at: z.string().nullish(),
      lifecycle: z.string().nullish(),
    }),
  ),
  has_more: z.boolean().nullish(),
  last_id: z.string().nullish(),
})

const openaiList = z.object({
  data: z.array(z.object({ id: z.string(), created: z.number().nullish() })),
})

const googlePage = z.object({
  models: z
    .array(
      z.object({
        name: z.string(),
        displayName: z.string().nullish(),
        supportedGenerationMethods: z.array(z.string()).nullish(),
      }),
    )
    .default([]),
  nextPageToken: z.string().nullish(),
})

const openrouterList = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullish(),
      created: z.number().nullish(),
      architecture: z.object({ output_modalities: z.array(z.string()).nullish() }).nullish(),
    }),
  ),
})

async function fetchModels(
  provider: AiProvider,
  base: string,
  apiKey: string | null,
  signal: AbortSignal,
): Promise<AiModelOption[]> {
  switch (provider) {
    case "anthropic": {
      const headers = { "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" }
      const out: AiModelOption[] = []
      let after: string | null = null
      for (let page = 0; page < MAX_PAGES; page++) {
        const q: string = after ? `&after_id=${encodeURIComponent(after)}` : ""
        const res = await getJson(`${base}/models?limit=1000${q}`, headers, anthropicPage, signal)
        for (const m of res.data) {
          if (m.lifecycle === "retired") continue
          out.push({ id: m.id, name: m.display_name ?? null, created: m.created_at ?? null })
        }
        if (!res.has_more || !res.last_id) break
        after = res.last_id
      }
      return out
    }
    case "openai": {
      const headers = { authorization: `Bearer ${apiKey ?? ""}` }
      const res = await getJson(`${base}/models`, headers, openaiList, signal)
      return res.data
        .filter((m) => !OPENAI_NON_TEXT.test(m.id))
        .map((m) => ({ id: m.id, name: null, created: isoFromSeconds(m.created) }))
    }
    case "google": {
      const headers = { "x-goog-api-key": apiKey ?? "" }
      const out: AiModelOption[] = []
      let token: string | null = null
      for (let page = 0; page < MAX_PAGES; page++) {
        const q: string = token ? `&pageToken=${encodeURIComponent(token)}` : ""
        const res = await getJson(`${base}/models?pageSize=1000${q}`, headers, googlePage, signal)
        for (const m of res.models) {
          const methods = m.supportedGenerationMethods
          if (methods && !methods.includes("generateContent")) continue
          out.push({
            id: m.name.replace(/^models\//, ""),
            name: m.displayName ?? null,
            created: null,
          })
        }
        if (!res.nextPageToken) break
        token = res.nextPageToken
      }
      return out
    }
    case "openrouter": {
      // OpenRouter's list is public; send the key anyway when we have one.
      const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {}
      const res = await getJson(`${base}/models`, headers, openrouterList, signal)
      return res.data
        .filter((m) => {
          const outModes = m.architecture?.output_modalities
          return !outModes || outModes.includes("text")
        })
        .map((m) => ({ id: m.id, name: m.name ?? null, created: isoFromSeconds(m.created) }))
    }
  }
}

/** Newest first (by publish date when known, else by id so higher versions come first). */
function sortModels(models: AiModelOption[]): AiModelOption[] {
  const seen = new Set<string>()
  return models
    .filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)))
    .sort((a, b) => {
      if (a.created && b.created && a.created !== b.created) return a.created < b.created ? 1 : -1
      if (a.created && !b.created) return -1
      if (!a.created && b.created) return 1
      return b.id.localeCompare(a.id, "en", { numeric: true })
    })
}

/** Lists the provider's text models. `baseUrl` "" or undefined = the provider's default. */
export async function listAiModels(args: {
  provider: AiProvider
  apiKey: string | null
  baseUrl?: string | null
  signal?: AbortSignal
}): Promise<AiModelOption[]> {
  const base = aiBaseUrl(args.provider, args.baseUrl)
  const signal = args.signal ?? AbortSignal.timeout(15_000)
  return sortModels(await fetchModels(args.provider, base, args.apiKey, signal))
}
