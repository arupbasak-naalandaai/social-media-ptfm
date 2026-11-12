import type { Metadata } from "next"
import { Suspense } from "react"
import { MessagesSquare } from "lucide-react"
import { SignInCard } from "./sign-in-card"
import { Skeleton } from "@/components/ui/skeleton"

export const metadata: Metadata = { title: "Sign in" }

export default function SignInPage() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted/40 p-6">
      <div className="flex items-center gap-2 font-semibold">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <MessagesSquare className="size-4" />
        </div>
        Social Inbox
      </div>
      <Suspense fallback={<Skeleton className="h-56 w-full max-w-sm rounded-xl" />}>
        <SignInCard />
      </Suspense>
    </div>
  )
}
