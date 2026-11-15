/**
 * AI drafts API against a real database (TEST_DATABASE_URL): availability, regenerate,
 * drafting on open, and the key test's validation. No provider is called.
 */
import { effectivePermissions } from "@inbox/core"
import { randomBytes } from "node:crypto"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import type { AiDraftJobData, ItemDetail } from "@inbox/core"
import { createKeyring } from "@inbox/core/crypto"
import { createLogger } from "@inbox/core/logger"
import { createPrismaClient, type Prisma } from "@inbox/db"
import { settingsSecretAad } from "@inbox/pipeline"
import { createApp } from "./app"
import type { JobSender } from "./lib/jobs"

const url = process.env.TEST_DATABASE_URL
const prisma = url ? createPrismaClient(url) : null
const logger = createLogger("test", { level: "silent", transport: undefined })
const keyring = createKeyring(randomBytes(32).toString("base64"))
const ORG = "drafts-org"

const drafts: AiDraftJobData[] = []
const jobs: JobSender = {
  enqueueRefilter: async () => {},
  enqueuePoll: async () => {},
  enqueueIngest: async () => {},
  enqueueAiDraft: async (d) => void drafts.push(d),
  enqueueSendReply: async () => {},
  stop: async () => {},
}

const app = () =>
  createApp({
    auth: {
      handler: async () => new Response(null, { status: 404 }),
      getSession: async () => ({
        user: { id: "u-d", email: "o@example.com", name: "Owner" },
        session: { id: "s-d", activeOrganizationId: ORG },
      }),
    },
    orgs: {
      resolve: async () => ({
        id: ORG,
        name: "Drafts",
        role: "owner",
        permissions: effectivePermissions("owner", null),
      }),
    },
    logger,
    checkDb: async () => true,
    prisma: prisma!,
    jobs,
    keyring,
    urls: { apiPublicUrl: "https://api.example.com", webUrl: "https://app.example.com" },
  })

async function setAi(ai: Record<string, unknown>) {
  await prisma!.settings.upsert({
    where: { organizationId: ORG },
    create: { organizationId: ORG, ai: ai as Prisma.InputJsonObject },
    update: { ai: ai as Prisma.InputJsonObject },
  })
}

const readyAi = (extra: Record<string, unknown> = {}) => ({
  enabled: true,
  provider: "anthropic",
  ...extra,
  secrets: {
    anthropicApiKey: {
      enc: keyring.encrypt("sk-x-123456789", settingsSecretAad(ORG, "ai", "anthropicApiKey")),
      last4: "6789",
    },
  },
})

let itemId = ""

describe.skipIf(!url)("AI drafts API (integration)", () => {
  beforeEach(async () => {
    drafts.length = 0
    await prisma!.$executeRawUnsafe(
      'TRUNCATE "ai_draft", "item", "platform_account", "settings", "organization" CASCADE',
    )
    await prisma!.organization.create({
      data: { id: ORG, name: "Drafts", slug: "drafts", createdAt: new Date() },
    })
    const account = await prisma!.platformAccount.create({
      data: {
        organizationId: ORG,
        platform: "google_business",
        kind: "gbp_location",
        externalId: "locations/9",
        displayName: "Demo",
      },
    })
    itemId = (
      await prisma!.item.create({
        data: {
          organizationId: ORG,
          platform: "google_business",
          platformAccountId: account.id,
          type: "review",
          externalId: "r9",
          eventKind: "created",
          receivedAt: new Date(),
          status: "new",
          text: "Nice",
          rating: 5,
          raw: {},
        },
      })
    ).id
  })
  afterAll(async () => prisma?.$disconnect())

  const detail = async () =>
    (await (await app().request(`/api/items/${itemId}`)).json()) as ItemDetail
  const regenerate = () => app().request(`/api/items/${itemId}/drafts`, { method: "POST" })

  it("explains why AI isn't available and refuses to draft", async () => {
    expect((await detail()).ai).toEqual({
      allowed: true,
      available: false,
      message: "AI drafts are off (Settings → AI replies).",
    })
    await setAi({ enabled: true })
    expect((await detail()).ai.message).toMatch(/Add a Claude \(Anthropic\) API key/)
    const res = await regenerate()
    expect(res.status).toBe(409)
    expect(drafts).toHaveLength(0)
  })

  it("regenerates on request, even when a rule turned drafts off", async () => {
    await setAi(readyAi())
    await prisma!.item.update({ where: { id: itemId }, data: { aiDraftsAllowed: false } })
    expect((await detail()).ai).toEqual({ allowed: true, available: true, message: null })
    expect((await regenerate()).status).toBe(202)
    expect(drafts).toEqual([expect.objectContaining({ itemId, force: true })])
    expect((await prisma!.item.findUniqueOrThrow({ where: { id: itemId } })).aiDraftsAllowed).toBe(
      true,
    )
  })

  it("drafts when the item is opened only with 'when someone opens it'", async () => {
    await setAi(readyAi())
    await detail()
    expect(drafts).toHaveLength(0) // default: on arrival (the worker does it)
    await setAi(readyAi({ generateOn: "open" }))
    await detail()
    expect(drafts).toEqual([expect.objectContaining({ itemId })])
    expect(drafts[0]!.force).toBeUndefined()
  })

  it("key test validates input before calling a provider", async () => {
    const post = (body: unknown) =>
      app().request("/api/settings/ai/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    expect((await post({ provider: "anthropic", model: "" })).status).toBe(400)
    const noKey = await post({ provider: "openai", model: "gpt-x" })
    expect(noKey.status).toBe(400)
    expect(((await noKey.json()) as { error: string }).error).toBe("Add an API key first")
  })
})
