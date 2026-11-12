"use client"

import { useInfiniteQuery } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  MessagesSquare,
  Reply,
  SearchX,
} from "lucide-react"
import type { FollowUpListResponse, FollowUpThread, ItemCounts } from "@inbox/core"
import { EmptyState } from "@/components/app/empty-state"
import { Rating, StatusBadge } from "@/components/app/item-badges"
import { PlatformIcon } from "@/components/app/platform-icon"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { api, ApiError } from "@/lib/api"
import { absoluteTime, relativeTime } from "@/lib/format"
import { qk } from "@/lib/query-keys"
import { cn } from "cn"
import { ITEM_CARD_HEIGHT } from "./card-size"
import { isOpenStatus } from "./item-detail-parts"
import { ItemRowsSkeleton } from "./item-list-skeleton"
import { followUpQuery, itemHref } from "./list-state"
import { Toolbar } from "./toolbar"
import { useItemAction } from "./use-item-actions"
import type { useItemFilters } from "./use-item-filters"
import { useInboxShortcuts } from "./use-shortcuts"

const PAGE_SIZE = 30

/**
 * Conversations and comment threads you already replied to or resolved. When the person
 * writes again, the thread jumps to "New activity" at the top instead of the main inbox.
 */
export function FollowUpList({
  state,
  tabs,
}: {
  state: ReturnType<typeof useItemFilters>
  tabs: (counts: ItemCounts | undefined) => ReactNode
}) {
  const { filters, listHref, update, hasFilters, clearFilters } = state
  const router = useRouter()
  const params = useMemo(() => followUpQuery(filters), [filters])

  const query = useInfiniteQuery({
    queryKey: qk.followUps(params),
    queryFn: ({ pageParam }) =>
      api<FollowUpListResponse>("/items/follow-ups", {
        query: { ...params, cursor: pageParam, limit: PAGE_SIZE },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })

  const { threads, fresh, engaged, ordered } = useMemo(() => {
    const all = query.data?.pages.flatMap((p) => p.threads) ?? []
    const fresh = all.filter((t) => t.newCount > 0)
    const engaged = all.filter((t) => t.newCount === 0)
    // Keyboard order matches what's on screen: new activity first.
    return { threads: all, fresh, engaged, ordered: [...fresh, ...engaged] }
  }, [query.data])
  const counts = query.data?.pages[0]?.counts
  const now = query.dataUpdatedAt

  const [selected, setSelected] = useState<string | null>(null)
  const index = selected ? ordered.findIndex((t) => t.threadKey === selected) : -1
  const current = index >= 0 ? ordered[index] : undefined
  const action = useItemAction()

  const open = useCallback(
    (t: FollowUpThread, opts?: { reply?: boolean }) =>
      router.push(itemHref(t.item.id, listHref, opts)),
    [router, listHref],
  )
  const select = (i: number) => {
    const t = ordered[Math.max(0, Math.min(ordered.length - 1, i))]
    if (!t) return
    setSelected(t.threadKey)
    document
      .querySelector(`[data-thread-key="${CSS.escape(t.threadKey)}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }
  const resolve = (t: FollowUpThread) => {
    if (isOpenStatus(t.item.status)) action.mutate({ id: t.item.id, action: "resolve" })
  }

  useInboxShortcuts({
    next: () => select(index < 0 ? 0 : index + 1),
    prev: () => select(index < 0 ? 0 : index - 1),
    open: () => current && open(current),
    reply: () => current && open(current, { reply: true }),
    resolve: () => current && resolve(current),
    ignore: () => {
      if (current && isOpenStatus(current.item.status))
        action.mutate({ id: current.item.id, action: "ignore" })
    },
  })

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
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, threads.length])

  const card = (t: FollowUpThread) => (
    <ThreadCard
      key={t.threadKey}
      thread={t}
      now={now}
      selected={t.threadKey === selected}
      onOpen={() => {
        setSelected(t.threadKey)
        open(t)
      }}
      onReply={() => open(t, { reply: true })}
      onResolve={() => resolve(t)}
    />
  )

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4">
      {tabs(counts)}
      <Toolbar
        view="followups"
        filters={filters}
        update={update}
        hasFilters={hasFilters}
        clearFilters={clearFilters}
        seenTags={[]}
      />

      {query.isPending ? (
        <ItemRowsSkeleton />
      ) : query.isError ? (
        <EmptyState
          icon={AlertTriangle}
          title="Couldn't load follow-ups"
          description={
            query.error instanceof ApiError ? query.error.message : "Something went wrong."
          }
        >
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </EmptyState>
      ) : threads.length === 0 ? (
        hasFilters ? (
          <EmptyState
            icon={SearchX}
            title="No threads match these filters"
            description="Try widening the search or clearing filters."
          >
            <Button variant="outline" onClick={clearFilters}>
              Clear filters
            </Button>
          </EmptyState>
        ) : (
          <EmptyState
            icon={MessagesSquare}
            title="No follow-ups yet"
            description="Conversations you reply to or resolve collect here. When that person writes again, the thread jumps to the top so you can pick it up where you left off."
          />
        )
      ) : (
        <TooltipProvider delay={400}>
          {fresh.length > 0 ? (
            <ThreadSection title="New activity" count={fresh.length}>
              {fresh.map(card)}
            </ThreadSection>
          ) : null}
          {engaged.length > 0 ? (
            <ThreadSection title="You engaged" count={engaged.length} muted>
              {engaged.map(card)}
            </ThreadSection>
          ) : null}
          <div ref={sentinelRef} aria-hidden className="h-px" />
        </TooltipProvider>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <div className="hidden items-center gap-1.5 md:flex" aria-label="Keyboard shortcuts">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd> move · <Kbd>Enter</Kbd> open · <Kbd>r</Kbd> reply · <Kbd>e</Kbd> resolve
        </div>
        <div aria-live="polite">
          {isFetchingNextPage ? (
            <span className="flex items-center gap-1.5">
              <Spinner /> Loading more…
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function ThreadSection({
  title,
  count,
  muted = false,
  children,
}: {
  title: string
  count: number
  muted?: boolean
  children: ReactNode
}) {
  return (
    <section className="space-y-2" aria-label={title}>
      <h2
        className={cn(
          "flex items-center gap-2 text-xs font-medium tracking-wide uppercase",
          muted ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {title}
        <span className="font-normal text-muted-foreground tabular-nums">{count}</span>
      </h2>
      <ul className="flex flex-col">{children}</ul>
    </section>
  )
}

function ThreadCard({
  thread,
  now,
  selected,
  onOpen,
  onReply,
  onResolve,
}: {
  thread: FollowUpThread
  now: number
  selected: boolean
  onOpen: () => void
  onReply: () => void
  onResolve: () => void
}) {
  const { item } = thread
  const author = item.authorName ?? item.authorHandle ?? "Unknown"
  const text = item.text?.trim()
  const hasNew = thread.newCount > 0

  return (
    <li data-thread-key={thread.threadKey} className="px-px pt-px pb-2">
      <div
        onClick={onOpen}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "group flex cursor-pointer items-center gap-3 rounded-xl bg-card px-4 ring-1 transition-[background-color,box-shadow] duration-150",
          ITEM_CARD_HEIGHT,
          selected
            ? "bg-muted/50 ring-foreground/30"
            : "ring-foreground/10 hover:bg-muted/30 hover:ring-foreground/20",
          hasNew && !selected && "ring-blue-500/40",
        )}
      >
        <div className="relative shrink-0">
          <Avatar>
            <AvatarFallback className="text-xs font-medium">
              {author.replace(/^@/, "").slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <PlatformIcon
            platform={item.platform}
            className="absolute -right-1 -bottom-1 size-4 rounded-[5px] text-[8px] ring-2 ring-card"
          />
        </div>

        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium">{author}</span>
            <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:block">
              {item.accountName}
              {thread.itemCount > 1 ? ` · ${thread.itemCount} messages` : ""}
            </span>
            {item.type === "review" ? <Rating value={item.rating} className="shrink-0" /> : null}
          </div>
          <p className="truncate text-sm text-muted-foreground" title={text || undefined}>
            {text || <span className="italic">No text</span>}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {hasNew ? (
            <Badge className="bg-blue-600 text-white dark:bg-blue-500">{thread.newCount} new</Badge>
          ) : (
            <StatusBadge status={item.status} className="hidden md:inline-flex" />
          )}
          {thread.lastEngagedAt ? (
            <span
              className="hidden text-xs whitespace-nowrap text-muted-foreground lg:inline"
              title={absoluteTime(thread.lastEngagedAt)}
            >
              you · {relativeTime(thread.lastEngagedAt, now)}
            </span>
          ) : null}
        </div>

        <div className="grid shrink-0 items-center justify-items-end [@media(hover:hover)]:min-w-24">
          <span
            className="text-xs whitespace-nowrap text-muted-foreground tabular-nums [grid-area:1/1] transition-opacity duration-150 group-focus-within:opacity-0 group-hover:opacity-0 [@media(hover:none)]:opacity-100!"
            title={absoluteTime(thread.lastActivityAt)}
          >
            {relativeTime(thread.lastActivityAt, now)}
          </span>
          <div
            role="toolbar"
            aria-label="Quick actions"
            onClick={(e) => e.stopPropagation()}
            className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 [grid-area:1/1] group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:hidden"
          >
            {item.link ? (
              <IconAction label={item.link.label}>
                <a href={item.link.url} target="_blank" rel="noreferrer" />
              </IconAction>
            ) : null}
            <IconAction label="Reply" onClick={onReply} />
            {hasNew ? <IconAction label="Resolve" onClick={onResolve} /> : null}
          </div>
        </div>
      </div>
    </li>
  )
}

const ICONS = { Reply, Resolve: CheckCircle2 } as const

/** Ghost icon button with a tooltip. Pass an `<a>` child to render it as a link. */
function IconAction({
  label,
  onClick,
  children,
}: {
  label: string
  onClick?: () => void
  children?: React.ReactElement
}) {
  const Icon = (ICONS as Record<string, typeof Reply>)[label] ?? ExternalLink
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            className="text-muted-foreground hover:text-foreground"
            onClick={onClick}
            {...(children ? { nativeButton: false, render: children } : {})}
          />
        }
      >
        <Icon />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
