import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import {
  DM_REPLY_WINDOW_HOURS,
  VIEW_STATUSES,
  itemListQuerySchema,
  restoreItemSchema,
  type InboxView,
  type ItemDetail,
  type ItemListResponse,
  type ItemStatus,
  type ItemSummary,
} from "@inbox/core"
import type { Prisma, PrismaClient } from "@inbox/db"
import { notifyInbox } from "@inbox/pipeline"
import type { JobSender } from "../lib/jobs"
import { validate } from "../lib/validate"
import { requireAuth } from "../middleware/session"
import type { AppEnv } from "../types"

export interface ItemRouteDeps {
  prisma: PrismaClient
  jobs: JobSender
}

const SINCE_MS = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 } as const

const summarySelect = {
  id: true,
  platform: true,
  type: true,
  status: true,
  priority: true,
  eventKind: true,
  authorName: true,
  authorHandle: true,
  authorAvatarUrl: true,
  text: true,
  rating: true,
  language: true,
  tags: true,
  postTitle: true,
  postUrl: true,
  receivedAt: true,
  filterReason: true,
  manualOverride: true,
  conversationId: true,
  platformAccount: { select: { displayName: true } },
} satisfies Prisma.ItemSelect

type SummaryRow = Prisma.ItemGetPayload<{ select: typeof summarySelect }>

export function toSummary(row: SummaryRow): ItemSummary {
  const { platformAccount, receivedAt, ...rest } = row
  return { ...rest, receivedAt: receivedAt.toISOString(), accountName: platformAccount.displayName }
}

const idParam = z.object({ id: z.string().min(1).max(64) })

