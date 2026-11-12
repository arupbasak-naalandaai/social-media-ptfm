import type { Metadata } from "next"
import { Suspense } from "react"
import { ItemList } from "@/components/inbox/item-list"
import { ItemListSkeleton } from "@/components/inbox/item-list-skeleton"

export const metadata: Metadata = { title: "Inbox" }

export default function InboxPage() {
  return (
    <Suspense fallback={<ItemListSkeleton tabs />}>
      <ItemList defaultView="inbox" showTabs />
    </Suspense>
  )
}
