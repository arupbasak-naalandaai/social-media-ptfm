/**
 * DB side of the scheduler (PLAN §12): creating SyncState rows, applying interval changes,
 * leasing due rows, and recording poll results with backoff.
 */
import {
  ACCOUNT_ERROR_AFTER_FAILURES,
  SYNC_LEASE_SECONDS,
  SYNC_STREAMS,
  computeNextRunAt,
  parseSectionValues,
  streamsForKind,
  syncStreamKeyFor,
  youtubeQuotaDay,
  type SyncSettings,
} from "@inbox/core"
import type { Prisma, PrismaClient } from "@inbox/db"

type Tx = Prisma.TransactionClient | PrismaClient

/**
 * Creates the missing SyncState rows for an organization's accounts (one per stream the
 * account kind syncs), using the Sync settings. New rows are due immediately.
 */
export async function ensureSyncStates(
  prisma: Tx,
  organizationId: string,
  now: Date = new Date(),
): Promise<number> {
  const settings = await prisma.settings.findUnique({
    where: { organizationId },
    select: { sync: true },
  })
  const sync = parseSectionValues("sync", settings?.sync)
  const accounts = await prisma.platformAccount.findMany({
    where: { organizationId },
    select: { id: true, kind: true },
  })
  const data = accounts.flatMap((a) =>
    streamsForKind(a.kind).map((key) => {
      const def = SYNC_STREAMS[key]
      const conf = sync.streams[key]
      return {
        organizationId,
        platformAccountId: a.id,
        stream: def.stream,
        mode: conf.mode,
        intervalSeconds: conf.intervalMinutes * 60,
        backfillDays: sync.backfillDays,
        nextRunAt: now,
      }
    }),
  )
  if (data.length === 0) return 0
  const result = await prisma.syncState.createMany({ data, skipDuplicates: true })
  return result.count
}

/**
 * Applies new Sync settings to every SyncState of the organization: mode, interval and
 * backfill, and recomputes `nextRunAt` from the last run so a new interval takes effect at
 * the next scheduler tick. Run it in the same transaction as the settings write.
 *
 * @returns ids of the rows whose schedule changed.
 */
export async function applySyncSettings(
  tx: Tx,
  organizationId: string,
  sync: SyncSettings,
  now: Date = new Date(),
): Promise<string[]> {
  const states = await tx.syncState.findMany({
    where: { organizationId },
    select: {
      id: true,
      stream: true,
      mode: true,
      intervalSeconds: true,
      lastRunAt: true,
      nextRunAt: true,
      consecutiveFailures: true,
      backfillDays: true,
      platformAccount: { select: { platform: true } },
    },
  })
  const changed: string[] = []
  for (const s of states) {
    const key = syncStreamKeyFor(s.platformAccount.platform, s.stream)
    if (!key) continue
    const conf = sync.streams[key]
    const intervalSeconds = conf.intervalMinutes * 60
    if (
      s.mode === conf.mode &&
      s.intervalSeconds === intervalSeconds &&
      s.backfillDays === sync.backfillDays
    ) {
      continue
    }
    const nextRunAt = computeNextRunAt({
      lastRunAt: s.lastRunAt,
      now,
      intervalSeconds,
      failures: s.consecutiveFailures,
    })
    await tx.syncState.update({
      where: { id: s.id },
      data: { mode: conf.mode, intervalSeconds, backfillDays: sync.backfillDays, nextRunAt },
    })
    if (nextRunAt.getTime() !== s.nextRunAt.getTime() || s.mode !== conf.mode) changed.push(s.id)
  }
  return changed
}

/**
 * SQL condition for "the scheduler may run this row": not webhook-only, account included and
 * usable (seeded demo accounts count, so the scheduler can be watched locally), and the
 * workspace hasn't paused syncing. `st` = sync_state, `pa` = platform_account, `se` = settings.
 */
const SCHEDULABLE = `
  st."mode" <> 'webhook'
  AND pa."included"
  AND (pa."status" <> 'disconnected' OR COALESCE((pa."meta"->>'demo')::boolean, false))
  AND COALESCE((se."sync"->>'paused')::boolean, false) = false`

/**
 * Prisma stores DateTime as `timestamp` (no zone) holding UTC wall time, but `now()` is in the
 * session time zone (e.g. Asia/Kolkata locally). Compare and write in UTC, or rows look due
 * hours early and leases come out wrong.
 */
const UTC_NOW = `(now() AT TIME ZONE 'UTC')`

export interface ClaimedSyncState {
  id: string
  organizationId: string
}

/**
 * Leases due rows (`nextRunAt <= now`, not already leased) for `SYNC_LEASE_SECONDS`.
 * `FOR UPDATE SKIP LOCKED` makes concurrent schedulers (several worker replicas) safe.
 */
