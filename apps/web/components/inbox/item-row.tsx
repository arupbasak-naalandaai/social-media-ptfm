"use client"

import { motion } from "motion/react"
import { memo } from "react"
import { Archive, CheckCircle2, CircleSlash, EyeOff, Reply, RotateCcw, Undo2 } from "lucide-react"
import type { ItemSummary } from "@inbox/core"
import { PriorityBadge, Rating, StatusBadge } from "@/components/app/item-badges"
import { PlatformIcon } from "@/components/app/platform-icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { absoluteTime, relativeTime } from "@/lib/format"
import { cn } from "cn"
import type { ItemAction } from "./use-item-actions"

/** Cap the entrance stagger so the 50th card of a page doesn't wait seconds to appear. */
const MAX_STAGGER_STEPS = 10
const STAGGER = 0.035

const ACCENT: Partial<Record<ItemSummary["priority"], string>> = {
  urgent: "before:bg-red-500",
  high: "before:bg-orange-400",
}

export interface ItemRowProps {
  item: ItemSummary
  /** Position within its page; drives the entrance stagger. */
  staggerIndex: number
  selected: boolean
  filteredView: boolean
  now: number
  onOpen: (id: string) => void
  onRestore: (item: ItemSummary) => void
  onAction: (id: string, action: ItemAction) => void
  onReply: (id: string) => void
}

/**
 * One inbox card. The outer `li` owns the motion (fade/slide in, collapse out) and is
 * `overflow-hidden` so the exit height collapse closes the gap below it too.
 */
export const ItemRow = memo(function ItemRow({
  item,
  staggerIndex,
  selected,
  filteredView,
  now,
  onOpen,
  onRestore,
  onAction,
  onReply,
}: ItemRowProps) {
  const author = item.authorName ?? item.authorHandle ?? "Unknown"
  const text = item.text?.trim()
  const isNew = item.status === "new"
  const showPriority = !filteredView && (item.priority === "urgent" || item.priority === "high")

  return (
    <motion.li
      data-item-id={item.id}
      aria-current={selected ? "true" : undefined}
      className="overflow-hidden"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{
        opacity: 0,
        x: 48,
        height: 0,
        transition: {
          opacity: { duration: 0.18 },
          x: { duration: 0.22, ease: [0.4, 0, 1, 1] },
          height: { duration: 0.24, delay: 0.12, ease: [0.4, 0, 0.2, 1] },
        },
      }}
      transition={{
        type: "spring",
        stiffness: 420,
        damping: 34,
        delay: Math.min(staggerIndex, MAX_STAGGER_STEPS) * STAGGER,
      }}
    >
      {/* Padding lives inside the animated element so the gap collapses with the card. */}
      <div className="pb-2">
        <div
          onClick={() => onOpen(item.id)}
          className={cn(
            "group relative flex cursor-pointer gap-3 overflow-hidden rounded-xl border bg-card p-3 pl-4 transition-colors sm:p-4 sm:pl-5",
            "before:absolute before:inset-y-0 before:left-0 before:w-1 before:content-['']",
            ACCENT[item.priority] ?? "before:bg-transparent",
            "hover:border-foreground/20 hover:bg-muted/40",
            selected &&
              "border-primary/50 bg-primary/[0.04] hover:border-primary/60 hover:bg-primary/[0.06]",
          )}
        >
          <Avatar item={item} name={author} />

          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-baseline gap-2">
              {isNew ? (
                <span
                  className="size-2 shrink-0 translate-y-[-1px] self-center rounded-full bg-blue-500"
                  aria-label="New"
                />
              ) : null}
              <span className={cn("truncate text-sm", isNew ? "font-semibold" : "font-medium")}>
                {author}
              </span>
              <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline">
                {item.authorHandle && item.authorName ? `@${item.authorHandle} · ` : ""}
                {item.accountName}
              </span>
              <span
                className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums"
                title={absoluteTime(item.receivedAt)}
              >
                {relativeTime(item.receivedAt, now)}
              </span>
            </div>

            {item.type === "review" ? <Rating value={item.rating} /> : null}

            <p
              className={cn(
                "line-clamp-2 text-sm break-words",
                isNew ? "text-foreground" : "text-foreground/80",
              )}
            >
              {text ? (
                text
              ) : (
                <span className="text-muted-foreground italic">{emptyLabel(item)}</span>
              )}
            </p>

            {filteredView && item.filterReason ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <EyeOff className="size-3.5 shrink-0" />
                <span className="line-clamp-1">{item.filterReason}</span>
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-1.5 empty:hidden">
              {showPriority ? <PriorityBadge priority={item.priority} className="h-5" /> : null}
              {!isNew ? <StatusBadge status={item.status} className="h-5" /> : null}
              {item.type === "dm" ? (
                <Badge variant="outline" className="h-5">
                  DM
                </Badge>
              ) : null}
              {item.tags.map((t) => (
                <Badge key={t} variant="secondary" className="h-5">
                  {t}
                </Badge>
              ))}
            </div>
          </div>

          {filteredView ? (
            <div className="shrink-0 self-center">
              <Button
                variant="outline"
                size="sm"
                className="h-7"
                onClick={(e) => {
                  e.stopPropagation()
                  onRestore(item)
                }}
              >
                <Undo2 className="size-3.5" />
                <span className="hidden sm:inline">Not spam</span>
              </Button>
            </div>
          ) : (
            <HoverActions item={item} onAction={onAction} onReply={onReply} />
          )}
        </div>
      </div>
    </motion.li>
  )
})

