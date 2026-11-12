import path from "node:path"
import { defineConfig, env } from "prisma/config"

// Load the monorepo root .env in local dev. On Railway, variables come from the environment.
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../.env"))
} catch {
  // no .env file: rely on process.env
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "pnpm --filter @inbox/pipeline seed",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
})
