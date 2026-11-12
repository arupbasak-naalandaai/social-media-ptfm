"use client"

import { useCallback, useMemo } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { parseFilters, parseView, type ItemFilters, type ListView } from "./list-state"

export type { ItemFilters, ListView, Since, Sort } from "./list-state"

/** Filter + view + open-item state, stored in the URL so views are shareable and survive reloads. */
export function useItemFilters(defaultView: ListView) {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()

  const view = parseView(params, defaultView)
  const filters: ItemFilters = useMemo(() => parseFilters(params), [params])

  /** Item shown in the quick-preview sheet. */
  const openItemId = params.get("item")

  /** This list's URL without the preview param: where the full item page links back to. */
  const listHref = useMemo(() => {
    const next = new URLSearchParams(params.toString())
    next.delete("item")
    const qs = next.toString()
    return qs ? `${pathname}?${qs}` : pathname
  }, [params, pathname])

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

  return { view, filters, openItemId, listHref, update, hasFilters, clearFilters }
}
