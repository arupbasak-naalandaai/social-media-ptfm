import { NextResponse, type NextRequest } from "next/server"
import { getSessionCookie } from "better-auth/cookies"

const PUBLIC_PATHS = ["/sign-in"]

/** Local UI preview without login (the api serves a virtual preview user). Never in production. */
const DEV_AUTH_BYPASS =
  process.env.DEV_AUTH_BYPASS === "true" && process.env.NODE_ENV !== "production"

/**
 * Optimistic check only: a session cookie exists or not. The real check happens in the
 * (app) layout (server-side /api/me) and on every api request.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const hasSession = Boolean(getSessionCookie(request))
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))

  if (!hasSession && !isPublic && !DEV_AUTH_BYPASS) {
    const url = new URL("/sign-in", request.url)
    if (pathname !== "/") url.searchParams.set("next", pathname)
    return NextResponse.redirect(url)
  }
  return NextResponse.next()
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|healthz|favicon.ico|.*\\.(?:png|jpg|svg|ico|webp)$).*)",
  ],
}
