import { randomUUID } from "node:crypto"
import type { Prisma, PrismaClient } from "@inbox/db"
import {
  defaultFilterRows,
  isEmailAllowed,
  realOrganizationWhere,
  parseBootstrapAllowlist,
  parseGeneralSettings,
  parseMemberRole,
  type GeneralSettings,
} from "@inbox/core"
import type { Logger } from "@inbox/core/logger"

export type AccessDecision = { allowed: true } | { allowed: false; reason: string }
export type SessionDecision =
  { allowed: true; organizationId: string } | { allowed: false; reason: string }

export const NOT_ALLOWLISTED =
  "Your Google account isn't on this workspace's allowlist. Ask an admin to add you."
export const BOOTSTRAP_RESTRICTED =
  "This workspace hasn't been set up yet, and your account isn't allowed to set it up."

const BOOTSTRAP_LOCK_KEY = 482_901_337 // arbitrary constant for pg_advisory_xact_lock

/**
 * Sign-in access rules:
 * - No organization yet → the first allowed Google account becomes owner of a new org
 *   (restricted to BOOTSTRAP_OWNER_EMAILS when set).
 * - Afterwards → an email must match an org's sign-in allowlist (exact email or domain).
 *   Owners are always allowed, so they can't lock themselves out.
 * - Checked again at every session creation, so allowlist removals apply at next sign-in.
 */
