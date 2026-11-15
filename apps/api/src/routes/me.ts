import { Hono } from "hono"
import { requireAuth } from "../middleware/session"
import type { AppEnv } from "../types"

export const meRoutes = new Hono<AppEnv>().get("/", requireAuth, (c) => {
  const user = c.get("user")!
  const org = c.get("org")!
  return c.json({
    user: { id: user.id, email: user.email, name: user.name, image: user.image ?? null },
    organization: { id: org.id, name: org.name },
    role: org.role,
    /** Effective permissions; the UI uses them to show or hide controls (the API re-checks). */
    permissions: org.permissions,
    preview: c.get("preview"),
  })
})
