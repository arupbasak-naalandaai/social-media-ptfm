"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { AlertCircle, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { authClient } from "@/lib/auth-client"
import { publicEnv } from "@/lib/env"
import { describeAuthError } from "./auth-errors"

/** Only allow same-site relative paths as post-sign-in destinations. */
function safeNext(value: string | null): string {
  if (value && value.startsWith("/") && !value.startsWith("//")) return value
  return "/inbox"
}

export function SignInCard() {
  const router = useRouter()
  const params = useSearchParams()
  const next = safeNext(params.get("next"))
  const [error, setError] = useState<string | null>(() => describeAuthError(params.get("error")))
  const [pending, setPending] = useState(false)
  const oneTapStarted = useRef(false)
  const { data: session, isPending: sessionPending } = authClient.useSession()

  // Already signed in (validated by the api, not just a cookie): go straight to the app.
  useEffect(() => {
    if (session) router.replace(next)
  }, [session, next, router])

  // Google One Tap: one click for returning users. Falls back to the button below.
  useEffect(() => {
    if (!publicEnv.googleClientId || oneTapStarted.current || sessionPending || session) return
    oneTapStarted.current = true
    void authClient.oneTap({
      callbackURL: next,
      fetchOptions: {
        onSuccess: () => {
          router.replace(next)
          router.refresh()
        },
        onError: (ctx) =>
          setError(describeAuthError(ctx.error.message ?? ctx.error.code ?? "unknown")),
      },
      onPromptNotification: () => {
        // Prompt dismissed, skipped or in cooldown: the button is still there.
      },
    })
  }, [next, router, session, sessionPending])

  async function signInWithGoogle() {
    setPending(true)
    setError(null)
    const { error: err } = await authClient.signIn.social({
      provider: "google",
      callbackURL: next,
      errorCallbackURL: "/sign-in",
    })
    if (err) {
      setPending(false)
      setError(describeAuthError(err.message ?? err.code ?? "unknown"))
      toast.error("Sign-in failed")
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="text-center">
        <CardTitle className="text-xl">Welcome</CardTitle>
        <CardDescription>Sign in with your Google account to open the inbox.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>Couldn’t sign you in</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <Button size="lg" className="w-full" onClick={signInWithGoogle} disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : <GoogleIcon />}
          Continue with Google
        </Button>
        {!publicEnv.googleClientId ? (
          <p className="text-center text-xs text-muted-foreground">
            One Tap is off: NEXT_PUBLIC_GOOGLE_CLIENT_ID isn’t set.
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4">
      <path
        fill="#EA4335"
        d="M12 10.2v3.9h5.5c-.2 1.3-1.6 3.8-5.5 3.8-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 3.2 14.6 2.2 12 2.2 6.6 2.2 2.2 6.6 2.2 12s4.4 9.8 9.8 9.8c5.7 0 9.4-4 9.4-9.6 0-.6-.1-1.1-.2-1.6H12z"
      />
    </svg>
  )
}
