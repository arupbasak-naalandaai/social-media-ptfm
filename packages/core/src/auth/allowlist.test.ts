import { describe, expect, it } from "vitest"
import { isEmailAllowed, parseBootstrapAllowlist, signInAllowlistSchema } from "./allowlist"

describe("isEmailAllowed", () => {
  const allowlist = signInAllowlistSchema.parse({
    emails: ["Owner@Example.com"],
    domains: ["acme.io", "@partner.org"],
  })

  it.each([
    ["owner@example.com", true, "exact email, case-insensitive"],
    ["OWNER@EXAMPLE.COM", true, "upper-case email"],
    ["someone@acme.io", true, "domain match"],
    ["x@partner.org", true, "domain entered with leading @"],
    ["x@sub.acme.io", false, "subdomains are not wildcarded"],
    ["x@acme.io.evil.com", false, "suffix trick"],
    ["other@example.com", false, "same domain as an email entry is not enough"],
    ["no-at-sign", false, "malformed email"],
  ])("%s → %s (%s)", (email, expected) => {
    expect(isEmailAllowed(email, allowlist)).toBe(expected)
  })

  it("rejects everything for an empty allowlist", () => {
    expect(isEmailAllowed("a@b.com", { emails: [], domains: [] })).toBe(false)
  })
})

describe("signInAllowlistSchema", () => {
  it("rejects invalid domains", () => {
    expect(signInAllowlistSchema.safeParse({ domains: ["not a domain"] }).success).toBe(false)
  })
  it("rejects invalid emails", () => {
    expect(signInAllowlistSchema.safeParse({ emails: ["nope"] }).success).toBe(false)
  })
})

describe("parseBootstrapAllowlist", () => {
  it("returns null when unset or blank", () => {
    expect(parseBootstrapAllowlist(undefined)).toBeNull()
    expect(parseBootstrapAllowlist("  ")).toBeNull()
  })
  it("splits emails and domains", () => {
    expect(parseBootstrapAllowlist("me@x.com, @acme.io, example.org")).toEqual({
      emails: ["me@x.com"],
      domains: ["acme.io", "example.org"],
    })
  })
})
