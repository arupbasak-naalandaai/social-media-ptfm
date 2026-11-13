import {
  parseSectionSecrets,
  parseSectionValues,
  type SecretKey,
  type SettingsSection,
  type SettingsValues,
} from "@inbox/core"
import { aadFor, type Keyring } from "@inbox/core/crypto"
import type { PrismaClient } from "@inbox/db"

type Db = Pick<PrismaClient, "settings">

/** AAD for a secret stored inside a Settings section. */
export function settingsSecretAad(organizationId: string, section: string, key: string): string {
  return aadFor(organizationId, "settings", `${section}.${key}`)
}

/** One section's values for an organization, with defaults filled in. */
export async function loadSettingsSection<S extends SettingsSection>(
  prisma: Db,
  organizationId: string,
  section: S,
): Promise<SettingsValues[S]> {
  const row = await prisma.settings.findUnique({
    where: { organizationId },
    select: { [section]: true } as Record<S, true>,
  })
  return parseSectionValues(section, (row as Record<string, unknown> | null)?.[section])
}

/**
 * Decrypts one secret from Settings (for server-side use only: platform calls, AI calls).
 * Returns null when it isn't set.
 */
export async function loadSettingsSecret<S extends SettingsSection>(
  prisma: Db,
  keyring: Keyring,
  organizationId: string,
  section: S,
  key: SecretKey<S>,
): Promise<string | null> {
  const row = await prisma.settings.findUnique({
    where: { organizationId },
    select: { [section]: true } as Record<S, true>,
  })
  const stored = parseSectionSecrets(section, (row as Record<string, unknown> | null)?.[section])[
    key
  ]
  if (!stored) return null
  return keyring.decrypt(stored.enc, settingsSecretAad(organizationId, section, key))
}
