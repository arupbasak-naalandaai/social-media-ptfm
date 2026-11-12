import { Skeleton } from "@/components/ui/skeleton"

/** Shown while the server checks the session. Mirrors the sidebar + header layout. */
export function ShellSkeleton() {
  return (
    <div className="flex min-h-svh w-full" aria-busy="true" aria-label="Loading">
      <div className="hidden w-64 shrink-0 flex-col gap-3 border-r p-3 md:flex">
        <Skeleton className="h-10 w-full" />
        <div className="mt-4 space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
        <Skeleton className="mt-auto h-12 w-full" />
      </div>
      <div className="flex flex-1 flex-col">
        <div className="flex h-14 items-center gap-3 border-b px-4">
          <Skeleton className="size-7" />
          <Skeleton className="h-4 w-24" />
        </div>
        <div className="space-y-3 p-6">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    </div>
  )
}
