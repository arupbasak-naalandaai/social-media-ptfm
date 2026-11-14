import { z } from "zod"

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().optional(),
  WORKER_PORT: z.coerce.number().int().positive().default(3002),
  DATABASE_URL: z.string().min(1),
  ENCRYPTION_KEY: z
    .string()
    .refine(
      (k) => Buffer.from(k, "base64").length === 32,
      "ENCRYPTION_KEY must be 32 bytes, base64",
    ),
  /** Comma-separated previous keys, still accepted for decryption after a rotation. */
  ENCRYPTION_KEYS_PREVIOUS: z.string().default(""),
  /** The sign-in OAuth client; refreshes Google connection tokens when Settings has no client. */
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
})

export type WorkerEnv = z.infer<typeof envSchema> & { port: number }

export function loadEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n")
    throw new Error(`Invalid worker environment:\n${issues}`)
  }
  return { ...parsed.data, port: parsed.data.PORT ?? parsed.data.WORKER_PORT }
}
