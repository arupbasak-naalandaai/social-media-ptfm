import { Star } from "lucide-react"
import type { ItemStatus, ItemType, Priority } from "@inbox/core"
import { Badge } from "@/components/ui/badge"
import { cn } from "cn"

const PRIORITY: Record<Priority, { label: string; className: string }> = {
  urgent: {
    label: "Urgent",
    className: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400",
  },
  high: {
    label: "High",
    className: "border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-400",
  },
  normal: { label: "Normal", className: "text-muted-foreground" },
  low: { label: "Low", className: "border-transparent bg-muted text-muted-foreground" },
}

export function PriorityBadge({ priority, className }: { priority: Priority; className?: string }) {
  const p = PRIORITY[priority]
  return (
    <Badge variant="outline" className={cn(p.className, className)}>
      {p.label}
    </Badge>
  )
}

export const STATUS_LABELS: Record<ItemStatus, string> = {
  new: "New",
  pending: "Pending",
  replied: "Replied",
  resolved: "Resolved",
  ignored: "Ignored",
  failed: "Failed",
  filtered: "Filtered",
  archived: "Archived",
}

const STATUS_CLASS: Partial<Record<ItemStatus, string>> = {
  new: "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  pending: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  replied: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  resolved: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  failed: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400",
}

export function StatusBadge({ status, className }: { status: ItemStatus; className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(STATUS_CLASS[status] ?? "text-muted-foreground", className)}
    >
      {STATUS_LABELS[status]}
    </Badge>
  )
}

export const TYPE_LABELS: Record<ItemType, string> = {
  review: "Review",
  comment: "Comment",
  dm: "DM",
}

export function Rating({ value, className }: { value: number | null; className?: string }) {
  if (value == null) return <span className="text-muted-foreground">—</span>
  return (
    <span
      className={cn("inline-flex items-center gap-0.5", className)}
      aria-label={`${value} out of 5 stars`}
    >
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          className={cn(
            "size-3",
            i < value ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40",
          )}
        />
      ))}
    </span>
  )
}
