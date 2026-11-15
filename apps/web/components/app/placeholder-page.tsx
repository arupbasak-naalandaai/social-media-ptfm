"use client"

import { Suspense } from "react"
import { Lock } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "./empty-state"
import { can } from "@inbox/core"
import { useMe } from "./me-context"
import { ALL_NAV } from "./nav"

/** Phase 1 shell: every section renders its empty state until its phase lands. */
export function PlaceholderPage({ href }: { href: string }) {
  return (
    <Suspense fallback={<Skeleton className="flex-1 rounded-xl" />}>
      <PlaceholderContent href={href} />
    </Suspense>
  )
}

function PlaceholderContent({ href }: { href: string }) {
  const { permissions } = useMe()
  const item = ALL_NAV.find((n) => n.href === href)
  if (!item) return null

  if (item.permission && !can(permissions, item.permission)) {
    return (
      <EmptyState
        icon={Lock}
        title="You don’t have access"
        description={`Ask an owner or admin if you need to change ${item.title.toLowerCase()}.`}
      />
    )
  }

  return (
    <EmptyState icon={item.icon} title={`${item.title} is empty`} description={item.description}>
      <Badge variant="outline">Coming in phase {item.phase}</Badge>
    </EmptyState>
  )
}
