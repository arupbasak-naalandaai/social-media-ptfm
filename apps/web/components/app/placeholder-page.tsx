"use client"

import { Suspense } from "react"
import { Lock } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "./empty-state"
import { useIsAdmin } from "./me-context"
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
  const isAdmin = useIsAdmin()
  const item = ALL_NAV.find((n) => n.href === href)
  if (!item) return null

  if (item.adminOnly && !isAdmin) {
    return (
      <EmptyState
        icon={Lock}
        title="Owners and admins only"
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
