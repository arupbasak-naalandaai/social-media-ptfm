"use client"

import { useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query"
import { Fragment, useCallback, useState, type ReactNode } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { ArrowLeft, ChevronDown, ChevronUp, ExternalLink, EyeOff } from "lucide-react"
import type {
  FollowUpListResponse,
  ItemDetail,
  ItemListResponse,
  ItemStatus,
  ThreadEntry,
} from "@inbox/core"
import { PriorityBadge, Rating, StatusBadge, TYPE_LABELS } from "@/components/app/item-badges"
import { ALL_NAV } from "@/components/app/nav"
import { PLATFORM_LABELS, PlatformIcon } from "@/components/app/platform-icon"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Skeleton } from "@/components/ui/skeleton"
import { api, ApiError } from "@/lib/api"
import { absoluteTime, relativeTime } from "@/lib/format"
import { qk } from "@/lib/query-keys"
import { cn } from "cn"
import {
  authorLabel,
  isHiddenStatus,
  ItemActionButtons,
  OpenInAppButton,
  placeholder,
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

function initials(name: string): string {
  return (
    name
      .replace(/^@/, "")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("") || "?"
  )
}

/** "Google Business review", "Instagram DM", "Facebook comment". */
function channelLabel(item: Pick<ItemDetail, "platform" | "type">): string {
  const type = item.type === "dm" ? TYPE_LABELS.dm : TYPE_LABELS[item.type].toLowerCase()
  return `${PLATFORM_LABELS[item.platform]} ${type}`
}

function backLabel(from: string): string {
  const path = new URL(from, "http://local").pathname
  return ALL_NAV.find((n) => path === n.href || path.startsWith(`${n.href}/`))?.title ?? "Back"
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** "Today", "Yesterday", or "Tue, 12 Nov" (with the year when it isn't this year). */
function dayLabel(iso: string, now: number): string {
  const d = new Date(iso)
  const today = new Date(now)
  const days = Math.round((startOfDay(today) - startOfDay(d)) / 86_400_000)
  if (days === 0) return "Today"
  if (days === 1) return "Yesterday"
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  })
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
}

/**
 * Full item page: one panel with the conversation and the reply box under it, and the item's
 * details in a sidebar (stacked on phones). j/k walk the list it was opened from; after
 * resolving, it moves to the next item.
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
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-3">
      <nav className="flex flex-wrap items-center gap-2" aria-label="Item navigation">
        <Button variant="ghost" size="sm" nativeButton={false} render={<Link href={from} />}>
          <ArrowLeft /> {backLabel(from)}
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
        <div className="grid flex-1 overflow-hidden rounded-xl border bg-card lg:grid-cols-[minmax(0,1fr)_19rem]">
          <section className="flex min-w-0 flex-col" aria-label="Conversation">
            <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b px-5 py-4 sm:px-6">
              <div className="flex min-w-0 items-center gap-3">
                <div className="relative shrink-0">
                  <Avatar size="lg">
                    <AvatarFallback className="font-medium">
                      {initials(authorLabel(query.data))}
                    </AvatarFallback>
                  </Avatar>
                  <PlatformIcon
                    platform={query.data.platform}
                    className="absolute -right-1 -bottom-1 size-4.5 rounded-[5px] text-[9px] ring-2 ring-card"
                  />
                </div>
                <div className="min-w-0">
                  <h2 className="truncate text-base leading-tight font-semibold">
                    {authorLabel(query.data)}
                  </h2>
                  <p className="truncate text-sm text-muted-foreground">
                    {query.data.authorHandle && query.data.authorName
                      ? `@${query.data.authorHandle} · `
                      : ""}
                    {channelLabel(query.data)} ·{" "}
                    <span title={absoluteTime(query.data.receivedAt)}>
                      {relativeTime(query.data.receivedAt, query.dataUpdatedAt)}
                    </span>
                  </p>
                </div>
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
            </header>

            <div className="flex-1 px-5 py-6 sm:px-6">
              <Messages item={query.data} now={query.dataUpdatedAt} />
            </div>

            <div className="border-t bg-muted/30 px-5 py-4 sm:px-6">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-medium">Reply</h3>
                {hidden ? null : (
                  <span className="text-xs text-muted-foreground">
                    <Kbd>r</Kbd> to focus
                  </span>
                )}
              </div>
              {hidden ? (
                <p className="text-sm text-muted-foreground">
                  This item is hidden from the inbox. Restore it to reply.
                </p>
              ) : (
                <ReplyComposer
                  item={query.data}
                  focusToken={focusToken}
                  now={query.dataUpdatedAt}
                  rows={5}
                  onSent={(res) => {
                    if (res.afterSend === "next") moveOn()
                  }}
                />
              )}
            </div>
          </section>

          <Details item={query.data} />
        </div>
      )}

      <p className="hidden text-xs text-muted-foreground md:block">
        <Kbd>j</Kbd> <Kbd>k</Kbd> next/previous · <Kbd>r</Kbd> reply · <Kbd>e</Kbd> resolve ·{" "}
        <Kbd>i</Kbd> ignore · <Kbd>Esc</Kbd> back
      </p>

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

// ─── Messages ─────────────────────────────────────────────────────────────────

/** A lone item reads as plain text; a thread lists every message, oldest first, by day. */
function Messages({ item, now }: { item: ItemDetail; now: number }) {
  if (item.thread.length <= 1) {
    return (
      <div className="max-w-prose space-y-3">
        {item.type === "review" ? <Rating value={item.rating} className="[&_svg]:size-4" /> : null}
        <p className="text-[15px] leading-7 break-words whitespace-pre-wrap">
          {item.text?.trim() || (
            <span className="text-muted-foreground italic">{placeholder(item, item.type)}</span>
          )}
        </p>
      </div>
    )
  }

  const entries = item.thread
  return (
    <ol className="max-w-prose">
      {entries.map((m, i) => {
        const prev = entries[i - 1]
        const day = dayLabel(m.at, now)
        const newDay = !prev || dayLabel(prev.at, now) !== day
        const grouped =
          !newDay && prev !== undefined && prev.ours === m.ours && prev.authorName === m.authorName
        return (
          <Fragment key={`${m.kind}-${m.id}`}>
            {newDay ? (
              <li
                role="presentation"
                className="flex items-center gap-3 py-3 text-xs text-muted-foreground first:pt-0"
              >
                {day}
                <span className="h-px flex-1 bg-border" />
              </li>
            ) : null}
            <Message item={item} entry={m} grouped={grouped} />
          </Fragment>
        )
      })}
    </ol>
  )
}

function Message({
  item,
  entry: m,
  grouped,
}: {
  item: ItemDetail
  entry: ThreadEntry
  grouped: boolean
}) {
  const current = m.kind === "item" && m.id === item.id
  const hidden = !m.ours && isHiddenStatus(m.status as ItemStatus)
  const name = m.ours ? "You" : (m.authorName ?? authorLabel(item))
  const replyState = m.kind === "reply" && m.status !== "sent" ? m.status : null

  return (
    <li
      className={cn(
        "-mx-3 flex gap-3 rounded-lg px-3",
        grouped ? "pb-1.5" : "pt-1.5 pb-1.5",
        current && "bg-muted/60 py-2.5",
      )}
      aria-current={current ? "true" : undefined}
    >
      {grouped ? (
        <span aria-hidden className="w-8 shrink-0" />
      ) : (
        <Avatar className="mt-0.5">
          <AvatarFallback
            className={cn("text-xs font-medium", m.ours && "bg-primary text-primary-foreground")}
          >
            {m.ours ? initials(m.authorName ?? "You") : initials(name)}
          </AvatarFallback>
        </Avatar>
      )}
      <div className="min-w-0 flex-1">
        {grouped ? null : (
          <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
            <span className="font-medium">{name}</span>
            {m.ours && m.authorName ? (
              <span className="text-xs text-muted-foreground">as {m.authorName}</span>
            ) : null}
            <time
              dateTime={m.at}
              title={absoluteTime(m.at)}
              className="text-xs text-muted-foreground tabular-nums"
            >
              {clockTime(m.at)}
            </time>
          </p>
        )}
        <p
          className={cn(
            "text-[15px] leading-6 break-words whitespace-pre-wrap",
            hidden && "text-muted-foreground",
          )}
          title={grouped ? absoluteTime(m.at) : undefined}
        >
          {m.text?.trim() || (
            <span className="text-muted-foreground italic">{placeholder(m, item.type)}</span>
          )}
        </p>
        {current || hidden || replyState ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {[
              current ? "This item" : null,
              hidden ? "Hidden by filters" : null,
              replyState ? `Reply ${replyState}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        ) : null}
      </div>
    </li>
  )
}

// ─── Details sidebar ──────────────────────────────────────────────────────────

function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  )
}

function SidebarSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-t px-5 py-4">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

/** Properties of the item, where it was posted, and which rules matched it. */
function Details({ item }: { item: ItemDetail }) {
  const hidden = isHiddenStatus(item.status)
  return (
    <aside
      className="border-t bg-muted/20 text-sm lg:border-t-0 lg:border-l"
      aria-label="Item details"
    >
      <div className="px-5 py-4">
        <h3 className="text-xs font-medium text-muted-foreground">Details</h3>
        <dl className="mt-3 grid grid-cols-[5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2.5">
          <Property label="Status">
            <StatusBadge status={item.status} />
          </Property>
          <Property label="Priority">
            <PriorityBadge priority={item.priority} />
          </Property>
          {item.type === "review" ? (
            <Property label="Rating">
              <Rating value={item.rating} />
            </Property>
          ) : null}
          <Property label="Channel">
            <span className="flex items-start gap-1.5">
              <PlatformIcon platform={item.platform} className="mt-0.5 size-4 rounded text-[8px]" />
              {channelLabel(item)}
            </span>
          </Property>
          <Property label="Account">{item.accountName}</Property>
          <Property label="Received">
            <span title={absoluteTime(item.receivedAt)}>{absoluteTime(item.receivedAt)}</span>
          </Property>
          {item.resolvedAt ? (
            <Property label="Resolved">{absoluteTime(item.resolvedAt)}</Property>
          ) : null}
          {item.isFollowUp ? <Property label="Follow-up">Yes, they wrote again</Property> : null}
        </dl>
      </div>

      {hidden && item.filterReason ? (
        <div className="border-t px-5 py-4">
          <Alert className="bg-background">
            <EyeOff />
            <AlertTitle>Hidden from the inbox</AlertTitle>
            <AlertDescription>{item.filterReason}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      {item.postUrl || item.postTitle ? (
        <SidebarSection title={item.type === "review" ? "Location" : "Posted on"}>
          {item.postUrl ? (
            <a
              href={item.postUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-full items-center gap-1.5 underline-offset-4 hover:underline"
            >
              <span className="truncate">{item.postTitle ?? "View original"}</span>
              <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
            </a>
          ) : (
            <p>{item.postTitle}</p>
          )}
        </SidebarSection>
      ) : null}

      <SidebarSection title="Tags">
        {item.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {item.tags.map((t) => (
              <Badge key={t} variant="secondary">
                #{t}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground">None</p>
        )}
      </SidebarSection>

      {item.matchedRules.length > 0 ? (
        <SidebarSection title="Matched rules">
          <ul className="space-y-1">
            {item.matchedRules.map((r) => (
              <li key={`${r.id}-${r.dryRun}`}>
                <Link
                  href="/filters"
                  className={cn(
                    "underline-offset-4 hover:underline",
                    r.dryRun && "text-muted-foreground",
                  )}
                >
                  {r.name}
                  {r.dryRun ? " (dry run)" : ""}
                </Link>
              </li>
            ))}
          </ul>
        </SidebarSection>
      ) : null}
    </aside>
  )
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

export function PageSkeleton() {
  return (
    <div
      className="grid flex-1 overflow-hidden rounded-xl border lg:grid-cols-[minmax(0,1fr)_19rem]"
      aria-busy="true"
      aria-label="Loading item"
    >
      <div className="flex flex-col">
        <div className="flex items-center gap-3 border-b px-6 py-4">
          <Skeleton className="size-10 rounded-full" />
          <div className="space-y-1.5">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3.5 w-52" />
          </div>
        </div>
        <div className="flex-1 space-y-2.5 px-6 py-6">
          <Skeleton className="h-4 w-full max-w-prose" />
          <Skeleton className="h-4 w-5/6 max-w-prose" />
          <Skeleton className="h-4 w-2/3 max-w-prose" />
        </div>
        <div className="space-y-3 border-t px-6 py-4">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-28 w-full" />
        </div>
      </div>
      <div className="space-y-3 border-t px-5 py-4 lg:border-t-0 lg:border-l">
        <Skeleton className="h-3 w-14" />
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </div>
    </div>
  )
}
