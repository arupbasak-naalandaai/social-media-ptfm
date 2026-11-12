"use client"

import { useCallback, useMemo } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import {
  ITEM_STATUSES,
  ITEM_TYPES,
  PLATFORMS,
  PRIORITIES,
  type InboxView,
  type ItemStatus,
  type ItemType,
  type Platform,
  type Priority,
} from "@inbox/core"

export type Since = "24h" | "7d" | "30d" | "all"
export type Sort = "newest" | "oldest" | "priority"

export interface ItemFilters {
  q: string
  platform: Platform[]
  type: ItemType[]
  priority: Priority[]
  status: ItemStatus[]
  tag: string
  since: Since
  sort: Sort
}

const SINCE: readonly Since[] = ["24h", "7d", "30d", "all"]
const SORTS: readonly Sort[] = ["newest", "oldest", "priority"]

function list<T extends string>(raw: string | null, allowed: readonly T[]): T[] {
  if (!raw) return []
  return raw.split(",").filter((v): v is T => (allowed as readonly string[]).includes(v))
}

/** Filter + view + open-item state, stored in the URL so views are shareable and survive reloads. */
export function useItemFilters(defaultView: InboxView) {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const view: InboxView = (() => {
    const v = params.get("view")
    return v === "inbox" || v === "done" || v === "filtered" ? v : defaultView
  })()

  const filters: ItemFilters = useMemo(
    () => ({
      q: params.get("q") ?? "",
      platform: list(params.get("platform"), PLATFORMS),
      type: list(params.get("type"), ITEM_TYPES),
      priority: list(params.get("priority"), PRIORITIES),
      status: list(params.get("status"), ITEM_STATUSES),
      tag: params.get("tag") ?? "",
      since: (SINCE as readonly string[]).includes(params.get("since") ?? "")
        ? (params.get("since") as Since)
        : "all",
      sort: (SORTS as readonly string[]).includes(params.get("sort") ?? "")
        ? (params.get("sort") as Sort)
        : "newest",
    }),
    [params],
  )

  const openItemId = params.get("item")

  const update = useCallback(
    (patch: Record<string, string | string[] | null>) => {
      const next = new URLSearchParams(params.toString())
      for (const [key, value] of Object.entries(patch)) {
        const v = Array.isArray(value) ? value.join(",") : value
        if (
          v === null ||
          v === "" ||
          (key === "since" && v === "all") ||
          (key === "sort" && v === "newest")
        ) {
          next.delete(key)
        } else next.set(key, v)
      }
      const qs = next.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [params, pathname, router],
  )

  const hasFilters =
    filters.q !== "" ||
    filters.platform.length > 0 ||
    filters.type.length > 0 ||
    filters.priority.length > 0 ||
    filters.status.length > 0 ||
    filters.tag !== "" ||
    filters.since !== "all"

  const clearFilters = useCallback(
    () =>
      update({
        q: null,
        platform: null,
        type: null,
        priority: null,
        status: null,
        tag: null,
        since: null,
      }),
    [update],
  )

  return { view, filters, openItemId, update, hasFilters, clearFilters }
}
