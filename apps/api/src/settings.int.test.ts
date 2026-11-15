/**
 * Settings, sync controls and the Activity log against a real database (TEST_DATABASE_URL).
 * The Phase 3 acceptance check lives here: changing an interval moves `nextRunAt` at once.
 */
import { effectivePermissions } from "@inbox/core"
import { randomBytes } from "node:crypto"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import type {
  AuditEntryDto,
  Paged,
  PollJobData,
  IngestJobData,
  Role,
  SettingsResponse,
  SettingsUpdateResponse,
  SyncListResponse,
  WebhookEventDto,
} from "@inbox/core"
import { createKeyring } from "@inbox/core/crypto"
import { createLogger } from "@inbox/core/logger"
import { createPrismaClient } from "@inbox/db"
import { ensureSyncStates, loadSettingsSecret } from "@inbox/pipeline"
import { createApp } from "./app"
import type { JobSender } from "./lib/jobs"

const url = process.env.TEST_DATABASE_URL
const prisma = url ? createPrismaClient(url) : null
const logger = createLogger("test", { level: "silent", transport: undefined })
const keyring = createKeyring(randomBytes(32).toString("base64"))
const ORG = "settings-org"
const USER = "u-settings"

const polls: PollJobData[] = []
const ingests: IngestJobData[] = []
const jobs: JobSender = {
  enqueueRefilter: async () => {},
  enqueuePoll: async (d) => void polls.push(d),
  enqueueIngest: async (d) => void ingests.push(d),
  enqueueAiDraft: async () => {},
  enqueueSendReply: async () => {},
  stop: async () => {},
}

