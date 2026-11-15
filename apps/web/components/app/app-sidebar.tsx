"use client"

import { Suspense } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { MessagesSquare } from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { can } from "@inbox/core"
import { useMe } from "./me-context"
import { NAV_MAIN, NAV_MANAGE, type NavItem } from "./nav"
import { UserMenu } from "./user-menu"

function NavGroup({ label, items }: { label: string; items: NavItem[] }) {
  // Groups with permission-gated items wait for the member's access; the rest render in the static shell.
  if (!items.some((i) => i.permission)) return <NavGroupList label={label} items={items} />
  return (
    <Suspense fallback={<NavGroupSkeleton label={label} count={items.length} />}>
      <RoleFilteredNavGroup label={label} items={items} />
    </Suspense>
  )
}

function RoleFilteredNavGroup({ label, items }: { label: string; items: NavItem[] }) {
  const { permissions } = useMe()
  const visible = items.filter((i) => !i.permission || can(permissions, i.permission))
  if (visible.length === 0) return null
  return <NavGroupList label={label} items={visible} />
}

function NavGroupSkeleton({ label, count }: { label: string; count: number }) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarMenu>
        {Array.from({ length: count }).map((_, i) => (
          <SidebarMenuItem key={i} className="flex h-8 items-center gap-2 px-2">
            <Skeleton className="size-4 rounded-md" />
            <Skeleton className="h-4 w-3/5" />
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  )
}

function NavGroupList({ label, items }: { label: string; items: NavItem[] }) {
  const pathname = usePathname()
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.href}>
              <SidebarMenuButton
                isActive={pathname === item.href || pathname.startsWith(`${item.href}/`)}
                tooltip={item.title}
                render={<Link href={item.href} />}
              >
                <item.icon />
                <span>{item.title}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

function OrgName() {
  const { organization } = useMe()
  return <span className="truncate text-xs text-muted-foreground">{organization.name}</span>
}

export function AppSidebar() {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href="/inbox" />}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <MessagesSquare className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">Social Inbox</span>
                <Suspense fallback={<Skeleton className="mt-0.5 h-3 w-20" />}>
                  <OrgName />
                </Suspense>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavGroup label="Inbox" items={NAV_MAIN} />
        <NavGroup label="Manage" items={NAV_MANAGE} />
      </SidebarContent>
      <SidebarFooter>
        <Suspense fallback={<Skeleton className="h-12 w-full rounded-lg" />}>
          <UserMenu />
        </Suspense>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
