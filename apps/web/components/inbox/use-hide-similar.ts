"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import type { HideSimilarResponse } from "@inbox/core"
import { api, ApiError } from "@/lib/api"
import { qk } from "@/lib/query-keys"

/**
 * "Hide similar": archives the item and teaches the Low-value phrases list its wording, so
 * look-alike comments are filtered from now on (existing ones are re-filtered by the worker).
 * Undo removes the learned phrase and restores the item.
 */
export function useHideSimilar(opts: { onHidden?: (id: string) => void } = {}) {
  const queryClient = useQueryClient()
  const invalidate = (id: string) => {
    void queryClient.invalidateQueries({ queryKey: qk.items })
    void queryClient.invalidateQueries({ queryKey: qk.item(id) })
    void queryClient.invalidateQueries({ queryKey: qk.lists })
  }

  const undo = useMutation({
    mutationFn: async ({ id, entryId }: { id: string; entryId: string | null }) => {
      if (entryId) await api(`/lists/${entryId}`, { method: "DELETE" })
      await api(`/items/${id}/restore`, { method: "POST", body: { addToAllowlist: false } })
    },
    onSuccess: () => toast.success("Restored, and the phrase was removed"),
    onError: (err) =>
      toast.error("Couldn't undo", {
        description: err instanceof ApiError ? err.message : "Please try again.",
      }),
    onSettled: (_d, _e, { id }) => invalidate(id),
  })

  return useMutation({
    mutationFn: (id: string) =>
      api<HideSimilarResponse>(`/items/${id}/hide-similar`, { method: "POST" }),
    onSuccess: (res, id) => {
      opts.onHidden?.(id)
      toast.success("Hidden as low-value", {
        description: res.entryId
          ? `Comments like “${res.phrase}” will be filtered from now on.`
          : `“${res.phrase}” was already on the Low-value phrases list.`,
        action: {
          label: "Undo",
          onClick: () => undo.mutate({ id, entryId: res.entryId }),
        },
      })
    },
    onError: (err) =>
      toast.error("Couldn't hide this", {
        description: err instanceof ApiError ? err.message : "Please try again.",
      }),
    onSettled: (_d, _e, id) => invalidate(id),
  })
}
