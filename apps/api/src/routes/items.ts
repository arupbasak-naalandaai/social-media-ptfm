import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import {
  DM_REPLY_WINDOW_HOURS,
  ENGAGED_STATUSES,
  LEARN_PHRASE_ERRORS,
  OPEN_STATUSES,
  VIEW_STATUSES,
  followUpListQuerySchema,
  itemLink,
  itemListQuerySchema,
  learnLowValuePhrase,
  replyRequestSchema,
  restoreItemSchema,
  type FollowUpListResponse,
  type FollowUpThread,
  type HideSimilarResponse,
  type InboxView,
  type ItemCounts,
  type ItemDetail,
  type ReplyQueuedResponse,
  type ItemListResponse,
  type ItemStatus,
  type ItemSummary,
  type Platform,
  type ThreadEntry,
  can,
} from "@inbox/core"
import { Prisma, type PrismaClient } from "@inbox/db"
import {
  aiAvailability,
  canSendFrom,
  isDemoAccount,
  cancelReply,
  queueReply,
  ReplyRejected,
  loadSettingsSection,
  markLaterItemsAsFollowUps,
  notifyInbox,
} from "@inbox/pipeline"
import type { JobSender } from "../lib/jobs"
import { validate } from "../lib/validate"
import { requireAuth, requirePermission, visiblePlatforms } from "../middleware/session"
import type { AppEnv, OrgContext } from "../types"

export interface ItemRouteDeps {
  prisma: PrismaClient
  jobs: JobSender
}

const SINCE_MS = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 } as const
const HIDDEN_STATUSES = VIEW_STATUSES.filtered

const summarySelect = {
  id: true,
  platform: true,
  type: true,
  status: true,
  priority: true,
  eventKind: true,
  externalId: true,
  authorName: true,
  authorHandle: true,
  authorAvatarUrl: true,
  text: true,
  rating: true,
  language: true,
  tags: true,
  postId: true,
  postTitle: true,
  postUrl: true,
  externalUrl: true,
  receivedAt: true,
  filterReason: true,
  manualOverride: true,
  conversationId: true,
  isFollowUp: true,
  platformAccount: { select: { displayName: true, externalId: true } },
} satisfies Prisma.ItemSelect

type SummaryRow = Prisma.ItemGetPayload<{ select: typeof summarySelect }>

export function toSummary(row: SummaryRow): ItemSummary {
  const { platformAccount, receivedAt, externalId, postId, externalUrl, ...rest } = row
  return {
    ...rest,
    receivedAt: receivedAt.toISOString(),
    accountName: platformAccount.displayName,
    link: itemLink({
      platform: row.platform,
      type: row.type,
      externalId,
      postId,
      postUrl: row.postUrl,
      externalUrl,
      accountExternalId: platformAccount.externalId,
    }),
  }
}

const idParam = z.object({ id: z.string().min(1).max(64) })

/** Items the member may see: their organization, on the platforms they have access to. */
function scope(org: OrgContext): Prisma.ItemWhereInput {
  return { organizationId: org.id, platform: { in: visiblePlatforms(org) } }
}

const canReply = requirePermission({ inbox: ["reply"] })
const canTriage = requirePermission({ inbox: ["triage"] })
const canUseAi = requirePermission({ ai: ["draft"] })

