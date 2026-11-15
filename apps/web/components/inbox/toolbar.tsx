"use client"

import { Suspense, useEffect, useState } from "react"
import { Search, Tag, X } from "lucide-react"
import {
  ITEM_TYPES,
  PLATFORMS,
  PRIORITIES,
  VIEW_STATUSES,
  type ItemStatus,
  type Platform,
} from "@inbox/core"
import { usePlatforms } from "@/components/app/me-context"
import { PLATFORM_LABELS, PlatformIcon } from "@/components/app/platform-icon"
import { STATUS_LABELS, TYPE_LABELS } from "@/components/app/item-badges"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { MultiSelect } from "./multi-select"
import type { ItemFilters, ListView, Since, Sort } from "./use-item-filters"

const PRIORITY_LABELS = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" } as const
const SINCE_ITEMS: { value: Since; label: string }[] = [
  { value: "all", label: "Any time" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
]
const SORT_ITEMS: { value: Sort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "priority", label: "Priority" },
]

/** Tags the default rules add; tags seen in the current results are merged in. */
const KNOWN_TAGS = ["vip", "complaint", "low-rating", "low-value", "spam"]

function PlatformSelect({
  platforms,
  value,
  onChange,
}: {
  platforms: readonly Platform[]
  value: string[]
  onChange: (v: string[]) => void
}) {
  return (
    <MultiSelect
      label="Platform"
      options={platforms.map((p) => ({
        value: p,
        label: PLATFORM_LABELS[p],
        icon: <PlatformIcon platform={p} title={false} className="size-4 text-[8px]" />,
      }))}
      value={value}
      onChange={onChange}
    />
  )
}

/** Only the platforms this member can see. Hidden when there's just one. */
function MyPlatformSelect({
  value,
  onChange,
}: {
  value: string[]
  onChange: (v: string[]) => void
}) {
  const platforms = usePlatforms()
  if (platforms.length <= 1) return null
  return <PlatformSelect platforms={platforms} value={value} onChange={onChange} />
}

export function Toolbar({
  view,
  filters,
  update,
  hasFilters,
  clearFilters,
  seenTags,
}: {
  view: ListView
  filters: ItemFilters
  update: (patch: Record<string, string | string[] | null>) => void
  hasFilters: boolean
  clearFilters: () => void
  seenTags: string[]
}) {
  const [search, setSearch] = useState(filters.q)

  // Debounce search → URL.
  useEffect(() => {
    if (search === filters.q) return
    const t = setTimeout(() => update({ q: search.trim() || null }), 300)
    return () => clearTimeout(t)
  }, [search, filters.q, update])

  // Keep the box in sync when the URL changes elsewhere (e.g. "Clear filters").
  const [syncedQ, setSyncedQ] = useState(filters.q)
  if (filters.q !== syncedQ) {
    setSyncedQ(filters.q)
    if (search.trim() !== filters.q) setSearch(filters.q)
  }

  // Follow-ups are threads, not items: only search, platform, type and date apply.
  const threads = view === "followups"
  const statusOptions =
    view === "inbox" || view === "followups"
      ? null
      : VIEW_STATUSES[view].map((s) => ({ value: s, label: STATUS_LABELS[s] }))
  const tags = [...new Set([...KNOWN_TAGS, ...seenTags])].sort()

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-64">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search text or author…"
          aria-label="Search"
          className="pl-8"
        />
      </div>
      <Suspense
        fallback={
          <PlatformSelect
            platforms={PLATFORMS}
            value={filters.platform}
            onChange={(v) => update({ platform: v })}
          />
        }
      >
        <MyPlatformSelect value={filters.platform} onChange={(v) => update({ platform: v })} />
      </Suspense>
      <MultiSelect
        label="Type"
        options={ITEM_TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] }))}
        value={filters.type}
        onChange={(v) => update({ type: v })}
      />
      {threads ? null : (
        <MultiSelect
          label="Priority"
          options={[...PRIORITIES].reverse().map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))}
          value={filters.priority}
          onChange={(v) => update({ priority: v })}
        />
      )}
      {statusOptions ? (
        <MultiSelect<ItemStatus>
          label="Status"
          options={statusOptions}
          value={filters.status}
          onChange={(v) => update({ status: v })}
        />
      ) : null}
      {threads ? null : <TagMenu filters={filters} update={update} tags={tags} />}
      <Select
        items={SINCE_ITEMS}
        value={filters.since}
        onValueChange={(v) => update({ since: v ? String(v) : null })}
      >
        <SelectTrigger size="sm" aria-label="Date range">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SINCE_ITEMS.map((s) => (
            <SelectItem key={s.value} value={s.value}>
              {s.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hasFilters ? (
        <Button variant="ghost" size="sm" className="h-8" onClick={clearFilters}>
          <X className="size-3.5" /> Clear filters
        </Button>
      ) : null}
      <div className={threads ? "hidden" : "ml-auto"}>
        <Select
          items={SORT_ITEMS}
          value={filters.sort}
          onValueChange={(v) => update({ sort: v ? String(v) : null })}
        >
          <SelectTrigger size="sm" aria-label="Sort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {SORT_ITEMS.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

function TagMenu({
  filters,
  update,
  tags,
}: {
  filters: ItemFilters
  update: (patch: Record<string, string | string[] | null>) => void
  tags: string[]
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" className="h-8 gap-1.5 border-dashed" />}
      >
        <Tag className="size-3.5" />
        {filters.tag || "Tag"}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-40">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Tag</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={filters.tag}
            onValueChange={(v) => update({ tag: String(v) || null })}
          >
            <DropdownMenuRadioItem value="">Any tag</DropdownMenuRadioItem>
            {tags.map((t) => (
              <DropdownMenuRadioItem key={t} value={t}>
                {t}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
