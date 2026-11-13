import { createKeyring } from "@inbox/core/crypto"
import { createLogger } from "@inbox/core/logger"
import { getPrisma } from "@inbox/db"
import { startBoss } from "./boss"
import { loadEnv } from "./env"
import { startHealthServer, type HealthState } from "./health"
import { registerGoogle } from "./google"
import { registerMeta } from "./meta"
import { registerYoutube } from "./youtube"
import { registerAiDraftWorker } from "./jobs/ai-draft"
import { registerFilterWorker } from "./jobs/filter"
import { registerIngestWorker } from "./jobs/ingest"
import { registerMaintenanceWorker, registerTokenRefreshWorker } from "./jobs/periodic"
import { registerPollWorker } from "./jobs/poll"
import { registerSendReplyWorker } from "./jobs/send-reply"
import { schedulerTick, TICK_MS } from "./scheduler"

const logger = createLogger("worker")
const env = loadEnv()
const prisma = getPrisma()
const keyring = createKeyring(env.ENCRYPTION_KEY, env.ENCRYPTION_KEYS_PREVIOUS)

const state: HealthState = {
  bossStarted: false,
  lastTickAt: null,
  checkDb: async () => {
    await prisma.$queryRaw`SELECT 1`
    return true
  },
}

const server = startHealthServer(env.port, state, (port) =>
  logger.info({ port }, `worker health on http://localhost:${port}/health`),
)

const boss = await startBoss(env.DATABASE_URL, logger)
state.bossStarted = true
registerGoogle()
registerMeta()
registerYoutube()
await registerFilterWorker(boss, prisma, logger)
await registerPollWorker(boss, prisma, keyring, logger)
await registerAiDraftWorker(boss, prisma, keyring, logger)
await registerSendReplyWorker(boss, prisma, keyring, logger)
await registerIngestWorker(boss, prisma, keyring, logger)
await registerTokenRefreshWorker(boss, prisma, logger)
await registerMaintenanceWorker(boss, prisma, logger)

// Scheduler: due SyncState rows → poll jobs, plus per-org periodic jobs (see scheduler.ts).
let ticking = false
async function tick() {
  if (ticking) return // a slow tick never overlaps the next one
  ticking = true
  try {
    await schedulerTick(boss, prisma, logger)
    state.lastTickAt = new Date()
  } catch (err) {
    logger.error({ err }, "scheduler tick failed")
  } finally {
    ticking = false
  }
}
const tickTimer = setInterval(() => void tick(), TICK_MS)
await tick()
logger.info({ everyMs: TICK_MS }, "scheduler running")

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down")
  clearInterval(tickTimer)
  const force = setTimeout(() => process.exit(1), 35_000)
  force.unref()
  await boss
    .stop({ graceful: true, timeout: 30_000 })
    .catch((err) => logger.error({ err }, "boss stop failed"))
  server.close()
  await prisma.$disconnect()
  process.exit(0)
}
process.on("SIGTERM", () => void shutdown("SIGTERM"))
process.on("SIGINT", () => void shutdown("SIGINT"))
