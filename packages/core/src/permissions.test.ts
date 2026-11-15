import { describe, expect, it } from "vitest"
import {
  allowedPlatforms,
  can,
  effectivePermissions,
  isWithin,
  parseAppPermissions,
  roleDefaults,
} from "./permissions"

describe("permissions", () => {
  it("gives each role its defaults", () => {
    const member = effectivePermissions("member", null)
    expect(can(member, { inbox: ["read", "reply", "triage"] })).toBe(true)
    expect(can(member, { filter: ["manage"] })).toBe(false)
    expect(can(member, { member: ["update"] })).toBe(false)
    expect(allowedPlatforms(member)).toHaveLength(5)

    const admin = effectivePermissions("admin", null)
    expect(can(admin, { settings: ["manage"], member: ["update"] })).toBe(true)
    expect(can(admin, { organization: ["delete"] })).toBe(false)
    expect(can(effectivePermissions("owner", null), { organization: ["delete"] })).toBe(true)
  })

  it("replaces app permissions with a member's override, keeping org permissions from the role", () => {
    const fbOnly = parseAppPermissions({ platform: ["facebook"], inbox: ["read", "reply"] })!
    const perms = effectivePermissions("member", fbOnly)
    expect(allowedPlatforms(perms)).toEqual(["facebook"])
    expect(can(perms, { inbox: ["reply"] })).toBe(true)
    expect(can(perms, { inbox: ["triage"] })).toBe(false)
    expect(can(perms, { activity: ["read"] })).toBe(false)

    const adminFb = effectivePermissions("admin", fbOnly)
    expect(can(adminFb, { member: ["update"] })).toBe(true)
    expect(can(adminFb, { settings: ["manage"] })).toBe(false)
  })

  it("never restricts an owner", () => {
    const perms = effectivePermissions("owner", parseAppPermissions({ platform: [] }))
    expect(allowedPlatforms(perms)).toHaveLength(5)
    expect(can(perms, { settings: ["manage"] })).toBe(true)
  })

  it("parses stored overrides leniently", () => {
    expect(parseAppPermissions(null)).toBeNull()
    expect(parseAppPermissions("not json")).toBeNull()
    expect(parseAppPermissions({ platform: ["myspace"] })).toBeNull()
    expect(parseAppPermissions('{"platform":["youtube","youtube"]}')).toMatchObject({
      platform: ["youtube"],
      inbox: [],
    })
  })

  it("checks that a grant stays within what the granter holds", () => {
    const holder = effectivePermissions("admin", parseAppPermissions({ platform: ["facebook"] }))
    expect(isWithin({ platform: ["facebook"] }, holder)).toBe(true)
    expect(isWithin({ platform: ["facebook", "instagram"] }, holder)).toBe(false)
    expect(isWithin(roleDefaults("member"), effectivePermissions("admin", null))).toBe(true)
  })
})
