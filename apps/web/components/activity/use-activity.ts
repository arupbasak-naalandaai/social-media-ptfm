"use client"

import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import type { AuditEntryDto, JobDto, JobState, Paged, WebhookEventDto } from "@inbox/core"
import { api } from "@/lib/api"
import { qk } from "@/lib/query-keys"

const PAGE = 50

function usePaged<T>(tab: string, path: string, params: Record<string, string | undefined>) {
  return useInfiniteQuery({
    queryKey: qk.activityTab(tab, params),
    queryFn: ({ pageParam }) =>
      api<Paged<T>>(path, { query: { ...params, limit: PAGE, cursor: pageParam ?? undefined } }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  })
}

export const useAuditLog = (entity?: string) =>
  usePaged<AuditEntryDto>("audit", "/activity/audit", { entity })

export const useJobs = (state?: JobState, queue?: string) =>
  usePaged<JobDto>("jobs", "/activity/jobs", { state, queue })

export const useWebhookEvents = () =>
  usePaged<WebhookEventDto>("webhooks", "/activity/webhooks", {})

export function useReplayWebhook() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api(`/webhooks/${id}/replay`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Replay queued", {
        description: "The delivery runs through the ingest queue again.",
      })
      void qc.invalidateQueries({ queryKey: qk.activity })
    },
    onError: (err) =>
      toast.error("Couldn’t replay", {
        description: err instanceof Error ? err.message : undefined,
      }),
  })
}
