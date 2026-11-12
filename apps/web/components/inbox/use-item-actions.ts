"use client"

import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query"
import { toast } from "sonner"
import {
  VIEW_STATUSES,
  type InboxView,
  type ItemListResponse,
  type ItemStatus,
  type ItemSummary,
} from "@inbox/core"
import { api, ApiError } from "@/lib/api"
import { qk } from "@/lib/query-keys"

export type ItemAction = "resolve" | "ignore" | "reopen" | "archive" | "restore"

export const RESULT_STATUS: Record<ItemAction, ItemStatus> = {
  resolve: "resolved",
  ignore: "ignored",
  reopen: "new",
  archive: "archived",
  restore: "new",
}

const DONE_MESSAGE: Record<ItemAction, string> = {
  resolve: "Marked as resolved",
  ignore: "Ignored",
  reopen: "Moved back to the inbox",
  archive: "Archived",
  restore: "Restored to the inbox",
}

/** Actions whose effect "Undo" can reverse by reopening the item. */
const UNDOABLE: readonly ItemAction[] = ["resolve", "ignore", "archive"]

interface Vars {
  id: string
  action: ItemAction
  addToAllowlist?: boolean
  /** Suppress the success toast (used by Undo itself). */
  silent?: boolean
}

type ListParams = { view?: InboxView; status?: ItemStatus[] }

/** Removes an item from cached lists it no longer belongs to once its status changes. */
function removeFromLists(
  data: InfiniteData<ItemListResponse> | undefined,
  params: ListParams,
  id: string,
  nextStatus: ItemStatus,
) {
  if (!data) return data
  const allowed: readonly ItemStatus[] = params.status?.length
    ? params.status
    : VIEW_STATUSES[params.view ?? "inbox"]
  if (allowed.includes(nextStatus)) {
    return {
      ...data,
      pages: data.pages.map((p) => ({
        ...p,
        items: p.items.map((i) => (i.id === id ? { ...i, status: nextStatus } : i)),
      })),
    }
  }
  return {
    ...data,
    pages: data.pages.map((p) => ({ ...p, items: p.items.filter((i) => i.id !== id) })),
  }
}

export function useItemAction() {
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: ({ id, action, addToAllowlist }: Vars) =>
      api<ItemSummary>(`/items/${id}/${action}`, {
        method: "POST",
        ...(action === "restore" ? { body: { addToAllowlist: addToAllowlist ?? false } } : {}),
      }),
    onMutate: async ({ id, action }) => {
      await queryClient.cancelQueries({ queryKey: qk.items })
      const snapshots = queryClient.getQueriesData<InfiniteData<ItemListResponse>>({
        queryKey: [...qk.items, "list"],
      })
      for (const [key, data] of snapshots) {
        const params = (key[2] ?? {}) as ListParams
        queryClient.setQueryData(key, removeFromLists(data, params, id, RESULT_STATUS[action]))
      }
      return { snapshots }
    },
    onError: (err, _vars, ctx) => {
      for (const [key, data] of ctx?.snapshots ?? []) queryClient.setQueryData(key, data)
      toast.error("That didn't work", {
        description: err instanceof ApiError ? err.message : "Please try again.",
      })
    },
    onSuccess: (_item, { id, action, silent }) => {
      if (silent) return
      toast.success(DONE_MESSAGE[action], {
        ...(UNDOABLE.includes(action)
          ? {
              action: {
                label: "Undo",
                onClick: () => mutation.mutate({ id, action: "reopen", silent: true }),
              },
            }
          : {}),
      })
    },
    onSettled: (_d, _e, { id }) => {
      void queryClient.invalidateQueries({ queryKey: qk.items })
      void queryClient.invalidateQueries({ queryKey: qk.item(id) })
    },
  })

  return mutation
}
