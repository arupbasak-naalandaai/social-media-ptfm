"use client"

/** Typed same-origin client for the Hono api (proxied through /api/* by Next). */

export interface ApiIssue {
  path?: string
  conditionId?: string
  message: string
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: ApiIssue[] = [],
  ) {
    super(message)
    this.name = "ApiError"
  }
}

type Query = Record<string, string | number | boolean | string[] | null | undefined>

export function toQueryString(query: Query): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue
    if (Array.isArray(value)) {
      if (value.length) params.set(key, value.join(","))
    } else params.set(key, String(value))
  }
  const s = params.toString()
  return s ? `?${s}` : ""
}

export async function api<T>(
  path: string,
  init: Omit<RequestInit, "body"> & { body?: unknown; query?: Query } = {},
): Promise<T> {
  const { body, query, headers, ...rest } = init
  const res = await fetch(`/api${path}${query ? toQueryString(query) : ""}`, {
    ...rest,
    headers: {
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : null,
    credentials: "same-origin",
  })
  if (res.status === 204) return undefined as T
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const err = (data ?? {}) as { error?: string; issues?: ApiIssue[] }
    throw new ApiError(err.error ?? `Request failed (${res.status})`, res.status, err.issues ?? [])
  }
  return data as T
}
