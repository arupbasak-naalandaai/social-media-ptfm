import { z } from "zod"
import { signInAllowlistSchema } from "../auth/allowlist"

export const generalSettingsSchema = z.object({
  organizationName: z.string().trim().min(1).max(100).default("My workspace"),
  timezone: z.string().trim().min(1).default("UTC"),
  signInAllowlist: signInAllowlistSchema.default({ emails: [], domains: [] }),
})
export type GeneralSettings = z.infer<typeof generalSettingsSchema>

/** Parses a stored JSON blob, filling defaults for missing keys. */
export function parseGeneralSettings(value: unknown): GeneralSettings {
  return generalSettingsSchema.parse(value ?? {})
}
