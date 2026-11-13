"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import type {
  SettingsResponse,
  SettingsSection,
  SettingsUpdateResponse,
  SyncListResponse,
} from "@inbox/core"
import { api, ApiError } from "@/lib/api"
import { qk } from "@/lib/query-keys"

export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: () => api<SettingsResponse>("/settings") })
}

export interface SaveSectionInput {
  section: SettingsSection
  values: unknown
  secrets?: Record<string, string | null>
}

/**
 * PUT /api/settings/:section with the current version. On success the cached settings take
 * the new version and section (so the next save on another tab isn't a false conflict).
 */
export function useSaveSection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ section, values, secrets }: SaveSectionInput) => {
      const current = qc.getQueryData<SettingsResponse>(qk.settings)
      if (!current) throw new Error("Settings are still loading")
      return api<SettingsUpdateResponse>(`/settings/${section}`, {
        method: "PUT",
        body: {
          version: current.version,
          values,
          ...(secrets && Object.keys(secrets).length ? { secrets } : {}),
        },
      })
    },
    onSuccess: (res, { section }) => {
      qc.setQueryData<SettingsResponse>(qk.settings, (d) =>
        d
          ? {
              ...d,
              version: res.version,
              updatedAt: res.updatedAt,
              sections: { ...d.sections, [section]: res.section },
            }
          : d,
      )
      if (section === "sync") void qc.invalidateQueries({ queryKey: qk.sync })
      toast.success("Settings saved", {
        description:
          res.rescheduled !== undefined && res.rescheduled > 0
            ? `${res.rescheduled} sync schedule${res.rescheduled === 1 ? "" : "s"} updated. The new times apply at the next scheduler tick.`
            : undefined,
      })
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        toast.error("Someone else changed these settings", {
          description: "Reload to see their changes, then make yours again.",
          action: {
            label: "Reload",
            onClick: () => void qc.invalidateQueries({ queryKey: qk.settings }),
          },
        })
      } else if (!(err instanceof ApiError && err.status === 400)) {
        toast.error("Couldn’t save settings", {
          description: err instanceof Error ? err.message : undefined,
        })
      }
    },
  })
}

export function useSyncStatus() {
  return useQuery({
    queryKey: qk.sync,
    queryFn: () => api<SyncListResponse>("/sync"),
    // Relative times ("in 3 min") stay fresh even without SSE events.
    refetchInterval: 60_000,
  })
}

export function useRunSync() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api(`/sync/${id}/run`, { method: "POST" }),
    onSuccess: () => {
      toast.success("Sync queued")
      void qc.invalidateQueries({ queryKey: qk.sync })
    },
    onError: (err) =>
      toast.error("Couldn’t start the sync", {
        description: err instanceof Error ? err.message : undefined,
      }),
  })
}
