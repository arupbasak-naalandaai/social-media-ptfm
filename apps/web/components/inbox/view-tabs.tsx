"use client"

import type { ItemCounts } from "@inbox/core"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "cn"
import type { ListView } from "./list-state"

/** Open · Follow-ups · Done. Follow-ups lights up when someone you talked to wrote again. */
export function ViewTabs({
  view,
  counts,
  onChange,
}: {
  view: ListView
  counts: ItemCounts | undefined
  onChange: (view: ListView) => void
}) {
  return (
    <Tabs value={view} onValueChange={(v) => onChange(v as ListView)}>
      <TabsList>
        <TabsTrigger value="inbox">
          Open
          {counts ? <CountBadge n={counts.inbox} /> : null}
        </TabsTrigger>
        <TabsTrigger value="followups">
          Follow-ups
          {counts && counts.followUps > 0 ? <CountBadge n={counts.followUps} highlight /> : null}
        </TabsTrigger>
        <TabsTrigger value="done">
          Done
          {counts ? <CountBadge n={counts.done} /> : null}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
}

function CountBadge({ n, highlight = false }: { n: number; highlight?: boolean }) {
  return (
    <Badge
      variant={highlight ? "default" : "secondary"}
      className={cn("h-4 min-w-4 rounded-full px-1 text-[10px] tabular-nums")}
      aria-label={highlight ? `${n} with new activity` : undefined}
    >
      {n}
    </Badge>
  )
}
