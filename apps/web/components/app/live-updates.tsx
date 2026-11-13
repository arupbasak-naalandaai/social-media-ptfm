"use client"

import { useQueryClient } from "@tanstack/react-query"
import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import { toast } from "sonner"
import type { InboxStreamEvent } from "@inbox/core"
import { qk } from "@/lib/query-keys"

type LiveStatus = "connecting" | "live" | "offline"
const LiveContext = createContext<LiveStatus>("connecting")

/**
 * Subscribes to GET /api/stream (SSE) and invalidates cached queries when the server says
 * something changed, so the inbox updates without a refresh. EventSource reconnects on its own.
 */
export function LiveUpdates({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<LiveStatus>("connecting")

  useEffect(() => {
    const source = new EventSource("/api/stream", { withCredentials: true })
    const parse = (e: MessageEvent<string>) => JSON.parse(e.data) as InboxStreamEvent

    source.addEventListener("ready", () => setStatus("live"))
    source.addEventListener("ping", () => setStatus("live"))
    source.onerror = () =>
      setStatus(source.readyState === EventSource.CLOSED ? "offline" : "connecting")

    source.addEventListener("items.changed", (e) => {
      const event = parse(e as MessageEvent<string>)
      void queryClient.invalidateQueries({ queryKey: qk.items })
      if (event.type === "items.changed") {
        for (const id of event.itemIds)
          void queryClient.invalidateQueries({ queryKey: qk.item(id) })
      }
    })
    source.addEventListener("items.refiltered", (e) => {
      const event = parse(e as MessageEvent<string>)
      void queryClient.invalidateQueries({ queryKey: qk.items })
      void queryClient.invalidateQueries({ queryKey: qk.filters })
      if (event.type === "items.refiltered" && event.changed > 0) {
        toast.info(`Filters re-applied`, {
          description: `${event.changed} item${event.changed === 1 ? "" : "s"} moved between Inbox and Filtered.`,
        })
      }
    })
    source.addEventListener(
      "rules.changed",
      () => void queryClient.invalidateQueries({ queryKey: qk.filters }),
    )
    source.addEventListener(
      "lists.changed",
      () => void queryClient.invalidateQueries({ queryKey: qk.lists }),
    )

    source.addEventListener("sync.changed", () => {
      void queryClient.invalidateQueries({ queryKey: qk.sync })
      void queryClient.invalidateQueries({ queryKey: qk.connections })
      void queryClient.invalidateQueries({ queryKey: qk.activity })
    })
    source.addEventListener("settings.changed", (e) => {
      const event = parse(e as MessageEvent<string>)
      // Our own save already updated the cache to this version: skip the refetch.
      const cached = queryClient.getQueryData<{ version: number }>(qk.settings)
      if (event.type === "settings.changed" && cached && cached.version >= event.version) return
      void queryClient.invalidateQueries({ queryKey: qk.settings })
      void queryClient.invalidateQueries({ queryKey: qk.activity })
    })

    return () => source.close()
  }, [queryClient])

  return <LiveContext value={status}>{children}</LiveContext>
}

export function useLiveStatus(): LiveStatus {
  return useContext(LiveContext)
}
