import { createMiddleware } from "hono/factory"
import type { Logger } from "@inbox/core/logger"
import type { AppEnv } from "../types"

/** Attaches a request-scoped child logger and logs one line per request. */
export function requestLogger(root: Logger) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const logger = root.child({ requestId: c.get("requestId") })
    c.set("logger", logger)
    const start = performance.now()
    await next()
    const ms = Math.round(performance.now() - start)
    const path = new URL(c.req.url).pathname
    if (path === "/health") return
    logger.info({ method: c.req.method, path, status: c.res.status, ms }, "request")
  })
}
