import type { Role } from "@inbox/core"
import type { Logger } from "@inbox/core/logger"

export interface SessionUser {
  id: string
  email: string
  name: string
  image?: string | null | undefined
}

export interface ResolvedSession {
  user: SessionUser
  session: { id: string; activeOrganizationId?: string | null | undefined }
}

/** The subset of better-auth the HTTP layer needs. Lets tests use a stub. */
export interface AuthLike {
  handler: (request: Request) => Promise<Response>
  getSession: (headers: Headers) => Promise<ResolvedSession | null>
}

export interface OrgContext {
  id: string
  name: string
  role: Role
}

export type AppEnv = {
  Variables: {
    requestId: string
    logger: Logger
    user: SessionUser | null
    session: ResolvedSession["session"] | null
    org: OrgContext | null
    /** True when the identity comes from DEV_AUTH_BYPASS, not a real session. */
    preview: boolean
  }
}
