/**
 * Scheduler DB logic against a real database (TEST_DATABASE_URL): leasing, backoff, account
 * health, retention and the token expiry check.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { MAX_BACKOFF_SECONDS } from "@inbox/core"
import { createPrismaClient } from "@inbox/db"
import { applyRetention, checkTokenExpiry } from "./maintenance"
import {
  applySyncSettings,
  claimDueSyncStates,
  claimSyncState,
  ensureSyncStates,
  recordPollResult,
} from "./sync"
import { parseSectionValues } from "@inbox/core"

const url = process.env.TEST_DATABASE_URL
const prisma = url ? createPrismaClient(url) : null
const ORG = "sync-org"
const MIN = 60_000
const DAY = 24 * 60 * MIN

async function seed() {
  await prisma!.organization.create({
    data: { id: ORG, name: "Sync", slug: "sync", createdAt: new Date() },
  })
  await prisma!.platformAccount.createMany({
    data: [
      {
        organizationId: ORG,
        platform: "youtube",
        kind: "yt_channel",
        externalId: "UC-1",
        displayName: "YT",
      },
      {
        organizationId: ORG,
        platform: "facebook",
        kind: "fb_page",
        externalId: "fb-1",
        displayName: "FB",
      },
    ],
  })
}

const yt = () =>
  prisma!.syncState.findFirstOrThrow({
    where: { organizationId: ORG, platformAccount: { platform: "youtube" } },
    include: { platformAccount: true },
  })

describe.skipIf(!url)("scheduler + maintenance (integration)", () => {
  beforeEach(async () => {
    await prisma!.$executeRawUnsafe(
      'TRUNCATE "sync_state", "platform_account", "item", "webhook_event", "audit_log", "settings", "organization" CASCADE',
    )
    await seed()
  })
  afterAll(async () => prisma?.$disconnect())

  it("creates one schedule per stream, due now, and is idempotent", async () => {
    expect(await ensureSyncStates(prisma!, ORG)).toBe(3) // yt comments, fb comments + dms
    expect(await ensureSyncStates(prisma!, ORG)).toBe(0)
    const state = await yt()
    expect(state.intervalSeconds).toBe(5 * 60)
    expect(state.mode).toBe("polling")
  })

  it("leases due rows once and skips leased, future, paused and webhook-only rows", async () => {
    await ensureSyncStates(prisma!, ORG)
    const claimed = await claimDueSyncStates(prisma!)
    expect(claimed).toHaveLength(3)
    expect(await claimDueSyncStates(prisma!)).toHaveLength(0) // leased

    await prisma!.syncState.updateMany({ data: { lockedUntil: null } })
    await prisma!.syncState.updateMany({
      where: { stream: "dms" },
      data: { mode: "webhook" },
    })
    expect((await claimDueSyncStates(prisma!)).map((c) => c.id)).toHaveLength(2)

    await prisma!.syncState.updateMany({ data: { lockedUntil: null } })
    await prisma!.settings.create({ data: { organizationId: ORG, sync: { paused: true } } })
    expect(await claimDueSyncStates(prisma!)).toHaveLength(0)
  })

  it("compares times in UTC whatever the session time zone (regression)", async () => {
    await ensureSyncStates(prisma!, ORG)
    // One minute in the future: not due. With a session zone ahead of UTC (e.g. +05:30) a
    // plain `now()` comparison treated it as hours overdue.
    await prisma!.syncState.updateMany({ data: { nextRunAt: new Date(Date.now() + MIN) } })
    await prisma!.$executeRawUnsafe(`SET TIME ZONE 'Asia/Kolkata'`)
    try {
      expect(await claimDueSyncStates(prisma!)).toHaveLength(0)
      await prisma!.syncState.updateMany({ data: { nextRunAt: new Date(Date.now() - MIN) } })
      const before = Date.now()
      expect(await claimDueSyncStates(prisma!)).toHaveLength(3)
      // The lease ends ~5 minutes from now in UTC, not 5.5 hours off.
      const lease = (await yt()).lockedUntil!.getTime()
      expect(lease).toBeGreaterThan(before + 4 * MIN)
      expect(lease).toBeLessThan(before + 6 * MIN)
    } finally {
      await prisma!.$executeRawUnsafe(`SET TIME ZONE 'UTC'`)
    }
  })

  it("manual claim fails while a lease is held", async () => {
    await ensureSyncStates(prisma!, ORG)
    const { id } = await yt()
    expect(await claimSyncState(prisma!, id)).toBe(true)
    expect(await claimSyncState(prisma!, id)).toBe(false)
  })

  it("success schedules the next run one interval later and clears the lease", async () => {
    await ensureSyncStates(prisma!, ORG)
    const { id } = await yt()
    await claimSyncState(prisma!, id)
    const now = new Date()
    await recordPollResult(prisma!, id, { ok: true, cursor: "c1", quotaUnits: 2 }, now)
    const s = await yt()
    expect(s.lockedUntil).toBeNull()
    expect(s.nextRunAt.getTime()).toBe(now.getTime() + 5 * MIN)
    expect(s.cursor).toBe("c1")
    expect(s.quotaUsedToday).toBe(2)
    expect(s.lastSuccessAt?.getTime()).toBe(now.getTime())
  })

  it("backs off exponentially, flags the account after 3 failures, and recovers", async () => {
    await ensureSyncStates(prisma!, ORG)
    const { id } = await yt()
    const now = new Date()
    for (const [n, expectedMin] of [
      [1, 10],
      [2, 20],
    ] as const) {
      await recordPollResult(prisma!, id, { ok: false, error: "HTTP 500" }, now)
      const s = await yt()
      expect(s.consecutiveFailures).toBe(n)
      expect(s.nextRunAt.getTime()).toBe(now.getTime() + expectedMin * MIN)
      expect(s.platformAccount.status).toBe("connected")
    }
    await recordPollResult(prisma!, id, { ok: false, error: "HTTP 500" }, now)
    let s = await yt()
    expect(s.platformAccount.status).toBe("error")
    expect(s.platformAccount.lastError).toMatch(/3 times/)
    expect(s.lastError).toBe("HTTP 500")

    // Capped at 6 h.
    await prisma!.syncState.update({ where: { id }, data: { consecutiveFailures: 20 } })
    await recordPollResult(prisma!, id, { ok: false, error: "x" }, now)
    expect((await yt()).nextRunAt.getTime()).toBe(now.getTime() + MAX_BACKOFF_SECONDS * 1000)

    await recordPollResult(prisma!, id, { ok: true }, now)
    s = await yt()
    expect(s.consecutiveFailures).toBe(0)
    expect(s.lastError).toBeNull()
    expect(s.platformAccount.status).toBe("connected")
  })

  it("applySyncSettings recomputes nextRunAt from the last run and reports changes", async () => {
    await ensureSyncStates(prisma!, ORG)
    const { id } = await yt()
    const lastRunAt = new Date(Date.now() - 3 * MIN)
    await prisma!.syncState.update({ where: { id }, data: { lastRunAt } })
    const sync = parseSectionValues("sync", {})
    expect(await applySyncSettings(prisma!, ORG, sync)).toEqual([]) // nothing changed
    sync.streams.yt_comments.intervalMinutes = 2
    expect(await applySyncSettings(prisma!, ORG, sync)).toEqual([id])
    // Already overdue under the new interval: due at the next tick.
    expect((await yt()).nextRunAt.getTime()).toBe(lastRunAt.getTime() + 2 * MIN)
  })

  it("retention deletes old filtered items, processed webhooks and audit entries only", async () => {
    const now = new Date()
    const old = new Date(now.getTime() - 400 * DAY)
    await prisma!.settings.create({
      data: {
        organizationId: ORG,
        data: { filteredRetentionDays: 90, webhookRetentionDays: 30, auditRetentionDays: 365 },
      },
    })
    const account = await prisma!.platformAccount.findFirstOrThrow({
      where: { organizationId: ORG },
    })
    const item = (externalId: string, status: "filtered" | "new", manualOverride = false) => ({
      organizationId: ORG,
      platform: account.platform,
      platformAccountId: account.id,
      type: "comment" as const,
      externalId,
      eventKind: "created",
      receivedAt: old,
      status,
      manualOverride,
      raw: {},
    })
    await prisma!.item.createMany({
      data: [item("a", "filtered"), item("b", "new"), item("c", "filtered", true)],
    })
    await prisma!.webhookEvent.createMany({
      data: [
        {
          organizationId: ORG,
          source: "meta",
          payload: {},
          signatureValid: true,
          receivedAt: old,
          processedAt: old,
        },
        { organizationId: ORG, source: "meta", payload: {}, signatureValid: true, receivedAt: old },
      ],
    })
    await prisma!.auditLog.createMany({
      data: [
        { organizationId: ORG, action: "x", entity: "x", createdAt: old },
        { organizationId: ORG, action: "y", entity: "y", createdAt: now },
      ],
    })

    expect(await applyRetention(prisma!, ORG, now)).toEqual({
      filteredItems: 1,
      webhookEvents: 1,
      auditEntries: 1,
    })
    expect(
      (await prisma!.item.findMany({ select: { externalId: true } }))
        .map((i) => i.externalId)
        .sort(),
    ).toEqual(["b", "c"])

    // 0 = keep filtered items forever.
    await prisma!.settings.update({
      where: { organizationId: ORG },
      data: { data: { filteredRetentionDays: 0 } },
    })
    await prisma!.item.create({ data: item("d", "filtered") })
    expect((await applyRetention(prisma!, ORG, now)).filteredItems).toBe(0)
  })

  it("token check marks expiring and expired connections", async () => {
    const now = new Date()
    const [ytAcc, fbAcc] = await Promise.all([
      prisma!.platformAccount.findFirstOrThrow({ where: { platform: "youtube" } }),
      prisma!.platformAccount.findFirstOrThrow({ where: { platform: "facebook" } }),
    ])
    await prisma!.platformAccount.update({
      where: { id: ytAcc.id },
      data: { tokenExpiresAt: new Date(now.getTime() + 2 * DAY) },
    })
    await prisma!.platformAccount.update({
      where: { id: fbAcc.id },
      data: { tokenExpiresAt: new Date(now.getTime() - MIN) },
    })
    expect(await checkTokenExpiry(prisma!, ORG, now)).toEqual({
      expiring: [ytAcc.id],
      expired: [fbAcc.id],
    })
    const after = await prisma!.platformAccount.findMany({ orderBy: { platform: "asc" } })
    expect(after.map((a) => [a.platform, a.status])).toEqual([
      ["facebook", "error"],
      ["youtube", "expiring"],
    ])
    // Idempotent.
    expect(await checkTokenExpiry(prisma!, ORG, now)).toEqual({ expiring: [], expired: [] })
  })
})
