import { evaluate } from "@inbox/core"
import type { Logger } from "@inbox/core/logger"
import type { PrismaClient } from "@inbox/db"
import { loadFilterSetup } from "./context"
import { writeRuleMatches } from "./ingest"
import { filterColumns, itemToFilterInput, statusForDecision } from "./mapping"

export interface RefilterResult {
  examined: number
  changed: number
  changedIds: string[]
}

const BATCH = 500

/**
 * Re-runs the current rules over stored items after a rule or list change, so the inbox
 * reflects the edit. Only touches items still in the automatic flow: status new/filtered and
 * no manual override. Replied, resolved, ignored, pending and failed items are left alone.
 */
export async function refilterOrganization(
  prisma: PrismaClient,
  organizationId: string,
  logger?: Logger,
): Promise<RefilterResult> {
  const setup = await loadFilterSetup(prisma, organizationId, logger)
  let cursor: string | undefined
  let examined = 0
  const changedIds: string[] = []

  for (;;) {
    const items = await prisma.item.findMany({
      where: { organizationId, status: { in: ["new", "filtered"] }, manualOverride: false },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    })
    if (items.length === 0) break
    cursor = items[items.length - 1]!.id

    for (const item of items) {
      examined++
      const result = evaluate(itemToFilterInput(item), setup.rules, setup.context)
      const next = { status: statusForDecision(result), ...filterColumns(result) }
      const unchanged =
        item.status === next.status &&
        item.priority === next.priority &&
        sameArray(item.tags, next.tags) &&
        sameArray(item.matchedRuleIds, next.matchedRuleIds) &&
        sameArray(item.dryRunRuleIds, next.dryRunRuleIds) &&
        item.filterReason === next.filterReason &&
        item.aiDraftsAllowed === next.aiDraftsAllowed &&
        item.requireApproval === next.requireApproval &&
        item.skipSlack === next.skipSlack &&
        item.slackChannelId === next.slackChannelId
      if (unchanged) continue

      await prisma.$transaction(async (tx) => {
        await tx.item.update({
          where: { id: item.id },
          data: { ...next, lastFilteredAt: setup.context.now },
        })
        await writeRuleMatches(tx, organizationId, item.id, item.receivedAt, result)
      })
      changedIds.push(item.id)
    }
  }

  logger?.info({ organizationId, examined, changed: changedIds.length }, "refilter: done")
  return { examined, changed: changedIds.length, changedIds }
}

function sameArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}
