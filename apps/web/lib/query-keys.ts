/** React Query keys. SSE events invalidate by prefix (see live-updates.tsx). */
export const qk = {
  items: ["items"] as const,
  itemList: (params: Record<string, unknown>) => ["items", "list", params] as const,
  item: (id: string) => ["items", "detail", id] as const,
  filters: ["filters"] as const,
  lists: ["lists"] as const,
}