const OPEN_STATUSES: readonly ItemSummary["status"][] = ["new", "pending", "failed"]

/**
 * Floating quick-action bar, revealed on hover or when focus moves into the card.
 * Touch devices have no hover, so it stays hidden there (the item sheet has every action).
 */
function HoverActions({
  item,
  onAction,
  onReply,
}: {
  item: ItemSummary
  onAction: (id: string, action: ItemAction) => void
  onReply: (id: string) => void
}) {
  const isOpen = OPEN_STATUSES.includes(item.status)
  return (
    <div
      role="toolbar"
      aria-label="Quick actions"
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "absolute top-2 right-2 flex items-center gap-0.5 rounded-lg border bg-popover p-0.5 shadow-sm sm:top-3 sm:right-3",
        "translate-y-1 opacity-0 transition-[opacity,translate] duration-150 ease-out",
        "group-focus-within:translate-y-0 group-focus-within:opacity-100 group-hover:translate-y-0 group-hover:opacity-100",
        "motion-reduce:translate-y-0 [@media(hover:none)]:hidden",
      )}
    >
      {isOpen ? (
        <>
          <ActionButton label="Reply" shortcut="r" onClick={() => onReply(item.id)}>
            <Reply />
          </ActionButton>
          <ActionButton
            label="Resolve"
            shortcut="e"
            className="hover:bg-emerald-500/10 hover:text-emerald-600 dark:hover:text-emerald-400"
            onClick={() => onAction(item.id, "resolve")}
          >
            <CheckCircle2 />
          </ActionButton>
          <ActionButton label="Ignore" shortcut="i" onClick={() => onAction(item.id, "ignore")}>
            <CircleSlash />
          </ActionButton>
        </>
      ) : (
        <ActionButton label="Reopen" onClick={() => onAction(item.id, "reopen")}>
          <RotateCcw />
        </ActionButton>
      )}
      <ActionButton
        label="Archive"
        className="hover:bg-destructive/10 hover:text-destructive"
        onClick={() => onAction(item.id, "archive")}
      >
        <Archive />
      </ActionButton>
    </div>
  )
}

function ActionButton({
  label,
  shortcut,
  className,
  onClick,
  children,
}: {
  label: string
  shortcut?: string
  className?: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            className={cn("text-muted-foreground", className)}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label}
        {shortcut ? <Kbd>{shortcut}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  )
}

function Avatar({ item, name }: { item: ItemSummary; name: string }) {
  return (
    <div className="relative shrink-0 self-start">
      <div
        className="flex size-9 items-center justify-center rounded-full text-sm font-semibold text-white select-none"
        style={{ backgroundColor: `oklch(0.62 0.13 ${hue(name)})` }}
        aria-hidden
      >
        {initial(name)}
      </div>
      <PlatformIcon
        platform={item.platform}
        className="absolute -right-1 -bottom-1 size-4 text-[8px] ring-2 ring-card"
      />
    </div>
  )
}

function initial(name: string): string {
  return (name.replace(/^@/, "").trim()[0] ?? "?").toUpperCase()
}

/** Stable per-author hue so the same person always gets the same colour. */
function hue(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return h % 360
}

function emptyLabel(item: ItemSummary): string {
  if (item.type === "review") return "Rating only, no text"
  if (item.eventKind === "story_mention") return "Mentioned you in their story"
  if (item.eventKind === "deleted") return "Deleted on the platform"
  return "No text"
}