export function createAccessPolicy(
  prisma: PrismaClient,
  bootstrapOwnerEmails: string | undefined,
  logger?: Logger,
) {
  const bootstrapAllowlist = parseBootstrapAllowlist(bootstrapOwnerEmails)

  async function orgAllowlists(): Promise<{ organizationId: string; general: GeneralSettings }[]> {
    const rows = await prisma.settings.findMany({
      // The demo workspace is never joinable, whatever its allowlist says.
      where: { organization: realOrganizationWhere() },
      select: { organizationId: true, general: true },
    })
    return rows.map((r) => ({
      organizationId: r.organizationId,
      general: parseGeneralSettings(r.general),
    }))
  }

  async function matchingOrganizationIds(email: string): Promise<string[]> {
    const lists = await orgAllowlists()
    return lists
      .filter((l) => isEmailAllowed(email, l.general.signInAllowlist))
      .map((l) => l.organizationId)
  }

  /** No owner yet (fresh DB, or only the seeded demo org): the next allowed user claims it. */
  async function needsOwner(client: Pick<PrismaClient, "member">): Promise<boolean> {
    return (await client.member.count({ where: { role: { contains: "owner" } } })) === 0
  }

  async function canCreateUser(email: string): Promise<AccessDecision> {
    if (await needsOwner(prisma)) {
      if (bootstrapAllowlist && !isEmailAllowed(email, bootstrapAllowlist)) {
        logger?.warn({ email }, "auth: bootstrap sign-in rejected (BOOTSTRAP_OWNER_EMAILS)")
        return { allowed: false, reason: BOOTSTRAP_RESTRICTED }
      }
      return { allowed: true }
    }
    const matches = await matchingOrganizationIds(email)
    if (matches.length === 0) {
      logger?.warn({ email }, "auth: sign-up rejected (not on allowlist)")
      return { allowed: false, reason: NOT_ALLOWLISTED }
    }
    return { allowed: true }
  }

  /** Makes the first user owner (claiming an existing org or creating one), or auto-joins allowlisted orgs. */
  async function onUserCreated(user: { id: string; email: string; name: string }): Promise<void> {
    await prisma.$transaction(async (tx) => {
      // Serialize bootstrap so two simultaneous first sign-ins can't both become owner.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`

      if (await needsOwner(tx)) {
        // Claim the oldest real org (never the seeded demo workspace) or create a fresh one.
        const existing = await tx.organization.findFirst({
          where: realOrganizationWhere(),
          orderBy: { createdAt: "asc" },
          select: { id: true, name: true },
        })
        const organizationId = existing?.id ?? randomUUID()
        if (!existing) {
          await tx.organization.create({
            data: {
              id: organizationId,
              name: "My workspace",
              slug: "workspace",
              createdAt: new Date(),
            },
          })
        }
        const current = await tx.settings.findUnique({ where: { organizationId } })
        const prior = parseGeneralSettings(current?.general)
        const email = user.email.toLowerCase()
        const general: GeneralSettings = {
          ...prior,
          organizationName: existing?.name ?? prior.organizationName,
          signInAllowlist: {
            ...prior.signInAllowlist,
            emails: [...new Set([...prior.signInAllowlist.emails, email])],
          },
        }
        // Default filter rules and lists (only the missing ones, so a claimed org keeps its edits).
        const defaults = defaultFilterRows(organizationId)
        await tx.filterRule.createMany({
          data: defaults.rules as Prisma.FilterRuleCreateManyInput[],
          skipDuplicates: true,
        })
        await tx.listEntry.createMany({ data: defaults.lists, skipDuplicates: true })
        await tx.member.deleteMany({ where: { organizationId, userId: user.id } })
        await tx.member.create({
          data: {
            id: randomUUID(),
            organizationId,
            userId: user.id,
            role: "owner",
            createdAt: new Date(),
          },
        })
        await tx.settings.upsert({
          where: { organizationId },
          create: { organizationId, general, updatedById: user.id },
          update: { general, updatedById: user.id },
        })
        await tx.auditLog.create({
          data: {
            organizationId,
            actorId: user.id,
            action: "organization.bootstrap",
            entity: "organization",
            entityId: organizationId,
            after: { ownerEmail: user.email, claimedExistingOrg: Boolean(existing) },
          },
        })
        logger?.info(
          { organizationId, userId: user.id },
          "auth: bootstrapped organization; first user is owner",
        )
        return
      }

      const rows = await tx.settings.findMany({
        where: { organization: realOrganizationWhere() },
        select: { organizationId: true, general: true },
      })
      for (const row of rows) {
        if (!isEmailAllowed(user.email, parseGeneralSettings(row.general).signInAllowlist)) continue
        await joinAsMember(tx, row.organizationId, user.id)
      }
    })
  }

  async function canStartSession(userId: string): Promise<SessionDecision> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } })
    if (!user) return { allowed: false, reason: NOT_ALLOWLISTED }

    const lists = new Map((await orgAllowlists()).map((l) => [l.organizationId, l.general]))
    const memberships = await prisma.member.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: { organizationId: true, role: true },
    })

    for (const m of memberships) {
      const role = parseMemberRole(m.role)
      const general = lists.get(m.organizationId)
      if (role === "owner") return { allowed: true, organizationId: m.organizationId }
      if (general && isEmailAllowed(user.email, general.signInAllowlist)) {
        return { allowed: true, organizationId: m.organizationId }
      }
    }

    // Existing account that was added to an allowlist later: join that org now.
    for (const [organizationId, general] of lists) {
      if (!isEmailAllowed(user.email, general.signInAllowlist)) continue
      await prisma.$transaction((tx) => joinAsMember(tx, organizationId, userId))
      return { allowed: true, organizationId }
    }

    logger?.warn({ userId, email: user.email }, "auth: session rejected (not on allowlist)")
    return { allowed: false, reason: NOT_ALLOWLISTED }
  }

  return { canCreateUser, onUserCreated, canStartSession }
}

type Tx = Prisma.TransactionClient

async function joinAsMember(tx: Tx, organizationId: string, userId: string): Promise<void> {
  const existing = await tx.member.findFirst({
    where: { organizationId, userId },
    select: { id: true },
  })
  if (existing) return
  await tx.member.create({
    data: { id: randomUUID(), organizationId, userId, role: "member", createdAt: new Date() },
  })
  await tx.auditLog.create({
    data: {
      organizationId,
      actorId: userId,
      action: "member.auto_join",
      entity: "member",
      entityId: userId,
      after: { role: "member", via: "sign_in_allowlist" },
    },
  })
}
