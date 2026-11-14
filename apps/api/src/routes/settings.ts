import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import {
  SECTION_SECRETS,
  SETTINGS_SECTIONS,
  YOUTUBE_QUOTA_BLOCK_RATIO,
  aiBaseUrlSchema,
  aiProviderSchema,
  estimateYoutubeDailyUnits,
  parseSectionSecrets,
  parseSectionValues,
  secretLast4,
  secretStatuses,
  settingsSectionSchema,
  settingsUpdateSchema,
  type AiModelOption,
  type SettingsResponse,
  type SettingsSection,
  type SettingsSectionDto,
  type SettingsUpdateResponse,
  type SettingsValues,
  type StoredSecret,
  type SyncSettings,
} from "@inbox/core"
import type { Keyring } from "@inbox/core/crypto"
import type { Prisma, PrismaClient, Settings } from "@inbox/db"
import {
  AI_KEY_FOR,
  applySyncSettings,
  generatedMetaVerifyTokens,
  hasSignInGoogleClient,
  languageModelFor,
  listAiModels,
  loadSettingsSection,
  loadSettingsSecret,
  notifyInbox,
  settingsSecretAad,
  testAiConnection,
} from "@inbox/pipeline"
import { requireAuth, requireRole } from "../middleware/session"
import { googleRedirectUri, linkedinRedirectUri } from "./oauth"
import type { AppEnv } from "../types"

export interface SettingsRouteDeps {
  prisma: PrismaClient
  keyring: Keyring
  urls: { apiPublicUrl: string; webUrl: string }
}

class VersionConflict extends Error {}

/** Typed-but-unsaved key and endpoint win; otherwise the saved ones are used. */
const aiModelsSchema = z.object({
  provider: aiProviderSchema,
  apiKey: z.string().trim().min(1).max(8192).optional(),
  baseUrl: aiBaseUrlSchema.optional(),
})

const aiTestSchema = aiModelsSchema.extend({
  model: z.string().trim().min(1).max(100),
})

function sectionDto<S extends SettingsSection>(
  section: S,
  stored: unknown,
  orgName?: string,
): SettingsSectionDto<S> {
  const values = parseSectionValues(section, stored)
  // The organization's real name lives on Organization; keep the General tab truthful.
  if (section === "general" && orgName) {
    ;(values as SettingsValues["general"]).organizationName = orgName
  }
  return { values, secrets: secretStatuses(section, parseSectionSecrets(section, stored)) }
}

/** Only the keys whose values changed, for a readable audit entry. */
function diffValues(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b: Record<string, unknown> = {}
  const a: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      b[key] = before[key]
      a[key] = after[key]
    }
  }
  return { before: b, after: a }
}

