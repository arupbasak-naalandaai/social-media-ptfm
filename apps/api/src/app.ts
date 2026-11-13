import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { requestId } from "hono/request-id"
import type { Logger } from "@inbox/core/logger"
import { requestLogger } from "./middleware/logging"
import { sessionMiddleware, type DevPreview, type OrgResolver } from "./middleware/session"
import type { PrismaClient } from "@inbox/db"
import type { EventSource } from "./lib/events"
import type { JobSender } from "./lib/jobs"
import type { Keyring } from "@inbox/core/crypto"
import { activityRoutes, webhookAdminRoutes } from "./routes/activity"
import { filterRoutes } from "./routes/filters"
import { itemRoutes } from "./routes/items"
import { listRoutes } from "./routes/lists"
import { meRoutes } from "./routes/me"
import { settingsRoutes } from "./routes/settings"
import { connectionRoutes } from "./routes/connections"
import { oauthRoutes } from "./routes/oauth"
import { streamRoutes } from "./routes/stream"
import { webhookRoutes, type WebhookDeps } from "./routes/webhooks"
import { syncRoutes } from "./routes/sync"
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
  /** Encrypts secrets saved in Settings (ENCRYPTION_KEY). Settings routes need it. */
  keyring?: Keyring | undefined
  /** Public URLs shown in Settings (webhook and OAuth redirect URLs). */
  urls?: { apiPublicUrl: string; webUrl: string } | undefined
  /** Tests: a local JWKS instead of Google's. */
  googleJwks?: WebhookDeps["googleJwks"]
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

  // Public platform webhooks (no session; each verifies its own signature).
  if (deps.prisma && deps.jobs) {
    app.route(
      "/webhooks",
      webhookRoutes({
        prisma: deps.prisma,
        jobs: deps.jobs,
        logger: deps.logger,
        apiPublicUrl: deps.urls?.apiPublicUrl ?? "",
        ...(deps.googleJwks ? { googleJwks: deps.googleJwks } : {}),
      }),
    )
  }

  // Everything else under /api gets the session + org context.
  app.use("/api/*", sessionMiddleware(deps.auth, deps.orgs, deps.devPreview))
  app.route("/api/me", meRoutes)
  if (deps.prisma && deps.jobs) {
    app.route("/api/items", itemRoutes({ prisma: deps.prisma, jobs: deps.jobs }))
    app.route("/api/filters", filterRoutes({ prisma: deps.prisma, jobs: deps.jobs }))
    app.route("/api/lists", listRoutes({ prisma: deps.prisma, jobs: deps.jobs }))
    app.route("/api/sync", syncRoutes({ prisma: deps.prisma, jobs: deps.jobs }))
    app.route("/api/activity", activityRoutes({ prisma: deps.prisma, jobs: deps.jobs }))
    app.route("/api/webhooks", webhookAdminRoutes({ prisma: deps.prisma, jobs: deps.jobs }))
    if (deps.keyring) {
      const urls = deps.urls ?? { apiPublicUrl: "", webUrl: "" }
      app.route(
        "/api/connections",
        connectionRoutes({ prisma: deps.prisma, keyring: deps.keyring }),
      )
      app.route(
        "/api/oauth",
        oauthRoutes({ prisma: deps.prisma, keyring: deps.keyring, urls, logger: deps.logger }),
      )
      app.route(
        "/api/settings",
        settingsRoutes({
          prisma: deps.prisma,
          keyring: deps.keyring,
          urls: deps.urls ?? { apiPublicUrl: "", webUrl: "" },
        }),
      )
    }
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
