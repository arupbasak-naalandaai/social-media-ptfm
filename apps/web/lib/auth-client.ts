"use client"

import { createAuthClient } from "better-auth/react"
import { oneTapClient, organizationClient } from "better-auth/client/plugins"
import { publicEnv } from "./env"

// Same-origin: requests go to /api/auth/* on the web domain and are proxied to the api.
export const authClient = createAuthClient({
  plugins: [
    organizationClient(),
    ...(publicEnv.googleClientId
      ? [
          oneTapClient({
            clientId: publicEnv.googleClientId,
            autoSelect: false,
            cancelOnTapOutside: true,
            context: "signin",
            promptOptions: { baseDelay: 1000, maxAttempts: 3 },
          }),
        ]
      : []),
  ],
})

export const { useSession, signOut } = authClient
