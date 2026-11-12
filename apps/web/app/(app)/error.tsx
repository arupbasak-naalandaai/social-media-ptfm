"use client"

import { AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/app/empty-state"

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <EmptyState
      icon={AlertTriangle}
      title="Something went wrong"
      description={
        error.digest ? `Error reference: ${error.digest}` : "An unexpected error occurred."
      }
    >
      <Button variant="outline" onClick={reset}>
        Try again
      </Button>
    </EmptyState>
  )
}
