import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import {
  effectivePermissions,
  emailDomain,
  isWithin,
  memberUpdateSchema,
  normalizeEmail,
  parseAppPermissions,
  parseGeneralSettings,
  parseMemberRole,
  roleDefaults,
  type AppPermissionMap,
  type MemberDto,
  type MemberRemovedResponse,
  type MembersResponse,
  type PermissionMap,
  type Role,
} from "@inbox/core"
import { Prisma, type PrismaClient } from "@inbox/db"
import { validate } from "../lib/validate"
import { requireAuth, requirePermission } from "../middleware/session"
import type { AppEnv, OrgContext } from "../types"

export interface MemberRouteDeps {
  prisma: PrismaClient
}

const idParam = z.object({ id: z.string().min(1).max(64) })

const memberSelect = {
  id: true,
  userId: true,
  role: true,
  permissions: true,
  createdAt: true,
  user: { select: { name: true, email: true, image: true } },
} satisfies Prisma.MemberSelect

type MemberRow = Prisma.MemberGetPayload<{ select: typeof memberSelect }>

function appOnly(perms: PermissionMap): AppPermissionMap {
  const { platform, inbox, ai, filter, connection, activity, settings } = perms
  return {
    platform: [...(platform ?? [])],
    inbox: [...(inbox ?? [])],
    ai: [...(ai ?? [])],
    filter: [...(filter ?? [])],
    connection: [...(connection ?? [])],
    activity: [...(activity ?? [])],
    settings: [...(settings ?? [])],
  }
}

function toDto(row: MemberRow, selfId: string): MemberDto {
  const role: Role = parseMemberRole(row.role) ?? "member"
  const override = role === "owner" ? null : parseAppPermissions(row.permissions)
  return {
    id: row.id,
    userId: row.userId,
    name: row.user.name,
    email: row.user.email,
    image: row.user.image,
    role,
    custom: override !== null,
    permissions: appOnly(effectivePermissions(role, override)),
    joinedAt: row.createdAt.toISOString(),
    isSelf: row.userId === selfId,
  }
}

/**
 * Members and their access. Who can do what:
 * - Listing and editing need `member:update` (owners and admins by default); removing needs
 *   `member:delete`.
 * - Nobody edits an owner or themselves (no self-lockout, no self-promotion).
 * - A non-owner can only hand out permissions they hold themselves.
 */
export function memberRoutes({ prisma }: MemberRouteDeps) {
  async function findTarget(org: OrgContext, id: string, selfId: string) {
    const row = await prisma.member.findFirst({
      where: { id, organizationId: org.id },
      select: memberSelect,
    })
    if (!row) throw new HTTPException(404, { message: "Member not found" })
    if (parseMemberRole(row.role) === "owner") {
      throw new HTTPException(403, { message: "Owners always have full access" })
    }
    if (row.userId === selfId) {
      throw new HTTPException(403, { message: "You can't change your own access" })
    }
    return row
  }

  return (
    new Hono<AppEnv>()
      .use("*", requireAuth)

      .get("/", requirePermission({ member: ["update"] }), async (c) => {
        const org = c.get("org")!
        const user = c.get("user")!
        const rows = await prisma.member.findMany({
          where: { organizationId: org.id },
          orderBy: { createdAt: "asc" },
          select: memberSelect,
        })
        const body: MembersResponse = {
          members: rows.map((r) => toDto(r, user.id)),
          roleDefaults: { admin: roleDefaults("admin"), member: roleDefaults("member") },
          grantable: appOnly(org.permissions),
        }
        return c.json(body)
      })

      .patch(
        "/:id",
        requirePermission({ member: ["update"] }),
        validate("param", idParam),
        validate("json", memberUpdateSchema),
        async (c) => {
          const org = c.get("org")!
          const user = c.get("user")!
          const { id } = c.req.valid("param")
          const patch = c.req.valid("json")
          const row = await findTarget(org, id, user.id)

          const beforeRole: Role = parseMemberRole(row.role) ?? "member"
          const beforeOverride = parseAppPermissions(row.permissions)
          const role: Role = patch.role ?? beforeRole
          const override =
            patch.permissions === undefined
              ? beforeOverride
              : (patch.permissions as AppPermissionMap | null)

          const next = effectivePermissions(role, override)
          if (org.role !== "owner" && !isWithin(appOnly(next), org.permissions)) {
            throw new HTTPException(403, {
              message: "You can only give access you have yourself",
            })
          }
          if (org.role !== "owner" && role === "admin" && beforeRole !== "admin") {
            // Admin's org permissions (members, invitations) come from the role itself.
            const admins = effectivePermissions("admin", null)
            if (!admins.member?.every((a) => org.permissions.member?.includes(a))) {
              throw new HTTPException(403, { message: "You can't make someone an admin" })
            }
          }

          const updated = await prisma.member.update({
            where: { id },
            data: {
              role,
              permissions: override === null ? Prisma.DbNull : (override as Prisma.InputJsonValue),
            },
            select: memberSelect,
          })
          await prisma.auditLog.create({
            data: {
              organizationId: org.id,
              actorId: user.id,
              action: "member.update",
              entity: "member",
              entityId: row.userId,
              before: { role: beforeRole, permissions: beforeOverride } as Prisma.InputJsonValue,
              after: { role, permissions: override } as Prisma.InputJsonValue,
            },
          })
          return c.json(toDto(updated, user.id))
        },
      )

      /**
       * Removes the member, signs them out, and takes their exact email off the sign-in
       * allowlist (otherwise they'd re-join at their next sign-in).
       */
      .delete(
        "/:id",
        requirePermission({ member: ["delete"] }),
        validate("param", idParam),
        async (c) => {
          const org = c.get("org")!
          const user = c.get("user")!
          const { id } = c.req.valid("param")
          const row = await findTarget(org, id, user.id)
          const email = normalizeEmail(row.user.email)

          const stillAllowedByDomain = await prisma.$transaction(async (tx) => {
            await tx.member.delete({ where: { id } })
            await tx.session.deleteMany({
              where: { userId: row.userId, activeOrganizationId: org.id },
            })
            const settings = await tx.settings.findUnique({
              where: { organizationId: org.id },
              select: { general: true },
            })
            const general = parseGeneralSettings(settings?.general)
            const emails = general.signInAllowlist.emails.filter((e) => normalizeEmail(e) !== email)
            if (settings && emails.length !== general.signInAllowlist.emails.length) {
              await tx.settings.update({
                where: { organizationId: org.id },
                data: {
                  general: { ...general, signInAllowlist: { ...general.signInAllowlist, emails } },
                  updatedById: user.id,
                },
              })
            }
            await tx.auditLog.create({
              data: {
                organizationId: org.id,
                actorId: user.id,
                action: "member.remove",
                entity: "member",
                entityId: row.userId,
                before: { email, role: row.role },
              },
            })
            return general.signInAllowlist.domains.includes(emailDomain(email))
          })

          const body: MemberRemovedResponse = { removed: true, stillAllowedByDomain }
          return c.json(body)
        },
      )
  )
}
