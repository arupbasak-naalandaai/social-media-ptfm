import type { SettingsSection } from "@inbox/core"
import type { PrismaClient } from "@inbox/db"

/** Postgres NOTIFY channel the api LISTENs on and fans out over SSE. */
export const INBOX_CHANNEL = "inbox_events"

export type InboxEvent =
  | { type: "items.changed"; organizationId: string; itemIds: string[]; reason: string }
  | { type: "items.refiltered"; organizationId: string; changed: number; examined: number }
  | { type: "rules.changed"; organizationId: string }
  | { type: "lists.changed"; organizationId: string }
  | { type: "sync.changed"; organizationId: string; syncStateIds: string[] }
  | {
      type: "settings.changed"
      organizationId: string
      section: SettingsSection
      version: number
    }

/** NOTIFY payloads are limited to 8000 bytes: keep id lists short. */
const MAX_IDS = 100

export async function notifyInbox(
  prisma: Pick<PrismaClient, "$executeRaw">,
  event: InboxEvent,
): Promise<void> {
  const payload =
    event.type === "items.changed" && event.itemIds.length > MAX_IDS
      ? { ...event, itemIds: event.itemIds.slice(0, MAX_IDS), truncated: true }
      : event.type === "sync.changed" && event.syncStateIds.length > MAX_IDS
        ? { ...event, syncStateIds: event.syncStateIds.slice(0, MAX_IDS) }
        : event
  await prisma.$executeRaw`SELECT pg_notify(${INBOX_CHANNEL}, ${JSON.stringify(payload)})`
}