export async function claimDueSyncStates(
  prisma: Pick<PrismaClient, "$queryRawUnsafe">,
  limit = 50,
): Promise<ClaimedSyncState[]> {
  return prisma.$queryRawUnsafe<ClaimedSyncState[]>(
    `UPDATE "sync_state" SET "lockedUntil" = ${UTC_NOW} + make_interval(secs => $1::int)
     WHERE "id" IN (
       SELECT st."id" FROM "sync_state" st
       JOIN "platform_account" pa ON pa."id" = st."platformAccountId"
       LEFT JOIN "settings" se ON se."organizationId" = st."organizationId"
       WHERE st."nextRunAt" <= ${UTC_NOW}
         AND (st."lockedUntil" IS NULL OR st."lockedUntil" < ${UTC_NOW})
         AND ${SCHEDULABLE}
       ORDER BY st."nextRunAt"
       FOR UPDATE OF st SKIP LOCKED
       LIMIT $2::int)
     RETURNING "id", "organizationId"`,
    SYNC_LEASE_SECONDS,
    limit,
  )
}

/** Leases one row for a manual "Run now". Returns false when a poll already holds it. */
export async function claimSyncState(
  prisma: Pick<PrismaClient, "$executeRawUnsafe">,
  id: string,
): Promise<boolean> {
  const count = await prisma.$executeRawUnsafe(
    `UPDATE "sync_state" SET "lockedUntil" = ${UTC_NOW} + make_interval(secs => $2::int)
     WHERE "id" = $1 AND ("lockedUntil" IS NULL OR "lockedUntil" < ${UTC_NOW})`,
    id,
    SYNC_LEASE_SECONDS,
  )
  return count > 0
}

/** Whether the scheduler would pick this row up (mirrors the SQL condition above). */
export function isSchedulable(input: {
  mode: string
  included: boolean
  status: string
  demo: boolean
  paused: boolean
}): boolean {
  return (
    input.mode !== "webhook" &&
    input.included &&
    (input.status !== "disconnected" || input.demo) &&
    !input.paused
  )
}

export type PollOutcome =
  | { ok: true; cursor?: string | null | undefined; quotaUnits?: number | undefined }
  | { ok: false; error: string; quotaUnits?: number | undefined }

/**
 * Records a poll result: clears the lease, resets or increments failures, schedules the next
 * run (with backoff), counts YouTube quota for the Pacific day, and flips the account to
 * `error` after repeated failures (and back to `connected` after a success).
 */
export async function recordPollResult(
  prisma: PrismaClient,
  syncStateId: string,
  outcome: PollOutcome,
  now: Date = new Date(),
): Promise<void> {
  const state = await prisma.syncState.findUnique({
    where: { id: syncStateId },
    select: {
      intervalSeconds: true,
      consecutiveFailures: true,
      quotaUsedToday: true,
      quotaDay: true,
      platformAccountId: true,
      platformAccount: { select: { status: true } },
    },
  })
  if (!state) return

  const today = youtubeQuotaDay(now)
  const sameDay = state.quotaDay?.toISOString().slice(0, 10) === today
  const quotaUsedToday = (sameDay ? state.quotaUsedToday : 0) + (outcome.quotaUnits ?? 0)
  const failures = outcome.ok ? 0 : state.consecutiveFailures + 1
  const nextRunAt = computeNextRunAt({
    lastRunAt: now,
    now,
    intervalSeconds: state.intervalSeconds,
    failures,
  })

  await prisma.$transaction(async (tx) => {
    await tx.syncState.update({
      where: { id: syncStateId },
      data: {
        lockedUntil: null,
        lastRunAt: now,
        nextRunAt,
        consecutiveFailures: failures,
        quotaUsedToday,
        quotaDay: new Date(`${today}T00:00:00Z`),
        ...(outcome.ok
          ? {
              lastSuccessAt: now,
              lastError: null,
              ...(outcome.cursor !== undefined ? { cursor: outcome.cursor } : {}),
            }
          : { lastError: outcome.error.slice(0, 1000) }),
      },
    })

    const accountStatus = state.platformAccount.status
    if (!outcome.ok && failures >= ACCOUNT_ERROR_AFTER_FAILURES && accountStatus !== "error") {
      if (accountStatus === "connected" || accountStatus === "expiring") {
        await tx.platformAccount.update({
          where: { id: state.platformAccountId },
          data: {
            status: "error",
            lastError: `Sync failed ${failures} times in a row: ${outcome.error}`.slice(0, 1000),
            lastErrorAt: now,
          },
        })
      }
    }
    if (outcome.ok && accountStatus === "error") {
      // Recover only when no other stream of this account is still failing.
      const failing = await tx.syncState.count({
        where: {
          platformAccountId: state.platformAccountId,
          consecutiveFailures: { gte: ACCOUNT_ERROR_AFTER_FAILURES },
        },
      })
      if (failing === 0) {
        await tx.platformAccount.update({
          where: { id: state.platformAccountId },
          data: { status: "connected", lastError: null },
        })
      }
    }
  })
}
