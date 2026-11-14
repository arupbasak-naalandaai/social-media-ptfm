/**
 * pnpm db:demo:remove [--dry-run]
 *
 * Removes demo content from real workspaces: the seeded demo platform accounts (and with them
 * their items, sync schedules, replies and drafts), seeded items, the demo-only sample list
 * entries, and the "Demo workspace" name. Needed once for databases where a real sign-in claimed
 * the seeded workspace before the demo got its own organization.
 *
 * Never touches the demo workspace itself, users, members, filter rules, settings or anything
 * from a really connected account.
 */
import path from "node:path"
import { DEMO_SAMPLE_LIST_ENTRIES, parseGeneralSettings, realOrganizationWhere } from "@inbox/core"
import { createLogger } from "@inbox/core/logger"
import { createPrismaClient, type Prisma } from "@inbox/db"

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../../../.env"))
} catch {
  // rely on process.env
}

const logger = createLogger("demo-remove")
const prisma = createPrismaClient()
const dryRun = process.argv.includes("--dry-run")

const DEMO_NAME = "Demo workspace"
const REAL_NAME = "My workspace"

async function main() {
  const orgs = await prisma.organization.findMany({
    where: realOrganizationWhere(),
    select: { id: true, name: true, slug: true },
  })
  for (const org of orgs) {
    const organizationId = org.id
    const demoAccounts = { organizationId, meta: { path: ["demo"], equals: true } }
    const accountIds = (
      await prisma.platformAccount.findMany({ where: demoAccounts, select: { id: true } })
    ).map((a) => a.id)
    const seededItems: Prisma.ItemWhereInput = {
      organizationId,
      OR: [{ platformAccountId: { in: accountIds } }, { raw: { path: ["seed"], equals: true } }],
    }
    const sampleEntries: Prisma.ListEntryWhereInput = {
      organizationId,
      platform: null,
      OR: DEMO_SAMPLE_LIST_ENTRIES.map((e) => ({ list: e.list, kind: e.kind, value: e.value })),
    }
    const plan = {
      demoAccounts: accountIds.length,
      items: await prisma.item.count({ where: seededItems }),
      sampleListEntries: await prisma.listEntry.count({ where: sampleEntries }),
      rename: org.name === DEMO_NAME,
    }
    if (!plan.demoAccounts && !plan.items && !plan.sampleListEntries && !plan.rename) {
      logger.info({ organizationId }, "no demo content")
      continue
    }
    if (dryRun) {
      logger.info({ organizationId, ...plan }, "dry run: would remove")
      continue
    }

    await prisma.$transaction(async (tx) => {
      await tx.item.deleteMany({ where: seededItems })
      // Accounts cascade to their sync schedules (and any remaining items).
      await tx.platformAccount.deleteMany({ where: { id: { in: accountIds } } })
      await tx.conversation.deleteMany({ where: { organizationId, items: { none: {} } } })
      await tx.listEntry.deleteMany({ where: sampleEntries })
      if (plan.rename) {
        await tx.organization.update({
          where: { id: organizationId },
          data: { name: REAL_NAME, ...(org.slug === "demo" ? { slug: "workspace" } : {}) },
        })
        const settings = await tx.settings.findUnique({ where: { organizationId } })
        if (settings) {
          const general = parseGeneralSettings(settings.general)
          if (general.organizationName === DEMO_NAME) {
            await tx.settings.update({
              where: { organizationId },
              data: {
                general: { ...general, organizationName: REAL_NAME } as Prisma.InputJsonObject,
              },
            })
          }
        }
      }
    })
    logger.info({ organizationId, ...plan }, "removed demo content")
  }
}

main()
  .catch((err) => {
    logger.error({ err }, "demo removal failed")
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
