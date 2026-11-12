"use client"

import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { Maximize2, Reply } from "lucide-react"
import type { ItemDetail } from "@inbox/core"
import { PriorityBadge, Rating, StatusBadge, TYPE_LABELS } from "@/components/app/item-badges"
import { PLATFORM_LABELS, PlatformIcon } from "@/components/app/platform-icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { api, ApiError } from "@/lib/api"
import { absoluteTime, relativeTime } from "@/lib/format"
import { qk } from "@/lib/query-keys"
import {
  authorLabel,
  isHiddenStatus,
  ItemActionButtons,
  ItemBody,
  ItemContext,
  OpenInAppButton,
} from "./item-detail-parts"
import type { RestoreTarget } from "./restore-dialog"
import type { ItemAction } from "./use-item-actions"

/**
 * Quick preview (Space, or the eye button on a card): read and triage without leaving the
 * list. Replying happens on the full item page, which has room for the thread and composer.
 */
export function ItemSheet({
  itemId,
  onOpenChange,
  fullHref,
  onAction,
  onRestore,
  onHideSimilar,
}: {
  itemId: string | null
  onOpenChange: (open: boolean) => void
  fullHref: (id: string, opts?: { reply?: boolean }) => string
  onAction: (id: string, action: ItemAction) => void
  onRestore: (target: RestoreTarget) => void
  onHideSimilar: (id: string) => void
}) {
  return (
    <Sheet open={itemId !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
      >
        {itemId ? (
          <ItemSheetBody
            itemId={itemId}
            fullHref={fullHref}
            onAction={onAction}
            onRestore={onRestore}
            onHideSimilar={onHideSimilar}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function ItemSheetBody({
  itemId,
  fullHref,
  onAction,
  onRestore,
  onHideSimilar,
}: {
  itemId: string
  fullHref: (id: string, opts?: { reply?: boolean }) => string
  onAction: (id: string, action: ItemAction) => void
  onRestore: (target: RestoreTarget) => void
  onHideSimilar: (id: string) => void
}) {
  const query = useQuery({
    queryKey: qk.item(itemId),
    queryFn: () => api<ItemDetail>(`/items/${itemId}`),
  })

  if (query.isPending) return <SheetSkeleton />
  if (query.isError) {
    return (
      <div className="p-6">
        <SheetHeader className="p-0">
          <SheetTitle>Couldn&apos;t load this item</SheetTitle>
          <SheetDescription>
            {query.error instanceof ApiError ? query.error.message : "Something went wrong."}
          </SheetDescription>
        </SheetHeader>
        <Button variant="outline" className="mt-4" onClick={() => void query.refetch()}>
          Try again
        </Button>
      </div>
    )
  }

  const item = query.data
  const now = query.dataUpdatedAt
  const hidden = isHiddenStatus(item.status)

  return (
    <>
      <SheetHeader className="gap-3 border-b p-4 pr-12">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <PlatformIcon platform={item.platform} />
          <span className="truncate">
            {PLATFORM_LABELS[item.platform]} · {TYPE_LABELS[item.type]} · {item.accountName}
          </span>
        </div>
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <SheetTitle className="truncate text-base">{authorLabel(item)}</SheetTitle>
            <SheetDescription className="text-xs">
              {item.authorHandle && item.authorName ? `@${item.authorHandle} · ` : ""}
              <span title={absoluteTime(item.receivedAt)}>
                {relativeTime(item.receivedAt, now)}
              </span>
            </SheetDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <OpenInAppButton link={item.link} variant="ghost" iconOnly />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Open full view"
              title="Open full view"
              nativeButton={false}
              render={<Link href={fullHref(item.id)} />}
            >
              <Maximize2 />
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <PriorityBadge priority={item.priority} />
          <StatusBadge status={item.status} />
          {item.isFollowUp ? (
            <Badge
              variant="outline"
              className="border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-400"
            >
              Follow-up
            </Badge>
          ) : null}
          {item.tags.map((t) => (
            <Badge key={t} variant="secondary">
              {t}
            </Badge>
          ))}
        </div>
      </SheetHeader>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {item.type === "review" ? <Rating value={item.rating} className="[&_svg]:size-4" /> : null}
        <ItemBody item={item} now={now} />
        <ItemContext item={item} />
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t p-3">
        {!hidden ? (
          <Button nativeButton={false} render={<Link href={fullHref(item.id, { reply: true })} />}>
            <Reply /> Reply <Kbd className="ml-1 hidden sm:inline-flex">r</Kbd>
          </Button>
        ) : null}
        <ItemActionButtons
          item={item}
          onAction={onAction}
          onRestore={onRestore}
          onHideSimilar={onHideSimilar}
        />
      </div>
    </>
  )
}

function SheetSkeleton() {
  return (
    <div className="space-y-4 p-4" aria-busy="true">
      <SheetHeader className="p-0">
        <SheetTitle className="sr-only">Loading item</SheetTitle>
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-6 w-40" />
      </SheetHeader>
      <Separator />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-28 w-full" />
    </div>
  )
}
