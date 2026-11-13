import type { PgBoss } from "pg-boss"
import type { NormalizedItem } from "@inbox/core"
import type { Logger } from "@inbox/core/logger"
import type { PrismaClient } from "@inbox/db"
import { ingestNormalizedItem, loadFilterSetup, notifyInbox } from "@inbox/pipeline"
import { enqueueDraftsOnArrival } from "./ai-draft"

/**
 * Stores fetched or pushed items for one account: filter → store → NOTIFY → drafts on arrival.
 * Shared by polls (reconcile) and webhook handlers, so both paths behave the same.
 */
export async function ingestItems(
  deps: { boss: PgBoss; prisma: PrismaClient; logger?: Logger },
  args: { organizationId: string; platformAccountId: string; items: NormalizedItem[] },
): Promise<{ created: number; updated: number; dropped: number; duplicates: number }> {
  const out = { created: 0, updated: 0, dropped: 0, duplicates: 0 }
  if (args.items.length === 0) return out
  const { prisma } = deps
  const setup = await loadFilterSetup(prisma, args.organizationId, deps.logger)
  const changed: string[] = []
  const createdIds: string[] = []
  for (const item of args.items) {
    const res = await ingestNormalizedItem(prisma, {
      organizationId: args.organizationId,
      platformAccountId: args.platformAccountId,
      item,
      setup,
      logger: deps.logger,
    })
    if (res.outcome === "created") {
      out.created++
      changed.push(res.itemId)
      createdIds.push(res.itemId)
    } else if (res.outcome === "updated") {
      out.updated++
      changed.push(res.itemId)
    } else if (res.outcome === "dropped") out.dropped++
    else out.duplicates++
  }
  if (changed.length) {
    await notifyInbox(prisma, {
      type: "items.changed",
      organizationId: args.organizationId,
      itemIds: changed,
      reason: "synced",
    })
  }
  await enqueueDraftsOnArrival(deps.boss, prisma, args.organizationId, createdIds)
  return out
}
