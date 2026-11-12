"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import type {
  FilterRuleInput,
  ListEntryDto,
  ListKind,
  ListName,
  RuleTestRequest,
  RuleTestResponse,
  RuleWithStats,
} from "@inbox/core"
import { api, ApiError } from "@/lib/api"
import { qk } from "@/lib/query-keys"

type RulesData = { rules: RuleWithStats[] }
type ListsData = { entries: ListEntryDto[] }

export function useRules() {
  return useQuery({ queryKey: qk.filters, queryFn: () => api<RulesData>("/filters") })
}

export function useListEntries() {
  return useQuery({ queryKey: qk.lists, queryFn: () => api<ListsData>("/lists") })
}

function errorToast(title: string, err: unknown) {
  toast.error(title, { description: err instanceof Error ? err.message : undefined })
}

/** Optimistic PATCH (enabled / dryRun / stopProcessing). */
export function usePatchRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string
      patch: Partial<Pick<RuleWithStats, "enabled" | "dryRun" | "stopProcessing">>
    }) => api(`/filters/${id}`, { method: "PATCH", body: patch }),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: qk.filters })
      const prev = qc.getQueryData<RulesData>(qk.filters)
      qc.setQueryData<RulesData>(qk.filters, (d) =>
        d ? { rules: d.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) } : d,
      )
      return { prev }
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.filters, ctx.prev)
      errorToast("Couldn’t update the rule", err)
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.filters }),
  })
}

/** Optimistic reorder: rewrites priorities locally, rolls back on error. */
export function useReorderRules() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) => api("/filters/reorder", { method: "POST", body: { ids } }),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: qk.filters })
      const prev = qc.getQueryData<RulesData>(qk.filters)
      qc.setQueryData<RulesData>(qk.filters, (d) => {
        if (!d) return d
        const byId = new Map(d.rules.map((r) => [r.id, r]))
        return {
          rules: ids.flatMap((id, i) => {
            const r = byId.get(id)
            return r ? [{ ...r, priority: (i + 1) * 10 }] : []
          }),
        }
      })
      return { prev }
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.filters, ctx.prev)
      errorToast("Couldn’t reorder rules", err)
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.filters }),
  })
}

export function useDeleteRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api(`/filters/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Rule deleted")
      void qc.invalidateQueries({ queryKey: qk.filters })
      void qc.invalidateQueries({ queryKey: qk.items })
    },
    onError: (err) => errorToast("Couldn’t delete the rule", err),
  })
}

export function useApplyRules() {
  return useMutation({
    mutationFn: () => api("/filters/apply", { method: "POST" }),
    onSuccess: () => toast.success("Re-applying rules to existing items…"),
    onError: (err) => errorToast("Couldn’t re-apply rules", err),
  })
}

export function useSaveRule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, rule }: { id: string | null; rule: FilterRuleInput }) =>
      id
        ? api<{ id: string }>(`/filters/${id}`, { method: "PUT", body: rule })
        : api<{ id: string }>("/filters", { method: "POST", body: rule }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.filters })
      void qc.invalidateQueries({ queryKey: qk.items })
    },
  })
}

export function useTestRule() {
  return useMutation({
    mutationFn: (req: RuleTestRequest) =>
      api<RuleTestResponse>("/filters/test", { method: "POST", body: req }),
  })
}

export function useAddListEntry() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (entry: { list: ListName; kind: ListKind; value: string }) =>
      api<ListEntryDto>("/lists", { method: "POST", body: { ...entry, platform: null } }),
    onMutate: async (entry) => {
      await qc.cancelQueries({ queryKey: qk.lists })
      const prev = qc.getQueryData<ListsData>(qk.lists)
      const temp: ListEntryDto = {
        id: `temp-${entry.list}-${entry.kind}-${entry.value}`,
        ...entry,
        platform: null,
        note: null,
        createdAt: new Date().toISOString(),
      }
      qc.setQueryData<ListsData>(qk.lists, (d) => (d ? { entries: [...d.entries, temp] } : d))
      return { prev }
    },
    onError: (err, entry, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.lists, ctx.prev)
      if (err instanceof ApiError && err.status === 409)
        toast.info(`“${entry.value}” is already on the list`)
      else errorToast("Couldn’t add the entry", err)
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.lists }),
  })
}

export function useRemoveListEntry() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api(`/lists/${id}`, { method: "DELETE" }),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: qk.lists })
      const prev = qc.getQueryData<ListsData>(qk.lists)
      qc.setQueryData<ListsData>(qk.lists, (d) =>
        d ? { entries: d.entries.filter((e) => e.id !== id) } : d,
      )
      return { prev }
    },
    onError: (err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.lists, ctx.prev)
      errorToast("Couldn’t remove the entry", err)
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.lists }),
  })
}
