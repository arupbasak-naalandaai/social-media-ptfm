import path from "node:path"
import { defineConfig } from "vitest/config"

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../.env"))
} catch {
  // no .env
}

export default defineConfig({
  test: {
    // Integration tests share one database: run files serially.
    fileParallelism: false,
  },
})
