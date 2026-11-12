import type { PrismaClient } from "@inbox/db"

/** Postgres NOTIFY channel the api LISTENs on and fans out over SSE. */
export const INBOX_CHANNEL = "inbox_events"

export type InboxEvent =
  | { type: "items.changed"; organizationId: string; itemIds: string[]; reason: string }
  | { type: "items.refiltered"; organizationId: string; changed: number; examined: number }
  | { type: "rules.changed"; organizationId: string }
  | { type: "lists.changed"; organizationId: string }

/** NOTIFY payloads are limited to 8000 bytes: keep id lists short. */
const MAX_IDS = 100

export async function notifyInbox(
  prisma: Pick<PrismaClient, "$executeRaw">,
  event: InboxEvent,
): Promise<void> {
  const payload =
    event.type === "items.changed" && event.itemIds.length > MAX_IDS
      ? { ...event, itemIds: event.itemIds.slice(0, MAX_IDS), truncated: true }
      : event
  await prisma.$executeRaw`SELECT pg_notify(${INBOX_CHANNEL}, ${JSON.stringify(payload)})`
}
