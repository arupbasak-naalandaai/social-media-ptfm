import { z } from "zod"

const url = z.url().transform((u) => u.replace(/\/+$/, ""))

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().optional(),
  API_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  WEB_URL: url,
  API_PUBLIC_URL: url,
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  BOOTSTRAP_OWNER_EMAILS: z.string().optional(),
  /** Local UI preview without signing in. Never allowed in production (see loadEnv). */
  DEV_AUTH_BYPASS: z.stringbool().default(false),
  DEV_AUTH_ROLE: z.enum(["owner", "admin", "member"]).default("owner"),
  RAILWAY_ENVIRONMENT_NAME: z.string().optional(),
  ENCRYPTION_KEY: z
    .string()
    .refine(
      (k) => Buffer.from(k, "base64").length === 32,
      "ENCRYPTION_KEY must be 32 bytes, base64",
    ),
})

export type ApiEnv = z.infer<typeof envSchema> & { port: number }

export function loadEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n")
    throw new Error(`Invalid api environment:\n${issues}`)
  }
  const env = parsed.data
  if (env.DEV_AUTH_BYPASS && (env.NODE_ENV === "production" || env.RAILWAY_ENVIRONMENT_NAME)) {
    throw new Error(
      "DEV_AUTH_BYPASS=true is only allowed in local development. Remove it from this environment.",
    )
  }
  return { ...env, port: env.PORT ?? env.API_PORT }
}
