const NOT_ALLOWED =
  "Your Google account isn't on this workspace's allowlist. Ask an owner or admin to add your email or domain."

/** Maps better-auth error codes / messages (from ?error= or API responses) to plain language. */
export function describeAuthError(raw: string | null | undefined): string | null {
  if (!raw) return null
  const value = decodeURIComponent(raw).toLowerCase()
  if (
    value.includes("allowlist") ||
    value.includes("forbidden") ||
    value.includes("unable_to_create_user")
  ) {
    return NOT_ALLOWED
  }
  if (value.includes("isn't allowed to set it up") || value.includes("hasn't been set up")) {
    return "This workspace hasn't been set up yet, and your account isn't allowed to set it up."
  }
  if (value.includes("access_denied")) return "Google sign-in was cancelled."
  if (value.includes("state")) return "Your sign-in session expired. Please try again."
  return "Something went wrong while signing in. Please try again."
}
