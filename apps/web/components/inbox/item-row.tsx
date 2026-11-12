"use client"

import { motion } from "motion/react"
import { memo, type ReactNode } from "react"
import {
  Archive,
  CheckCircle2,
  CircleSlash,
  ExternalLink,
  Eye,
  EyeOff,
  Reply,
  RotateCcw,
  Undo2,
} from "lucide-react"
import type { ItemSummary } from "@inbox/core"
import { PriorityBadge, Rating, StatusBadge } from "@/components/app/item-badges"
import { PlatformIcon } from "@/components/app/platform-icon"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { absoluteTime, relativeTime } from "@/lib/format"
import { cn } from "cn"
import { ITEM_CARD_HEIGHT } from "./card-size"
import type { ItemAction } from "./use-item-actions"

/** Cap the entrance stagger so the 50th card of a page doesn't wait seconds to appear. */
const MAX_STAGGER_STEPS = 10
const STAGGER = 0.03

const OPEN_STATUSES: readonly ItemSummary["status"][] = ["new", "pending", "failed"]

export interface ItemRowProps {
  item: ItemSummary
  /** Position within its page; drives the entrance stagger. */
  staggerIndex: number
  selected: boolean
  filteredView: boolean
  now: number
  /** Full item page. */
  onOpen: (id: string) => void
  /** Quick preview in the side sheet. */
  onPreview: (id: string) => void
  onRestore: (item: ItemSummary) => void
  onAction: (id: string, action: ItemAction) => void
  onReply: (id: string) => void
}

/**
 * One fixed-height inbox card. The `li` owns the motion and clips during the exit collapse;
 * the inner wrapper's padding leaves room for the card ring and doubles as the gap.
 */
export const ItemRow = memo(function ItemRow({
  item,
  staggerIndex,
  selected,
  filteredView,
  now,
  onOpen,
  onPreview,
  onRestore,
  onAction,
  onReply,
}: ItemRowProps) {
  const author = item.authorName ?? item.authorHandle ?? "Unknown"
  const text = item.text?.trim()

  return (
    <motion.li
      data-item-id={item.id}
      aria-current={selected ? "true" : undefined}
      className="overflow-hidden"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{
        opacity: 0,
        x: 32,
        height: 0,
        transition: {
          opacity: { duration: 0.16 },
          x: { duration: 0.2, ease: [0.4, 0, 1, 1] },
          height: { duration: 0.22, delay: 0.1, ease: [0.4, 0, 0.2, 1] },
        },
      }}
      transition={{
        type: "spring",
        stiffness: 500,
        damping: 40,
        delay: Math.min(staggerIndex, MAX_STAGGER_STEPS) * STAGGER,
      }}
    >
      <div className="px-px pt-px pb-2">
        <div
          onClick={() => onOpen(item.id)}
          className={cn(
            "group flex cursor-pointer items-center gap-3 rounded-xl bg-card px-4 ring-1 transition-[background-color,box-shadow] duration-150",
            ITEM_CARD_HEIGHT,
            selected
              ? "bg-muted/50 ring-foreground/30"
              : "ring-foreground/10 hover:bg-muted/30 hover:ring-foreground/20",
          )}
        >
          <AuthorAvatar item={item} name={author} />

          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium">{author}</span>
              <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:block">
                {item.authorHandle && item.authorName ? `@${item.authorHandle} · ` : ""}
                {item.accountName}
              </span>
              {item.type === "review" ? <Rating value={item.rating} className="shrink-0" /> : null}
            </div>
            <p className="truncate text-sm text-muted-foreground" title={text || undefined}>
              {text ? text : <span className="italic">{emptyLabel(item)}</span>}
            </p>
          </div>

          <Meta item={item} filteredView={filteredView} />

          {filteredView ? (
            <div className="flex shrink-0 items-center gap-3">
              <Time item={item} now={now} className="hidden sm:inline" />
              <Button
                variant="outline"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation()
                  onRestore(item)
                }}
              >
                <Undo2 />
                <span className="hidden sm:inline">Not spam</span>
              </Button>
            </div>
          ) : (
            // Time and quick actions share one grid cell and cross-fade on hover / focus.
            <div className="grid shrink-0 items-center justify-items-end [@media(hover:hover)]:min-w-30">
              <Time
                item={item}
                now={now}
                className="[grid-area:1/1] transition-opacity duration-150 group-focus-within:opacity-0 group-hover:opacity-0 [@media(hover:none)]:opacity-100!"
              />
              <QuickActions
                item={item}
                onAction={onAction}
                onReply={onReply}
                onPreview={onPreview}
              />
            </div>
          )}
        </div>
      </div>
    </motion.li>
  )
})

