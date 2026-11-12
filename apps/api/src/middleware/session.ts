import { createMiddleware } from "hono/factory"
import { HTTPException } from "hono/http-exception"
import { hasRole, parseMemberRole, type Role } from "@inbox/core"
import type { PrismaClient } from "@inbox/db"
import type { AppEnv, AuthLike, OrgContext } from "../types"

export interface OrgResolver {
  resolve(userId: string, organizationId: string): Promise<OrgContext | null>
}

export function prismaOrgResolver(prisma: PrismaClient): OrgResolver {
  return {
    async resolve(userId, organizationId) {
      const member = await prisma.member.findFirst({
        where: { userId, organizationId },
        select: { role: true, organization: { select: { id: true, name: true } } },
      })
      const role = parseMemberRole(member?.role)
      if (!member || !role) return null
      return { id: member.organization.id, name: member.organization.name, role }
    },
  }
}

/**
 * DEV_AUTH_BYPASS: a virtual, signed-out "preview" identity for local UI work.
 * Nothing is written to the database, so the first real Google sign-in still becomes owner.
 */
export interface DevPreview {
  role: Role
  /** The org the preview acts in: the first real org if one exists, else a virtual one. */
  resolveOrg(): Promise<{ id: string; name: string }>
}

export const PREVIEW_USER = {
  id: "dev-preview-user",
  email: "preview@localhost",
  name: "Preview (no login)",
  image: null,
} as const

export function prismaDevPreview(prisma: PrismaClient, role: Role): DevPreview {
  return {
    role,
    async resolveOrg() {
      const org = await prisma.organization.findFirst({
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true },
      })
      return org ?? { id: "dev-preview-org", name: "Preview workspace" }
    },
  }
}

/** Loads the session (if any) and the active organization + role. Never rejects by itself. */
export function sessionMiddleware(auth: AuthLike, orgs: OrgResolver, devPreview?: DevPreview) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const result = await auth.getSession(c.req.raw.headers)
    c.set("preview", false)

    // A real session always wins over the preview identity.
    if (!result && devPreview) {
      const org = await devPreview.resolveOrg()
      c.set("user", { ...PREVIEW_USER })
      c.set("session", { id: "dev-preview-session", activeOrganizationId: org.id })
      c.set("org", { ...org, role: devPreview.role })
      c.set("preview", true)
      await next()
      return
    }

    c.set("user", result?.user ?? null)
    c.set("session", result?.session ?? null)
    const orgId = result?.session.activeOrganizationId
    c.set("org", result && orgId ? await orgs.resolve(result.user.id, orgId) : null)
    await next()
  })
}

/** 401 without a session; 403 without an active organization membership. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get("user")) throw new HTTPException(401, { message: "Sign in required" })
  if (!c.get("org")) throw new HTTPException(403, { message: "No active organization" })
  await next()
})

/** Use after requireAuth. Owner > admin > member. */
export function requireRole(required: Role) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!hasRole(c.get("org")?.role, required)) {
      throw new HTTPException(403, { message: `Requires ${required} role` })
    }
    await next()
  })
}
