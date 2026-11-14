import { serve } from "@hono/node-server"
import { createAuth } from "@inbox/auth"
import { createKeyring } from "@inbox/core/crypto"
import { createLogger } from "@inbox/core/logger"
import { getPrisma } from "@inbox/db"
import { setSignInGoogleClient } from "@inbox/pipeline"
import { createApp } from "./app"
import { loadEnv } from "./env"
import { InboxEventBus } from "./lib/events"
import { createJobSender } from "./lib/jobs"
import { prismaDevPreview, prismaOrgResolver } from "./middleware/session"

const logger = createLogger("api")
const env = loadEnv()
const prisma = getPrisma()

if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
  logger.warn("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set: Google sign-in will fail")
}
// The sign-in client also runs Business Profile + YouTube connections unless Settings has its own.
setSignInGoogleClient(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET)

const auth = createAuth(
  prisma,
  {
    webUrl: env.WEB_URL,
    secret: env.BETTER_AUTH_SECRET,
    googleClientId: env.GOOGLE_CLIENT_ID,
    googleClientSecret: env.GOOGLE_CLIENT_SECRET,
    bootstrapOwnerEmails: env.BOOTSTRAP_OWNER_EMAILS,
  },
  logger.child({ module: "auth" }),
)

if (env.DEV_AUTH_BYPASS) {
  logger.warn(
    { role: env.DEV_AUTH_ROLE },
    "DEV_AUTH_BYPASS is ON: signed-out requests act as a preview user. Local development only.",
  )
}

const jobs = await createJobSender(env.DATABASE_URL, logger.child({ module: "jobs" }))
const events = new InboxEventBus(env.DATABASE_URL, logger.child({ module: "events" }))
await events.start()

const app = createApp({
  prisma,
  jobs,
  events,
  keyring: createKeyring(env.ENCRYPTION_KEY, env.ENCRYPTION_KEYS_PREVIOUS),
  urls: { apiPublicUrl: env.API_PUBLIC_URL, webUrl: env.WEB_URL },
  auth: {
    handler: (req) => auth.handler(req),
    getSession: (headers) => auth.api.getSession({ headers }),
  },
  orgs: prismaOrgResolver(prisma),
  devPreview: env.DEV_AUTH_BYPASS ? prismaDevPreview(prisma, env.DEV_AUTH_ROLE) : undefined,
  logger,
  checkDb: async () => {
    await prisma.$queryRaw`SELECT 1`
    return true
  },
})

// "::" listens on IPv6 and IPv4 (dual-stack), as Railway's private network requires.
const server = serve({ fetch: app.fetch, port: env.port, hostname: "::" }, (info) => {
  logger.info({ port: info.port }, `api listening on http://localhost:${info.port}`)
})

function shutdown(signal: string) {
  logger.info({ signal }, "shutting down")
  server.close(() => {
    void Promise.allSettled([events.stop(), jobs.stop(), prisma.$disconnect()]).finally(() =>
      process.exit(0),
    )
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))
