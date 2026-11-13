"use client"

import { Suspense, useEffect, useRef } from "react"
import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import {
  Bell,
  Building2,
  CircleAlert,
  Database,
  Filter,
  Hash,
  Lock,
  Plug,
  RefreshCw,
  Reply,
  Sparkles,
  type LucideIcon,
} from "lucide-react"
import { cn } from "cn"
import { SETTINGS_SECTIONS, type SettingsSection } from "@inbox/core"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/app/empty-state"
import { useIsAdmin } from "@/components/app/me-context"
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

interface SectionMeta {
  label: string
  description: string
  icon: LucideIcon
}

const SECTION_META: Record<SettingsSection, SectionMeta> = {
  general: {
    label: "General",
    description: "Workspace name, time zone and who can sign in.",
    icon: Building2,
  },
  connections: {
    label: "Connections",
    description: "App credentials for Meta, Google and LinkedIn.",
    icon: Plug,
  },
  sync: {
    label: "Sync",
    description: "Polling schedules for each stream, and pausing sync.",
    icon: RefreshCw,
  },
  filters: {
    label: "Filters",
    description: "When filter rules and AI checks run on incoming items.",
    icon: Filter,
  },
  ai: {
    label: "AI replies",
    description: "Provider, model and brand voice for drafted replies.",
    icon: Sparkles,
  },
  replies: {
    label: "Replies",
    description: "Sending behaviour, signatures and automatic replies.",
    icon: Reply,
  },
  slack: {
    label: "Slack",
    description: "Post new items to Slack and reply from threads.",
    icon: Hash,
  },
  notifications: {
    label: "Notifications",
    description: "Desktop alerts and warnings for expiring connections.",
    icon: Bell,
  },
  data: {
    label: "Data",
    description: "How long filtered items, webhooks and audit logs are kept.",
    icon: Database,
  },
}

const SECTION_GROUPS: { label: string; sections: SettingsSection[] }[] = [
  { label: "Workspace", sections: ["general", "notifications", "data"] },
  { label: "Sources", sections: ["connections", "sync", "filters"] },
  { label: "Responding", sections: ["ai", "replies", "slack"] },
]

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
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="flex flex-col gap-6 md:flex-row md:gap-10">
        <div className="hidden w-52 shrink-0 flex-col gap-2 md:flex">
          {Array.from({ length: 9 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
        <Skeleton className="h-9 w-full md:hidden" />
        <div className="flex flex-1 flex-col gap-4">
          <Skeleton className="h-12 w-80" />
          <Skeleton className="h-96 w-full rounded-xl" />
        </div>
      </div>
    </div>
  )
}

function useSectionHref() {
  const pathname = usePathname()
  const params = useSearchParams()
  return (section: SettingsSection) => {
    const sp = new URLSearchParams(params)
    if (section === "general") sp.delete("tab")
    else sp.set("tab", section)
    const qs = sp.toString()
    return qs ? `${pathname}?${qs}` : pathname
  }
}

function SettingsContent() {
  const params = useSearchParams()
  const tabParam = params.get("tab")
  const tab: SettingsSection = isSection(tabParam) ? tabParam : "general"
  const { data, isPending, isError, error, refetch } = useSettings()

  if (isPending) return <SettingsSkeleton />
  if (isError) {
    return (
      <Alert variant="destructive" className="mx-auto max-w-6xl">
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

  const meta = SECTION_META[tab]
  const Icon = meta.icon

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div className="flex flex-col gap-1">
          <h2 className="text-2xl font-semibold tracking-tight">Settings</h2>
          <p className="text-sm text-muted-foreground">
            Manage how your workspace syncs, filters and replies.
          </p>
        </div>
        {data.updatedAt ? (
          <p className="text-xs text-muted-foreground">Last saved {relativeTime(data.updatedAt)}</p>
        ) : null}
      </header>

      <div className="flex flex-col gap-6 md:flex-row md:items-start md:gap-10">
        <SettingsNav active={tab} />
        <SettingsMobileNav active={tab} />

        <div className="flex min-w-0 flex-1 flex-col gap-5">
          <div className="flex items-start gap-3 border-b pb-5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground">
              <Icon className="size-4" />
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <h3 className="text-base font-semibold leading-tight">{meta.label}</h3>
              <p className="text-sm text-muted-foreground">{meta.description}</p>
            </div>
          </div>
          {/* Panels stay mounted, so unsaved edits survive switching sections. */}
          {SETTINGS_SECTIONS.map((s) => (
            <section
              key={s}
              id={`settings-panel-${s}`}
              aria-label={SECTION_META[s].label}
              hidden={s !== tab}
              className="min-w-0"
            >
              <SectionTab tab={s} data={data} />
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Desktop: grouped vertical nav that stays in view while the form scrolls. */
function SettingsNav({ active }: { active: SettingsSection }) {
  const hrefFor = useSectionHref()
  return (
    <nav
      aria-label="Settings sections"
      className="sticky top-20 hidden w-52 shrink-0 flex-col gap-5 md:flex"
    >
      {SECTION_GROUPS.map((group) => (
        <div key={group.label} className="flex flex-col gap-0.5">
          <p className="px-2.5 pb-1 text-xs font-medium text-muted-foreground/80">{group.label}</p>
          {group.sections.map((s) => {
            const { label, icon: Icon } = SECTION_META[s]
            const isActive = s === active
            return (
              <Link
                key={s}
                href={hrefFor(s)}
                replace
                scroll={false}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors outline-none",
                  "hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  isActive && "bg-muted font-medium text-foreground",
                )}
              >
                <Icon
                  className={cn(
                    "size-4 shrink-0 transition-colors",
                    isActive
                      ? "text-foreground"
                      : "text-muted-foreground/70 group-hover:text-foreground",
                  )}
                />
                {label}
              </Link>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

/** Mobile: one scrollable row of chips; the active one is kept in view. */
function SettingsMobileNav({ active }: { active: SettingsSection }) {
  const hrefFor = useSectionHref()
  const activeRef = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "center" })
  }, [active])

  return (
    <nav
      aria-label="Settings sections"
      className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:hidden [&::-webkit-scrollbar]:hidden"
    >
      {SECTION_GROUPS.flatMap((g) => g.sections).map((s) => {
        const { label, icon: Icon } = SECTION_META[s]
        const isActive = s === active
        return (
          <Link
            key={s}
            ref={isActive ? activeRef : undefined}
            href={hrefFor(s)}
            replace
            scroll={false}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm whitespace-nowrap text-muted-foreground transition-colors outline-none",
              "hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
              isActive && "border-foreground bg-foreground text-background hover:text-background",
            )}
          >
            <Icon className="size-3.5" />
            {label}
          </Link>
        )
      })}
    </nav>
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
