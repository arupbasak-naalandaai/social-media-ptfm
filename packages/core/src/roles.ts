export const ROLES = ["owner", "admin", "member"] as const
export type Role = (typeof ROLES)[number]

const RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 }

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value)
}

/** True if `role` is at least `required` (owner > admin > member). */
export function hasRole(role: Role | null | undefined, required: Role): boolean {
  return role != null && RANK[role] >= RANK[required]
}

/** better-auth stores multiple roles as a comma-separated string. Returns the highest. */
export function parseMemberRole(raw: string | null | undefined): Role | null {
  if (!raw) return null
  const roles = raw
    .split(",")
    .map((r) => r.trim())
    .filter(isRole)
  if (roles.length === 0) return null
  return roles.reduce((best, r) => (RANK[r] > RANK[best] ? r : best))
}
