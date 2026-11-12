import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "./generated/prisma/client"

export type { PrismaClient }

export function createPrismaClient(connectionString = process.env.DATABASE_URL): PrismaClient {
  if (!connectionString) throw new Error("DATABASE_URL is not set")
  const adapter = new PrismaPg({ connectionString })
  return new PrismaClient({ adapter })
}

const globalForPrisma = globalThis as unknown as { __inboxPrisma?: PrismaClient }

/** Process-wide singleton (survives tsx watch reloads in dev). */
export function getPrisma(): PrismaClient {
  globalForPrisma.__inboxPrisma ??= createPrismaClient()
  return globalForPrisma.__inboxPrisma
}
