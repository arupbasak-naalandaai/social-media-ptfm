import {
  filterRuleSchema,
  listEntrySchema,
  parseGeneralSettings,
  type FilterContext,
  type FilterRule,
  type ListEntry,
} from "@inbox/core"
import type { Logger } from "@inbox/core/logger"
import type { FilterRule as FilterRuleRow, PrismaClient } from "@inbox/db"

/** Converts a DB row to an engine rule. Returns null (and logs) when the stored JSON is invalid. */
export function ruleFromRow(row: FilterRuleRow, logger?: Logger): FilterRule | null {
  const parsed = filterRuleSchema.safeParse({
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    enabled: row.enabled,
    priority: row.priority,
    stopProcessing: row.stopProcessing,
    platforms: row.platforms,
    itemTypes: row.itemTypes,
    conditions: row.conditions,
    actions: row.actions,
    dryRun: row.dryRun,
  })
  if (!parsed.success) {
    logger?.error(
      { ruleId: row.id, issues: parsed.error.issues },
      "filter rule failed validation; skipped",
    )
    return null
  }
  return parsed.data
}

export async function loadRules(
  prisma: PrismaClient,
  organizationId: string,
  logger?: Logger,
): Promise<FilterRule[]> {
  const rows = await prisma.filterRule.findMany({
    where: { organizationId },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  })
  return rows.map((r) => ruleFromRow(r, logger)).filter((r): r is FilterRule => r !== null)
}

export async function loadLists(
  prisma: PrismaClient,
  organizationId: string,
): Promise<ListEntry[]> {
  const rows = await prisma.listEntry.findMany({
    where: { organizationId },
    select: { list: true, kind: true, value: true, platform: true },
  })
  return rows.flatMap((r) => {
    const parsed = listEntrySchema.safeParse(r)
    return parsed.success ? [parsed.data] : []
  })
}

export interface OrgFilterSetup {
  rules: FilterRule[]
  context: FilterContext
}

/** Everything the engine needs for one organization, loaded once per batch. */
export async function loadFilterSetup(
  prisma: PrismaClient,
  organizationId: string,
  logger?: Logger,
  now: Date = new Date(),
): Promise<OrgFilterSetup> {
  const [rules, lists, settings] = await Promise.all([
    loadRules(prisma, organizationId, logger),
    loadLists(prisma, organizationId),
    prisma.settings.findUnique({ where: { organizationId }, select: { general: true } }),
  ])
  const timezone = parseGeneralSettings(settings?.general).timezone
  return { rules, context: { lists, now, timezone } }
}