function AuthorAvatar({ item, name }: { item: ItemSummary; name: string }) {
  return (
    <div className="relative shrink-0">
      <Avatar>
        <AvatarFallback className="text-xs font-medium">{initials(name)}</AvatarFallback>
      </Avatar>
      <PlatformIcon
        platform={item.platform}
        className="absolute -right-1 -bottom-1 size-4 rounded-[5px] text-[8px] ring-2 ring-card"
      />
    </div>
  )
}

/** Badges on the right of the card: kept to one line, extra tags fold into "+N". */
function Meta({ item, filteredView }: { item: ItemSummary; filteredView: boolean }) {
  const showPriority = !filteredView && (item.priority === "urgent" || item.priority === "high")
  // "New" is the default and "Filtered" is implied by the reason, so neither earns a badge.
  const showStatus = item.status !== "new" && item.status !== "filtered"
  const [firstTag, ...moreTags] = item.tags

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {filteredView && item.filterReason ? (
        <span
          className="hidden max-w-56 items-center gap-1.5 text-xs text-muted-foreground lg:flex"
          title={item.filterReason}
        >
          <EyeOff className="size-3.5 shrink-0" />
          <span className="truncate">{item.filterReason}</span>
        </span>
      ) : null}
      {showPriority ? <PriorityBadge priority={item.priority} /> : null}
      {showStatus ? <StatusBadge status={item.status} className="hidden md:inline-flex" /> : null}
      {item.type === "dm" ? (
        <Badge variant="outline" className="hidden text-muted-foreground md:inline-flex">
          DM
        </Badge>
      ) : null}
      {firstTag ? (
        <Badge variant="secondary" className="hidden md:inline-flex">
          #{firstTag}
        </Badge>
      ) : null}
      {moreTags.length > 0 ? (
        <Badge
          variant="secondary"
          className="hidden md:inline-flex"
          title={moreTags.map((t) => `#${t}`).join(" ")}
        >
          +{moreTags.length}
        </Badge>
      ) : null}
    </div>
  )
}

function Time({ item, now, className }: { item: ItemSummary; now: number; className?: string }) {
  return (
    <span
      className={cn("text-xs whitespace-nowrap text-muted-foreground tabular-nums", className)}
      title={absoluteTime(item.receivedAt)}
    >
      {relativeTime(item.receivedAt, now)}
    </span>
  )
}

/**
 * Revealed on hover or keyboard focus. Touch devices have no hover, so it stays hidden there
 * (and can't swallow taps); the full item page has every action.
 */
function QuickActions({
  item,
  onAction,
  onReply,
  onPreview,
}: {
  item: ItemSummary
  onAction: (id: string, action: ItemAction) => void
  onReply: (id: string) => void
  onPreview: (id: string) => void
}) {
  const isOpen = OPEN_STATUSES.includes(item.status)
  return (
    <div
      role="toolbar"
      aria-label="Quick actions"
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "flex items-center gap-0.5 [grid-area:1/1]",
        "opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100",
        "[@media(hover:none)]:hidden",
      )}
    >
      <ActionButton label="Preview" shortcut="Space" onClick={() => onPreview(item.id)}>
        <Eye />
      </ActionButton>
      {item.link ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={item.link.label}
                className="text-muted-foreground hover:text-foreground"
                nativeButton={false}
                render={<a href={item.link.url} target="_blank" rel="noreferrer" />}
              />
            }
          >
            <ExternalLink />
          </TooltipTrigger>
          <TooltipContent>{item.link.label}</TooltipContent>
        </Tooltip>
      ) : null}
      {isOpen ? (
        <>
          <ActionButton label="Reply" shortcut="r" onClick={() => onReply(item.id)}>
            <Reply />
          </ActionButton>
          <ActionButton label="Resolve" shortcut="e" onClick={() => onAction(item.id, "resolve")}>
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
      <ActionButton label="Archive" onClick={() => onAction(item.id, "archive")}>
        <Archive />
      </ActionButton>
    </div>
  )
}

function ActionButton({
  label,
  shortcut,
  onClick,
  children,
}: {
  label: string
  shortcut?: string
  onClick: () => void
  children: ReactNode
}) {
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
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut ? <Kbd>{shortcut}</Kbd> : null}
      </TooltipContent>
    </Tooltip>
  )
}

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

function emptyLabel(item: ItemSummary): string {
  if (item.type === "review") return "Rating only, no text"
  if (item.eventKind === "story_mention") return "Mentioned you in their story"
  if (item.eventKind === "deleted") return "Deleted on the platform"
  return "No text"
}
