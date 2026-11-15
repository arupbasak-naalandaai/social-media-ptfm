/**
 * Settings → AI replies → "Connect OpenRouter": sign in at openrouter.ai and get an API key back,
 * instead of pasting one. The key is stored like a typed one (encrypted `openrouterApiKey`) and
 * OpenRouter becomes the AI provider.
 *
 * OpenRouter's callback carries only `?code=`, so the pending PKCE verifier is keyed by
 * organization + user (single use, 10 min). A forged callback can't plant someone else's key:
 * its code was issued for a different challenge and won't exchange with our verifier.
 */
import { Hono } from "hono"
import { secretLast4, parseSectionSecrets, parseSectionValues } from "@inbox/core"
import { aadFor, type Keyring } from "@inbox/core/crypto"
import type { Logger } from "@inbox/core/logger"
import type { Prisma, PrismaClient } from "@inbox/db"
import {
  exchangeOpenRouterCode,
  notifyInbox,
  OpenRouterAuthError,
  openrouterAuthUrl,
  pkcePair,
  settingsSecretAad,
} from "@inbox/pipeline"
import { requireAuth, requirePermission } from "../middleware/session"
import type { AppEnv } from "../types"

export interface OpenRouterRouteDeps {
  prisma: PrismaClient
  keyring: Keyring
  urls: { webUrl: string }
  logger: Logger
}

const STATE_TTL_MS = 10 * 60 * 1000

export function openrouterRoutes({ prisma, keyring, urls, logger }: OpenRouterRouteDeps) {
  const callbackUrl = `${urls.webUrl}/api/oauth/openrouter/callback`
  const back = (params: Record<string, string>) =>
    `${urls.webUrl}/settings?${new URLSearchParams({ tab: "ai", ...params })}`
  const identifier = (orgId: string, userId: string) => `oauth:openrouter:${orgId}:${userId}`
  const aad = (id: string) => aadFor("-", "oauth_state", id)

  /** Stores the key, switches the provider to OpenRouter, bumps the settings version. */
  async function saveKey(organizationId: string, actorId: string, key: string) {
    const saved = await prisma.$transaction(async (tx) => {
      const current = await tx.settings.upsert({
        where: { organizationId },
        create: { organizationId },
        update: {},
      })
      const before = parseSectionValues("ai", current.ai)
      const secrets = parseSectionSecrets("ai", current.ai)
      const json = {
        ...before,
        provider: "openrouter",
        secrets: {
          ...secrets,
          openrouterApiKey: {
            enc: keyring.encrypt(key, settingsSecretAad(organizationId, "ai", "openrouterApiKey")),
            last4: secretLast4(key),
          },
        },
      } as Prisma.InputJsonObject
      const updated = await tx.settings.update({
        where: { organizationId },
        data: { ai: json, version: { increment: 1 }, updatedById: actorId },
      })
      await tx.auditLog.create({
        data: {
          organizationId,
          actorId,
          action: "settings.update",
          entity: "settings",
          entityId: "ai",
          before: { provider: before.provider },
          after: {
            provider: "openrouter",
            secrets: { openrouterApiKey: "set" },
            via: "openrouter_login",
          },
        },
      })
      return updated
    })
    await notifyInbox(prisma, {
      type: "settings.changed",
      organizationId,
      section: "ai",
      version: saved.version,
    })
  }

  return new Hono<AppEnv>()
    .use("*", requireAuth, requirePermission({ settings: ["manage"] }))

    .get("/start", async (c) => {
      const org = c.get("org")!
      const user = c.get("user")!
      const id = identifier(org.id, user.id)
      const { verifier, challenge } = pkcePair()
      // One pending login per admin: a new Connect click replaces an unfinished one.
      await prisma.verification.deleteMany({ where: { identifier: id } })
      await prisma.verification.create({
        data: {
          id: `oauth-or-${challenge.slice(0, 32)}`,
          identifier: id,
          value: keyring.encrypt(verifier, aad(id)),
          expiresAt: new Date(Date.now() + STATE_TTL_MS),
        },
      })
      return c.redirect(openrouterAuthUrl({ callbackUrl, codeChallenge: challenge }))
    })

    .get("/callback", async (c) => {
      const org = c.get("org")!
      const user = c.get("user")!
      const code = c.req.query("code")
      if (!code) return c.redirect(back({ error: "OpenRouter didn't send a sign-in code." }))

      const id = identifier(org.id, user.id)
      const row = await prisma.verification.findFirst({ where: { identifier: id } })
      if (row) await prisma.verification.delete({ where: { id: row.id } })
      let verifier: string | null = null
      try {
        verifier = row && row.expiresAt > new Date() ? keyring.decrypt(row.value, aad(id)) : null
      } catch {
        verifier = null
      }
      if (!verifier) {
        return c.redirect(
          back({ error: "That sign-in link expired or was already used. Try Connect again." }),
        )
      }

      try {
        const key = await exchangeOpenRouterCode({ code, codeVerifier: verifier })
        await saveKey(org.id, user.id, key)
        return c.redirect(back({ connected: "openrouter" }))
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "openrouter connect failed")
        const message =
          err instanceof OpenRouterAuthError ? err.message : "Connecting OpenRouter failed."
        return c.redirect(back({ error: message }))
      }
    })
}
