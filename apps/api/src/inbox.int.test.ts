/**
 * Inbox/filters API against a real database (TEST_DATABASE_URL), with the refilter job run
 * inline so rule edits are reflected synchronously.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import {
  DEFAULT_RULES,
  type FilterRuleInput,
  type FollowUpListResponse,
  type HideSimilarResponse,
  type ItemDetail,
  type ItemListResponse,
  type NormalizedItem,
  type RuleWithStats,
  type Role,
} from "@inbox/core"
import { createLogger } from "@inbox/core/logger"
import { createPrismaClient, type Prisma } from "@inbox/db"
import { ingestNormalizedItem, loadFilterSetup, refilterOrganization } from "@inbox/pipeline"
import { buildSeedItems, SEED_ACCOUNTS } from "../../../packages/pipeline/src/seed/fixtures"
import { createApp } from "./app"
import type { JobSender } from "./lib/jobs"

const url = process.env.TEST_DATABASE_URL
const prisma = url ? createPrismaClient(url) : null
const logger = createLogger("test", { level: "silent", transport: undefined })
const ORG = "int-org"

const inlineJobs: JobSender = {
  enqueueRefilter: async (orgId) => {
    await refilterOrganization(prisma!, orgId)
  },
  stop: async () => {},
}

function app(role: Role = "owner") {
  return createApp({
    auth: {
      handler: async () => new Response(null, { status: 404 }),
      getSession: async () => ({
        user: { id: "u-int", email: "owner@example.com", name: "Owner" },
        session: { id: "s-int", activeOrganizationId: ORG },
      }),
    },
    orgs: { resolve: async () => ({ id: ORG, name: "Int", role }) },
    logger,
    checkDb: async () => true,
    prisma: prisma!,
    jobs: inlineJobs,
  })
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

async function seedOrg() {
  await prisma!.organization.create({
    data: { id: ORG, name: "Int", slug: "int", createdAt: new Date() },
  })
  await prisma!.settings.create({ data: { organizationId: ORG, general: {} } })
  for (const { defaultKey, ...rule } of DEFAULT_RULES) {
    await prisma!.filterRule.create({
      data: {
        organizationId: ORG,
        defaultKey,
        isDefault: true,
        name: rule.name,
        enabled: rule.enabled,
        priority: rule.priority,
        stopProcessing: rule.stopProcessing,
        dryRun: rule.dryRun,
        platforms: rule.platforms as Prisma.InputJsonValue,
        itemTypes: rule.itemTypes as Prisma.InputJsonValue,
        conditions: rule.conditions as unknown as Prisma.InputJsonObject,
        actions: rule.actions as unknown as Prisma.InputJsonArray,
      },
    })
  }
  await prisma!.listEntry.createMany({
    data: [
      { organizationId: ORG, list: "spam_keywords", kind: "keyword", value: "check my profile" },
      { organizationId: ORG, list: "trusted_domains", kind: "domain", value: "youtube.com" },
    ],
  })
  const accounts = new Map<string, string>()
  for (const a of SEED_ACCOUNTS) {
    const acc = await prisma!.platformAccount.create({
      data: {
        organizationId: ORG,
        platform: a.platform,
        kind: a.kind,
        externalId: a.externalId,
        displayName: a.displayName,
      },
    })
    accounts.set(a.key, acc.id)
  }
  const setup = await loadFilterSetup(prisma!, ORG)
  for (const { accountKey, item } of buildSeedItems(new Date("2026-11-12T12:00:00Z"))) {
    await ingestNormalizedItem(prisma!, {
      organizationId: ORG,
      platformAccountId: accounts.get(accountKey)!,
      item,
      setup,
    })
  }
}

const findByText = (list: ItemListResponse, text: string) => list.items.find((i) => i.text === text)

/** Ingests one extra Instagram comment through the real pipeline. */
async function ingestComment(
  externalId: string,
  text: string,
  over: Partial<NormalizedItem> = {},
): Promise<string> {
  const account = await prisma!.platformAccount.findFirstOrThrow({
    where: { organizationId: ORG, platform: "instagram" },
  })
  const res = await ingestNormalizedItem(prisma!, {
    organizationId: ORG,
    platformAccountId: account.id,
    setup: await loadFilterSetup(prisma!, ORG),
    item: {
      platform: "instagram",
      type: "comment",
      eventKind: "created",
      externalId,
      parentExternalId: null,
      postId: "ig-media-1",
      postUrl: "https://instagram.com/p/demo1",
      externalUrl: null,
      postTitle: "Truffle pasta reel",
      postPublishedAt: null,
      authorName: "Nina Park",
      authorHandle: "nina.park",
      authorId: "instagram-user-nina",
      authorAvatarUrl: null,
      isOwnAccount: false,
      isReplyToOurReply: false,
      text,
      rating: null,
      language: "en",
      platformCreatedAt: null,
      platformUpdatedAt: null,
      receivedAt: new Date(),
      conversation: null,
      raw: {},
      ...over,
    },
  })
  if (res.outcome !== "created") throw new Error(`expected created, got ${res.outcome}`)
  return res.itemId
}

