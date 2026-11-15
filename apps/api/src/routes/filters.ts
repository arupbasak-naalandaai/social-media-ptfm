import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import {
  evaluate,
  filterRuleInputSchema,
  orderedApplicableRules,
  reorderRulesSchema,
  ruleTestRequestSchema,
  ruleTogglePatchSchema,
  usesAiFields,
  validateConditionTree,
  type FilterContext,
  type FilterInput,
  type FilterResult,
  type FilterRule,
  type FilterRuleInput,
  type RuleTestOutcome,
  type RuleTestResponse,
  type RuleTestRow,
  type RuleWithStats,
} from "@inbox/core"
import type { FilterRule as FilterRuleRow, Prisma, PrismaClient } from "@inbox/db"
import { itemToFilterInput, loadFilterSetup, notifyInbox, ruleFromRow } from "@inbox/pipeline"
import { autoRefilterEnabled, type JobSender } from "../lib/jobs"
import { validate } from "../lib/validate"
import { requireAuth, requirePermission } from "../middleware/session"
import type { AppEnv } from "../types"

export interface FilterRouteDeps {
  prisma: PrismaClient
  jobs: JobSender
}

const idParam = z.object({ id: z.string().min(1).max(64) })
const PRIORITY_STEP = 10
const TEST_SAMPLE_SIZE = 200

function assertValidTree(rule: FilterRuleInput) {
  const issues = validateConditionTree(rule.conditions)
  if (issues.length > 0) {
    throw new HTTPException(400, {
      message: issues.map((i) => i.message).join("; "),
      cause: issues,
    })
  }
}

function toJson(rule: FilterRuleInput) {
  return {
    name: rule.name,
    description: rule.description ?? null,
    enabled: rule.enabled,
    stopProcessing: rule.stopProcessing,
    dryRun: rule.dryRun,
    platforms: rule.platforms as Prisma.InputJsonValue,
    itemTypes: rule.itemTypes as Prisma.InputJsonValue,
    conditions: rule.conditions as unknown as Prisma.InputJsonObject,
    actions: rule.actions as unknown as Prisma.InputJsonArray,
  }
}

function snapshot(row: FilterRuleRow) {
  return {
    name: row.name,
    enabled: row.enabled,
    priority: row.priority,
    stopProcessing: row.stopProcessing,
    dryRun: row.dryRun,
    platforms: row.platforms,
    itemTypes: row.itemTypes,
    conditions: row.conditions,
    actions: row.actions,
  } as Prisma.InputJsonObject
}

function outcome(r: FilterResult): RuleTestOutcome {
  return { decision: r.decision, priority: r.priority, filterReason: r.filterReason }
}

