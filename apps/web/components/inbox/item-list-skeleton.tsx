import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "cn"
import { ITEM_CARD_HEIGHT } from "./card-size"

/** Static fallback while the URL-driven list mounts (no data or time access). */
export function ItemListSkeleton({ tabs = false }: { tabs?: boolean }) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4">
      {tabs ? <Skeleton className="h-8 w-44" /> : null}
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-20" />
        <Skeleton className="h-8 w-20" />
      </div>
      <ItemRowsSkeleton />
    </div>
  )
}

/** Placeholder cards shaped like `ItemRow` (same fixed height). */
export function ItemRowsSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading items">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className={cn(
            "flex items-center gap-3 rounded-xl px-4 ring-1 ring-foreground/10",
            ITEM_CARD_HEIGHT,
          )}
        >
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3.5 w-8/12" />
          </div>
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  )
}
