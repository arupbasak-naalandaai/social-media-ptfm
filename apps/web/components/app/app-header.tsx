"use client"

import { Suspense } from "react"
import { usePathname } from "next/navigation"
import { FlaskConical } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useLiveStatus } from "./live-updates"
import { useMe } from "./me-context"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { ALL_NAV } from "./nav"
import { ThemeToggle } from "./theme-toggle"

export function AppHeader() {
  const pathname = usePathname()
  const current = ALL_NAV.find((n) => pathname === n.href || pathname.startsWith(`${n.href}/`))
  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <SidebarTrigger className="-ml-1" />
      <Separator
        orientation="vertical"
        className="mr-2 data-vertical:h-4 data-vertical:self-center"
      />
      <h1 className="text-sm font-medium">{current?.title ?? "Social Inbox"}</h1>
      <div className="ml-auto flex items-center gap-2">
        <LiveDot />
        <Suspense fallback={null}>
          <PreviewBadge />
        </Suspense>
        <ThemeToggle />
      </div>
    </header>
  )
}

/** Makes it obvious the app is running without a real session (DEV_AUTH_BYPASS). */
function PreviewBadge() {
  const { preview, role } = useMe()
  if (!preview) return null
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant="outline"
            className="gap-1 border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400"
          />
        }
      >
        <FlaskConical className="size-3" />
        Preview mode
      </TooltipTrigger>
      <TooltipContent>
        Signed out, acting as a virtual {role} (DEV_AUTH_BYPASS). Local development only.
      </TooltipContent>
    </Tooltip>
  )
}

/** Live-update connection state (SSE). */
function LiveDot() {
  const status = useLiveStatus()
  const label =
    status === "live"
      ? "Live updates on"
      : status === "connecting"
        ? "Connecting…"
        : "Live updates offline"
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="flex size-6 items-center justify-center"
            aria-label={label}
            role="status"
          />
        }
      >
        <span
          className={
            status === "live"
              ? "size-2 rounded-full bg-emerald-500"
              : status === "connecting"
                ? "size-2 animate-pulse rounded-full bg-amber-500"
                : "size-2 rounded-full bg-muted-foreground"
          }
        />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
