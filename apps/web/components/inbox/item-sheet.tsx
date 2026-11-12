"use client"

import { useQuery } from "@tanstack/react-query"
import { useEffect, useRef, useState, type ReactNode } from "react"
import Link from "next/link"
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  Clock,
  EyeOff,
  ExternalLink,
  RotateCcw,
  Send,
  Sparkles,
  Undo2,
} from "lucide-react"
import type { ItemDetail } from "@inbox/core"
import { PriorityBadge, Rating, StatusBadge, TYPE_LABELS } from "@/components/app/item-badges"
import { PLATFORM_LABELS, PlatformIcon } from "@/components/app/platform-icon"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { Textarea } from "@/components/ui/textarea"
import { api, ApiError } from "@/lib/api"
import { absoluteTime, relativeTime } from "@/lib/format"
import { qk } from "@/lib/query-keys"
import { cn } from "cn"
import type { RestoreTarget } from "./restore-dialog"
import type { ItemAction } from "./use-item-actions"

export function ItemSheet({
  itemId,
  onOpenChange,
  focusReplyToken,
  onAction,
  onRestore,
}: {
  itemId: string | null
  onOpenChange: (open: boolean) => void
  /** Changes whenever the "r" shortcut asks to focus the reply box. */
  focusReplyToken: number
  onAction: (id: string, action: ItemAction) => void
  onRestore: (target: RestoreTarget) => void
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
            focusReplyToken={focusReplyToken}
            onAction={onAction}
            onRestore={onRestore}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function ItemSheetBody({
  itemId,
  focusReplyToken,
  onAction,
  onRestore,
}: {
  itemId: string
  focusReplyToken: number
  onAction: (id: string, action: ItemAction) => void
  onRestore: (target: RestoreTarget) => void
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

  return (
    <ItemDetailView
      item={query.data}
      focusReplyToken={focusReplyToken}
      onAction={onAction}
      onRestore={onRestore}
      now={query.dataUpdatedAt}
    />
  )
}

function ItemDetailView({
  item,
  focusReplyToken,
  onAction,
  onRestore,
  now,
}: {
  item: ItemDetail
  focusReplyToken: number
  onAction: (id: string, action: ItemAction) => void
  onRestore: (target: RestoreTarget) => void
  now: number
}) {
  const isHidden = item.status === "filtered" || item.status === "archived"
  const isDone =
    item.status === "resolved" || item.status === "replied" || item.status === "ignored"
  const author = item.authorName ?? (item.authorHandle ? `@${item.authorHandle}` : "Unknown author")

  return (
    <>
      <SheetHeader className="gap-3 border-b p-4 pr-12">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <PlatformIcon platform={item.platform} />
          <span className="truncate">
            {PLATFORM_LABELS[item.platform]} · {TYPE_LABELS[item.type]} · {item.accountName}
          </span>
        </div>
        <div className="min-w-0">
          <SheetTitle className="truncate text-base">{author}</SheetTitle>
          <SheetDescription className="text-xs">
            {item.authorHandle && item.authorName ? `@${item.authorHandle} · ` : ""}
            <span title={absoluteTime(item.receivedAt)}>{relativeTime(item.receivedAt, now)}</span>
          </SheetDescription>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <PriorityBadge priority={item.priority} />
          <StatusBadge status={item.status} />
          {item.tags.map((t) => (
            <Badge key={t} variant="secondary">
              {t}
            </Badge>
          ))}
        </div>
      </SheetHeader>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {item.type === "review" ? <Rating value={item.rating} className="[&_svg]:size-4" /> : null}

        {item.type === "dm" && item.thread.length > 0 ? (
          <Thread item={item} now={now} />
        ) : (
          <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
            {item.text?.trim() || <span className="text-muted-foreground italic">No text</span>}
          </p>
        )}

        {item.postUrl || item.postTitle ? (
          <Section title={item.type === "review" ? "Location" : "On post"}>
            {item.postUrl ? (
              <a
                href={item.postUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary underline-offset-4 hover:underline"
              >
                {item.postTitle ?? "View original"}
                <ExternalLink className="size-3.5" />
              </a>
            ) : (
              <span className="text-sm">{item.postTitle}</span>
            )}
          </Section>
        ) : null}

        {isHidden && item.filterReason ? (
          <Alert>
            <EyeOff />
            <AlertTitle>Hidden from the inbox</AlertTitle>
            <AlertDescription>{item.filterReason}</AlertDescription>
          </Alert>
        ) : null}

        {item.matchedRules.length > 0 ? (
          <Section title="Matched rules">
            <div className="flex flex-wrap gap-1.5">
              {item.matchedRules.map((r) => (
                <Badge
                  key={`${r.id}-${r.dryRun}`}
                  variant="outline"
                  className={cn(r.dryRun && "border-dashed text-muted-foreground")}
                  render={<Link href="/filters" />}
                >
                  {r.name}
                  {r.dryRun ? " (dry run)" : ""}
                </Badge>
              ))}
            </div>
          </Section>
        ) : null}

        <Section title="AI drafts" icon={<Sparkles className="size-3.5" />}>
          {item.aiDrafts.length > 0 ? (
            <div className="space-y-2">
              {item.aiDrafts.map((d) => (
                <div key={d.id} className="rounded-lg border p-3 text-sm">
                  {d.text}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {item.aiDraftsAllowed
                ? "AI drafts arrive with Phase 4."
                : "No AI drafts for this item (rule: notify only)."}
            </p>
          )}
        </Section>

        {item.replies.length > 0 ? (
          <Section title="Replies">
            <div className="space-y-2">
              {item.replies.map((r) => (
                <div key={r.id} className="rounded-lg border bg-muted/40 p-3 text-sm">
                  <p className="whitespace-pre-wrap">{r.text}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {r.status}
                    {r.error ? ` · ${r.error}` : ""}
                  </p>
                </div>
              ))}
            </div>
          </Section>
        ) : null}

        {!isHidden ? <ReplyBox item={item} focusToken={focusReplyToken} now={now} /> : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t p-3">
        {isHidden ? (
          <Button
            onClick={() =>
              onRestore({
                id: item.id,
                authorName: item.authorName,
                authorHandle: item.authorHandle,
                filterReason: item.filterReason,
              })
            }
          >
            <Undo2 /> Not spam / restore
          </Button>
        ) : null}
        {!isHidden && !isDone ? (
          <>
            <Button onClick={() => onAction(item.id, "resolve")}>
              <CheckCircle2 /> Resolve <Kbd className="ml-1 hidden sm:inline-flex">e</Kbd>
            </Button>
            <Button variant="outline" onClick={() => onAction(item.id, "ignore")}>
              Ignore <Kbd className="ml-1 hidden sm:inline-flex">i</Kbd>
            </Button>
          </>
        ) : null}
        {isDone ? (
          <Button variant="outline" onClick={() => onAction(item.id, "reopen")}>
            <RotateCcw /> Reopen
          </Button>
        ) : null}
        {!isHidden ? (
          <Button variant="ghost" className="ml-auto" onClick={() => onAction(item.id, "archive")}>
            <Archive /> Archive
          </Button>
        ) : null}
      </div>
    </>
  )
}

function Section({
  title,
  icon,
  children,
}: {
  title: string
  icon?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  )
}

function Thread({ item, now }: { item: ItemDetail; now: number }) {
  return (
    <div className="space-y-2" aria-label="Conversation">
      {item.thread.map((m) => {
        const current = m.id === item.id
        return (
          <div key={m.id} className="flex flex-col items-start gap-0.5">
            <div
              className={cn(
                "max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm break-words whitespace-pre-wrap",
                current && "ring-2 ring-primary/40",
              )}
            >
              {m.text?.trim() || (
                <span className="text-muted-foreground italic">
                  {threadPlaceholder(m.eventKind)}
                </span>
              )}
            </div>
            <span
              className="px-1 text-[11px] text-muted-foreground"
              title={absoluteTime(m.receivedAt)}
            >
              {relativeTime(m.receivedAt, now)}
              {m.status === "filtered" ? " · filtered" : ""}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function threadPlaceholder(eventKind: string): string {
  if (eventKind === "story_mention") return "Mentioned you in their story"
  if (eventKind === "story_reaction") return "Reacted to your story"
  return "No text"
}

function ReplyBox({
  item,
  focusToken,
  now,
}: {
  item: ItemDetail
  focusToken: number
  now: number
}) {
  const [text, setText] = useState("")
  const ref = useRef<HTMLTextAreaElement>(null)
  const expired = item.replyWindow?.expired === true

  useEffect(() => {
    if (focusToken > 0) ref.current?.focus()
  }, [focusToken])

  const disabledReason = expired
    ? null
    : !item.canReply
      ? `Connect ${PLATFORM_LABELS[item.platform]} in Connections to reply from here.`
      : null

  return (
    <section className="space-y-2">
      <h3 className="flex items-center justify-between text-xs font-medium tracking-wide text-muted-foreground uppercase">
        <span>Reply</span>
        <span className="font-normal normal-case">
          <Kbd>r</Kbd> to focus
        </span>
      </h3>
      {expired ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Reply window expired, reply in the app.</AlertTitle>
          <AlertDescription>
            {PLATFORM_LABELS[item.platform]} only allows replies within {item.replyWindow?.hours}{" "}
            hours of the customer&apos;s last message.
          </AlertDescription>
        </Alert>
      ) : item.replyWindow?.expiresAt ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="size-3.5" />
          Reply window closes {relativeTime(item.replyWindow.expiresAt, now)}
        </p>
      ) : null}
      <Textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={expired ? "Replying is blocked for this conversation" : "Write a reply…"}
        disabled={expired}
        rows={4}
        aria-label="Reply"
      />
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{disabledReason}</p>
        <Button size="sm" disabled={expired || !item.canReply || text.trim() === ""}>
          <Send /> Send
        </Button>
      </div>
    </section>
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
