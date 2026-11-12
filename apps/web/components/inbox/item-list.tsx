"use client"

import { useInfiniteQuery } from "@tanstack/react-query"
import { AnimatePresence, MotionConfig } from "motion/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AlertTriangle, CheckCheck, Filter, Inbox, ListFilter, SearchX } from "lucide-react"
import {
  VIEW_STATUSES,
  type InboxView,
  type ItemListResponse,
  type ItemStatus,
  type ItemSummary,
} from "@inbox/core"
import { EmptyState } from "@/components/app/empty-state"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { api, ApiError } from "@/lib/api"
import { qk } from "@/lib/query-keys"
import { FollowUpList } from "./follow-up-list"
import { ItemRow } from "./item-row"
import { ItemRowsSkeleton } from "./item-list-skeleton"
import { ItemSheet } from "./item-sheet"
import { itemHref, listQuery, type ListView } from "./list-state"
import { RestoreDialog, type RestoreTarget } from "./restore-dialog"
import { Toolbar } from "./toolbar"
import { RESULT_STATUS, useItemAction, type ItemAction } from "./use-item-actions"
import { useHideSimilar } from "./use-hide-similar"
import { useItemFilters } from "./use-item-filters"
import { useInboxShortcuts } from "./use-shortcuts"
import { ViewTabs } from "./view-tabs"

const PAGE_SIZE = 50

type ListState = ReturnType<typeof useItemFilters>

/**
 * Inbox (Open · Follow-ups · Done) and Filtered. All state that matters (view, filters,
 * previewed item) lives in the URL.
 */
export function ItemList({ defaultView, showTabs }: { defaultView: ListView; showTabs: boolean }) {
  const state = useItemFilters(defaultView)
  const tabs = (counts: ItemListResponse["counts"] | undefined) =>
    showTabs ? (
      <ViewTabs
        view={state.view}
        counts={counts}
        onChange={(v) => state.update({ view: v === "inbox" ? null : v, status: null, item: null })}
      />
    ) : null

  if (state.view === "followups") return <FollowUpList state={state} tabs={tabs} />
  return <ItemListView state={state} view={state.view} tabs={tabs} />
}

/**
 * A flat list of items: toolbar, cards, quick-preview sheet, restore dialog and shortcuts.
 * Opening an item goes to its full page; Space previews it in the sheet.
 */
