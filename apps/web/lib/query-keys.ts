/** React Query keys. SSE events invalidate by prefix (see live-updates.tsx). */
export const qk = {
  items: ["items"] as const,
  itemList: (params: Record<string, unknown>) => ["items", "list", params] as const,
  followUps: (params: Record<string, unknown>) => ["items", "followups", params] as const,
  item: (id: string) => ["items", "detail", id] as const,
  filters: ["filters"] as const,
  lists: ["lists"] as const,
  settings: ["settings"] as const,
  aiModels: (provider: string, baseUrl: string, typedKey: string | null) =>
    ["ai-models", provider, baseUrl, typedKey] as const,
  sync: ["sync"] as const,
  connections: ["connections"] as const,
  activity: ["activity"] as const,
  activityTab: (tab: string, params: Record<string, unknown>) => ["activity", tab, params] as const,
}
