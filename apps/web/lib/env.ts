/** Public (browser-safe) config. NEXT_PUBLIC_* values are inlined at build time. */
export const publicEnv = {
  googleClientId: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "",
}
