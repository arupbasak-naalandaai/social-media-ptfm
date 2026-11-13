import { z } from "zod"
import { signInAllowlistSchema } from "../auth/allowlist"

/** True for an IANA time zone this runtime knows, e.g. "Asia/Kolkata". */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export const generalSettingsSchema = z.object({
  organizationName: z.string().trim().min(1, "Enter a name").max(100).default("My workspace"),
  timezone: z
    .string()
    .trim()
    .min(1)
    .refine(isValidTimeZone, "Pick a time zone from the list")
    .default("UTC"),
  signInAllowlist: signInAllowlistSchema.default({ emails: [], domains: [] }),
})
export type GeneralSettings = z.infer<typeof generalSettingsSchema>

/** Parses a stored JSON blob, filling defaults for missing keys. */
export function parseGeneralSettings(value: unknown): GeneralSettings {
  return generalSettingsSchema.parse(value ?? {})
}
