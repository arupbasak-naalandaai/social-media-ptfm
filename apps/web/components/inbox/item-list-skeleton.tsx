import { Skeleton } from "@/components/ui/skeleton"

/** Static fallback while the URL-driven list mounts (no data or time access). */
export function ItemListSkeleton({ tabs = false }: { tabs?: boolean }) {
  return (
    <div className="flex flex-1 flex-col gap-4" aria-busy="true" aria-label="Loading items">
      {tabs ? <Skeleton className="h-8 w-44" /> : null}
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-20" />
        <Skeleton className="h-8 w-20" />
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex gap-3 rounded-xl border p-4">
            <Skeleton className="size-9 shrink-0 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3.5 w-11/12" />
              <Skeleton className="h-3.5 w-2/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