/** Filters shared by the item list and the follow-ups list (everything except status). */
function commonWhere(
  org: OrgContext,
  q: {
    platform?: ItemSummary["platform"][] | undefined
    type?: ItemSummary["type"][] | undefined
    since: keyof typeof SINCE_MS | "all"
    q?: string | undefined
  },
): Prisma.ItemWhereInput {
  const allowed: Platform[] = visiblePlatforms(org)
  return {
    ...scope(org),
    platform: { in: q.platform ? q.platform.filter((p) => allowed.includes(p)) : allowed },
    ...(q.type ? { type: { in: q.type } } : {}),
    ...(q.since !== "all" ? { receivedAt: { gte: new Date(Date.now() - SINCE_MS[q.since]) } } : {}),
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
}

/** Where clause for a view. The inbox leaves out follow-ups: they have their own tab. */
function viewWhere(view: InboxView, statuses: readonly ItemStatus[]): Prisma.ItemWhereInput {
  return {
    status: { in: [...statuses] },
    ...(view === "inbox" ? { isFollowUp: false } : {}),
  }
}

export function itemRoutes({ prisma, jobs }: ItemRouteDeps) {
  async function findOwned(org: OrgContext, id: string) {
    const item = await prisma.item.findFirst({ where: { id, ...scope(org) } })
    if (!item) throw new HTTPException(404, { message: "Item not found" })
    return item
  }

  async function setStatus(
    org: OrgContext,
    id: string,
    data: Prisma.ItemUpdateInput,
    reason: string,
  ) {
    await findOwned(org, id)
    const updated = await prisma.item.update({ where: { id }, data, select: summarySelect })
    await notifyInbox(prisma, {
      type: "items.changed",
      organizationId: org.id,
      itemIds: [id],
      reason,
    })
    return toSummary(updated)
  }

  async function countViews(org: OrgContext): Promise<ItemCounts> {
    const views = Object.keys(VIEW_STATUSES) as InboxView[]
    const [followUps, ...counts] = await Promise.all([
      prisma.item.count({
        where: { ...scope(org), isFollowUp: true, status: { in: [...OPEN_STATUSES] } },
      }),
      ...views.map((view) =>
        prisma.item.count({ where: { ...scope(org), ...viewWhere(view, VIEW_STATUSES[view]) } }),
      ),
    ])
    return {
      ...(Object.fromEntries(views.map((v, i) => [v, counts[i] ?? 0])) as Record<
        InboxView,
        number
      >),
      followUps,
    }
  }

  return (
    new Hono<AppEnv>()
      .use("*", requireAuth, requirePermission({ inbox: ["read"] }))

      .get("/", validate("query", itemListQuerySchema), async (c) => {
        const org = c.get("org")!
        const q = c.req.valid("query")
        const statuses: readonly ItemStatus[] = q.status?.length ? q.status : VIEW_STATUSES[q.view]
        const where: Prisma.ItemWhereInput = {
          ...viewWhere(q.view, statuses),
          ...commonWhere(org, q),
          ...(q.priority ? { priority: { in: q.priority } } : {}),
          ...(q.tag ? { tags: { has: q.tag } } : {}),
        }
        const orderBy: Prisma.ItemOrderByWithRelationInput[] =
          q.sort === "priority"
            ? [{ priority: "desc" }, { receivedAt: "desc" }, { id: "desc" }]
            : [{ receivedAt: q.sort === "oldest" ? "asc" : "desc" }, { id: "desc" }]
        // Opaque offset cursor (stable enough for an inbox; keyset can replace it later).
        const offset = q.cursor ? Math.max(0, Number.parseInt(q.cursor, 10) || 0) : 0

        const [rows, counts] = await Promise.all([
          prisma.item.findMany({
            where,
            orderBy,
            skip: offset,
            take: q.limit + 1,
            select: summarySelect,
          }),
          countViews(org),
        ])
        const hasMore = rows.length > q.limit
        const body: ItemListResponse = {
          items: rows.slice(0, q.limit).map(toSummary),
          nextCursor: hasMore ? String(offset + q.limit) : null,
          counts,
        }
        return c.json(body)
      })

      /**
       * Threads you engaged with (replied to or resolved), newest activity first. Threads where
       * the person wrote again (open follow-ups) always come first, on the first page.
       */
      .get("/follow-ups", validate("query", followUpListQuerySchema), async (c) => {
        const org = c.get("org")!
        const q = c.req.valid("query")
        const offset = q.cursor ? Math.max(0, Number.parseInt(q.cursor, 10) || 0) : 0
        const filters = commonWhere(org, q)
        const threadKeyNotNull = { threadKey: { not: null } } satisfies Prisma.ItemWhereInput
        const byActivity = [
          { _max: { receivedAt: "desc" } },
          { threadKey: "asc" },
        ] satisfies Prisma.ItemOrderByWithAggregationInput[]

        const active = await prisma.item.groupBy({
          by: ["threadKey"],
          where: {
            organizationId: org.id,
            ...threadKeyNotNull,
            isFollowUp: true,
            status: { in: [...OPEN_STATUSES] },
            ...filters,
          },
          _max: { receivedAt: true },
          orderBy: byActivity,
          take: 200,
        })
        const activeKeys = active.map((g) => g.threadKey!)

        const rest = await prisma.item.groupBy({
          by: ["threadKey"],
          where: {
            organizationId: org.id,
            AND: [threadKeyNotNull, { threadKey: { notIn: activeKeys } }],
            status: { in: [...ENGAGED_STATUSES] },
            ...filters,
          },
          _max: { receivedAt: true },
          orderBy: byActivity,
          skip: offset,
          take: q.limit + 1,
        })
        const hasMore = rest.length > q.limit
        const keys = [
          ...(offset === 0 ? activeKeys : []),
          ...rest.slice(0, q.limit).map((g) => g.threadKey!),
        ]

        const [items, counts] = await Promise.all([
          keys.length
            ? prisma.item.findMany({
                where: {
                  ...scope(org),
                  threadKey: { in: keys },
                  status: { notIn: [...HIDDEN_STATUSES] },
                },
                orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
                select: { ...summarySelect, threadKey: true, resolvedAt: true },
              })
            : Promise.resolve([]),
          countViews(org),
        ])

        const byThread = new Map<string, typeof items>()
        for (const it of items) {
          const list = byThread.get(it.threadKey!) ?? []
          list.push(it)
          byThread.set(it.threadKey!, list)
        }
        const threads: FollowUpThread[] = keys.flatMap((key) => {
          const list = byThread.get(key)
          if (!list?.length) return []
          const open = list.filter(
            (i) => i.isFollowUp && (OPEN_STATUSES as readonly ItemStatus[]).includes(i.status),
          )
          const engagedAt = list
            .filter((i) => (ENGAGED_STATUSES as readonly ItemStatus[]).includes(i.status))
            .map((i) => i.resolvedAt?.getTime() ?? 0)
          const pick = open[0] ?? list[0]!
          const { threadKey: _k, resolvedAt: _r, ...summary } = pick
          return [
            {
              threadKey: key,
              item: toSummary(summary),
              itemCount: list.length,
              newCount: open.length,
              lastEngagedAt: engagedAt.length
                ? new Date(Math.max(...engagedAt)).toISOString()
                : null,
              lastActivityAt: list[0]!.receivedAt.toISOString(),
            },
          ]
        })

        const body: FollowUpListResponse = {
          threads,
          nextCursor: hasMore ? String(offset + q.limit) : null,
          counts,
        }
        return c.json(body)
      })

      .get("/:id", validate("param", idParam), async (c) => {
        const org = c.get("org")!
        const { id } = c.req.valid("param")
        const row = await prisma.item.findFirst({
          where: { id, ...scope(org) },
          select: {
            ...summarySelect,
            threadKey: true,
            isOwnAccount: true,
            aiDraftsAllowed: true,
            requireApproval: true,
            resolvedAt: true,
            matchedRuleIds: true,
            dryRunRuleIds: true,
            platformAccount: {
              select: {
                displayName: true,
                externalId: true,
                accessTokenEnc: true,
                meta: true,
                status: true,
              },
            },
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

        const threadItems = await prisma.item.findMany({
          where: row.threadKey
            ? { organizationId: org.id, threadKey: row.threadKey }
            : { organizationId: org.id, id: row.id },
          orderBy: { receivedAt: "asc" },
          take: 200,
          select: {
            id: true,
            text: true,
            receivedAt: true,
            authorName: true,
            eventKind: true,
            status: true,
            isOwnAccount: true,
            replies: {
              select: { id: true, text: true, status: true, sentAt: true, createdAt: true },
            },
          },
        })
        const thread: ThreadEntry[] = threadItems
          .flatMap((t): ThreadEntry[] => [
            {
              id: t.id,
              kind: "item",
              text: t.text,
              at: t.receivedAt.toISOString(),
              authorName: t.authorName,
              eventKind: t.eventKind,
              status: t.status,
              ours: t.isOwnAccount,
            },
            ...t.replies.map((r): ThreadEntry => ({
              id: r.id,
              kind: "reply",
              text: r.text,
              at: (r.sentAt ?? r.createdAt).toISOString(),
              authorName: row.platformAccount.displayName,
              eventKind: "created",
              status: r.status,
              ours: true,
            })),
          ])
          .sort((a, b) => a.at.localeCompare(b.at))

        const aiBlocked = await aiAvailability(prisma, org.id)
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
          threadKey: _threadKey,
          isOwnAccount,
          aiDraftsAllowed,
          requireApproval,
          ...summaryFields
        } = row
        const aiAllowed = can(org.permissions, { ai: ["draft"] })
        const detail: ItemDetail = {
          ...toSummary({ ...summaryFields, platformAccount }),
          externalId: row.externalId,
          postId: row.postId,
          isOwnAccount,
          aiDraftsAllowed,
          requireApproval,
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
          thread,
          replyWindow: windowHours
            ? {
                hours: windowHours,
                expiresAt: expiresAt?.toISOString() ?? null,
                expired: expiresAt ? expiresAt.getTime() < Date.now() : false,
              }
            : null,
          aiDrafts: aiAllowed
            ? aiDrafts.map((d) => ({ ...d, createdAt: d.createdAt.toISOString() }))
            : [],
          replies: replies.map((r) => ({ ...r, sentAt: r.sentAt?.toISOString() ?? null })),
          canReply: canSendFrom(platformAccount),
          demoAccount: isDemoAccount(platformAccount),
          ai: {
            allowed: aiAllowed,
            available: aiAllowed && aiBlocked === null,
            message: aiAllowed ? (aiBlocked?.message ?? null) : null,
          },
        }

        // Settings → AI replies → "When someone opens the item": draft now (deduplicated).
        if (
          aiAllowed &&
          aiBlocked === null &&
          aiDrafts.length === 0 &&
          aiDraftsAllowed &&
          !isOwnAccount &&
          (row.status === "new" || row.status === "pending") &&
          (await loadSettingsSection(prisma, org.id, "ai")).generateOn === "open"
        ) {
          await jobs.enqueueAiDraft({
            organizationId: org.id,
            itemId: row.id,
            requestId: c.get("requestId"),
          })
        }
        return c.json(detail)
      })

      // Queue a reply; it posts after Settings → Replies → undo window unless cancelled.
      .post(
        "/:id/reply",
        canReply,
        validate("param", idParam),
        validate("json", replyRequestSchema),
        async (c) => {
          const org = c.get("org")!
          const { id } = c.req.valid("param")
          const body = c.req.valid("json")
          await findOwned(org, id)
          if (body.draftId && !can(org.permissions, { ai: ["draft"] })) {
            throw new HTTPException(403, { message: "Your access doesn't include AI drafts" })
          }
          let queued
          try {
            queued = await queueReply(prisma, {
              organizationId: org.id,
              itemId: id,
              userId: c.get("user")!.id,
              text: body.text,
              draftId: body.draftId,
            })
          } catch (err) {
            if (err instanceof ReplyRejected) {
              throw new HTTPException(err.status, { message: err.message })
            }
            throw err
          }
          await jobs.enqueueSendReply(
            { organizationId: org.id, replyId: queued.reply.id, requestId: c.get("requestId") },
            queued.undoSeconds,
          )
          await notifyInbox(prisma, {
            type: "items.changed",
            organizationId: org.id,
            itemIds: [id],
            reason: "reply_queued",
          })
          const body202: ReplyQueuedResponse = {
            replyId: queued.reply.id,
            text: queued.reply.text,
            undoSeconds: queued.undoSeconds,
            sendsAt: new Date(Date.now() + queued.undoSeconds * 1000).toISOString(),
            afterSend: queued.afterSend,
          }
          return c.json(body202, 202)
        },
      )

      // Undo within the window. 409 once it has started sending.
      .post(
        "/:id/replies/:replyId/cancel",
        canReply,
        validate("param", z.object({ id: z.string().min(1), replyId: z.string().min(1) })),
        async (c) => {
          const org = c.get("org")!
          const { id, replyId } = c.req.valid("param")
          await findOwned(org, id)
          const owned = await prisma.reply.findFirst({
            where: { id: replyId, itemId: id, organizationId: org.id },
            select: { id: true },
          })
          if (!owned) throw new HTTPException(404, { message: "Reply not found" })
          const text = await cancelReply(prisma, org.id, replyId)
          if (text === null) {
            throw new HTTPException(409, { message: "Too late: the reply is already sending" })
          }
          await notifyInbox(prisma, {
            type: "items.changed",
            organizationId: org.id,
            itemIds: [id],
            reason: "reply_cancelled",
          })
          return c.json({ cancelled: true, text })
        },
      )

      // Draft (again) with AI. Replaces drafts nobody picked; 409 when AI isn't set up.
      .post("/:id/drafts", canReply, canUseAi, validate("param", idParam), async (c) => {
        const org = c.get("org")!
        const { id } = c.req.valid("param")
        const item = await prisma.item.findFirst({
          where: { id, ...scope(org) },
          select: { id: true, aiDraftsAllowed: true, isOwnAccount: true },
        })
        if (!item) throw new HTTPException(404, { message: "Item not found" })
        if (item.isOwnAccount) {
          throw new HTTPException(409, { message: "This is our own message: nothing to reply to" })
        }
        const blocked = await aiAvailability(prisma, org.id)
        if (blocked) throw new HTTPException(409, { message: blocked.message })
        if (!item.aiDraftsAllowed) {
          // An explicit click overrides a rule's "no AI drafts" for this item.
          await prisma.item.update({ where: { id }, data: { aiDraftsAllowed: true } })
        }
        await jobs.enqueueAiDraft({
          organizationId: org.id,
          itemId: id,
          force: true,
          requestId: c.get("requestId"),
        })
        return c.json({ queued: true }, 202)
      })

      .post("/:id/resolve", canTriage, validate("param", idParam), async (c) => {
        const org = c.get("org")!
        const user = c.get("user")!
        const { id } = c.req.valid("param")
        const item = await setStatus(
          org,
          id,
          {
            status: "resolved",
            resolvedAt: new Date(),
            resolvedById: user.id,
            manualOverride: true,
          },
          "resolved",
        )
        // Anything the person wrote after this item is now a follow-up.
        const stored = await prisma.item.findUniqueOrThrow({
          where: { id },
          select: { id: true, organizationId: true, threadKey: true, receivedAt: true },
        })
        const moved = await markLaterItemsAsFollowUps(prisma, stored)
        if (moved.length) {
          await notifyInbox(prisma, {
            type: "items.changed",
            organizationId: org.id,
            itemIds: moved,
            reason: "follow-up",
          })
        }
        return c.json(item)
      })

      .post("/:id/ignore", canTriage, validate("param", idParam), async (c) => {
        const org = c.get("org")!
        const { id } = c.req.valid("param")
        return c.json(
          await setStatus(org, id, { status: "ignored", manualOverride: true }, "ignored"),
        )
      })

      .post("/:id/reopen", canTriage, validate("param", idParam), async (c) => {
        const org = c.get("org")!
        const { id } = c.req.valid("param")
        return c.json(
          await setStatus(
            org,
            id,
            { status: "new", resolvedAt: null, resolvedById: null, manualOverride: true },
            "reopened",
          ),
        )
      })

      .post("/:id/archive", canTriage, validate("param", idParam), async (c) => {
        const org = c.get("org")!
        const { id } = c.req.valid("param")
        return c.json(
          await setStatus(
            org,
            id,
            { status: "archived", filterReason: "Archived by a teammate", manualOverride: true },
            "archived",
          ),
        )
      })

      /**
       * "Hide similar": learns a low-value phrase from this item's text, adds it to the
       * Low-value phrases list, archives the item, and re-filters so look-alikes leave the inbox.
       */
      .post(
        "/:id/hide-similar",
        canTriage,
        requirePermission({ filter: ["manage"] }),
        validate("param", idParam),
        async (c) => {
          const org = c.get("org")!
          const user = c.get("user")!
          const { id } = c.req.valid("param")
          const before = await findOwned(org, id)
          const learned = learnLowValuePhrase(before.text)
          if (!learned.ok) {
            throw new HTTPException(400, { message: LEARN_PHRASE_ERRORS[learned.reason] })
          }
          const { phrase } = learned
          const listed = { organizationId: org.id, list: "low_value_phrases", kind: "keyword" }

          let entryId: string | null = null
          const existing = await prisma.listEntry.findFirst({
            where: { ...listed, value: phrase, platform: null },
            select: { id: true },
          })
          if (!existing) {
            try {
              const entry = await prisma.listEntry.create({
                data: {
                  ...listed,
                  value: phrase,
                  platform: null,
                  note: `Learned from “${(before.text ?? "").slice(0, 80)}”`,
                  createdById: user.id,
                },
              })
              entryId = entry.id
            } catch (err) {
              // A concurrent "Hide similar" added the same phrase: fine.
              if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"))
                throw err
            }
          }

          const item = await setStatus(
            org,
            id,
            {
              status: "archived",
              filterReason: `Hidden as low-value (“${phrase}”)`,
              manualOverride: true,
              tags: before.tags.includes("low-value") ? before.tags : [...before.tags, "low-value"],
            },
            "hidden-similar",
          )
          await prisma.auditLog.create({
            data: {
              organizationId: org.id,
              actorId: user.id,
              action: "item.hide_similar",
              entity: "item",
              entityId: id,
              before: { status: before.status },
              after: { status: "archived", phrase, listEntryId: entryId },
            },
          })
          if (entryId) {
            await notifyInbox(prisma, { type: "lists.changed", organizationId: org.id })
            await jobs.enqueueRefilter(org.id, c.get("requestId"))
          }
          const body: HideSimilarResponse = { item, phrase, entryId }
          return c.json(body)
        },
      )

      /** "Not spam / restore": back to the inbox, optionally allowlisting the author. */
      .post(
        "/:id/restore",
        canTriage,
        validate("param", idParam),
        validate("json", restoreItemSchema),
        async (c) => {
          const org = c.get("org")!
          const user = c.get("user")!
          const { id } = c.req.valid("param")
          const { addToAllowlist } = c.req.valid("json")
          if (addToAllowlist && !can(org.permissions, { filter: ["manage"] })) {
            throw new HTTPException(403, { message: "Adding to the allowlist needs filter access" })
          }
          const before = await findOwned(org, id)

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
            org,
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
