/**
 * The demo workspace (`pnpm db:seed`) is a separate organization marked by its `metadata`.
 * Real Google sign-ins never claim or join it, so a real account never sees demo content.
 * Only the signed-out local preview (DEV_AUTH_BYPASS) acts in it.
 */

/** `Organization.metadata` of the demo workspace. */
export const DEMO_ORG_METADATA = JSON.stringify({ demo: true })

export function isDemoOrganization(org: { metadata: string | null }): boolean {
  return org.metadata === DEMO_ORG_METADATA
}

/** Prisma `where` for organizations that are real workspaces (not the demo one). */
export function realOrganizationWhere() {
  return { OR: [{ metadata: null }, { metadata: { not: DEMO_ORG_METADATA } }] }
}

/** Sample block/allow entries the seed adds for the demo items (not real defaults). */
export const DEMO_SAMPLE_LIST_ENTRIES = [
  { list: "blocklist", kind: "author_handle", value: "known.troll" },
  { list: "blocklist", kind: "domain", value: "insta-boost.xyz" },
  { list: "allowlist", kind: "author_handle", value: "chef.marco" },
] as const
