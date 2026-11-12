/**
 * URL ⇄ list state, as plain functions. The list reads it through `useItemFilters`; the full
 * item page parses its `from` link with the same functions so it can find the list's cached
 * results (next/previous item) without fetching anything.
 */
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
/** The inbox views plus Follow-ups (threads you engaged with). */
export type ListView = InboxView | "followups"

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
const VIEWS: readonly ListView[] = ["inbox", "followups", "done", "filtered"]

function list<T extends string>(raw: string | null, allowed: readonly T[]): T[] {
  if (!raw) return []
  return raw.split(",").filter((v): v is T => (allowed as readonly string[]).includes(v))
}

type Params = Pick<URLSearchParams, "get">

export function parseView(params: Params, defaultView: ListView): ListView {
  const v = params.get("view")
  return (VIEWS as readonly string[]).includes(v ?? "") ? (v as ListView) : defaultView
}

export function parseFilters(params: Params): ItemFilters {
  const since = params.get("since") ?? ""
  const sort = params.get("sort") ?? ""
  return {
    q: params.get("q") ?? "",
    platform: list(params.get("platform"), PLATFORMS),
    type: list(params.get("type"), ITEM_TYPES),
    priority: list(params.get("priority"), PRIORITIES),
    status: list(params.get("status"), ITEM_STATUSES),
    tag: params.get("tag") ?? "",
    since: (SINCE as readonly string[]).includes(since) ? (since as Since) : "all",
    sort: (SORTS as readonly string[]).includes(sort) ? (sort as Sort) : "newest",
  }
}

/** The list page a path belongs to decides the view when the URL has none. */
export function defaultViewForPath(pathname: string): ListView {
  return pathname.startsWith("/filtered") ? "filtered" : "inbox"
}

/** GET /api/items params for an inbox view (also the React Query key). */
export function listQuery(view: InboxView, f: ItemFilters) {
  return {
    view,
    q: f.q || undefined,
    platform: f.platform,
    type: f.type,
    priority: f.priority,
    status: f.status,
    tag: f.tag || undefined,
    since: f.since,
    sort: f.sort,
  }
}

/** GET /api/items/follow-ups params (also the React Query key). */
export function followUpQuery(f: ItemFilters) {
  return { q: f.q || undefined, platform: f.platform, type: f.type, since: f.since }
}

/** Only same-app relative paths are accepted as a "back to list" target. */
export function safeListHref(from: string | null): string {
  if (!from || !from.startsWith("/") || from.startsWith("//")) return "/inbox"
  return from
}

/** Link to the full item page, remembering which list it was opened from. */
export function itemHref(id: string, from: string, opts: { reply?: boolean } = {}): string {
  const params = new URLSearchParams({ from })
  if (opts.reply) params.set("reply", "1")
  return `/items/${encodeURIComponent(id)}?${params.toString()}`
}
