import { describe, expect, it } from "vitest"
import { Hono } from "hono"
import { createLogger } from "@inbox/core/logger"
import type { Role } from "@inbox/core"
import { createApp } from "./app"
import {
  requireAuth,
  requireRole,
  sessionMiddleware,
  type DevPreview,
  type OrgResolver,
} from "./middleware/session"
import { loadEnv } from "./env"
import type { AppEnv, AuthLike, ResolvedSession } from "./types"

const logger = createLogger("test", { level: "silent", transport: undefined })

const signedIn: ResolvedSession = {
  user: { id: "u1", email: "owner@example.com", name: "Owner" },
  session: { id: "s1", activeOrganizationId: "org1" },
}

function stubAuth(session: ResolvedSession | null): AuthLike {
  return {
    handler: async (req) => Response.json({ handled: new URL(req.url).pathname }),
    getSession: async () => session,
  }
}

function stubOrgs(role: Role | null): OrgResolver {
  return { resolve: async (_u, id) => (role ? { id, name: "Acme", role } : null) }
}

function app(
  session: ResolvedSession | null,
  role: Role | null = "owner",
  db = true,
  devPreview?: DevPreview,
) {
  return createApp({
    auth: stubAuth(session),
    orgs: stubOrgs(role),
    logger,
    checkDb: async () => db,
    devPreview,
  })
}

const preview = (role: Role = "owner"): DevPreview => ({
  role,
  resolveOrg: async () => ({ id: "org-preview", name: "Preview workspace" }),
})

describe("api app", () => {
  it("GET /health → 200 when the db answers", async () => {
    const res = await app(null).request("/health")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: "ok", db: true })
  })

  it("GET /health → 503 when the db is down", async () => {
    const res = await app(null, null, false).request("/health")
    expect(res.status).toBe(503)
  })

  it("delegates /api/auth/* to better-auth", async () => {
    const res = await app(null).request("/api/auth/get-session")
    expect(await res.json()).toEqual({ handled: "/api/auth/get-session" })
  })

  it("GET /api/me → 401 without a session", async () => {
    const res = await app(null).request("/api/me")
    expect(res.status).toBe(401)
  })

  it("GET /api/me → 403 when signed in without an org membership", async () => {
    const res = await app(signedIn, null).request("/api/me")
    expect(res.status).toBe(403)
  })

  it("GET /api/me → user, org, role", async () => {
    const res = await app(signedIn, "owner").request("/api/me")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      user: { id: "u1", email: "owner@example.com", name: "Owner", image: null },
      organization: { id: "org1", name: "Acme" },
      role: "owner",
      preview: false,
    })
  })

  it("sets x-request-id on responses", async () => {
    const res = await app(null).request("/health")
    expect(res.headers.get("x-request-id")).toBeTruthy()
  })
})

describe("requireRole", () => {
  function guarded(role: Role | null) {
    const h = new Hono<AppEnv>()
    h.use("*", sessionMiddleware(stubAuth(signedIn), stubOrgs(role)))
    h.get("/admin", requireAuth, requireRole("admin"), (c) => c.text("ok"))
    h.onError((err, c) => c.text(err.message, (err as { status?: 403 }).status ?? 500))
    return h
  }

  it.each([
    ["owner", 200],
    ["admin", 200],
    ["member", 403],
  ] as const)("%s → %i", async (role, status) => {
    const res = await guarded(role).request("/admin")
    expect(res.status).toBe(status)
  })
})

describe("DEV_AUTH_BYPASS preview identity", () => {
  it("signed-out /api/me returns the preview user when enabled", async () => {
    const res = await app(null, null, true, preview("admin")).request("/api/me")
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      user: { email: "preview@localhost" },
      organization: { id: "org-preview" },
      role: "admin",
      preview: true,
    })
  })

  it("a real session wins over the preview identity", async () => {
    const res = await app(signedIn, "member", true, preview("owner")).request("/api/me")
    expect(await res.json()).toMatchObject({ user: { id: "u1" }, role: "member", preview: false })
  })

  it("is off unless configured", async () => {
    expect((await app(null).request("/api/me")).status).toBe(401)
  })
})

describe("loadEnv", () => {
  const base = {
    DATABASE_URL: "postgresql://localhost/x",
    BETTER_AUTH_SECRET: "x".repeat(32),
    WEB_URL: "http://localhost:3000",
    API_PUBLIC_URL: "http://localhost:3001",
    ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  }

  it("allows DEV_AUTH_BYPASS in development", () => {
    expect(loadEnv({ ...base, DEV_AUTH_BYPASS: "true" }).DEV_AUTH_BYPASS).toBe(true)
  })

  it("refuses DEV_AUTH_BYPASS in production", () => {
    expect(() => loadEnv({ ...base, NODE_ENV: "production", DEV_AUTH_BYPASS: "true" })).toThrow(
      /only allowed in local development/,
    )
  })

  it("refuses DEV_AUTH_BYPASS on Railway", () => {
    expect(() =>
      loadEnv({ ...base, RAILWAY_ENVIRONMENT_NAME: "production", DEV_AUTH_BYPASS: "true" }),
    ).toThrow(/only allowed in local development/)
  })

  it("defaults DEV_AUTH_BYPASS to off", () => {
    expect(loadEnv(base).DEV_AUTH_BYPASS).toBe(false)
  })
})

describe("GET /api/stream", () => {
  it("sends SSE with no-transform so proxies don't gzip/buffer it", async () => {
    const a = createApp({
      auth: stubAuth(signedIn),
      orgs: stubOrgs("owner"),
      logger,
      checkDb: async () => true,
      events: { subscribe: () => () => {} },
    })
    const controller = new AbortController()
    const res = await a.request("/api/stream", { signal: controller.signal })
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    expect(res.headers.get("cache-control")).toContain("no-transform")
    const reader = res.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain("event: ready")
    controller.abort()
    await reader.cancel()
  })

  it("requires a session", async () => {
    const a = createApp({
      auth: stubAuth(null),
      orgs: stubOrgs(null),
      logger,
      checkDb: async () => true,
      events: { subscribe: () => () => {} },
    })
    expect((await a.request("/api/stream")).status).toBe(401)
  })
})
