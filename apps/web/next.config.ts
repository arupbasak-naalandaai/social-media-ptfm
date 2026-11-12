import path from "node:path"
import type { NextConfig } from "next"

// Local dev: read the monorepo root .env (Next only reads apps/web/.env* by default).
// On Railway, variables come from the service environment.
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../.env"))
} catch {
  // no root .env
}

const apiInternalUrl = (process.env.API_INTERNAL_URL ?? "http://localhost:3001").replace(/\/+$/, "")

const nextConfig: NextConfig = {
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  transpilePackages: ["@inbox/core"],
  turbopack: {
    root: path.resolve(import.meta.dirname, "../.."),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // The browser only talks to this origin. /api/* is proxied to the Hono api
  // (Railway private network in production) so auth cookies stay first-party.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiInternalUrl}/api/:path*` }]
  },
}

export default nextConfig
