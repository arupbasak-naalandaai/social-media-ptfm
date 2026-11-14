/**
 * Integration tests for the sign-in access policy, run through better-auth's own
 * internal adapter so the real databaseHooks fire (same path as the Google OAuth / One Tap
 * callbacks). Requires TEST_DATABASE_URL (a migrated, disposable database).
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { createPrismaClient } from "@inbox/db"
import { DEFAULT_RULES, DEMO_ORG_METADATA, parseGeneralSettings } from "@inbox/core"
import { createAuth } from "./auth"
import { BOOTSTRAP_RESTRICTED, NOT_ALLOWLISTED } from "./access"

const url = process.env.TEST_DATABASE_URL
const prisma = url ? createPrismaClient(url) : null

function makeAuth(bootstrapOwnerEmails?: string) {
  return createAuth(prisma!, {
    webUrl: "http://localhost:3000",
    secret: "test-secret-test-secret-test-secret-123",
    googleClientId: "test-client-id",
    googleClientSecret: "test-client-secret",
    bootstrapOwnerEmails,
  })
}

async function signUp(auth: ReturnType<typeof makeAuth>, email: string) {
  const ctx = await auth.$context
  return ctx.internalAdapter.createUser(
    { email, name: email.split("@")[0]!, emailVerified: true },
    { method: "oauth", oauth: { providerId: "google" } },
  )
}

async function startSession(auth: ReturnType<typeof makeAuth>, userId: string) {
  const ctx = await auth.$context
  // The core Session type doesn't include the organization plugin's field.
  return (await ctx.internalAdapter.createSession(userId)) as Awaited<
    ReturnType<typeof ctx.internalAdapter.createSession>
  > & { activeOrganizationId?: string | null }
}

async function setAllowlist(emails: string[], domains: string[]) {
  const settings = await prisma!.settings.findFirstOrThrow()
  const general = parseGeneralSettings(settings.general)
  await prisma!.settings.update({
    where: { organizationId: settings.organizationId },
    data: { general: { ...general, signInAllowlist: { emails, domains } } },
  })
}

describe.skipIf(!url)("sign-in access policy (integration)", () => {
  beforeEach(async () => {
    await prisma!.$executeRawUnsafe(
      'TRUNCATE "audit_log", "settings", "invitation", "member", "organization", "session", "account", "verification", "user" CASCADE',
    )
  })

  afterAll(async () => {
    await prisma?.$disconnect()
  })

  it("makes the first user the owner of a new organization", async () => {
    const auth = makeAuth()
    const owner = await signUp(auth, "Owner@Example.com")

    const org = await prisma!.organization.findFirstOrThrow()
    const member = await prisma!.member.findFirstOrThrow({ where: { userId: owner.id } })
    expect(member).toMatchObject({ organizationId: org.id, role: "owner" })

    const settings = await prisma!.settings.findUniqueOrThrow({ where: { organizationId: org.id } })
    expect(parseGeneralSettings(settings.general).signInAllowlist.emails).toEqual([
      "owner@example.com",
    ])

    const session = await startSession(auth, owner.id)
    expect(session.activeOrganizationId).toBe(org.id)

    const audit = await prisma!.auditLog.findFirstOrThrow({
      where: { action: "organization.bootstrap" },
    })
    expect(audit.actorId).toBe(owner.id)
  })

  it("rejects a second user who is not on the allowlist", async () => {
    const auth = makeAuth()
    await signUp(auth, "owner@example.com")
    await expect(signUp(auth, "stranger@other.com")).rejects.toThrow(NOT_ALLOWLISTED)
    expect(await prisma!.user.count()).toBe(1)
  })

  it("lets allowlisted domains in as members, and removal blocks the next session", async () => {
    const auth = makeAuth()
    await signUp(auth, "owner@example.com")
    await setAllowlist(["owner@example.com"], ["acme.io"])

    const dev = await signUp(auth, "dev@acme.io")
    const member = await prisma!.member.findFirstOrThrow({ where: { userId: dev.id } })
    expect(member.role).toBe("member")
    await expect(startSession(auth, dev.id)).resolves.toMatchObject({ userId: dev.id })

    await setAllowlist(["owner@example.com"], [])
    await expect(startSession(auth, dev.id)).rejects.toThrow(NOT_ALLOWLISTED)
  })

  it("never locks the owner out, even if they remove themselves from the allowlist", async () => {
    const auth = makeAuth()
    const owner = await signUp(auth, "owner@example.com")
    await setAllowlist([], [])
    await expect(startSession(auth, owner.id)).resolves.toMatchObject({ userId: owner.id })
  })

  it("auto-joins an existing account once it is added to the allowlist", async () => {
    const auth = makeAuth()
    await signUp(auth, "owner@example.com")
    await setAllowlist(["owner@example.com"], ["acme.io"])
    const dev = await signUp(auth, "dev@acme.io")
    await prisma!.member.deleteMany({ where: { userId: dev.id } })

    const session = await startSession(auth, dev.id)
    expect(session.activeOrganizationId).toBeTruthy()
    expect(await prisma!.member.count({ where: { userId: dev.id } })).toBe(1)
  })

  it("restricts the first owner to BOOTSTRAP_OWNER_EMAILS when set", async () => {
    const auth = makeAuth("boss@corp.com, partner.org")
    await expect(signUp(auth, "random@gmail.com")).rejects.toThrow(BOOTSTRAP_RESTRICTED)
    expect(await prisma!.organization.count()).toBe(0)

    const boss = await signUp(auth, "boss@corp.com")
    expect(
      await prisma!.member.findFirst({ where: { userId: boss.id, role: "owner" } }),
    ).not.toBeNull()
  })

  it("lets the first real user claim an existing real org that has no owner", async () => {
    const auth = makeAuth()
    await prisma!.organization.create({
      data: { id: "seeded-org", name: "Demo workspace", slug: "demo", createdAt: new Date() },
    })
    await prisma!.settings.create({
      data: { organizationId: "seeded-org", general: { organizationName: "Demo workspace" } },
    })

    const owner = await signUp(auth, "me@example.com")
    expect(await prisma!.organization.count()).toBe(1)
    const member = await prisma!.member.findFirstOrThrow({ where: { userId: owner.id } })
    expect(member).toMatchObject({ organizationId: "seeded-org", role: "owner" })
    const settings = await prisma!.settings.findUniqueOrThrow({
      where: { organizationId: "seeded-org" },
    })
    expect(parseGeneralSettings(settings.general)).toMatchObject({
      organizationName: "Demo workspace",
      signInAllowlist: { emails: ["me@example.com"] },
    })

    // The org now has an owner, so a stranger is rejected.
    await expect(signUp(auth, "stranger@other.com")).rejects.toThrow(NOT_ALLOWLISTED)
  })

  it("never puts a real account in the demo workspace", async () => {
    const auth = makeAuth()
    await prisma!.organization.create({
      data: {
        id: "demo-x",
        name: "Demo workspace",
        slug: "demo",
        metadata: DEMO_ORG_METADATA,
        createdAt: new Date(),
      },
    })
    // Even an allowlist that matches everyone doesn't let anyone join it.
    await prisma!.settings.create({
      data: {
        organizationId: "demo-x",
        general: { signInAllowlist: { emails: [], domains: ["example.com"] } },
      },
    })

    const owner = await signUp(auth, "me@example.com")
    const member = await prisma!.member.findFirstOrThrow({ where: { userId: owner.id } })
    expect(member.organizationId).not.toBe("demo-x")
    expect(member.role).toBe("owner")
    expect(await prisma!.member.count({ where: { organizationId: "demo-x" } })).toBe(0)

    // The new real workspace starts with the default filters, and no demo content.
    expect(
      await prisma!.filterRule.count({ where: { organizationId: member.organizationId } }),
    ).toBe(DEFAULT_RULES.length)
    expect(
      await prisma!.listEntry.count({ where: { organizationId: member.organizationId } }),
    ).toBeGreaterThan(0)
    expect(
      await prisma!.platformAccount.count({ where: { organizationId: member.organizationId } }),
    ).toBe(0)

    const colleague = await signUp(auth, "colleague@example.com").catch(() => null)
    expect(colleague).toBeNull()
    const session = await startSession(auth, owner.id)
    expect(session.activeOrganizationId).toBe(member.organizationId)
  })
})
