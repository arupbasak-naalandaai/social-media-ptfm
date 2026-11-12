import { betterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { APIError } from "better-auth/api"
import { oneTap, organization } from "better-auth/plugins"
import type { PrismaClient } from "@inbox/db"
import type { Logger } from "@inbox/core/logger"
import { createAccessPolicy } from "./access"

export interface AuthEnv {
  /** Public web URL. Cookies live here, so it's also better-auth's base URL. */
  webUrl: string
  secret: string
  googleClientId: string
  googleClientSecret: string
  /** Raw BOOTSTRAP_OWNER_EMAILS value (optional). */
  bootstrapOwnerEmails?: string | undefined
}

export function createAuth(prisma: PrismaClient, env: AuthEnv, logger?: Logger) {
  const policy = createAccessPolicy(prisma, env.bootstrapOwnerEmails, logger)

  return betterAuth({
    appName: "Social Inbox",
    baseURL: env.webUrl,
    secret: env.secret,
    trustedOrigins: [env.webUrl],
    database: prismaAdapter(prisma, { provider: "postgresql" }),

    // Google is the only way in. No email/password.
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: env.googleClientId,
        clientSecret: env.googleClientSecret,
        prompt: "select_account",
        // openid email profile only; platform scopes are separate org-level connections.
        scope: ["openid", "email", "profile"],
      },
    },
    account: {
      encryptOAuthTokens: true,
      accountLinking: { enabled: true, trustedProviders: ["google"] },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 days
      updateAge: 60 * 60 * 24, // refresh daily
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    onAPIError: {
      // OAuth callback failures (e.g. not on the allowlist) land on the sign-in page with ?error=
      errorURL: `${env.webUrl}/sign-in`,
    },

    plugins: [
      oneTap({ clientId: env.googleClientId }),
      organization({
        // Organizations are created by the bootstrap hook, not by users (MVP: single org).
        allowUserToCreateOrganization: false,
        creatorRole: "owner",
      }),
    ],

    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const decision = await policy.canCreateUser(user.email)
            if (!decision.allowed) {
              throw new APIError("FORBIDDEN", { message: decision.reason })
            }
            return { data: user }
          },
          after: async (user) => {
            await policy.onUserCreated({ id: user.id, email: user.email, name: user.name })
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const result = await policy.canStartSession(session.userId)
            if (!result.allowed) {
              throw new APIError("FORBIDDEN", { message: result.reason })
            }
            return { data: { ...session, activeOrganizationId: result.organizationId } }
          },
        },
      },
    },
  })
}

export type Auth = ReturnType<typeof createAuth>
export type AuthSession = Auth["$Infer"]["Session"]
