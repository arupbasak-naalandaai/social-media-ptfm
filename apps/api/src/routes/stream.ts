import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import type { InboxStreamEvent } from "@inbox/core"
import type { InboxEvent } from "@inbox/pipeline"
import type { EventSource } from "../lib/events"
import { requireAuth } from "../middleware/session"
import type { AppEnv } from "../types"

const HEARTBEAT_MS = 20_000

function toStreamEvent(e: InboxEvent): InboxStreamEvent {
  // Never forward organizationId (or anything else server-internal) to the browser.
  switch (e.type) {
    case "items.changed":
      return { type: e.type, itemIds: e.itemIds, reason: e.reason }
    case "items.refiltered":
      return { type: e.type, changed: e.changed, examined: e.examined }
    case "rules.changed":
    case "lists.changed":
      return { type: e.type }
    case "sync.changed":
      return { type: e.type, syncStateIds: e.syncStateIds }
    case "settings.changed":
      return { type: e.type, section: e.section, version: e.version }
  }
}

/** GET /api/stream: Server-Sent Events for the signed-in organization. */
export function streamRoutes(events: EventSource) {
  return new Hono<AppEnv>().get("/", requireAuth, (c) => {
    const org = c.get("org")!
    const response = streamSSE(c, async (stream) => {
      let id = 0
      const queue: InboxStreamEvent[] = []
      let wake: (() => void) | null = null
      const unsubscribe = events.subscribe(org.id, (e) => {
        queue.push(toStreamEvent(e))
        wake?.()
      })
      stream.onAbort(() => {
        unsubscribe()
        wake?.()
      })

      await stream.writeSSE({
        event: "ready",
        data: JSON.stringify({ ok: true }),
        id: String(id++),
      })
      while (!stream.aborted && !stream.closed) {
        const next = queue.shift()
        if (next) {
          await stream.writeSSE({ event: next.type, data: JSON.stringify(next), id: String(id++) })
          continue
        }
        await new Promise<void>((resolve) => {
          wake = resolve
          setTimeout(resolve, HEARTBEAT_MS)
        })
        wake = null
        if (queue.length === 0 && !stream.aborted)
          await stream.writeSSE({ event: "ping", data: "{}" })
      }
      unsubscribe()
    })
    // streamSSE sets "Cache-Control: no-cache"; add no-transform (set afterwards so it sticks) so
    // proxies, including Next's gzip compression on the /api rewrite, don't buffer the stream.
    response.headers.set("Cache-Control", "no-cache, no-transform")
    response.headers.set("X-Accel-Buffering", "no")
    return response
  })
}
