/**
 * Periodic per-organization jobs: data retention (Settings → Data) and the token expiry
 * check (Settings → Notifications → warning days). Both are idempotent.
 */
import { parseSectionValues } from "@inbox/core"
import type { PrismaClient } from "@inbox/db"

const DAY_MS = 24 * 60 * 60 * 1000

export interface RetentionResult {
  filteredItems: number
  webhookEvents: number
  auditEntries: number
}

/**
 * Deletes data older than the retention windows in Settings → Data:
 * - items in `filtered` (rule-archived, never touched by a person), when retention > 0
 * - processed webhook deliveries (unprocessed ones are kept so they can still be replayed)
 * - audit entries
 */
export async function applyRetention(
  prisma: PrismaClient,
  organizationId: string,
  now: Date = new Date(),
): Promise<RetentionResult> {
  const row = await prisma.settings.findUnique({
    where: { organizationId },
    select: { data: true },
  })
  const data = parseSectionValues("data", row?.data)
  const before = (days: number) => new Date(now.getTime() - days * DAY_MS)

  const filteredItems =
    data.filteredRetentionDays > 0
      ? (
          await prisma.item.deleteMany({
            where: {
              organizationId,
              status: "filtered",
              manualOverride: false,
              receivedAt: { lt: before(data.filteredRetentionDays) },
            },
          })
        ).count
      : 0
  const webhookEvents = (
    await prisma.webhookEvent.deleteMany({
      where: {
        organizationId,
        processedAt: { not: null },
        receivedAt: { lt: before(data.webhookRetentionDays) },
      },
    })
  ).count
  const auditEntries = (
    await prisma.auditLog.deleteMany({
      where: { organizationId, createdAt: { lt: before(data.auditRetentionDays) } },
    })
  ).count

  return { filteredItems, webhookEvents, auditEntries }
}

export interface TokenCheckResult {
  /** Accounts newly marked `expiring`. */
  expiring: string[]
  /** Accounts newly marked `error` because their token has expired. */
  expired: string[]
}

/**
 * Marks connected accounts whose token expires within the warning window as `expiring`, and
 * accounts whose token has already expired as `error`. Platforms with refresh tokens renew
 * them in their own phase (a renewed token moves the account back to `connected`).
 */
export async function checkTokenExpiry(
  prisma: PrismaClient,
  organizationId: string,
  now: Date = new Date(),
): Promise<TokenCheckResult> {
  const row = await prisma.settings.findUnique({
    where: { organizationId },
    select: { notifications: true },
  })
  const { tokenExpiryWarningDays } = parseSectionValues("notifications", row?.notifications)
  const warnBefore = new Date(now.getTime() + tokenExpiryWarningDays * DAY_MS)

  const accounts = await prisma.platformAccount.findMany({
    where: {
      organizationId,
      status: { in: ["connected", "expiring"] },
      tokenExpiresAt: { not: null, lt: warnBefore },
    },
    select: { id: true, status: true, tokenExpiresAt: true },
  })
  const expiring: string[] = []
  const expired: string[] = []
  for (const a of accounts) {
    if (a.tokenExpiresAt! <= now) {
      await prisma.platformAccount.update({
        where: { id: a.id },
        data: {
          status: "error",
          lastError: "The access token expired. Reconnect this account.",
          lastErrorAt: now,
        },
      })
      expired.push(a.id)
    } else if (a.status === "connected") {
      await prisma.platformAccount.update({ where: { id: a.id }, data: { status: "expiring" } })
      expiring.push(a.id)
    }
  }
  return { expiring, expired }
}
