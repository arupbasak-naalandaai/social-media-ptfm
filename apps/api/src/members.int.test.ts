/**
 * Members & access API against a real database (TEST_DATABASE_URL): listing, custom access,
 * the owner/self/escalation guards, and removal.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import {
  effectivePermissions,
  parseAppPermissions,
  parseGeneralSettings,
  type AppPermissionMap,
  type MemberDto,
  type MembersResponse,
  type Role,
} from "@inbox/core"
import { createLogger } from "@inbox/core/logger"
import { createPrismaClient } from "@inbox/db"
import { createApp } from "./app"
import { prismaOrgResolver } from "./middleware/session"
import type { JobSender } from "./lib/jobs"

const url = process.env.TEST_DATABASE_URL
const prisma = url ? createPrismaClient(url) : null
const logger = createLogger("test", { level: "silent", transport: undefined })
const ORG = "members-org"

const noJobs: JobSender = {
  enqueueRefilter: async () => {},
  enqueuePoll: async () => {},
  enqueueIngest: async () => {},
  enqueueAiDraft: async () => {},
  enqueueSendReply: async () => {},
  stop: async () => {},
}

/** Signed in as `userId`; role and custom access come from the real member row. */
function as(userId: string) {
  return createApp({
    auth: {
      handler: async () => new Response(null, { status: 404 }),
      getSession: async () => ({
        user: { id: userId, email: `${userId}@acme.io`, name: userId },
        session: { id: `s-${userId}`, activeOrganizationId: ORG },
      }),
    },
    orgs: prismaOrgResolver(prisma!),
    logger,
    checkDb: async () => true,
    prisma: prisma!,
    jobs: noJobs,
  })
}

async function addMember(userId: string, role: Role, permissions?: AppPermissionMap) {
  await prisma!.user.create({
    data: { id: userId, email: `${userId}@acme.io`, name: userId, emailVerified: true },
  })
  return prisma!.member.create({
    data: {
      id: `m-${userId}`,
      organizationId: ORG,
      userId,
      role,
      createdAt: new Date(),
      ...(permissions ? { permissions } : {}),
    },
  })
}

function patch(userId: string, memberId: string, body: unknown) {
  return as(userId).request(`/api/members/${memberId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe.skipIf(!url)("members & access API (integration)", () => {
  beforeEach(async () => {
    await prisma!.$executeRawUnsafe(
      'TRUNCATE "audit_log", "settings", "member", "session", "organization", "user" CASCADE',
    )
    await prisma!.organization.create({
      data: { id: ORG, name: "Acme", slug: "acme", createdAt: new Date() },
    })
    await prisma!.settings.create({
      data: {
        organizationId: ORG,
        general: {
          signInAllowlist: { emails: ["owner@acme.io", "dev@acme.io"], domains: ["acme.io"] },
        },
      },
    })
    await addMember("owner", "owner")
    await addMember("admin", "admin")
    await addMember("dev", "member")
  })

  afterAll(async () => prisma?.$disconnect())

  it("lists members for admins, not for members", async () => {
    const res = await as("admin").request("/api/members")
    expect(res.status).toBe(200)
    const body = (await res.json()) as MembersResponse
    expect(body.members.map((m) => [m.userId, m.role, m.custom])).toEqual([
      ["owner", "owner", false],
      ["admin", "admin", false],
      ["dev", "member", false],
    ])
    expect((await as("dev").request("/api/members")).status).toBe(403)
  })

  it("gives a member Facebook-only access, which applies on their next request", async () => {
    const access = { platform: ["facebook"], inbox: ["read", "reply"] }
    const res = await patch("admin", "m-dev", { permissions: access })
    expect(res.status).toBe(200)
    const dto = (await res.json()) as MemberDto
    expect(dto).toMatchObject({ custom: true, permissions: { platform: ["facebook"] } })

    const me = (await (await as("dev").request("/api/me")).json()) as {
      permissions: { platform: string[]; inbox: string[] }
    }
    expect(me.permissions.platform).toEqual(["facebook"])
    expect(me.permissions.inbox).toEqual(["read", "reply"])

    // Back to the role's defaults.
    await patch("admin", "m-dev", { permissions: null })
    const row = await prisma!.member.findUniqueOrThrow({ where: { id: "m-dev" } })
    expect(parseAppPermissions(row.permissions)).toBeNull()
    expect(await prisma!.auditLog.count({ where: { action: "member.update" } })).toBe(2)
  })

  it("never edits an owner or yourself", async () => {
    expect((await patch("admin", "m-owner", { role: "member" })).status).toBe(403)
    expect((await patch("admin", "m-admin", { role: "member" })).status).toBe(403)
  })

  it("stops an admin handing out access they don't have", async () => {
    await prisma!.member.update({
      where: { id: "m-admin" },
      data: {
        permissions: {
          ...effectivePermissions("admin", null),
          platform: ["facebook"],
        } as object,
      },
    })
    // The dev's member defaults include every platform: more than this admin holds.
    expect((await patch("admin", "m-dev", { role: "member" })).status).toBe(403)
    expect(
      (await patch("admin", "m-dev", { permissions: { platform: ["instagram"] } })).status,
    ).toBe(403)
    expect(
      (await patch("admin", "m-dev", { permissions: { platform: ["facebook"] } })).status,
    ).toBe(200)
    // The owner isn't limited.
    expect((await patch("owner", "m-dev", { role: "admin", permissions: null })).status).toBe(200)
  })

  it("removes a member, signs them out and takes them off the allowlist", async () => {
    await prisma!.session.create({
      data: {
        id: "sess-dev",
        token: "t-dev",
        userId: "dev",
        expiresAt: new Date(Date.now() + 86_400_000),
        activeOrganizationId: ORG,
      },
    })
    expect((await as("dev").request("/api/members/m-admin", { method: "DELETE" })).status).toBe(403)
    const res = await as("admin").request("/api/members/m-dev", { method: "DELETE" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ removed: true, stillAllowedByDomain: true })
    expect(await prisma!.member.count({ where: { id: "m-dev" } })).toBe(0)
    expect(await prisma!.session.count({ where: { userId: "dev" } })).toBe(0)
    const settings = await prisma!.settings.findUniqueOrThrow({ where: { organizationId: ORG } })
    expect(parseGeneralSettings(settings.general).signInAllowlist.emails).toEqual(["owner@acme.io"])
  })
})
