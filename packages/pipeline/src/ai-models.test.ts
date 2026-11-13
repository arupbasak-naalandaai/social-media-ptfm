import { afterEach, describe, expect, it, vi } from "vitest"
import { AiModelListError, listAiModels } from "./ai-models"

type Call = { url: string; headers: Record<string, string> }

function mockFetch(responses: Array<{ status?: number; body: unknown }>): Call[] {
  const calls: Call[] = []
  let i = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
      const r = responses[Math.min(i++, responses.length - 1)]!
      return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
        status: r.status ?? 200,
      })
    }),
  )
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("listAiModels", () => {
  it("anthropic: pages with after_id, drops retired models, newest first", async () => {
    const calls = mockFetch([
      {
        body: {
          data: [
            {
              id: "claude-old",
              display_name: "Old",
              created_at: "2024-01-01T00:00:00Z",
              lifecycle: "retired",
            },
            {
              id: "claude-sonnet-5-5",
              display_name: "Claude Sonnet 5.5",
              created_at: "2026-09-28T00:00:00Z",
              lifecycle: "active",
            },
          ],
          has_more: true,
          last_id: "claude-sonnet-5-5",
        },
      },
      {
        body: {
          data: [
            {
              id: "claude-fable-5-2",
              display_name: "Claude Fable 5.2",
              created_at: "2026-11-10T00:00:00Z",
            },
          ],
          has_more: false,
          last_id: "claude-fable-5-2",
        },
      },
    ])
    const models = await listAiModels({ provider: "anthropic", apiKey: "sk-ant" })
    expect(models.map((m) => m.id)).toEqual(["claude-fable-5-2", "claude-sonnet-5-5"])
    expect(models[0]).toMatchObject({ name: "Claude Fable 5.2", created: "2026-11-10T00:00:00Z" })
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/models?limit=1000")
    expect(calls[0]!.headers["x-api-key"]).toBe("sk-ant")
    expect(calls[1]!.url).toContain("after_id=claude-sonnet-5-5")
  })

  it("openai: uses the endpoint override and drops non-text models", async () => {
    const calls = mockFetch([
      {
        body: {
          data: [
            { id: "gpt-6.1-terra", created: 1792000000 },
            { id: "text-embedding-3-large", created: 1700000000 },
            { id: "whisper-1", created: 1690000000 },
          ],
        },
      },
    ])
    const models = await listAiModels({
      provider: "openai",
      apiKey: "sk-oa",
      baseUrl: "https://gateway.example.com/openai/v1/",
    })
    expect(models.map((m) => m.id)).toEqual(["gpt-6.1-terra"])
    expect(calls[0]!.url).toBe("https://gateway.example.com/openai/v1/models")
    expect(calls[0]!.headers.authorization).toBe("Bearer sk-oa")
  })

  it("google: strips models/ and keeps generateContent models", async () => {
    mockFetch([
      {
        body: {
          models: [
            {
              name: "models/gemini-4-hydrogen",
              displayName: "Gemini 4 Hydrogen",
              supportedGenerationMethods: ["generateContent"],
            },
            { name: "models/text-embedding-005", supportedGenerationMethods: ["embedContent"] },
            { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
          ],
        },
      },
    ])
    const models = await listAiModels({ provider: "google", apiKey: "g-key" })
    expect(models.map((m) => m.id)).toEqual(["gemini-4-hydrogen", "gemini-3.8-flash"])
  })

  it("openrouter: works without a key and keeps text-output models", async () => {
    const calls = mockFetch([
      {
        body: {
          data: [
            {
              id: "google/gemini-4-hydrogen",
              name: "Gemini 4 Hydrogen",
              created: 1794506460,
              architecture: { output_modalities: ["text"] },
            },
            {
              id: "acme/image-gen",
              name: "Image",
              created: 1794600000,
              architecture: { output_modalities: ["image"] },
            },
          ],
        },
      },
    ])
    const models = await listAiModels({ provider: "openrouter", apiKey: null })
    expect(models.map((m) => m.id)).toEqual(["google/gemini-4-hydrogen"])
    expect(calls[0]!.headers.authorization).toBeUndefined()
  })

  it("surfaces the provider's error message", async () => {
    mockFetch([
      {
        status: 401,
        body: { error: { type: "authentication_error", message: "invalid x-api-key" } },
      },
    ])
    const err = await listAiModels({ provider: "anthropic", apiKey: "bad" }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(AiModelListError)
    expect((err as AiModelListError).message).toBe("401 invalid x-api-key")
  })
})
