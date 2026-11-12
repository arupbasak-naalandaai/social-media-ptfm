import { pino, type Logger, type LoggerOptions } from "pino"

export type { Logger }

/** Paths whose values never reach logs. */
export const REDACT_PATHS = [
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.secret",
  "*.clientSecret",
  "*.apiKey",
  "*.password",
  "headers.authorization",
  "headers.cookie",
  'headers["set-cookie"]',
  "req.headers.authorization",
  "req.headers.cookie",
]

export function createLogger(service: string, options: LoggerOptions = {}): Logger {
  const pretty = process.env.NODE_ENV !== "production" && process.env.LOG_PRETTY !== "false"
  return pino({
    name: service,
    level: process.env.LOG_LEVEL ?? "info",
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: { service },
    ...(pretty
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
          },
        }
      : {}),
    ...options,
  })
}
