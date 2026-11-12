import "server-only"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { cacheLife } from "next/cache"

const API = (process.env.API_INTERNAL_URL ?? "http://localhost:3001").replace(/\/+$/, "")

export interface Me {
  user: { id: string; email: string; name: string; image: string | null }
  organization: { id: string; name: string }
  role: "owner" | "admin" | "member"
  /** True when the api is running with DEV_AUTH_BYPASS and there is no real session. */
  preview: boolean
}

/**
 * The signed-in user, active org and role, from the api (which validates the better-auth
 * session). Redirects to /sign-in without a session and /no-access without a membership.
 *
 * `use cache: private` lets this read cookies under Cache Components; the result is cached
 * per session in the browser only. Next server code never talks to the DB or platforms.
 */
export async function getCurrentMe(): Promise<Me> {
  "use cache: private"
  cacheLife({ stale: 30, revalidate: 60, expire: 300 })

  const cookieHeader = (await cookies()).toString()
  const res = await fetch(`${API}/api/me`, {
    headers: { cookie: cookieHeader, accept: "application/json" },
  })
  if (res.status === 401) redirect("/sign-in")
  if (res.status === 403) redirect("/no-access")
  if (!res.ok) throw new Error(`api /api/me failed: ${res.status}`)
  return (await res.json()) as Me
}
