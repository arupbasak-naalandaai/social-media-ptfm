/**
 * "Connect OpenRouter": OpenRouter's OAuth PKCE flow. The admin signs in at openrouter.ai and
 * we receive a user-controlled API key, so there is nothing to copy and paste. One key reaches
 * Claude, GPT and Gemini models through OpenRouter.
 * https://openrouter.ai/docs/guides/overview/auth/oauth (checked 2026-11-15)
 */
import { z } from "zod"

const AUTH_URL = "https://openrouter.ai/auth"
const KEYS_URL = "https://openrouter.ai/api/v1/auth/keys"
const TIMEOUT_MS = 15_000

const keyResponseSchema = z.object({ key: z.string().min(1) })

export class OpenRouterAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OpenRouterAuthError"
  }
}

/** Where to send the admin: OpenRouter's sign-in page, which returns `?code=` to callbackUrl. */
export function openrouterAuthUrl(args: { callbackUrl: string; codeChallenge: string }): string {
  const url = new URL(AUTH_URL)
  url.searchParams.set("callback_url", args.callbackUrl)
  url.searchParams.set("code_challenge", args.codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  return url.toString()
}

/** Trades the callback's code (+ our PKCE verifier) for the API key. */
export async function exchangeOpenRouterCode(args: {
  code: string
  codeVerifier: string
}): Promise<string> {
  let res: Response
  try {
    res = await fetch(KEYS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: args.code,
        code_verifier: args.codeVerifier,
        code_challenge_method: "S256",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    throw new OpenRouterAuthError(`OpenRouter didn't respond: ${(err as Error).message}`)
  }
  const body: unknown = await res.json().catch(() => ({}))
  if (!res.ok) {
    const message =
      (body as { error?: { message?: unknown } })?.error?.message ?? res.statusText ?? "error"
    throw new OpenRouterAuthError(`OpenRouter ${res.status}: ${String(message)}`.slice(0, 300))
  }
  const parsed = keyResponseSchema.safeParse(body)
  if (!parsed.success) throw new OpenRouterAuthError("OpenRouter didn't return a key")
  return parsed.data.key
}