export function filterRoutes({ prisma, jobs }: FilterRouteDeps) {
  async function findOwned(organizationId: string, id: string) {
    const row = await prisma.filterRule.findFirst({ where: { id, organizationId } })
    if (!row) throw new HTTPException(404, { message: "Rule not found" })
    return row
  }

  async function afterChange(
    organizationId: string,
    actorId: string,
    requestId: string,
    action: string,
    entityId: string,
    before: Prisma.InputJsonObject | null,
    after: Prisma.InputJsonObject | null,
  ) {
    await prisma.auditLog.create({
      data: {
        organizationId,
        actorId,
        action,
        entity: "filter_rule",
        entityId,
        ...(before ? { before } : {}),
        ...(after ? { after } : {}),
      },
    })
    await notifyInbox(prisma, { type: "rules.changed", organizationId })
    // Re-run the rules over stored items so the inbox reflects the change
    // (unless Settings → Filters turned that off: then "Apply to existing items" does it).
    if (await autoRefilterEnabled(prisma, organizationId)) {
      await jobs.enqueueRefilter(organizationId, requestId)
    }
  }

  return (
    new Hono<AppEnv>()
      .use("*", requireAuth, requirePermission({ filter: ["read"] }))

      .get("/", async (c) => {
        const org = c.get("org")!
        const since = new Date(Date.now() - 7 * 86_400_000)
        const [rows, stats] = await Promise.all([
          prisma.filterRule.findMany({
            where: { organizationId: org.id },
            orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
          }),
          prisma.ruleMatch.groupBy({
            by: ["ruleId", "dryRun"],
            where: { organizationId: org.id, matchedAt: { gte: since } },
            _count: { _all: true },
          }),
        ])
        const count = (ruleId: string, dryRun: boolean) =>
          stats.find((s) => s.ruleId === ruleId && s.dryRun === dryRun)?._count._all ?? 0
        const rules: RuleWithStats[] = rows.flatMap((row) => {
          const rule = ruleFromRow(row, c.get("logger"))
          if (!rule) return []
          return [
            {
              ...rule,
              isDefault: row.isDefault,
              defaultKey: row.defaultKey,
              matches7d: count(row.id, false),
              dryRunMatches7d: count(row.id, true),
              updatedAt: row.updatedAt.toISOString(),
            },
          ]
        })
        return c.json({ rules })
      })

      /** Read-only: what would this draft rule match, and what would change? */
      .post("/test", validate("json", ruleTestRequestSchema), async (c) => {
        const org = c.get("org")!
        const body = c.req.valid("json")
        assertValidTree(body.rule)

        const setup = await loadFilterSetup(prisma, org.id, c.get("logger"))
        const saved = setup.rules.filter((r) => r.id !== body.ruleId)
        const existing = body.ruleId ? setup.rules.find((r) => r.id === body.ruleId) : undefined
        const draft: FilterRule = {
          ...body.rule,
          id: body.ruleId ?? "__draft__",
          priority: body.rule.priority ?? existing?.priority ?? Number.MAX_SAFE_INTEGER - 1,
          dryRun: false,
        }
        // "matched" ignores enabled so a disabled draft can still be tested.
        const probe: FilterRule = {
          ...draft,
          enabled: true,
          stopProcessing: false,
          actions: [{ type: "addTag", value: "__probe__" }],
        }
        const ctx: FilterContext = setup.context

        const run = (input: FilterInput, item: RuleTestRow["item"]): RuleTestRow => {
          const matched = evaluate(input, [probe], ctx).matched.length > 0
          const before = evaluate(input, setup.rules, ctx)
          const after = evaluate(input, [...saved, { ...draft, enabled: true }], ctx)
          const aiUnknown =
            usesAiFields(draft.conditions) &&
            orderedApplicableRules([probe], input).length > 0 &&
            ctx.ai === undefined
          return { item, matched, before: outcome(before), after: outcome(after), aiUnknown }
        }

        let rows: RuleTestRow[]
        if (body.mode === "sample") {
          const s = body.sample
          const input: FilterInput = {
            platform: s.platform,
            type: s.type,
            eventKind: s.eventKind,
            text: s.text,
            rating: s.type === "review" ? s.rating : null,
            language: null,
            authorName: s.authorName,
            authorHandle: s.authorHandle,
            authorId: null,
            isOwnAccount: s.isOwnAccount,
            isReplyToOurReply: false,
            postId: null,
            postPublishedAt: null,
            receivedAt: new Date(),
          }
          rows = [run(input, null)]
        } else {
          const items = await prisma.item.findMany({
            where: { organizationId: org.id },
            orderBy: { receivedAt: "desc" },
            take: TEST_SAMPLE_SIZE,
          })
          rows = items.map((item) =>
            run(itemToFilterInput(item), {
              id: item.id,
              platform: item.platform,
              type: item.type,
              authorName: item.authorName,
              text: item.text,
              rating: item.rating,
              status: item.status,
              receivedAt: item.receivedAt.toISOString(),
            }),
          )
        }

        const changed = (r: RuleTestRow) =>
          r.before.decision !== r.after.decision || r.before.priority !== r.after.priority
        const response: RuleTestResponse = {
          rows: body.mode === "recent" ? rows.filter((r) => r.matched || changed(r)) : rows,
          total: rows.length,
          matched: rows.filter((r) => r.matched).length,
          wouldChange: rows.filter(changed).length,
        }
        return c.json(response)
      })

      // ── Admin-only writes ──────────────────────────────────────────────────
      .post(
        "/",
        requirePermission({ filter: ["manage"] }),
        validate("json", filterRuleInputSchema),
        async (c) => {
          const org = c.get("org")!
          const rule = c.req.valid("json")
          assertValidTree(rule)
          const last = await prisma.filterRule.findFirst({
            where: { organizationId: org.id },
            orderBy: { priority: "desc" },
            select: { priority: true },
          })
          const row = await prisma.filterRule.create({
            data: {
              organizationId: org.id,
              ...toJson(rule),
              priority: rule.priority ?? (last?.priority ?? 0) + PRIORITY_STEP,
              createdById: c.get("user")!.id,
              updatedById: c.get("user")!.id,
            },
          })
          await afterChange(
            org.id,
            c.get("user")!.id,
            c.get("requestId"),
            "filter_rule.create",
            row.id,
            null,
            snapshot(row),
          )
          return c.json({ id: row.id }, 201)
        },
      )

      .put(
        "/:id",
        requirePermission({ filter: ["manage"] }),
        validate("param", idParam),
        validate("json", filterRuleInputSchema),
        async (c) => {
          const org = c.get("org")!
          const { id } = c.req.valid("param")
          const rule = c.req.valid("json")
          assertValidTree(rule)
          const before = await findOwned(org.id, id)
          const row = await prisma.filterRule.update({
            where: { id },
            data: {
              ...toJson(rule),
              ...(rule.priority !== undefined ? { priority: rule.priority } : {}),
              updatedById: c.get("user")!.id,
            },
          })
          await afterChange(
            org.id,
            c.get("user")!.id,
            c.get("requestId"),
            "filter_rule.update",
            id,
            snapshot(before),
            snapshot(row),
          )
          return c.json({ id })
        },
      )

      .patch(
        "/:id",
        requirePermission({ filter: ["manage"] }),
        validate("param", idParam),
        validate("json", ruleTogglePatchSchema),
        async (c) => {
          const org = c.get("org")!
          const { id } = c.req.valid("param")
          const patch = c.req.valid("json")
          const before = await findOwned(org.id, id)
          const row = await prisma.filterRule.update({
            where: { id },
            data: { ...patch, updatedById: c.get("user")!.id },
          })
          await afterChange(
            org.id,
            c.get("user")!.id,
            c.get("requestId"),
            "filter_rule.update",
            id,
            snapshot(before),
            snapshot(row),
          )
          return c.json({ id })
        },
      )

      .delete(
        "/:id",
        requirePermission({ filter: ["manage"] }),
        validate("param", idParam),
        async (c) => {
          const org = c.get("org")!
          const { id } = c.req.valid("param")
          const before = await findOwned(org.id, id)
          await prisma.filterRule.delete({ where: { id } })
          await afterChange(
            org.id,
            c.get("user")!.id,
            c.get("requestId"),
            "filter_rule.delete",
            id,
            snapshot(before),
            null,
          )
          return c.body(null, 204)
        },
      )

      .post(
        "/reorder",
        requirePermission({ filter: ["manage"] }),
        validate("json", reorderRulesSchema),
        async (c) => {
          const org = c.get("org")!
          const { ids } = c.req.valid("json")
          const owned = await prisma.filterRule.findMany({
            where: { organizationId: org.id },
            select: { id: true, priority: true },
            orderBy: { priority: "asc" },
          })
          const ownedIds = new Set(owned.map((r) => r.id))
          if (ids.length !== owned.length || !ids.every((id) => ownedIds.has(id))) {
            throw new HTTPException(400, { message: "ids must list every rule exactly once" })
          }
          await prisma.$transaction(
            ids.map((id, index) =>
              prisma.filterRule.update({
                where: { id },
                data: { priority: (index + 1) * PRIORITY_STEP },
              }),
            ),
          )
          await afterChange(
            org.id,
            c.get("user")!.id,
            c.get("requestId"),
            "filter_rule.reorder",
            "*",
            { order: owned.map((r) => r.id) },
            { order: ids },
          )
          return c.json({ ok: true })
        },
      )

      /** Manually re-run all rules over stored items. */
      .post("/apply", requirePermission({ filter: ["manage"] }), async (c) => {
        const org = c.get("org")!
        await jobs.enqueueRefilter(org.id, c.get("requestId"))
        return c.json({ queued: true }, 202)
      })
  )
}