export function itemRoutes({ prisma, jobs }: ItemRouteDeps) {
  async function findOwned(organizationId: string, id: string) {
    const item = await prisma.item.findFirst({ where: { id, organizationId } })
    if (!item) throw new HTTPException(404, { message: "Item not found" })
    return item
  }

  async function setStatus(
    organizationId: string,
    id: string,
    data: Prisma.ItemUpdateInput,
    reason: string,
  ) {
    await findOwned(organizationId, id)
    const updated = await prisma.item.update({ where: { id }, data, select: summarySelect })
    await notifyInbox(prisma, { type: "items.changed", organizationId, itemIds: [id], reason })
    return toSummary(updated)
  }

  return (
    new Hono<AppEnv>()
      .use("*", requireAuth)

      .get("/", validate("query", itemListQuerySchema), async (c) => {
        const org = c.get("org")!
        const q = c.req.valid("query")
        const base: Prisma.ItemWhereInput = { organizationId: org.id }
        const statuses: readonly ItemStatus[] = q.status?.length ? q.status : VIEW_STATUSES[q.view]
        const where: Prisma.ItemWhereInput = {
          ...base,
          status: { in: [...statuses] },
          ...(q.platform ? { platform: { in: q.platform } } : {}),
          ...(q.type ? { type: { in: q.type } } : {}),
          ...(q.priority ? { priority: { in: q.priority } } : {}),
          ...(q.tag ? { tags: { has: q.tag } } : {}),
          ...(q.since !== "all"
            ? { receivedAt: { gte: new Date(Date.now() - SINCE_MS[q.since]) } }
            : {}),
          ...(q.q
            ? {
                OR: [
                  { text: { contains: q.q, mode: "insensitive" } },
                  { authorName: { contains: q.q, mode: "insensitive" } },
                  { authorHandle: { contains: q.q, mode: "insensitive" } },
                ],
              }
            : {}),
        }
        const orderBy: Prisma.ItemOrderByWithRelationInput[] =
          q.sort === "priority"
            ? [{ priority: "desc" }, { receivedAt: "desc" }, { id: "desc" }]
            : [{ receivedAt: q.sort === "oldest" ? "asc" : "desc" }, { id: "desc" }]
        // Opaque offset cursor (stable enough for an inbox; keyset can replace it later).
        const offset = q.cursor ? Math.max(0, Number.parseInt(q.cursor, 10) || 0) : 0

        const [rows, ...counts] = await Promise.all([
          prisma.item.findMany({
            where,
            orderBy,
            skip: offset,
            take: q.limit + 1,
            select: summarySelect,
          }),
          ...(Object.keys(VIEW_STATUSES) as InboxView[]).map((view) =>
            prisma.item.count({ where: { ...base, status: { in: [...VIEW_STATUSES[view]] } } }),
          ),
        ])
        const hasMore = rows.length > q.limit
        const views = Object.keys(VIEW_STATUSES) as InboxView[]
        const body: ItemListResponse = {
          items: rows.slice(0, q.limit).map(toSummary),
          nextCursor: hasMore ? String(offset + q.limit) : null,
          counts: Object.fromEntries(views.map((v, i) => [v, counts[i] ?? 0])) as Record<
            InboxView,
            number
          >,
        }
        return c.json(body)
      })

      .get("/:id", validate("param", idParam), async (c) => {
        const org = c.get("org")!
        const { id } = c.req.valid("param")
        const row = await prisma.item.findFirst({
          where: { id, organizationId: org.id },
          select: {
            ...summarySelect,
            externalId: true,
            postId: true,
            isOwnAccount: true,
            aiDraftsAllowed: true,
            requireApproval: true,
            resolvedAt: true,
            matchedRuleIds: true,
            dryRunRuleIds: true,
            platformAccount: { select: { displayName: true, accessTokenEnc: true } },
            conversation: { select: { customerLastMessageAt: true } },
            aiDrafts: {
              orderBy: { createdAt: "asc" },
              select: { id: true, text: true, model: true, createdAt: true },
            },
            replies: {
              orderBy: { createdAt: "asc" },
              select: {
                id: true,
                text: true,
                status: true,
                source: true,
                sentAt: true,
                error: true,
              },
            },
          },
        })
        if (!row) throw new HTTPException(404, { message: "Item not found" })

        const ruleIds = [...row.matchedRuleIds, ...row.dryRunRuleIds]
        const rules = ruleIds.length
          ? await prisma.filterRule.findMany({
              where: { organizationId: org.id, id: { in: ruleIds } },
              select: { id: true, name: true },
            })
          : []
        const ruleName = new Map(rules.map((r) => [r.id, r.name]))

        const thread = row.conversationId
          ? await prisma.item.findMany({
              where: { organizationId: org.id, conversationId: row.conversationId },
              orderBy: { receivedAt: "asc" },
              select: {
                id: true,
                text: true,
                receivedAt: true,
                authorName: true,
                eventKind: true,
                status: true,
              },
            })
          : []

        const windowHours = row.type === "dm" ? DM_REPLY_WINDOW_HOURS[row.platform] : undefined
        const last = row.conversation?.customerLastMessageAt ?? null
        const expiresAt =
          windowHours && last ? new Date(last.getTime() + windowHours * 3_600_000) : null

        const {
          matchedRuleIds,
          dryRunRuleIds,
          conversation: _conversation,
          aiDrafts,
          replies,
          resolvedAt,
          platformAccount,
          ...summaryFields
        } = row
        const detail: ItemDetail = {
          ...toSummary({ ...summaryFields, platformAccount }),
          externalId: row.externalId,
          postId: row.postId,
          isOwnAccount: row.isOwnAccount,
          aiDraftsAllowed: row.aiDraftsAllowed,
          requireApproval: row.requireApproval,
          resolvedAt: resolvedAt?.toISOString() ?? null,
          matchedRules: [
            ...matchedRuleIds.map((id) => ({
              id,
              name: ruleName.get(id) ?? "Deleted rule",
              dryRun: false,
            })),
            ...dryRunRuleIds.map((id) => ({
              id,
              name: ruleName.get(id) ?? "Deleted rule",
              dryRun: true,
            })),
          ],
          thread: thread.map((t) => ({ ...t, receivedAt: t.receivedAt.toISOString() })),
          replyWindow: windowHours
            ? {
                hours: windowHours,
                expiresAt: expiresAt?.toISOString() ?? null,
                expired: expiresAt ? expiresAt.getTime() < Date.now() : false,
              }
            : null,
          aiDrafts: aiDrafts.map((d) => ({ ...d, createdAt: d.createdAt.toISOString() })),
          replies: replies.map((r) => ({ ...r, sentAt: r.sentAt?.toISOString() ?? null })),
          canReply: Boolean(platformAccount.accessTokenEnc),
        }
        return c.json(detail)
      })

      .post("/:id/resolve", validate("param", idParam), async (c) => {
        const org = c.get("org")!
        const user = c.get("user")!
        const { id } = c.req.valid("param")
        const item = await setStatus(
          org.id,
          id,
          {
            status: "resolved",
            resolvedAt: new Date(),
            resolvedById: user.id,
            manualOverride: true,
          },
          "resolved",
        )
        return c.json(item)
      })

      .post("/:id/ignore", validate("param", idParam), async (c) => {
        const org = c.get("org")!
        const { id } = c.req.valid("param")
        return c.json(
          await setStatus(org.id, id, { status: "ignored", manualOverride: true }, "ignored"),
        )
      })

      .post("/:id/reopen", validate("param", idParam), async (c) => {
        const org = c.get("org")!
        const { id } = c.req.valid("param")
        return c.json(
          await setStatus(
            org.id,
            id,
            { status: "new", resolvedAt: null, resolvedById: null, manualOverride: true },
            "reopened",
          ),
        )
      })

      .post("/:id/archive", validate("param", idParam), async (c) => {
        const org = c.get("org")!
        const { id } = c.req.valid("param")
        return c.json(
          await setStatus(
            org.id,
            id,
            { status: "archived", filterReason: "Archived by a teammate", manualOverride: true },
            "archived",
          ),
        )
      })

      /** "Not spam / restore": back to the inbox, optionally allowlisting the author. */
      .post(
        "/:id/restore",
        validate("param", idParam),
        validate("json", restoreItemSchema),
        async (c) => {
          const org = c.get("org")!
          const user = c.get("user")!
          const { id } = c.req.valid("param")
          const { addToAllowlist } = c.req.valid("json")
          const before = await findOwned(org.id, id)

          let allowlisted: { kind: string; value: string } | null = null
          if (addToAllowlist) {
            const entry = before.authorId
              ? { kind: "author_id", value: before.authorId }
              : before.authorHandle
                ? { kind: "author_handle", value: before.authorHandle.replace(/^@/, "") }
                : null
            if (!entry)
              throw new HTTPException(400, { message: "This item has no author to allowlist" })
            await prisma.listEntry.upsert({
              where: {
                organizationId_list_kind_value_platform: {
                  organizationId: org.id,
                  list: "allowlist",
                  kind: entry.kind,
                  value: entry.value,
                  platform: before.platform,
                },
              },
              create: {
                organizationId: org.id,
                list: "allowlist",
                kind: entry.kind,
                value: entry.value,
                platform: before.platform,
                note: `Restored from the Filtered tab (${before.authorName ?? entry.value})`,
                createdById: user.id,
              },
              update: {},
            })
            allowlisted = entry
          }

          const item = await setStatus(
            org.id,
            id,
            { status: "new", filterReason: null, manualOverride: true },
            "restored",
          )
          await prisma.auditLog.create({
            data: {
              organizationId: org.id,
              actorId: user.id,
              action: "item.restore",
              entity: "item",
              entityId: id,
              before: { status: before.status, filterReason: before.filterReason },
              after: { status: "new", allowlisted },
            },
          })
          if (allowlisted) {
            await jobs.enqueueRefilter(org.id, c.get("requestId"))
            await notifyInbox(prisma, { type: "lists.changed", organizationId: org.id })
          }
          return c.json(item)
        },
      )
  )
}