describe.skipIf(!url)("inbox + filters API (integration)", () => {
  beforeEach(async () => {
    await prisma!.$executeRawUnsafe(
      'TRUNCATE "rule_match", "reply", "ai_draft", "item", "conversation", "list_entry", "filter_rule", "sync_state", "platform_account", "audit_log", "settings", "member", "organization" CASCADE',
    )
    await seedOrg()
  })
  afterAll(async () => prisma?.$disconnect())

  it("splits seeded items into inbox and filtered, with counts", async () => {
    const inbox = await json<ItemListResponse>(await app().request("/api/items?limit=100"))
    const filtered = await json<ItemListResponse>(
      await app().request("/api/items?view=filtered&limit=100"),
    )
    expect(inbox.counts.inbox).toBe(inbox.items.length)
    expect(filtered.items.length).toBeGreaterThan(5)
    expect(findByText(filtered, "nice")?.filterReason).toContain("very short")
    expect(findByText(inbox, "nice")).toBeUndefined()
    // own replies and reactions were dropped entirely
    expect(inbox.items.some((i) => i.text?.includes("fully vegan"))).toBe(false)
  })

  it("editing a rule changes what appears in the inbox (acceptance)", async () => {
    const { rules } = await json<{ rules: RuleWithStats[] }>(await app().request("/api/filters"))
    const emoji = rules.find((r) => r.defaultKey === "archive_emoji_short")!
    expect(emoji.matches7d).toBeGreaterThan(0)

    const off = await app().request(`/api/filters/${emoji.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    })
    expect(off.status).toBe(200)
    const inbox = await json<ItemListResponse>(await app().request("/api/items?limit=100"))
    expect(findByText(inbox, "nice")).toBeDefined()
    expect(findByText(inbox, "🔥🔥")).toBeDefined()

    await app().request(`/api/filters/${emoji.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    })
    const after = await json<ItemListResponse>(await app().request("/api/items?limit=100"))
    expect(findByText(after, "nice")).toBeUndefined()
    expect(
      await prisma!.auditLog.count({
        where: { organizationId: ORG, action: "filter_rule.update" },
      }),
    ).toBe(2)
  })

  it("creates a custom rule that archives matching items, and rejects invalid ones", async () => {
    const rule: FilterRuleInput = {
      name: "Archive parking questions",
      enabled: true,
      stopProcessing: false,
      dryRun: false,
      platforms: "all",
      itemTypes: ["comment"],
      conditions: {
        id: "g",
        kind: "group",
        combinator: "and",
        children: [
          { id: "c1", kind: "condition", field: "text", operator: "contains", value: "parking" },
        ],
      },
      actions: [{ type: "archive" }],
    }
    const res = await app().request("/api/filters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rule),
    })
    expect(res.status).toBe(201)
    const filtered = await json<ItemListResponse>(
      await app().request("/api/items?view=filtered&limit=100"),
    )
    expect(
      filtered.items.some(
        (i) => i.text === "Do you have parking nearby?" && i.filterReason === rule.name,
      ),
    ).toBe(true)

    const bad = await app().request("/api/filters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...rule,
        conditions: {
          ...rule.conditions,
          children: [
            { id: "c1", kind: "condition", field: "rating", operator: "contains", value: "x" },
          ],
        },
      }),
    })
    expect(bad.status).toBe(400)
  })

  it("members can read rules but not change them", async () => {
    expect((await app("member").request("/api/filters")).status).toBe(200)
    const res = await app("member").request("/api/filters/apply", { method: "POST" })
    expect(res.status).toBe(403)
  })

  it("restores a filtered item and optionally allowlists the author", async () => {
    const filtered = await json<ItemListResponse>(
      await app().request("/api/items?view=filtered&limit=100"),
    )
    const spam = filtered.items.find((i) => i.authorHandle === "cryptoking_signals")!
    const res = await app().request(`/api/items/${spam.id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addToAllowlist: true }),
    })
    expect(res.status).toBe(200)
    const item = await prisma!.item.findUniqueOrThrow({ where: { id: spam.id } })
    expect(item).toMatchObject({ status: "new", manualOverride: true })
    expect(
      await prisma!.listEntry.count({ where: { organizationId: ORG, list: "allowlist" } }),
    ).toBe(1)
    expect(
      await prisma!.auditLog.count({ where: { action: "item.restore", entityId: spam.id } }),
    ).toBe(1)
  })

  it("test panel previews a draft rule without changing anything", async () => {
    const before = await prisma!.item.findMany({
      where: { organizationId: ORG },
      select: { id: true, status: true },
    })
    const res = await app().request("/api/filters/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "recent",
        rule: {
          name: "Archive questions",
          enabled: true,
          stopProcessing: false,
          dryRun: false,
          platforms: "all",
          itemTypes: "all",
          conditions: {
            id: "g",
            kind: "group",
            combinator: "and",
            children: [
              { id: "c", kind: "condition", field: "text", operator: "contains", value: "?" },
            ],
          },
          actions: [{ type: "archive" }],
        },
      }),
    })
    const body = await json<{ matched: number; wouldChange: number; total: number }>(res)
    expect(res.status).toBe(200)
    expect(body.matched).toBeGreaterThan(5)
    expect(body.wouldChange).toBeGreaterThan(0)
    const after = await prisma!.item.findMany({
      where: { organizationId: ORG },
      select: { id: true, status: true },
    })
    expect(after).toEqual(before)

    const sample = await json<{ rows: { matched: boolean; after: { decision: string } }[] }>(
      await app().request("/api/filters/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "sample",
          rule: {
            name: "x",
            enabled: true,
            stopProcessing: false,
            dryRun: false,
            platforms: "all",
            itemTypes: "all",
            conditions: {
              id: "g",
              kind: "group",
              combinator: "and",
              children: [{ id: "c", kind: "condition", field: "isEmojiOnly", operator: "isTrue" }],
            },
            actions: [{ type: "drop" }],
          },
          sample: { text: "🔥🔥🔥", platform: "instagram", type: "comment" },
        }),
      }),
    )
    expect(sample.rows[0]).toMatchObject({ matched: true, after: { decision: "drop" } })
  })

  it("rejects duplicate list entries and normalizes values", async () => {
    const add = () =>
      app().request("/api/lists", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ list: "blocklist", kind: "author_handle", value: "@Some.Troll" }),
      })
    const first = await add()
    expect(first.status).toBe(201)
    expect((await json<{ value: string }>(first)).value).toBe("some.troll")
    expect((await add()).status).toBe(409)
  })

  it("resolves and reopens an item", async () => {
    const inbox = await json<ItemListResponse>(await app().request("/api/items?limit=1"))
    const id = inbox.items[0]!.id
    expect((await app().request(`/api/items/${id}/resolve`, { method: "POST" })).status).toBe(200)
    const done = await json<ItemListResponse>(await app().request("/api/items?view=done"))
    expect(done.items.map((i) => i.id)).toContain(id)
    await app().request(`/api/items/${id}/reopen`, { method: "POST" })
    expect((await prisma!.item.findUniqueOrThrow({ where: { id } })).status).toBe("new")
  })

  it("returns item detail with matched rules and DM reply window", async () => {
    const dm = await prisma!.item.findFirstOrThrow({
      where: { organizationId: ORG, type: "dm", status: "new" },
    })
    const detail = await json<{ thread: unknown[]; replyWindow: { hours: number } | null }>(
      await app().request(`/api/items/${dm.id}`),
    )
    expect(detail.thread.length).toBeGreaterThan(0)
    expect(detail.replyWindow?.hours).toBe(24)
    expect((await app().request("/api/items/does-not-exist")).status).toBe(404)
  })

  it("moves later activity in a thread you resolved to Follow-ups", async () => {
    const parentId = await ingestComment("ig-thread-1", "Do you deliver to the old town?")
    // Already waiting when we resolve the parent: becomes a follow-up too.
    const earlyId = await ingestComment("ig-thread-1-a", "Also, is there a minimum order", {
      parentExternalId: "ig-thread-1",
      receivedAt: new Date(Date.now() + 1000),
    })
    expect((await app().request(`/api/items/${parentId}/resolve`, { method: "POST" })).status).toBe(
      200,
    )
    const lateId = await ingestComment("ig-thread-1-b", "Thanks, and on Sundays as well please", {
      parentExternalId: "ig-thread-1",
      receivedAt: new Date(Date.now() + 2000),
    })

    const inbox = await json<ItemListResponse>(await app().request("/api/items?limit=100"))
    const inboxIds = inbox.items.map((i) => i.id)
    expect(inboxIds).not.toContain(earlyId)
    expect(inboxIds).not.toContain(lateId)
    expect(inbox.counts.followUps).toBeGreaterThanOrEqual(2)
    expect(inbox.counts.inbox).toBe(inbox.items.length)

    const follow = await json<FollowUpListResponse>(await app().request("/api/items/follow-ups"))
    const thread = follow.threads.find((t) => t.item.id === lateId)
    expect(thread).toMatchObject({ newCount: 2, itemCount: 3 })
    expect(thread?.lastEngagedAt).not.toBeNull()
    // Threads with new activity come first.
    expect(follow.threads[0]!.newCount).toBeGreaterThan(0)

    const detail = await json<ItemDetail>(await app().request(`/api/items/${lateId}`))
    expect(detail.thread.map((t) => t.id)).toEqual([parentId, earlyId, lateId])
    expect(detail.isFollowUp).toBe(true)
    expect(detail.link).toMatchObject({ target: "post", url: "https://instagram.com/p/demo1" })
  })

  it("hide similar learns a phrase, archives the item and re-filters look-alikes", async () => {
    const firstId = await ingestComment("ig-lv-1", "Lovely plating chef 👌")
    const secondId = await ingestComment("ig-lv-2", "lovely plating, chef!!")
    const res = await app().request(`/api/items/${firstId}/hide-similar`, { method: "POST" })
    expect(res.status).toBe(200)
    const body = await json<HideSimilarResponse>(res)
    expect(body.phrase).toBe("lovely plating chef")
    expect(body.item.status).toBe("archived")
    expect(body.entryId).not.toBeNull()

    const second = await prisma!.item.findUniqueOrThrow({ where: { id: secondId } })
    expect(second.status).toBe("filtered")
    expect(second.tags).toContain("low-value")

    const question = await ingestComment("ig-lv-3", "Lovely plating, which plates are these?")
    const rejected = await app().request(`/api/items/${question}/hide-similar`, { method: "POST" })
    expect(rejected.status).toBe(400)
    expect(
      (await app("member").request(`/api/items/${secondId}/hide-similar`, { method: "POST" }))
        .status,
    ).toBe(403)
  })
})
