/**
 * Role-based access control, built on better-auth's access-control primitives so the
 * organization plugin (server + client) and our own API share one definition.
 *
 * - Roles (owner > admin > member) give a default permission set.
 * - Admins can give any non-owner member a custom set of *app* permissions
 *   (inbox, filters, connections, settings, activity, and which platforms they see).
 *   Organization-management permissions (members, invitations, …) always come from the role.
 * - Owners always have everything, so they can't be locked out.
 */
import { createAccessControl } from "better-auth/plugins/access"
import {
  adminAc,
  defaultStatements,
  memberAc,
  ownerAc,
} from "better-auth/plugins/organization/access"
import { z } from "zod"
import { PLATFORMS, type Platform } from "./filters/types"
import type { Role } from "./roles"

/** App resources an admin can grant per member. Order = order in the UI. */
export const appStatement = {
  /** Which platforms' items, accounts and sync schedules the member can see. */
  platform: PLATFORMS,
  inbox: ["read", "reply", "triage"],
  /** AI reply drafts: seeing them on items and asking for new ones. */
  ai: ["draft"],
  filter: ["read", "manage"],
  connection: ["read", "manage"],
  activity: ["read", "replay"],
  settings: ["manage"],
} as const

export const statement = { ...defaultStatements, ...appStatement } as const

export const ac = createAccessControl(statement)

type Statement = typeof statement
export type Resource = keyof Statement
export type AppResource = keyof typeof appStatement
export type ActionOf<R extends Resource> = Statement[R][number]
/** A set of permissions: resource → allowed actions. Missing resource = nothing allowed. */
export type PermissionMap = { [R in Resource]?: ActionOf<R>[] }
export type AppPermissionMap = { [R in AppResource]?: ActionOf<R>[] }

const ALL_APP = Object.fromEntries(
  Object.entries(appStatement).map(([r, actions]) => [r, [...actions]]),
) as Required<AppPermissionMap>

const MEMBER_APP: Required<AppPermissionMap> = {
  platform: [...PLATFORMS],
  inbox: ["read", "reply", "triage"],
  ai: ["draft"],
  filter: ["read"],
  connection: ["read"],
  activity: ["read"],
  settings: [],
}

export const owner = ac.newRole({ ...ownerAc.statements, ...ALL_APP })
export const admin = ac.newRole({ ...adminAc.statements, ...ALL_APP })
export const member = ac.newRole({ ...memberAc.statements, ...MEMBER_APP })

/** Pass to better-auth's `organization({ ac, roles })` and `organizationClient({ ac, roles })`. */
export const roles = { owner, admin, member }

const APP_RESOURCES = Object.keys(appStatement) as AppResource[]

function roleStatements(role: Role): PermissionMap {
  return roles[role].statements as unknown as PermissionMap
}

export function roleDefaults(role: Role): AppPermissionMap {
  return pickApp(roleStatements(role))
}

function pickApp(perms: PermissionMap): AppPermissionMap {
  const out: Record<string, string[]> = {}
  for (const r of APP_RESOURCES) out[r] = [...(perms[r] ?? [])]
  return out as AppPermissionMap
}

/** Stored per-member override (Member.permissions). `null` = use the role's defaults. */
export const appPermissionMapSchema = z.object(
  Object.fromEntries(
    APP_RESOURCES.map((r) => [
      r,
      z
        .array(z.enum(appStatement[r] as unknown as [string, ...string[]]))
        .max(appStatement[r].length)
        .transform((a) => [...new Set(a)])
        .default([]),
    ]),
  ) as unknown as { [R in AppResource]: z.ZodDefault<z.ZodType<ActionOf<R>[]>> },
)

/** Lenient read of the DB column: anything invalid falls back to the role's defaults. */
export function parseAppPermissions(raw: unknown): AppPermissionMap | null {
  if (raw == null) return null
  const value = typeof raw === "string" ? safeJson(raw) : raw
  const parsed = appPermissionMapSchema.safeParse(value)
  return parsed.success ? (parsed.data as AppPermissionMap) : null
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/** The permissions a member actually has: role defaults, with app permissions replaced by the override. */
export function effectivePermissions(
  role: Role,
  override: AppPermissionMap | null | undefined,
): PermissionMap {
  const base = roleStatements(role)
  if (role === "owner" || !override) return clone(base)
  return { ...clone(base), ...pickApp(override) }
}

function clone(perms: PermissionMap): PermissionMap {
  return Object.fromEntries(
    Object.entries(perms).map(([r, a]) => [r, [...(a as string[])]]),
  ) as PermissionMap
}

/** True when every requested action is allowed (better-auth's own `authorize`). */
export function can(perms: PermissionMap, request: PermissionMap): boolean {
  return ac.newRole(perms as never).authorize(request as never).success
}

/** Platforms the member may see. */
export function allowedPlatforms(perms: PermissionMap): Platform[] {
  return PLATFORMS.filter((p) => perms.platform?.includes(p))
}

/** True when `grant` gives nothing beyond `holder` (stops admins handing out what they lack). */
export function isWithin(grant: AppPermissionMap, holder: PermissionMap): boolean {
  return APP_RESOURCES.every((r) =>
    (grant[r] ?? []).every((a) => (holder[r] as string[] | undefined)?.includes(a)),
  )
}

/** Labels for the access editor. */
export const APP_PERMISSION_LABELS: {
  [R in AppResource]: {
    label: string
    description: string
    actions: { [A in ActionOf<R>]: string }
  }
} = {
  platform: {
    label: "Platforms",
    description: "Items, accounts and sync schedules they can see.",
    actions: {
      google_business: "Google Business",
      facebook: "Facebook",
      instagram: "Instagram",
      youtube: "YouTube",
      linkedin: "LinkedIn",
    },
  },
  inbox: {
    label: "Inbox",
    description: "Reviews, comments and DMs on their platforms.",
    actions: { read: "View", reply: "Reply", triage: "Resolve, ignore, archive" },
  },
  ai: {
    label: "AI",
    description: "AI-written reply suggestions.",
    actions: { draft: "See and generate AI reply drafts" },
  },
  filter: {
    label: "Filters",
    description: "Filter rules and lists.",
    actions: { read: "View", manage: "Create and edit" },
  },
  connection: {
    label: "Connections",
    description: "Connected pages, channels and locations.",
    actions: { read: "View", manage: "Connect, disconnect, run syncs" },
  },
  activity: {
    label: "Activity log",
    description: "Audit log, jobs and webhook deliveries.",
    actions: { read: "View", replay: "Replay webhooks" },
  },
  settings: {
    label: "Settings",
    description: "Workspace, sync, AI and reply settings.",
    actions: { manage: "Edit" },
  },
}