function ItemListView({
  state,
  view,
  tabs,
}: {
  state: ListState
  view: InboxView
  tabs: (counts: ItemListResponse["counts"] | undefined) => React.ReactNode
}) {
  const { filters, openItemId, listHref, update, hasFilters, clearFilters } = state
  const router = useRouter()
  const params = useMemo(() => listQuery(view, filters), [view, filters])

  const query = useInfiniteQuery({
    queryKey: qk.itemList(params),
    queryFn: ({ pageParam }) =>
      api<ItemListResponse>("/items", {
        query: { ...params, cursor: pageParam, limit: PAGE_SIZE },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })

  // Keep each item's position within its page: new pages stagger in from their own top.
  const rows = useMemo(
    () =>
      query.data?.pages.flatMap((p) => p.items.map((item, i) => ({ item, staggerIndex: i }))) ?? [],
    [query.data],
  )
  const items = useMemo(() => rows.map((r) => r.item), [rows])
  const counts = query.data?.pages[0]?.counts
  const seenTags = useMemo(() => [...new Set(items.flatMap((i) => i.tags))], [items])
  const now = query.dataUpdatedAt

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | null>(null)
  const action = useItemAction()

  const activeId = openItemId ?? selectedId
  const activeIndex = activeId ? items.findIndex((i) => i.id === activeId) : -1

  const fullHref = useCallback(
    (id: string, opts?: { reply?: boolean }) => itemHref(id, listHref, opts),
    [listHref],
  )
  const preview = useCallback((id: string | null) => update({ item: id }), [update])
  const openFull = useCallback(
    (id: string, opts?: { reply?: boolean }) => {
      setSelectedId(id)
      router.push(fullHref(id, opts))
    },
    [router, fullHref],
  )
  const onPreview = useCallback(
    (id: string) => {
      setSelectedId(id)
      preview(id)
    },
    [preview],
  )

  const select = useCallback(
    (index: number) => {
      const item = items[Math.max(0, Math.min(items.length - 1, index))]
      if (!item) return
      setSelectedId(item.id)
      if (openItemId) preview(item.id)
      document.querySelector(`[data-item-id="${item.id}"]`)?.scrollIntoView({ block: "nearest" })
    },
    [items, openItemId, preview],
  )

  const allowedStatuses: readonly ItemStatus[] = filters.status.length
    ? filters.status
    : VIEW_STATUSES[view]

  const runAction = useCallback(
    (id: string, act: ItemAction, addToAllowlist?: boolean) => {
      // When the item leaves this view, move on to its neighbour (and keep the sheet open on it).
      if (!allowedStatuses.includes(RESULT_STATUS[act])) {
        const idx = items.findIndex((i) => i.id === id)
        const neighbour = items[idx + 1] ?? items[idx - 1] ?? null
        setSelectedId(neighbour?.id ?? null)
        if (openItemId === id) preview(neighbour?.id ?? null)
      }
      action.mutate({
        id,
        action: act,
        ...(addToAllowlist !== undefined ? { addToAllowlist } : {}),
      })
    },
    [action, allowedStatuses, items, openItemId, preview],
  )

  const hideSimilar = useHideSimilar({
    onHidden: (id) => {
      if (openItemId === id) preview(null)
    },
  })

  const current: ItemSummary | undefined = activeIndex >= 0 ? items[activeIndex] : undefined
  const isHiddenView = view === "filtered"

  useInboxShortcuts({
    next: () => select(activeIndex < 0 ? 0 : activeIndex + 1),
    prev: () => select(activeIndex < 0 ? 0 : activeIndex - 1),
    open: () => current && openFull(current.id),
    preview: () => current && (openItemId === current.id ? preview(null) : onPreview(current.id)),
    reply: () => {
      if (!current || isHiddenView) return
      openFull(current.id, { reply: true })
    },
    resolve: () => current && !isHiddenView && runAction(current.id, "resolve"),
    ignore: () => current && !isHiddenView && runAction(current.id, "ignore"),
  })

  const onRestore = useCallback((item: RestoreTarget) => setRestoreTarget(item), [])

  // Stable handlers for the memoised rows (runAction changes whenever the list does).
  const runActionRef = useRef(runAction)
  useEffect(() => {
    runActionRef.current = runAction
  })
  const onRowAction = useCallback(
    (id: string, act: ItemAction) => runActionRef.current(id, act),
    [],
  )
  const onRowOpen = useCallback((id: string) => openFull(id), [openFull])
  const onRowReply = useCallback((id: string) => openFull(id, { reply: true }), [openFull])

  // Infinite scroll: fetch the next page when the sentinel below the list nears the viewport.
  // Re-observing after every page means a short page that leaves the sentinel visible
  // immediately triggers the next fetch.
  const sentinelRef = useRef<HTMLDivElement>(null)
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !hasNextPage || isFetchingNextPage) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void fetchNextPage()
      },
      { rootMargin: "600px 0px" },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, items.length])

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4">
      {tabs(counts)}

      <Toolbar
        view={view}
        filters={filters}
        update={update}
        hasFilters={hasFilters}
        clearFilters={clearFilters}
        seenTags={seenTags}
      />

      {query.isPending ? (
        <ItemRowsSkeleton />
      ) : query.isError ? (
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load items"
          description={
            query.error instanceof ApiError ? query.error.message : "Something went wrong."
          }
        >
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </EmptyState>
      ) : items.length === 0 ? (
        <ListEmpty view={view} hasFilters={hasFilters} clearFilters={clearFilters} />
      ) : (
        <MotionConfig reducedMotion="user">
          <TooltipProvider delay={400}>
            <ul aria-label="Items" className="flex flex-col">
              <AnimatePresence initial>
                {rows.map(({ item, staggerIndex }) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    staggerIndex={staggerIndex}
                    selected={item.id === activeId}
                    filteredView={isHiddenView}
                    now={now}
                    onOpen={onRowOpen}
                    onPreview={onPreview}
                    onRestore={onRestore}
                    onAction={onRowAction}
                    onReply={onRowReply}
                  />
                ))}
              </AnimatePresence>
            </ul>
          </TooltipProvider>
          <div ref={sentinelRef} aria-hidden className="h-px" />
        </MotionConfig>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <div className="hidden items-center gap-1.5 md:flex" aria-label="Keyboard shortcuts">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd> move · <Kbd>Enter</Kbd> open · <Kbd>Space</Kbd> preview ·{" "}
          {isHiddenView ? null : (
            <>
              <Kbd>r</Kbd> reply · <Kbd>e</Kbd> resolve · <Kbd>i</Kbd> ignore
            </>
          )}
        </div>
        <div className="flex items-center gap-3" aria-live="polite">
          {isFetchingNextPage ? (
            <span className="flex items-center gap-1.5">
              <Spinner /> Loading more…
            </span>
          ) : items.length > 0 && !hasNextPage ? (
            <span>That&apos;s everything · {items.length} items</span>
          ) : items.length > 0 ? (
            <span>{items.length} shown</span>
          ) : null}
        </div>
      </div>

      <ItemSheet
        itemId={openItemId}
        onOpenChange={(open) => {
          if (!open) preview(null)
        }}
        fullHref={fullHref}
        onAction={runAction}
        onRestore={onRestore}
        onHideSimilar={(id) => hideSimilar.mutate(id)}
      />
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

function ListEmpty({
  view,
  hasFilters,
  clearFilters,
}: {
  view: InboxView
  hasFilters: boolean
  clearFilters: () => void
}) {
  if (hasFilters) {
    return (
      <EmptyState
        icon={SearchX}
        title="No items match these filters"
        description="Try widening the search or clearing filters."
      >
        <Button variant="outline" onClick={clearFilters}>
          Clear filters
        </Button>
      </EmptyState>
    )
  }
  if (view === "done") {
    return (
      <EmptyState
        icon={CheckCheck}
        title="Nothing done yet"
        description="Items you resolve, ignore or reply to show up here."
      />
    )
  }
  if (view === "filtered") {
    return (
      <EmptyState
        icon={ListFilter}
        title="Nothing filtered"
        description="Items your filter rules hide (spam, low-value praise, emoji-only comments, blocklisted authors…) show up here with the rule that hid them."
      >
        <Button variant="outline" nativeButton={false} render={<Link href="/filters" />}>
          <Filter /> Review filter rules
        </Button>
      </EmptyState>
    )
  }
  return (
    <EmptyState
      icon={Inbox}
      title="Inbox zero"
      description="Nothing new needs a reply. Replies from people you already talked to land in Follow-ups."
    />
  )
}
