import { serve, type ServerType } from "@hono/node-server"
import { Hono } from "hono"

export interface HealthState {
  bossStarted: boolean
  lastTickAt: Date | null
  checkDb: () => Promise<boolean>
}

/** Tiny HTTP server so Railway can health-check the worker. */
export function startHealthServer(
  port: number,
  state: HealthState,
  onListen: (port: number) => void,
): ServerType {
  const app = new Hono()
  app.get("/health", async (c) => {
    const db = await state.checkDb().catch(() => false)
    const ok = db && state.bossStarted
    return c.json(
      {
        status: ok ? "ok" : "degraded",
        service: "worker",
        db,
        boss: state.bossStarted,
        lastTickAt: state.lastTickAt,
      },
      ok ? 200 : 503,
    )
  })
  return serve({ fetch: app.fetch, port, hostname: "::" }, (info) => onListen(info.port))
}
