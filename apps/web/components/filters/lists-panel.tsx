"use client"

import { AlertTriangle } from "lucide-react"
import {
  LIST_KINDS_BY_LIST,
  LIST_NAMES,
  type ListEntryDto,
  type ListKind,
  type ListName,
} from "@inbox/core"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { TagInput } from "@/components/app/tag-input"
import { PLATFORM_LABELS } from "@/components/app/platform-icon"
import { KIND_LABELS, LIST_LABELS } from "./helpers"
import { useAddListEntry, useListEntries, useRemoveListEntry } from "./use-filters"

const LIST_DESCRIPTIONS: Record<ListName, string> = {
  blocklist:
    "Anything from these authors, or containing these keywords or link domains, is archived.",
  allowlist:
    "VIP customers and partners: always shown in the inbox at high priority, even if other rules would filter them.",
  spam_keywords: "Comments and DMs containing any of these phrases are archived as likely spam.",
  trusted_domains: "Links to these domains never count as spam links. Subdomains are included.",
}

const PLACEHOLDERS: Record<ListKind, string> = {
  author_handle: "@handle, press Enter",
  author_id: "platform user ID",
  keyword: "word or phrase",
  domain: "example.com",
}

function normalizer(kind: ListKind): (v: string) => string {
  switch (kind) {
    case "author_handle":
      return (v) => v.trim().replace(/^@/, "").toLowerCase()
    case "domain":
      return (v) =>
        v
          .trim()
          .replace(/^https?:\/\//, "")
          .replace(/^www\./, "")
          .replace(/\/.*$/, "")
          .toLowerCase()
    case "keyword":
      return (v) => v.trim().toLowerCase()
    case "author_id":
      return (v) => v.trim()
  }
}

/** Chip label: platform-scoped entries (e.g. from "Not spam") show their platform. */
function labelOf(e: ListEntryDto): string {
  return e.platform ? `${e.value} · ${PLATFORM_LABELS[e.platform]}` : e.value
}

function KindInput({
  list,
  kind,
  entries,
  canEdit,
}: {
  list: ListName
  kind: ListKind
  entries: ListEntryDto[]
  canEdit: boolean
}) {
  const add = useAddListEntry()
  const remove = useRemoveListEntry()
  const byLabel = new Map(entries.map((e) => [labelOf(e), e]))
  const id = `list-${list}-${kind}`

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {KIND_LABELS[kind]}
      </Label>
      <TagInput
        id={id}
        aria-label={`${LIST_LABELS[list]}: ${KIND_LABELS[kind]}`}
        value={entries.map(labelOf)}
        placeholder={canEdit ? PLACEHOLDERS[kind] : "None"}
        disabled={!canEdit}
        normalize={normalizer(kind)}
        onChange={(next) => {
          const nextSet = new Set(next)
          for (const [label, entry] of byLabel) {
            if (!nextSet.has(label) && !entry.id.startsWith("temp-")) remove.mutate(entry.id)
          }
          for (const value of next) {
            if (!byLabel.has(value)) add.mutate({ list, kind, value })
          }
        }}
      />
    </div>
  )
}

export function ListsPanel({ canEdit }: { canEdit: boolean }) {
  const lists = useListEntries()

  if (lists.isPending) {
    return (
      <div className="grid gap-4 md:grid-cols-2" aria-busy="true" aria-label="Loading lists">
        {LIST_NAMES.map((l) => (
          <Skeleton key={l} className="h-44 w-full rounded-xl" />
        ))}
      </div>
    )
  }
  if (lists.isError) {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>Couldn’t load lists</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-2">
          {lists.error.message}
          <Button size="sm" variant="outline" onClick={() => void lists.refetch()}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  const entries = lists.data.entries
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {LIST_NAMES.map((list) => (
        <Card key={list}>
          <CardHeader>
            <CardTitle>{LIST_LABELS[list]}</CardTitle>
            <CardDescription>{LIST_DESCRIPTIONS[list]}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {LIST_KINDS_BY_LIST[list].map((kind) => (
              <KindInput
                key={kind}
                list={list}
                kind={kind}
                canEdit={canEdit}
                entries={entries.filter((e) => e.list === list && e.kind === kind)}
              />
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
