"use client"

import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  Copy,
  FlaskConical,
  GripVertical,
  MoreHorizontal,
  Pencil,
  ShieldCheck,
  Square,
  Trash2,
} from "lucide-react"
import type { RuleAction, RuleWithStats } from "@inbox/core"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { PlatformIcon } from "@/components/app/platform-icon"
import { TYPE_LABELS } from "@/components/app/item-badges"
import { cn } from "cn"

function ActionBadge({ action }: { action: RuleAction }) {
  switch (action.type) {
    case "drop":
      return <Badge variant="destructive">Drop</Badge>
    case "archive":
      return (
        <Badge
          variant="outline"
          className="border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
        >
          Archive
        </Badge>
      )
    case "setPriority":
      return (
        <Badge
          variant="outline"
          className={cn(
            action.value === "urgent" &&
              "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400",
            action.value === "high" &&
              "border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-400",
            (action.value === "low" || action.value === "normal") && "text-muted-foreground",
          )}
        >
          Priority: {action.value}
        </Badge>
      )
    case "addTag":
      return <Badge variant="secondary">#{action.value}</Badge>
    case "notifyOnly":
      return <Badge variant="outline">No AI drafts</Badge>
    case "requireApproval":
      return <Badge variant="outline">Needs approval</Badge>
    // Slack actions stay hidden until Slack is enabled (Phase 8).
    case "routeSlackChannel":
    case "skipSlack":
      return null
  }
}

export function RuleRow({
  rule,
  index,
  canEdit,
  canDrag,
  onEdit,
  onDuplicate,
  onToggle,
  onToggleDryRun,
  onDelete,
}: {
  rule: RuleWithStats
  index: number
  canEdit: boolean
  canDrag: boolean
  onEdit: () => void
  onDuplicate: () => void
  onToggle: (enabled: boolean) => void
  onToggleDryRun: () => void
  onDelete: () => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: rule.id,
    disabled: !canDrag,
  })
  const style = { transform: CSS.Transform.toString(transform), transition }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        "group flex flex-wrap items-start gap-2 border-b bg-background px-2 py-3 last:border-b-0 sm:flex-nowrap sm:gap-3 sm:px-3",
        isDragging && "relative z-10 rounded-lg shadow-lg ring-1 ring-border",
        !rule.enabled && "bg-muted/30",
      )}
    >
      {canDrag ? (
        <button
          ref={setActivatorNodeRef}
          type="button"
          className="mt-0.5 cursor-grab touch-none rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing"
          aria-label={`Reorder ${rule.name}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>
      ) : null}
      <span className="mt-0.5 w-5 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
        {index + 1}
      </span>

      <div className="min-w-0 flex-1 basis-[calc(100%-4rem)] sm:basis-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <button
            type="button"
            onClick={onEdit}
            className={cn(
              "text-left font-medium hover:underline",
              !rule.enabled && "text-muted-foreground",
            )}
          >
            {rule.name}
          </button>
          {rule.isDefault ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex text-muted-foreground" aria-label="Default rule" />
                }
              >
                <ShieldCheck className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>Default rule</TooltipContent>
            </Tooltip>
          ) : null}
          {rule.dryRun ? (
            <Badge
              variant="outline"
              className="gap-1 border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-400"
            >
              <FlaskConical className="size-3" /> Dry run
            </Badge>
          ) : null}
          {rule.stopProcessing ? (
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              <Square className="size-2.5 fill-current" /> Stops processing
            </Badge>
          ) : null}
        </div>
        {rule.description ? (
          <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{rule.description}</p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="flex items-center gap-1">
            {rule.platforms === "all" ? (
              <Badge variant="outline" className="text-muted-foreground">
                All platforms
              </Badge>
            ) : (
              rule.platforms.map((p) => (
                <PlatformIcon key={p} platform={p} className="size-4 text-[8px]" />
              ))
            )}
          </span>
          <Badge variant="outline" className="text-muted-foreground">
            {rule.itemTypes === "all"
              ? "All types"
              : rule.itemTypes.map((t) => `${TYPE_LABELS[t]}s`).join(", ")}
          </Badge>
          <span className="text-muted-foreground" aria-hidden>
            →
          </span>
          {rule.actions.map((a, i) => (
            <ActionBadge key={i} action={a} />
          ))}
        </div>
      </div>

      <div className="flex w-full shrink-0 items-center justify-between gap-3 pl-12 sm:w-auto sm:justify-end sm:pl-0">
        <span className="text-xs text-muted-foreground tabular-nums sm:text-right">
          <span className="font-medium text-foreground">{rule.matches7d}</span>{" "}
          {rule.matches7d === 1 ? "match" : "matches"} · 7 days
          {rule.dryRunMatches7d > 0 ? (
            <span className="ml-1 text-violet-600 sm:ml-0 sm:block dark:text-violet-400">
              {rule.dryRunMatches7d} dry-run
            </span>
          ) : null}
        </span>
        <div className="flex items-center gap-1">
          <Switch
            checked={rule.enabled}
            onCheckedChange={(v) => onToggle(v)}
            disabled={!canEdit}
            aria-label={`${rule.enabled ? "Disable" : "Enable"} ${rule.name}`}
          />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${rule.name}`} />
              }
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem onClick={onEdit}>
                <Pencil /> {canEdit ? "Edit" : "View"}
              </DropdownMenuItem>
              {canEdit ? (
                <>
                  <DropdownMenuItem onClick={onDuplicate}>
                    <Copy /> Duplicate
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={onToggleDryRun}>
                    <FlaskConical /> {rule.dryRun ? "Turn off dry run" : "Dry run"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={onDelete}>
                    <Trash2 /> Delete
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </li>
  )
}
