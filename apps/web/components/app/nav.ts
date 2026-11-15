import {
  Activity,
  BarChart3,
  Filter,
  Inbox,
  ListFilter,
  Plug,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react"
import type { PermissionMap } from "@inbox/core"

export interface NavItem {
  title: string
  href: string
  icon: LucideIcon
  /** Phase that builds this page (shown in the empty state). */
  phase: number
  description: string
  /** Shown only to members with these permissions (the api enforces them too). */
  permission?: PermissionMap
}

export const NAV_MAIN: NavItem[] = [
  {
    title: "Inbox",
    href: "/inbox",
    icon: Inbox,
    phase: 2,
    description: "Every review, comment and DM that needs a reply.",
    permission: { inbox: ["read"] },
  },
  {
    title: "Filtered",
    href: "/filtered",
    icon: ListFilter,
    phase: 2,
    description: "Items your filter rules archived, with one-click restore.",
    permission: { inbox: ["read"] },
  },
  {
    title: "Analytics",
    href: "/analytics",
    icon: BarChart3,
    phase: 10,
    description: "Response times, volume per platform and rating trends.",
  },
]

export const NAV_MANAGE: NavItem[] = [
  {
    title: "Filters",
    href: "/filters",
    icon: Filter,
    phase: 2,
    description: "Rules that decide what the team never needs to see.",
    permission: { filter: ["manage"] },
  },
  {
    title: "Connections",
    href: "/connections",
    icon: Plug,
    phase: 4,
    description: "Connect Google Business, Facebook, Instagram, YouTube and LinkedIn.",
    permission: { connection: ["read"] },
  },
  {
    title: "Activity log",
    href: "/activity",
    icon: Activity,
    phase: 3,
    description: "Webhook events, job failures and the audit log.",
    permission: { activity: ["read"] },
  },
  {
    title: "Members",
    href: "/members",
    icon: Users,
    phase: 11,
    description: "Who can sign in, their role, and which platforms and controls they can use.",
    permission: { member: ["update"] },
  },
  {
    title: "Settings",
    href: "/settings",
    icon: Settings,
    phase: 3,
    description: "Workspace, sync, AI replies, notifications and data.",
    permission: { settings: ["manage"] },
  },
]

export const ALL_NAV = [...NAV_MAIN, ...NAV_MANAGE]
