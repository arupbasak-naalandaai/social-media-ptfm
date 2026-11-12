"use client"

import { useRouter } from "next/navigation"
import { ShieldAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { authClient } from "@/lib/auth-client"

export function NoAccess() {
  const router = useRouter()
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="max-w-sm space-y-4 text-center">
        <ShieldAlert className="mx-auto size-10 text-muted-foreground" />
        <h1 className="text-lg font-semibold">No access to this workspace</h1>
        <p className="text-sm text-muted-foreground">
          You’re signed in, but your account isn’t a member of a workspace. Ask an owner or admin to
          add your email to the sign-in allowlist, then sign in again.
        </p>
        <Button
          variant="outline"
          onClick={async () => {
            await authClient.signOut()
            router.replace("/sign-in")
          }}
        >
          Sign out
        </Button>
      </div>
    </div>
  )
}
