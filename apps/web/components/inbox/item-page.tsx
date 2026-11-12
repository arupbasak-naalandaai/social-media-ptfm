"use client"

import { useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query"
import { useCallback, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { ArrowLeft, ChevronDown, ChevronUp } from "lucide-react"
import type { FollowUpListResponse, ItemDetail, ItemListResponse } from "@inbox/core"
import { PriorityBadge, Rating, StatusBadge, TYPE_LABELS } from "@/components/app/item-badges"
import { PLATFORM_LABELS, PlatformIcon } from "@/components/app/platform-icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
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
  ReplyComposer,
} from "./item-detail-parts"
import {
  defaultViewForPath,
  followUpQuery,
  itemHref,
  listQuery,
  parseFilters,
  parseView,
  safeListHref,
} from "./list-state"
import { RestoreDialog, type RestoreTarget } from "./restore-dialog"
import { useHideSimilar } from "./use-hide-similar"
import { useItemAction, type ItemAction } from "./use-item-actions"
import { useInboxShortcuts } from "./use-shortcuts"

/**
 * Item ids of the list this page was opened from, read from the React Query cache (no fetch).
 * Empty when the list isn't cached, e.g. after a reload: next/previous are then unavailable.
 */
function useListIds(from: string): string[] {
  const queryClient = useQueryClient()
  const url = new URL(from, "http://local")
  const view = parseView(url.searchParams, defaultViewForPath(url.pathname))
  const filters = parseFilters(url.searchParams)
  if (view === "followups") {
    const data = queryClient.getQueryData<InfiniteData<FollowUpListResponse>>(
      qk.followUps(followUpQuery(filters)),
    )
    const threads = data?.pages.flatMap((p) => p.threads) ?? []
    // Same order as the Follow-ups tab: new activity first.
    return [
      ...threads.filter((t) => t.newCount > 0),
      ...threads.filter((t) => t.newCount === 0),
    ].map((t) => t.item.id)
  }
  const data = queryClient.getQueryData<InfiniteData<ItemListResponse>>(
    qk.itemList(listQuery(view, filters)),
  )
  return data?.pages.flatMap((p) => p.items.map((i) => i.id)) ?? []
}

/** Actions after which the item usually leaves the list it came from. */
const LEAVES_LIST: readonly ItemAction[] = ["resolve", "ignore", "archive"]

/**
 * Full item page: the whole thread on the left, a roomy reply composer on the right (stacked on
 * phones). j/k walk the list it was opened from; after resolving, it moves to the next item.
 */
export function ItemPage({ itemId }: { itemId: string }) {
  const params = useSearchParams()
  const router = useRouter()
  const from = safeListHref(params.get("from"))
  const [focusToken, setFocusToken] = useState(params.get("reply") === "1" ? 1 : 0)
  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | null>(null)

  const query = useQuery({
    queryKey: qk.item(itemId),
    queryFn: () => api<ItemDetail>(`/items/${itemId}`),
  })

  const ids = useListIds(from)
  const index = ids.indexOf(itemId)
  const prevId = index > 0 ? ids[index - 1] : undefined
  const nextId = index >= 0 ? ids[index + 1] : undefined

  const goTo = useCallback(
    (id: string | undefined) => {
      if (id) router.replace(itemHref(id, from))
      else router.push(from)
    },
    [router, from],
  )
  const moveOn = useCallback(() => goTo(nextId ?? prevId), [goTo, nextId, prevId])

  const action = useItemAction()
  const runAction = useCallback(
    (id: string, act: ItemAction, addToAllowlist?: boolean) => {
      action.mutate({
        id,
        action: act,
        ...(addToAllowlist !== undefined ? { addToAllowlist } : {}),
      })
      if (LEAVES_LIST.includes(act)) moveOn()
    },
    [action, moveOn],
  )
  const hideSimilar = useHideSimilar({ onHidden: () => moveOn() })

  const item = query.data
  const hidden = item ? isHiddenStatus(item.status) : false

  useInboxShortcuts({
    next: () => nextId && goTo(nextId),
    prev: () => prevId && goTo(prevId),
    open: () => {},
    reply: () => item && !hidden && setFocusToken((t) => t + 1),
    resolve: () => item && !hidden && runAction(item.id, "resolve"),
    ignore: () => item && !hidden && runAction(item.id, "ignore"),
    escape: () => router.push(from),
  })

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4">
      <nav className="flex flex-wrap items-center gap-2" aria-label="Item navigation">
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href={from} />}>
          <ArrowLeft /> Back to list
        </Button>
        {ids.length > 0 && index >= 0 ? (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous item (k)"
              title="Previous (k)"
              disabled={!prevId}
              onClick={() => goTo(prevId)}
            >
              <ChevronUp />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next item (j)"
              title="Next (j)"
              disabled={!nextId}
              onClick={() => goTo(nextId)}
            >
              <ChevronDown />
            </Button>
            <span className="tabular-nums">
              {index + 1} of {ids.length}
              {ids.length >= 50 ? "+" : ""}
            </span>
          </div>
        ) : null}
        <div className="ml-auto">
          <OpenInAppButton link={item?.link ?? null} />
        </div>
      </nav>

      {query.isPending ? (
        <PageSkeleton />
      ) : query.isError ? (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <h2 className="text-base font-semibold">Couldn&apos;t load this item</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {query.error instanceof ApiError ? query.error.message : "Something went wrong."}
          </p>
          <Button variant="outline" className="mt-4" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          <article className="min-w-0 space-y-5 rounded-xl bg-card p-5 ring-1 ring-foreground/10">
            <header className="space-y-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <PlatformIcon platform={query.data.platform} />
                <span className="truncate">
                  {PLATFORM_LABELS[query.data.platform]} · {TYPE_LABELS[query.data.type]} ·{" "}
                  {query.data.accountName}
                </span>
              </div>
              <div>
                <h2 className="text-lg font-semibold">{authorLabel(query.data)}</h2>
                <p className="text-xs text-muted-foreground">
                  {query.data.authorHandle && query.data.authorName
                    ? `@${query.data.authorHandle} · `
                    : ""}
                  <span title={absoluteTime(query.data.receivedAt)}>
                    {relativeTime(query.data.receivedAt, query.dataUpdatedAt)}
                  </span>
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <PriorityBadge priority={query.data.priority} />
                <StatusBadge status={query.data.status} />
                {query.data.isFollowUp ? (
                  <Badge
                    variant="outline"
                    className="border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-400"
                  >
                    Follow-up
                  </Badge>
                ) : null}
                {query.data.tags.map((t) => (
                  <Badge key={t} variant="secondary">
                    #{t}
                  </Badge>
                ))}
              </div>
            </header>

            {query.data.type === "review" ? (
              <Rating value={query.data.rating} className="[&_svg]:size-4" />
            ) : null}
            <ItemBody item={query.data} now={query.dataUpdatedAt} large />
            <ItemContext item={query.data} />
          </article>

          <aside className="space-y-4 lg:sticky lg:top-20">
            <div className="space-y-3 rounded-xl bg-card p-5 ring-1 ring-foreground/10">
              <h2 className="flex items-center justify-between text-sm font-medium">
                Reply
                <span className="text-xs font-normal text-muted-foreground">
                  <Kbd>r</Kbd> to focus
                </span>
              </h2>
              {hidden ? (
                <p className="text-sm text-muted-foreground">
                  This item is hidden from the inbox. Restore it to reply.
                </p>
              ) : (
                <ReplyComposer
                  item={query.data}
                  focusToken={focusToken}
                  now={query.dataUpdatedAt}
                  rows={8}
                />
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ItemActionButtons
                item={query.data}
                onAction={runAction}
                onRestore={setRestoreTarget}
                onHideSimilar={(id) => hideSimilar.mutate(id)}
                hideSimilarPending={hideSimilar.isPending}
              />
            </div>
            <p className="hidden text-xs text-muted-foreground md:block">
              <Kbd>j</Kbd> <Kbd>k</Kbd> next/previous · <Kbd>e</Kbd> resolve · <Kbd>i</Kbd> ignore ·{" "}
              <Kbd>Esc</Kbd> back
            </p>
          </aside>
        </div>
      )}

      <RestoreDialog
        target={restoreTarget}
        onClose={() => setRestoreTarget(null)}
        onConfirm={(id, addToAllowlist) => {
          setRestoreTarget(null)
          runAction(id, "restore", addToAllowlist)
        }}
      />
    </div>
  )
}

export function PageSkeleton() {
  return (
    <div
      className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]"
      aria-busy="true"
      aria-label="Loading item"
    >
      <div className="space-y-4 rounded-xl p-5 ring-1 ring-foreground/10">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-16 w-3/4" />
      </div>
      <div className="space-y-3 rounded-xl p-5 ring-1 ring-foreground/10">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-8 w-48" />
      </div>
    </div>
  )
}
