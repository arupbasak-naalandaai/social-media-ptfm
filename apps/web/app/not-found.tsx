import Link from "next/link"
import { Button } from "@/components/ui/button"

export default function NotFound() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-lg font-semibold">Page not found</h1>
      <p className="text-sm text-muted-foreground">That page doesn’t exist.</p>
      <Button variant="outline" nativeButton={false} render={<Link href="/inbox" />}>
        Back to inbox
      </Button>
    </div>
  )
}