export function settingsRoutes({ prisma, keyring, urls }: SettingsRouteDeps) {
  async function loadRow(organizationId: string): Promise<Settings> {
    return prisma.settings.upsert({
      where: { organizationId },
      create: { organizationId },
      update: {},
    })
  }

  async function youtubeChannels(organizationId: string): Promise<number> {
    return prisma.platformAccount.count({
      where: { organizationId, kind: "yt_channel", included: true },
    })
  }

  return (
    new Hono<AppEnv>()
      .use("*", requireAuth, requireRole("admin"))

      .get("/", async (c) => {
        const org = c.get("org")!
        const row = await loadRow(org.id)
        const sections = Object.fromEntries(
          SETTINGS_SECTIONS.map((s) => [s, sectionDto(s, row[s], org.name)]),
        ) as SettingsResponse["sections"]
        const api = urls.apiPublicUrl
        const body: SettingsResponse = {
          version: row.version,
          updatedAt: row.updatedAt.toISOString(),
          sections,
          meta: {
            apiPublicUrl: api,
            webUrl: urls.webUrl,
            webhookUrls: {
              meta: `${api}/webhooks/meta`,
              google: `${api}/webhooks/google`,
              linkedin: `${api}/webhooks/linkedin`,
              slack: `${api}/slack/events`,
            },
            oauthRedirectUrls: {
              google: googleRedirectUri(urls.webUrl),
              meta: `${urls.webUrl}/api/oauth/meta/callback`,
              linkedin: linkedinRedirectUri(urls.webUrl),
            },
            youtubeChannels: await youtubeChannels(org.id),
            signInGoogleClient: hasSignInGoogleClient(),
            metaVerifyToken: generatedMetaVerifyTokens(keyring, org.id)[0] ?? "",
          },
        }
        return c.json(body)
      })

      // Settings → AI replies → Test: one tiny call with the typed key, or the saved one.
      .post("/ai/test", async (c) => {
        const org = c.get("org")!
        const parsed = aiTestSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) {
          return c.json({ error: "Choose a provider and enter a model ID" }, 400)
        }
        const { provider, model, apiKey } = parsed.data
        const key =
          apiKey ?? (await loadSettingsSecret(prisma, keyring, org.id, "ai", AI_KEY_FOR[provider]))
        if (!key) return c.json({ error: "Add an API key first" }, 400)
        const baseUrl =
          parsed.data.baseUrl ??
          (await loadSettingsSection(prisma, org.id, "ai")).baseUrls[provider]
        try {
          const reply = await testAiConnection(languageModelFor(provider, model, key, baseUrl))
          return c.json({ ok: true, reply })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          // The provider's message (e.g. "invalid x-api-key", "model not found") is the useful bit.
          return c.json({ error: `The provider said: ${message.slice(0, 300)}` }, 400)
        }
      })

      // Settings → AI replies → model picker: the provider's live model list.
      .post("/ai/models", async (c) => {
        const org = c.get("org")!
        const parsed = aiModelsSchema.safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) {
          const endpointIssue = parsed.error.issues.find((i) => i.path[0] === "baseUrl")
          return c.json({ error: endpointIssue?.message ?? "Choose a provider" }, 400)
        }
        const { provider, apiKey } = parsed.data
        const key =
          apiKey ?? (await loadSettingsSecret(prisma, keyring, org.id, "ai", AI_KEY_FOR[provider]))
        // OpenRouter's model list is public; the others need a key.
        if (!key && provider !== "openrouter") {
          return c.json({ error: "Add an API key to load models" }, 400)
        }
        const baseUrl =
          parsed.data.baseUrl ??
          (await loadSettingsSection(prisma, org.id, "ai")).baseUrls[provider]
        try {
          const models: AiModelOption[] = await listAiModels({ provider, apiKey: key, baseUrl })
          return c.json({ models })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return c.json({ error: `Couldn't load models: ${message.slice(0, 300)}` }, 400)
        }
      })

      .put("/:section", async (c) => {
        const org = c.get("org")!
        const user = c.get("user")!
        const sectionParse = settingsSectionSchema.safeParse(c.req.param("section"))
        if (!sectionParse.success) throw new HTTPException(404, { message: "Unknown section" })
        const section = sectionParse.data
        const parsed = settingsUpdateSchema(section).safeParse(await c.req.json().catch(() => null))
        if (!parsed.success) {
          return c.json(
            {
              error: "Invalid request",
              issues: parsed.error.issues.map((i) => ({
                path: i.path.join("."),
                message: i.message,
              })),
            },
            400,
          )
        }
        const body = parsed.data
        const values = body.values as SettingsValues[typeof section]
        const secretInput = (body.secrets ?? {}) as Partial<Record<string, string | null>>

        // YouTube quota guard (PLAN §12): block saves that would use > 90% on polling alone.
        if (section === "sync") {
          const sync = values as SyncSettings
          const estimated = estimateYoutubeDailyUnits({
            intervalMinutes: sync.streams.yt_comments.intervalMinutes,
            channels: await youtubeChannels(org.id),
            pagesPerPoll: sync.youtube.pagesPerPoll,
          })
          if (estimated > sync.youtube.dailyQuota * YOUTUBE_QUOTA_BLOCK_RATIO) {
            return c.json(
              {
                error: "YouTube polling would use too much of the daily quota",
                issues: [
                  {
                    path: "values.streams.yt_comments.intervalMinutes",
                    message: `About ${estimated.toLocaleString("en-US")} units a day: over 90% of the ${sync.youtube.dailyQuota.toLocaleString("en-US")}-unit quota, which leaves no room for replies. Use a longer interval.`,
                  },
                ],
              },
              400,
            )
          }
        }

        const now = new Date()
        let rescheduled: string[] = []
        let saved: Settings
        try {
          saved = await prisma.$transaction(async (tx) => {
            const current = await tx.settings.upsert({
              where: { organizationId: org.id },
              create: { organizationId: org.id },
              update: {},
            })
            if (current.version !== body.version) throw new VersionConflict()

            const beforeValues = parseSectionValues(section, current[section])
            const storedSecrets = parseSectionSecrets(section, current[section]) as Partial<
              Record<string, StoredSecret>
            >
            const nextSecrets: Record<string, StoredSecret> = {}
            const secretChanges: Record<string, "set" | "cleared"> = {}
            for (const key of SECTION_SECRETS[section] as readonly string[]) {
              const input = secretInput[key]
              if (input === undefined) {
                if (storedSecrets[key]) nextSecrets[key] = storedSecrets[key]
              } else if (input === null) {
                if (storedSecrets[key]) secretChanges[key] = "cleared"
              } else {
                nextSecrets[key] = {
                  enc: keyring.encrypt(input, settingsSecretAad(org.id, section, key)),
                  last4: secretLast4(input),
                }
                secretChanges[key] = "set"
              }
            }

            const json = {
              ...(values as Record<string, unknown>),
              ...(Object.keys(nextSecrets).length ? { secrets: nextSecrets } : {}),
            } as Prisma.InputJsonObject

            // Compare-and-swap on version: a concurrent save loses with a 409.
            const updated = await tx.settings.updateMany({
              where: { organizationId: org.id, version: body.version },
              data: { [section]: json, version: { increment: 1 }, updatedById: user.id },
            })
            if (updated.count !== 1) throw new VersionConflict()

            if (section === "general") {
              const general = values as SettingsValues["general"]
              await tx.organization.update({
                where: { id: org.id },
                data: { name: general.organizationName },
              })
            }
            if (section === "sync") {
              rescheduled = await applySyncSettings(tx, org.id, values as SyncSettings, now)
            }

            const diff = diffValues(
              beforeValues as Record<string, unknown>,
              values as Record<string, unknown>,
            )
            await tx.auditLog.create({
              data: {
                organizationId: org.id,
                actorId: user.id,
                action: "settings.update",
                entity: "settings",
                entityId: section,
                before: diff.before as Prisma.InputJsonObject,
                after: {
                  ...diff.after,
                  // Never the values: only which secrets changed.
                  ...(Object.keys(secretChanges).length ? { secrets: secretChanges } : {}),
                  ...(section === "sync" ? { rescheduled: rescheduled.length } : {}),
                } as Prisma.InputJsonObject,
              },
            })
            return tx.settings.findUniqueOrThrow({ where: { organizationId: org.id } })
          })
        } catch (err) {
          if (err instanceof VersionConflict) {
            throw new HTTPException(409, {
              message: "Someone else changed these settings. Reload to see their changes.",
            })
          }
          throw err
        }

        await notifyInbox(prisma, {
          type: "settings.changed",
          organizationId: org.id,
          section,
          version: saved.version,
        })
        if (rescheduled.length) {
          await notifyInbox(prisma, {
            type: "sync.changed",
            organizationId: org.id,
            syncStateIds: rescheduled,
          })
        }

        const response: SettingsUpdateResponse = {
          version: saved.version,
          updatedAt: saved.updatedAt.toISOString(),
          section: sectionDto(section, saved[section]) as SettingsSectionDto<SettingsSection>,
          ...(section === "sync" ? { rescheduled: rescheduled.length } : {}),
        }
        return c.json(response)
      })
  )
}
