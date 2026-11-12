import { z } from "zod"

const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((d) => d.replace(/^@/, ""))
  .pipe(z.string().regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/, "Enter a domain like example.com"))

export const signInAllowlistSchema = z.object({
  emails: z.array(z.email().trim().toLowerCase()).default([]),
  domains: z.array(domainSchema).default([]),
})
export type SignInAllowlist = z.infer<typeof signInAllowlistSchema>

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@")
  return at === -1 ? "" : normalizeEmail(email.slice(at + 1))
}

/** Exact email match or exact domain match (no subdomain wildcarding). */
export function isEmailAllowed(email: string, allowlist: SignInAllowlist): boolean {
  const normalized = normalizeEmail(email)
  if (allowlist.emails.some((e) => normalizeEmail(e) === normalized)) return true
  const domain = emailDomain(normalized)
  return domain !== "" && allowlist.domains.some((d) => d.toLowerCase() === domain)
}

/**
 * Parses BOOTSTRAP_OWNER_EMAILS ("a@x.com, @example.com, example.org").
 * Entries with "@" in the middle are emails; the rest are domains.
 */
export function parseBootstrapAllowlist(raw: string | undefined): SignInAllowlist | null {
  if (!raw || raw.trim() === "") return null
  const emails: string[] = []
  const domains: string[] = []
  for (const part of raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)) {
    if (part.indexOf("@") > 0) emails.push(normalizeEmail(part))
    else domains.push(part.replace(/^@/, "").toLowerCase())
  }
  return signInAllowlistSchema.parse({ emails, domains })
}
