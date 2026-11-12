import { Suspense } from "react"
import { AppHeader } from "@/components/app/app-header"
import { AppSidebar } from "@/components/app/app-sidebar"
import { LiveUpdates } from "@/components/app/live-updates"
import { MeProvider } from "@/components/app/me-context"
import { QueryProvider } from "@/components/app/query-provider"
import { ShellSkeleton } from "@/components/app/shell-skeleton"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { getCurrentMe } from "@/lib/server-api"

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <Suspense fallback={<ShellSkeleton />}>
      <AppShell>{children}</AppShell>
    </Suspense>
  )
}

/**
 * Starts the session read without awaiting it. The sidebar, header and page chrome render
 * immediately; user-specific parts unwrap the promise behind their own Suspense boundaries.
 */
function AppShell({ children }: { children: React.ReactNode }) {
  const mePromise = getCurrentMe()
  return (
    <MeProvider mePromise={mePromise}>
      <QueryProvider>
        <LiveUpdates>
          <SidebarProvider>
            <AppSidebar />
            <SidebarInset>
              <AppHeader />
              <main className="flex flex-1 flex-col p-4 md:p-6">{children}</main>
            </SidebarInset>
          </SidebarProvider>
        </LiveUpdates>
      </QueryProvider>
    </MeProvider>
  )
}
