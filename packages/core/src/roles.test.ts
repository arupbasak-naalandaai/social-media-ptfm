import { describe, expect, it } from "vitest"
import { hasRole, parseMemberRole } from "./roles"

describe("roles", () => {
  it.each([
    ["owner", "admin", true],
    ["admin", "admin", true],
    ["member", "admin", false],
    ["owner", "owner", true],
    ["admin", "owner", false],
    [null, "member", false],
  ] as const)("hasRole(%s, %s) = %s", (role, required, expected) => {
    expect(hasRole(role, required)).toBe(expected)
  })

  it("parses comma-separated roles and returns the highest", () => {
    expect(parseMemberRole("member, admin")).toBe("admin")
    expect(parseMemberRole("owner")).toBe("owner")
    expect(parseMemberRole("unknown")).toBeNull()
    expect(parseMemberRole(null)).toBeNull()
  })
})
