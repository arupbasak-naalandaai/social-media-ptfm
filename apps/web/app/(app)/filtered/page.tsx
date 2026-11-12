import type { Metadata } from "next"
import { Suspense } from "react"
import { ItemList } from "@/components/inbox/item-list"
import { ItemListSkeleton } from "@/components/inbox/item-list-skeleton"

export const metadata: Metadata = { title: "Filtered" }

export default function FilteredPage() {
  return (
    <div className="flex flex-1 flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Items hidden by your filter rules or archived by a teammate. Nothing here was deleted:
        restore anything that isn&apos;t spam.
      </p>
      <Suspense fallback={<ItemListSkeleton />}>
        <ItemList defaultView="filtered" showTabs={false} />
      </Suspense>
    </div>
  )
}
