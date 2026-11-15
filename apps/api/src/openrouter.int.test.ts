/**
 * Settings → AI replies → "Connect OpenRouter" against a real database (TEST_DATABASE_URL).
 * OpenRouter's key endpoint is stubbed (fetch).
 */
import { effectivePermissions } from "@inbox/core"
import { createHash, randomBytes } from "node:crypto"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createKeyring } from "@inbox/core/crypto"
import { createLogger } from "@inbox/core/logger"
import { createPrismaClient } from "@inbox/db"
import { loadSettingsSecret, loadSettingsSection } from "@inbox/pipeline"
import { createApp } from "./app"
import type { JobSender } from "./lib/jobs"

const url = process.env.TEST_DATABASE_URL
const prisma = url ? createPrismaClient(url) : null
const logger = createLogger("test", { level: "silent", transport: undefined })
const keyring = createKeyring(randomBytes(32).toString("base64"))
const ORG = "or-org"
const WEB = "https://app.example.com"
const KEY = "sk-or-v1-abcdef0123456789"

const jobs: JobSender = {
  enqueueRefilter: async () => {},
  enqueuePoll: async () => {},
  enqueueIngest: async () => {},
  enqueueAiDraft: async () => {},
  enqueueSendReply: async () => {},
  stop: async () => {},
}

const app = (role: "owner" | "member" = "owner") =>
  createApp({
    auth: {
      handler: async () => new Response(null, { status: 404 }),
      getSession: async () => ({
        user: { id: "u-or", email: "owner@example.com", name: "Owner" },
        session: { id: "s-or", activeOrganizationId: ORG },
      }),
    },
    orgs: {
      resolve: async () => ({
        id: ORG,
        name: "O",
        role,
        permissions: effectivePermissions(role, null),
      }),
    },
    logger,
    checkDb: async () => true,
    prisma: prisma!,
    jobs,
    keyring,
    urls: { apiPublicUrl: "https://api.example.com", webUrl: WEB },
  })

const location = (res: Response) => new URL(res.headers.get("location")!)

describe.skipIf(!url)("Connect OpenRouter (integration)", () => {
  beforeEach(async () => {
    await prisma!.$executeRawUnsafe(
      'TRUNCATE "verification", "audit_log", "settings", "organization" CASCADE',
    )
    await prisma!.organization.create({
      data: { id: ORG, name: "O", slug: "o", createdAt: new Date() },
    })
  })
  afterEach(() => vi.unstubAllGlobals())
  afterAll(async () => prisma?.$disconnect())

  it("signs in at OpenRouter, saves the key and switches the provider", async () => {
    const start = location(await app().request("/api/oauth/openrouter/start"))
    expect(start.origin + start.pathname).toBe("https://openrouter.ai/auth")
    expect(start.searchParams.get("callback_url")).toBe(`${WEB}/api/oauth/openrouter/callback`)
    expect(start.searchParams.get("code_challenge_method")).toBe("S256")
    const challenge = start.searchParams.get("code_challenge")!

    let sent: Record<string, string> = {}
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent = JSON.parse(String(init.body))
        return new Response(JSON.stringify({ key: KEY, user_id: "user_1" }), { status: 200 })
      }),
    )
    const done = location(await app().request("/api/oauth/openrouter/callback?code=abc"))
    expect(done.pathname).toBe("/settings")
    expect(Object.fromEntries(done.searchParams)).toEqual({ tab: "ai", connected: "openrouter" })

    // The verifier sent to OpenRouter matches the challenge it saw.
    expect(sent.code).toBe("abc")
    expect(createHash("sha256").update(sent.code_verifier!).digest("base64url")).toBe(challenge)

    expect(await loadSettingsSecret(prisma!, keyring, ORG, "ai", "openrouterApiKey")).toBe(KEY)
    expect((await loadSettingsSection(prisma!, ORG, "ai")).provider).toBe("openrouter")
    const audit = await prisma!.auditLog.findFirstOrThrow({ where: { entityId: "ai" } })
    expect(JSON.stringify(audit.after)).not.toContain(KEY)

    // Single use.
    const again = location(await app().request("/api/oauth/openrouter/callback?code=abc"))
    expect(again.searchParams.get("error")).toMatch(/expired or was already used/)
  })

  it("reports OpenRouter's error and keeps settings unchanged", async () => {
    await app().request("/api/oauth/openrouter/start")
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 400, message: "Invalid code" } }), {
            status: 400,
          }),
      ),
    )
    const res = location(await app().request("/api/oauth/openrouter/callback?code=bad"))
    expect(res.searchParams.get("error")).toBe("OpenRouter 400: Invalid code")
    expect(await loadSettingsSecret(prisma!, keyring, ORG, "ai", "openrouterApiKey")).toBeNull()
  })

  it("is for admins only", async () => {
    expect((await app("member").request("/api/oauth/openrouter/start")).status).toBe(403)
  })
})
