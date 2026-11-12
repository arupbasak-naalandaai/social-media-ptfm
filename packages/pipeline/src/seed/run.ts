/**
 * pnpm db:seed [--reset]
 *
 * Creates (or reuses) a demo organization with demo platform accounts, the default filter rules,
 * default keyword/domain lists, sample block/allow entries, and ~100 items ingested through the
 * real pipeline (so the Filtered tab shows actual rule decisions).
 *
 * Idempotent: rules and lists are only created when missing (user edits are kept), items are
 * de-duplicated by external id. --reset deletes this org's items, conversations and rule matches
 * first (never users, rules or settings).
 */
import path from "node:path"
import {
  DEFAULT_RULES,
  DEFAULT_SPAM_KEYWORDS,
  DEFAULT_TRUSTED_DOMAINS,
  type ListEntry,
} from "@inbox/core"
import { createLogger } from "@inbox/core/logger"
import { createPrismaClient, type Prisma } from "@inbox/db"
import { loadFilterSetup } from "../context"
import { ingestNormalizedItem } from "../ingest"
import { buildSeedItems, SEED_ACCOUNTS } from "./fixtures"

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../../../.env"))
} catch {
  // rely on process.env
}

const logger = createLogger("seed")
const prisma = createPrismaClient()
const reset = process.argv.includes("--reset")

const SAMPLE_LISTS: Omit<ListEntry, "platform">[] = [
  ...DEFAULT_SPAM_KEYWORDS.map((value) => ({
    list: "spam_keywords" as const,
    kind: "keyword" as const,
    value,
  })),
  ...DEFAULT_TRUSTED_DOMAINS.map((value) => ({
    list: "trusted_domains" as const,
    kind: "domain" as const,
    value,
  })),
  { list: "blocklist", kind: "author_handle", value: "known.troll" },
  { list: "blocklist", kind: "domain", value: "insta-boost.xyz" },
  { list: "allowlist", kind: "author_handle", value: "chef.marco" },
]

async function main() {
  // 1. Organization: reuse the oldest one (the real workspace if someone already signed in).
  let org = await prisma.organization.findFirst({ orderBy: { createdAt: "asc" } })
  if (!org) {
    org = await prisma.organization.create({
      data: { id: "demo-org", name: "Demo workspace", slug: "demo", createdAt: new Date() },
    })
    logger.info("created demo organization (the first Google sign-in will claim it as owner)")
  }
  const organizationId = org.id
  await prisma.settings.upsert({
    where: { organizationId },
    create: {
      organizationId,
      general: {
        organizationName: org.name,
        timezone: "UTC",
        signInAllowlist: { emails: [], domains: [] },
      },
    },
    update: {},
  })

  if (reset) {
    const deleted = await prisma.item.deleteMany({
      where: { organizationId, raw: { path: ["seed"], equals: true } },
    })
    await prisma.conversation.deleteMany({ where: { organizationId, items: { none: {} } } })
    logger.info({ deleted: deleted.count }, "reset: removed seeded items")
  }

  // 2. Default rules: create missing ones only, so edits survive re-seeding.
  let createdRules = 0
  for (const def of DEFAULT_RULES) {
    const { defaultKey, ...rule } = def
    const exists = await prisma.filterRule.findUnique({
      where: { organizationId_defaultKey: { organizationId, defaultKey } },
      select: { id: true },
    })
    if (exists) continue
    await prisma.filterRule.create({
      data: {
        organizationId,
        defaultKey,
        isDefault: true,
        name: rule.name,
        description: rule.description ?? null,
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
    createdRules++
  }

  // 3. Lists.
  const listResult = await prisma.listEntry.createMany({
    data: SAMPLE_LISTS.map((e) => ({
      organizationId,
      list: e.list,
      kind: e.kind,
      value: e.value,
      platform: null,
    })),
    skipDuplicates: true,
  })

  // 4. Demo platform accounts (no tokens: they can't sync or send until really connected).
  const accountIds = new Map<string, string>()
  for (const a of SEED_ACCOUNTS) {
    const acc = await prisma.platformAccount.upsert({
      where: {
        organizationId_platform_externalId: {
          organizationId,
          platform: a.platform,
          externalId: a.externalId,
        },
      },
      create: {
        organizationId,
        platform: a.platform,
        kind: a.kind,
        externalId: a.externalId,
        displayName: a.displayName,
        status: "disconnected",
        meta: { demo: true, handle: a.handle },
      },
      update: {},
      select: { id: true },
    })
    accountIds.set(a.key, acc.id)
  }

  // 5. Items through the real pipeline.
  const setup = await loadFilterSetup(prisma, organizationId, logger)
  const counts = { created: 0, dropped: 0, duplicate: 0, updated: 0, shown: 0, filtered: 0 }
  for (const { accountKey, item } of buildSeedItems()) {
    const res = await ingestNormalizedItem(prisma, {
      organizationId,
      platformAccountId: accountIds.get(accountKey)!,
      item,
      setup,
    })
    counts[res.outcome]++
    if (res.outcome === "created") counts[res.result.decision === "show" ? "shown" : "filtered"]++
  }

  logger.info(
    { organizationId, rulesCreated: createdRules, listEntriesCreated: listResult.count, ...counts },
    "seed complete",
  )
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, "seed failed")
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
