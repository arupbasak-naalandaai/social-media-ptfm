import { createLogger } from "@inbox/core/logger"
import { getPrisma } from "@inbox/db"
import { startBoss } from "./boss"
import { loadEnv } from "./env"
import { startHealthServer, type HealthState } from "./health"
import { registerFilterWorker } from "./jobs/filter"

const logger = createLogger("worker")
const env = loadEnv()
const prisma = getPrisma()

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
await registerFilterWorker(boss, prisma, logger)

// Scheduler tick (Phase 3 fills this in: due SyncState rows → poll jobs).
const TICK_MS = 30_000
const tick = setInterval(() => {
  state.lastTickAt = new Date()
  logger.debug("scheduler tick")
}, TICK_MS)
state.lastTickAt = new Date()

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down")
  clearInterval(tick)
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
