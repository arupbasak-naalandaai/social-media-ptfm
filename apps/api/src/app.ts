import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { requestId } from "hono/request-id"
import type { Logger } from "@inbox/core/logger"
import { requestLogger } from "./middleware/logging"
import { sessionMiddleware, type DevPreview, type OrgResolver } from "./middleware/session"
import type { PrismaClient } from "@inbox/db"
import type { EventSource } from "./lib/events"
import type { JobSender } from "./lib/jobs"
import { filterRoutes } from "./routes/filters"
import { itemRoutes } from "./routes/items"
import { listRoutes } from "./routes/lists"
import { meRoutes } from "./routes/me"
import { streamRoutes } from "./routes/stream"
import type { AppEnv, AuthLike } from "./types"

export interface AppDeps {
  auth: AuthLike
  orgs: OrgResolver
  logger: Logger
  /** Returns true when the database answers. Used by /health. */
  checkDb: () => Promise<boolean>
  /** Set only when DEV_AUTH_BYPASS=true (local development). */
  devPreview?: DevPreview | undefined
  /** Inbox domain (optional so auth-only tests can omit them). */
  prisma?: PrismaClient | undefined
  jobs?: JobSender | undefined
  events?: EventSource | undefined
}

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>()

  app.use("*", requestId({ headerName: "x-request-id" }))
  app.use("*", requestLogger(deps.logger))

  app.get("/health", async (c) => {
    const db = await deps.checkDb().catch(() => false)
    return c.json({ status: db ? "ok" : "degraded", service: "api", db }, db ? 200 : 503)
  })

  // better-auth owns everything under /api/auth/* (OAuth, One Tap, sessions, organization).
  app.on(["GET", "POST"], "/api/auth/*", (c) => deps.auth.handler(c.req.raw))

  // Everything else under /api gets the session + org context.
  app.use("/api/*", sessionMiddleware(deps.auth, deps.orgs, deps.devPreview))
  app.route("/api/me", meRoutes)
  if (deps.prisma && deps.jobs) {
    app.route("/api/items", itemRoutes({ prisma: deps.prisma, jobs: deps.jobs }))
    app.route("/api/filters", filterRoutes({ prisma: deps.prisma, jobs: deps.jobs }))
    app.route("/api/lists", listRoutes({ prisma: deps.prisma, jobs: deps.jobs }))
  }
  if (deps.events) app.route("/api/stream", streamRoutes(deps.events))

  app.notFound((c) => c.json({ error: "Not found" }, 404))

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      const issues = Array.isArray(err.cause) ? err.cause : undefined
      return c.json({ error: err.message, ...(issues ? { issues } : {}) }, err.status)
    }
    const logger = c.get("logger") ?? deps.logger
    logger.error({ err }, "unhandled error")
    return c.json({ error: "Internal server error", requestId: c.get("requestId") }, 500)
  })

  return app
}

export type App = ReturnType<typeof createApp>
