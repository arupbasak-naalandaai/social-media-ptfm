import type { Metadata } from "next"
import { Suspense } from "react"
import { ItemPage, PageSkeleton } from "@/components/inbox/item-page"

export const metadata: Metadata = { title: "Item" }

/** Full item view: thread + reply composer. The id is runtime data, so it renders in Suspense. */
export default function ItemRoute({ params }: PageProps<"/items/[id]">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      {params.then(({ id }) => (
        <ItemPage key={id} itemId={id} />
      ))}
    </Suspense>
  )
}