function app(role: Role = "owner") {
  return createApp({
    auth: {
      handler: async () => new Response(null, { status: 404 }),
      getSession: async () => ({
        user: { id: USER, email: "owner@example.com", name: "Owner" },
        session: { id: "s-settings", activeOrganizationId: ORG },
      }),
    },
    orgs: {
      resolve: async () => ({
        id: ORG,
        name: "Settings Org",
        role,
        permissions: effectivePermissions(role, null),
      }),
    },
    logger,
    checkDb: async () => true,
    prisma: prisma!,
    jobs,
    keyring,
    urls: { apiPublicUrl: "https://api.example.com", webUrl: "https://app.example.com" },
  })
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

function put(section: string, body: unknown, role: Role = "owner") {
  return app(role).request(`/api/settings/${section}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function getSettings(): Promise<SettingsResponse> {
  return json<SettingsResponse>(await app().request("/api/settings"))
}

async function seed() {
  await prisma!.organization.create({
    data: { id: ORG, name: "Settings Org", slug: "settings-org", createdAt: new Date() },
  })
  await prisma!.user.create({
    data: { id: USER, email: "owner@example.com", name: "Owner", emailVerified: true },
  })
  await prisma!.platformAccount.createMany({
    data: [
      {
        organizationId: ORG,
        platform: "youtube",
        kind: "yt_channel",
        externalId: "UC-1",
        displayName: "Channel",
        meta: { demo: true },
      },
      {
        organizationId: ORG,
        platform: "google_business",
        kind: "gbp_location",
        externalId: "locations/1",
        displayName: "Location",
      },
    ],
  })
  await ensureSyncStates(prisma!, ORG)
}

const ytState = () =>
  prisma!.syncState.findFirstOrThrow({
    where: { organizationId: ORG, platformAccount: { platform: "youtube" } },
  })

describe.skipIf(!url)("settings + sync + activity API (integration)", () => {
  beforeEach(async () => {
    polls.length = 0
    ingests.length = 0
    await prisma!.$executeRawUnsafe(
      'TRUNCATE "sync_state", "platform_account", "webhook_event", "audit_log", "settings", "member", "organization", "user" CASCADE',
    )
    await seed()
  })
  afterAll(async () => prisma?.$disconnect())

  it("returns all 9 sections with defaults, secrets as status only, and public URLs", async () => {
    const s = await getSettings()
    expect(Object.keys(s.sections)).toEqual([
      "general",
      "connections",
      "sync",
      "filters",
      "ai",
      "replies",
      "slack",
      "notifications",
      "data",
    ])
    expect(s.version).toBe(1)
    expect(s.sections.sync.values.streams.yt_comments.intervalMinutes).toBe(5)
    expect(s.sections.ai.secrets.anthropicApiKey).toEqual({ set: false, last4: null })
    expect(s.meta.webhookUrls.meta).toBe("https://api.example.com/webhooks/meta")
    expect(s.meta.youtubeChannels).toBe(1)
  })

  it("acceptance: changing an interval changes nextRunAt immediately", async () => {
    const lastRunAt = new Date(Date.now() - 2 * 60_000)
    const before = await ytState()
    await prisma!.syncState.update({
      where: { id: before.id },
      data: { lastRunAt, nextRunAt: new Date(lastRunAt.getTime() + 5 * 60_000) },
    })

    const s = await getSettings()
    const values = structuredClone(s.sections.sync.values)
    values.streams.yt_comments.intervalMinutes = 15
    const res = await put("sync", { version: s.version, values })
    expect(res.status).toBe(200)
    const body = await json<SettingsUpdateResponse<"sync">>(res)
    expect(body.version).toBe(2)
    expect(body.rescheduled).toBe(1)

    const after = await ytState()
    expect(after.intervalSeconds).toBe(15 * 60)
    expect(after.nextRunAt.getTime()).toBe(lastRunAt.getTime() + 15 * 60_000)

    // The sync status endpoint reflects it too.
    const sync = await json<SyncListResponse>(await app().request("/api/sync"))
    const yt = sync.states.find((st) => st.stream === "yt_comments")!
    expect(yt.intervalSeconds).toBe(900)
    expect(yt.nextRunAt).toBe(after.nextRunAt.toISOString())

    const audit = await prisma!.auditLog.findFirstOrThrow({ where: { action: "settings.update" } })
    expect(audit.entityId).toBe("sync")
    expect(audit.after).toMatchObject({ rescheduled: 1 })
  })

  it("rejects intervals below the minimum and webhook mode for YouTube", async () => {
    const s = await getSettings()
    const values = structuredClone(s.sections.sync.values)
    values.streams.gbp_reviews.intervalMinutes = 1
    const res = await put("sync", { version: s.version, values })
    expect(res.status).toBe(400)
    const err = await json<{ issues: { path: string }[] }>(res)
    expect(err.issues[0]!.path).toContain("gbp_reviews")

    const values2 = structuredClone(s.sections.sync.values) as unknown as {
      streams: { yt_comments: { mode: string } }
    }
    values2.streams.yt_comments.mode = "webhook"
    expect((await put("sync", { version: s.version, values: values2 })).status).toBe(400)
  })

  it("blocks YouTube polling that would use more than 90% of the daily quota", async () => {
    const s = await getSettings()
    const values = structuredClone(s.sections.sync.values)
    values.streams.yt_comments.intervalMinutes = 1
    values.youtube.dailyQuota = 1000
    values.youtube.pagesPerPoll = 1
    // 1440 polls/day × 1 channel = 1440 units > 900.
    const res = await put("sync", { version: s.version, values })
    expect(res.status).toBe(400)
    expect((await json<{ error: string }>(res)).error).toMatch(/quota/)
  })

  it("409s on a stale version", async () => {
    const s = await getSettings()
    const values = { ...s.sections.replies.values, undoSeconds: 10 }
    expect((await put("replies", { version: s.version, values })).status).toBe(200)
    const stale = await put("replies", {
      version: s.version,
      values: { ...values, undoSeconds: 3 },
    })
    expect(stale.status).toBe(409)
    expect((await getSettings()).sections.replies.values.undoSeconds).toBe(10)
  })

  it("encrypts secrets, returns only last4, keeps them on unrelated saves, and clears them", async () => {
    const key = "sk-ant-test-1234567890abcd"
    let s = await getSettings()
    let res = await put("ai", {
      version: s.version,
      values: s.sections.ai.values,
      secrets: { anthropicApiKey: key },
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain(key)
    expect(text).not.toContain("v1:")
    expect(JSON.parse(text).section.secrets.anthropicApiKey).toEqual({ set: true, last4: "abcd" })

    const row = await prisma!.settings.findUniqueOrThrow({ where: { organizationId: ORG } })
    expect(JSON.stringify(row.ai)).not.toContain(key)
    expect(await loadSettingsSecret(prisma!, keyring, ORG, "ai", "anthropicApiKey")).toBe(key)

    // A save without `secrets` keeps the stored one.
    s = await getSettings()
    res = await put("ai", {
      version: s.version,
      values: { ...s.sections.ai.values, enabled: true },
    })
    expect(
      (await json<SettingsUpdateResponse<"ai">>(res)).section.secrets.anthropicApiKey.set,
    ).toBe(true)

    // The audit log records that it changed, never the value.
    const audits = await prisma!.auditLog.findMany({ where: { entityId: "ai" } })
    expect(JSON.stringify(audits)).not.toContain(key)
    expect(audits.some((a) => JSON.stringify(a.after).includes('"anthropicApiKey":"set"'))).toBe(
      true,
    )

    s = await getSettings()
    res = await put("ai", {
      version: s.version,
      values: s.sections.ai.values,
      secrets: { anthropicApiKey: null },
    })
    expect((await json<SettingsUpdateResponse<"ai">>(res)).section.secrets.anthropicApiKey).toEqual(
      { set: false, last4: null },
    )
    expect(await loadSettingsSecret(prisma!, keyring, ORG, "ai", "anthropicApiKey")).toBeNull()
  })

  it("renames the organization from the General tab", async () => {
    const s = await getSettings()
    const res = await put("general", {
      version: s.version,
      values: {
        ...s.sections.general.values,
        organizationName: "Renamed",
        timezone: "Asia/Kolkata",
      },
    })
    expect(res.status).toBe(200)
    const org = await prisma!.organization.findUniqueOrThrow({ where: { id: ORG } })
    expect(org.name).toBe("Renamed")
    const bad = await put("general", {
      version: (await getSettings()).version,
      values: { ...s.sections.general.values, timezone: "Mars/Olympus" },
    })
    expect(bad.status).toBe(400)
  })

  it("is admin-only", async () => {
    expect((await app("member").request("/api/settings")).status).toBe(403)
    expect((await put("filters", { version: 1, values: {} }, "member")).status).toBe(403)
  })

  it("pausing sync takes every schedule off the scheduler", async () => {
    const s = await getSettings()
    await put("sync", { version: s.version, values: { ...s.sections.sync.values, paused: true } })
    const sync = await json<SyncListResponse>(await app().request("/api/sync"))
    expect(sync.paused).toBe(true)
    expect(sync.states.every((st) => !st.scheduled)).toBe(true)
    // …and manual runs too.
    const yt = await ytState()
    expect((await app().request(`/api/sync/${yt.id}/run`, { method: "POST" })).status).toBe(409)
    expect(polls).toHaveLength(0)
  })

  it("Run now leases the schedule, queues a poll, and refuses a second run", async () => {
    const yt = await ytState()
    const first = await app().request(`/api/sync/${yt.id}/run`, { method: "POST" })
    expect(first.status).toBe(202)
    expect(polls).toEqual([
      expect.objectContaining({ organizationId: ORG, syncStateId: yt.id, trigger: "manual" }),
    ])
    expect((await ytState()).lockedUntil!.getTime()).toBeGreaterThan(Date.now())

    const second = await app().request(`/api/sync/${yt.id}/run`, { method: "POST" })
    expect(second.status).toBe(409)

    // A real account that isn't connected can't be run.
    const gbp = await prisma!.syncState.findFirstOrThrow({
      where: { organizationId: ORG, platformAccount: { platform: "google_business" } },
    })
    await prisma!.platformAccount.update({
      where: { id: gbp.platformAccountId },
      data: { status: "disconnected" },
    })
    expect((await app().request(`/api/sync/${gbp.id}/run`, { method: "POST" })).status).toBe(409)
    expect((await app("member").request(`/api/sync/${yt.id}/run`, { method: "POST" })).status).toBe(
      403,
    )
  })

  it("Activity: audit log with actors, webhook list, and replay", async () => {
    const s = await getSettings()
    await put("notifications", {
      version: s.version,
      values: { ...s.sections.notifications.values, sound: true },
    })
    const audit = await json<Paged<AuditEntryDto>>(await app().request("/api/activity/audit"))
    expect(audit.entries[0]).toMatchObject({
      action: "settings.update",
      entityId: "notifications",
      actor: { id: USER, name: "Owner" },
      after: { sound: true },
    })

    const good = await prisma!.webhookEvent.create({
      data: {
        organizationId: ORG,
        source: "meta",
        payload: { object: "page" },
        signatureValid: true,
        error: "boom",
      },
    })
    const bad = await prisma!.webhookEvent.create({
      data: { source: "meta", payload: {}, signatureValid: false },
    })
    const hooks = await json<Paged<WebhookEventDto>>(await app().request("/api/activity/webhooks"))
    expect(hooks.entries.map((h) => h.id).sort()).toEqual([good.id, bad.id].sort())
    // Members only see deliveries matched to their organization.
    const memberHooks = await json<Paged<WebhookEventDto>>(
      await app("member").request("/api/activity/webhooks"),
    )
    expect(memberHooks.entries.map((h) => h.id)).toEqual([good.id])

    expect(
      (await app().request(`/api/webhooks/${good.id}/replay`, { method: "POST" })).status,
    ).toBe(202)
    expect(ingests).toEqual([
      expect.objectContaining({ webhookEventId: good.id, replay: true, organizationId: ORG }),
    ])
    expect(
      (await prisma!.webhookEvent.findUniqueOrThrow({ where: { id: good.id } })).error,
    ).toBeNull()
    expect((await app().request(`/api/webhooks/${bad.id}/replay`, { method: "POST" })).status).toBe(
      409,
    )
  })

  it("Activity: paginates the audit log", async () => {
    await prisma!.auditLog.createMany({
      data: Array.from({ length: 5 }, (_, i) => ({
        organizationId: ORG,
        actorId: USER,
        action: `test.${i}`,
        entity: "test",
        createdAt: new Date(Date.now() - i * 1000),
      })),
    })
    const p1 = await json<Paged<AuditEntryDto>>(await app().request("/api/activity/audit?limit=3"))
    expect(p1.entries.map((e) => e.action)).toEqual(["test.0", "test.1", "test.2"])
    expect(p1.nextCursor).toBe("3")
    const p2 = await json<Paged<AuditEntryDto>>(
      await app().request(`/api/activity/audit?limit=3&cursor=${p1.nextCursor}`),
    )
    expect(p2.entries.map((e) => e.action)).toEqual(["test.3", "test.4"])
    expect(p2.nextCursor).toBeNull()
  })
})
