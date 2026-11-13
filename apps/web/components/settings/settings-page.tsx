"use client"

import { Suspense } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { CircleAlert, Lock } from "lucide-react"
import { SETTINGS_SECTIONS, type SettingsSection } from "@inbox/core"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { EmptyState } from "@/components/app/empty-state"
import { useIsAdmin } from "@/components/app/me-context"
import { useIsMobile } from "@/hooks/use-mobile"
import { relativeTime } from "@/lib/format"
import { SyncTab } from "./sync-tab"
import {
  AiTab,
  ConnectionsTab,
  DataTab,
  FiltersTab,
  GeneralTab,
  NotificationsTab,
  RepliesTab,
  SlackTab,
} from "./tabs"
import { useSettings } from "./use-settings"

const TAB_LABELS: Record<SettingsSection, string> = {
  general: "General",
  connections: "Connections",
  sync: "Sync",
  filters: "Filters",
  ai: "AI replies",
  replies: "Replies",
  slack: "Slack",
  notifications: "Notifications",
  data: "Data",
}

function isSection(v: string | null): v is SettingsSection {
  return v !== null && (SETTINGS_SECTIONS as readonly string[]).includes(v)
}

export function SettingsPage() {
  return (
    <Suspense fallback={<SettingsSkeleton />}>
      <SettingsGate />
    </Suspense>
  )
}

function SettingsGate() {
  const isAdmin = useIsAdmin()
  if (!isAdmin) {
    return (
      <EmptyState
        icon={Lock}
        title="Owners and admins only"
        description="Ask an owner or admin if you need to change workspace settings."
      />
    )
  }
  return <SettingsContent />
}

function SettingsSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 md:flex-row">
      <Skeleton className="h-9 w-full md:h-80 md:w-44" />
      <Skeleton className="h-96 flex-1 rounded-xl" />
    </div>
  )
}

function SettingsContent() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const isMobile = useIsMobile()
  const tabParam = params.get("tab")
  const tab: SettingsSection = isSection(tabParam) ? tabParam : "general"
  const { data, isPending, isError, error, refetch } = useSettings()

  const setTab = (next: SettingsSection) => {
    const sp = new URLSearchParams(params)
    if (next === "general") sp.delete("tab")
    else sp.set("tab", next)
    const qs = sp.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  if (isPending) return <SettingsSkeleton />
  if (isError) {
    return (
      <Alert variant="destructive" className="mx-auto max-w-5xl">
        <CircleAlert />
        <AlertDescription className="flex flex-wrap items-center gap-2">
          Couldn’t load settings: {error.message}
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => setTab(v as SettingsSection)}
      orientation={isMobile ? "horizontal" : "vertical"}
      className="mx-auto w-full max-w-5xl gap-4 md:gap-6"
    >
      <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:overflow-visible md:px-0">
        <TabsList className="md:sticky md:top-4 md:w-44">
          {SETTINGS_SECTIONS.map((s) => (
            <TabsTrigger key={s} value={s}>
              {TAB_LABELS[s]}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {data.updatedAt ? (
          <p className="text-xs text-muted-foreground">Last saved {relativeTime(data.updatedAt)}</p>
        ) : null}
        {/* Panels stay mounted, so unsaved edits survive switching tabs. */}
        {SETTINGS_SECTIONS.map((s) => (
          <TabsContent key={s} value={s} keepMounted className="min-w-0">
            <SectionTab tab={s} data={data} />
          </TabsContent>
        ))}
      </div>
    </Tabs>
  )
}

function SectionTab({
  tab,
  data,
}: {
  tab: SettingsSection
  data: NonNullable<ReturnType<typeof useSettings>["data"]>
}) {
  switch (tab) {
    case "general":
      return <GeneralTab data={data} />
    case "connections":
      return <ConnectionsTab data={data} />
    case "sync":
      return <SyncTab data={data} canRun />
    case "filters":
      return <FiltersTab data={data} />
    case "ai":
      return <AiTab data={data} />
    case "replies":
      return <RepliesTab data={data} />
    case "slack":
      return <SlackTab data={data} />
    case "notifications":
      return <NotificationsTab data={data} />
    case "data":
      return <DataTab data={data} />
  }
}
