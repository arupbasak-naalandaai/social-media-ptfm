"use client"

import { Suspense, useState } from "react"
import { Info } from "lucide-react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useIsAdmin } from "@/components/app/me-context"
import { ListsPanel } from "./lists-panel"
import { RulesList } from "./rules-list"

type Tab = "rules" | "lists"

export function FiltersPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
      <FiltersContent />
    </Suspense>
  )
}

function FiltersContent() {
  const canEdit = useIsAdmin()
  const [tab, setTab] = useState<Tab>("rules")

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      {!canEdit ? (
        <Alert>
          <Info />
          <AlertDescription>
            Only owners and admins can change filters. You’re viewing them read-only.
          </AlertDescription>
        </Alert>
      ) : null}
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="rules">Rules</TabsTrigger>
          <TabsTrigger value="lists">Lists</TabsTrigger>
        </TabsList>
        <TabsContent value="rules" className="pt-3">
          <RulesList canEdit={canEdit} />
        </TabsContent>
        <TabsContent value="lists" className="pt-3">
          <ListsPanel canEdit={canEdit} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
