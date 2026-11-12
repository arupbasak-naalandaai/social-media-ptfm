// Used only by the better-auth CLI (`pnpm auth:generate`) to emit Prisma models.
// Values are placeholders: the CLI reads the plugin/table configuration, not credentials.
import { createPrismaClient } from "@inbox/db"
import { createAuth } from "./auth"

export const auth = createAuth(
  createPrismaClient(process.env.DATABASE_URL ?? "postgresql://localhost:5432/placeholder"),
  {
    webUrl: "http://localhost:3000",
    secret: "cli-placeholder-secret-cli-placeholder-secret",
    googleClientId: "placeholder",
    googleClientSecret: "placeholder",
  },
)
