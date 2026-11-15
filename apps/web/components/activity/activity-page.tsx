"use client"

import { Suspense, useState, type ReactNode } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import type { UseInfiniteQueryResult, InfiniteData } from "@tanstack/react-query"
import {
  ChevronRight,
  CircleAlert,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Webhook,
  Workflow,
} from "lucide-react"
import {
  JOB_STATES,
  QUEUES,
  type AuditEntryDto,
  type JobDto,
  type JobState,
  type Paged,
  type WebhookEventDto,
} from "@inbox/core"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { EmptyState } from "@/components/app/empty-state"
import { useCan } from "@/components/app/me-context"
import { SimpleSelect } from "@/components/filters/simple-select"
import { absoluteTime, relativeTime } from "@/lib/format"
import { cn } from "cn"
import { useAuditLog, useJobs, useReplayWebhook, useWebhookEvents } from "./use-activity"

type Tab = "audit" | "jobs" | "webhooks"
const TABS: Tab[] = ["audit", "jobs", "webhooks"]

export function ActivityPage() {
  return (
    <Suspense fallback={<RowsSkeleton />}>
      <ActivityContent />
    </Suspense>
  )
}

function ActivityContent() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const raw = params.get("tab")
  const tab: Tab = TABS.includes(raw as Tab) ? (raw as Tab) : "audit"
  const canReplay = useCan({ activity: ["replay"] })

  return (
    <Tabs
      value={tab}
      onValueChange={(v) => {
        const sp = new URLSearchParams(params)
        if (v === "audit") sp.delete("tab")
        else sp.set("tab", String(v))
        const qs = sp.toString()
        router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
      }}
      className="mx-auto w-full max-w-5xl gap-4"
    >
      <TabsList>
        <TabsTrigger value="audit">Audit log</TabsTrigger>
        <TabsTrigger value="jobs">Jobs</TabsTrigger>
        <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
      </TabsList>
      <TabsContent value="audit">
        <AuditTab />
      </TabsContent>
      <TabsContent value="jobs">
        <JobsTab />
      </TabsContent>
      <TabsContent value="webhooks">
        <WebhooksTab canReplay={canReplay} />
      </TabsContent>
    </Tabs>
  )
}

// ─── Shared list chrome ────────────────────────────────────────────────────────

function RowsSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-2">
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded-lg" />
      ))}
    </div>
  )
}

function PagedList<T>({
  query,
  toolbar,
  empty,
  renderRow,
}: {
  query: UseInfiniteQueryResult<InfiniteData<Paged<T>>>
  toolbar?: ReactNode
  empty: { icon: typeof History; title: string; description: string }
  renderRow: (row: T) => ReactNode
}) {
  const rows = query.data?.pages.flatMap((p) => p.entries) ?? []
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {toolbar}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          aria-label="Refresh"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCw className={cn(query.isFetching && "animate-spin")} />
        </Button>
      </div>
      {query.isPending ? (
        <RowsSkeleton />
      ) : query.isError ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription className="flex flex-wrap items-center gap-2">
            Couldn’t load this list: {query.error.message}
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : rows.length === 0 ? (
        <EmptyState {...empty} />
      ) : (
        <>
          <ul className="divide-y overflow-hidden rounded-xl border">{rows.map(renderRow)}</ul>
          {query.hasNextPage ? (
            <Button
              variant="outline"
              className="self-center"
              onClick={() => void query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
            >
              {query.isFetchingNextPage ? <Loader2 className="animate-spin" /> : null}
              Load more
            </Button>
          ) : null}
        </>
      )}
    </div>
  )
}

/** One expandable row: summary line, JSON details on open. */
function Row({
  summary,
  meta,
  badges,
  details,
  actions,
}: {
  summary: ReactNode
  meta: ReactNode
  badges?: ReactNode
  details: ReactNode
  actions?: ReactNode
}) {
  return (
    <li>
      <details className="group">
        <summary className="flex cursor-pointer list-none items-start gap-3 px-3 py-2.5 hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              {summary}
              {badges}
            </div>
            <div className="text-xs text-muted-foreground">{meta}</div>
          </div>
          {actions ? (
            // Buttons inside <summary> would toggle the row: stop that.
            <div className="shrink-0" onClick={(e) => e.preventDefault()}>
              {actions}
            </div>
          ) : null}
        </summary>
        <div className="flex flex-col gap-3 border-t bg-muted/30 px-3 py-3 pl-10">{details}</div>
      </details>
    </li>
  )
}

function Json({ label, value }: { label: string; value: unknown }) {
  if (value === null || value === undefined) return null
  if (typeof value === "object" && Object.keys(value as object).length === 0) return null
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-medium text-muted-foreground">{label}</div>
      <pre className="max-h-80 overflow-auto rounded-md bg-background p-2 font-mono text-xs leading-relaxed ring-1 ring-border">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  )
}

function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={absoluteTime(iso)}>
      {relativeTime(iso)}
    </time>
  )
}

// ─── Audit log ─────────────────────────────────────────────────────────────────

const SECTION_LABEL: Record<string, string> = {
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

function describeAudit(e: AuditEntryDto): string {
  switch (e.action) {
    case "settings.update":
      return `Changed ${SECTION_LABEL[e.entityId ?? ""] ?? e.entityId} settings`
    case "sync.run":
      return "Started a sync (Run now)"
    case "webhook.replay":
      return "Replayed a webhook delivery"
    case "filter_rule.create":
      return "Created a filter rule"
    case "filter_rule.update":
      return "Changed a filter rule"
    case "filter_rule.delete":
      return "Deleted a filter rule"
    case "filter_rule.reorder":
      return "Reordered filter rules"
    case "list_entry.create":
      return "Added a list entry"
    case "list_entry.delete":
      return "Removed a list entry"
    case "item.restore":
      return "Restored an item (Not spam)"
    case "item.hide_similar":
      return "Hid similar items"
    case "member.auto_join":
      return "Joined the workspace"
    case "organization.bootstrap":
      return "Became the first owner"
    default:
      return e.action
  }
}

const AUDIT_ENTITIES = [
  { value: "all", label: "Everything" },
  { value: "settings", label: "Settings" },
  { value: "filter_rule", label: "Filter rules" },
  { value: "list_entry", label: "Lists" },
  { value: "item", label: "Items" },
  { value: "sync_state", label: "Sync" },
  { value: "webhook_event", label: "Webhooks" },
] as const
type AuditEntity = (typeof AUDIT_ENTITIES)[number]["value"]

/** Name of the rule/entry touched, when the audit entry recorded one. */
function entityName(e: AuditEntryDto): string | null {
  for (const v of [e.after, e.before]) {
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>
      if (typeof o.name === "string") return o.name
      if (typeof o.value === "string") return o.value
    }
  }
  return null
}

function AuditTab() {
  const [entity, setEntity] = useState<AuditEntity>("all")
  const query = useAuditLog(entity === "all" ? undefined : entity)
  return (
    <PagedList
      query={query}
      toolbar={
        <SimpleSelect<AuditEntity>
          aria-label="Show"
          size="sm"
          className="w-40"
          value={entity}
          onChange={setEntity}
          options={AUDIT_ENTITIES.map((e) => ({ value: e.value, label: e.label }))}
        />
      }
      empty={{
        icon: History,
        title: "Nothing recorded yet",
        description:
          "Changes to settings, filters and lists, and other admin actions, show up here.",
      }}
      renderRow={(e) => {
        const name = entityName(e)
        return (
          <Row
            key={e.id}
            summary={
              <>
                <span className="font-medium">{e.actor?.name ?? e.actor?.email ?? "System"}</span>
                <span>{describeAudit(e)}</span>
                {name ? <span className="truncate text-muted-foreground">“{name}”</span> : null}
              </>
            }
            meta={
              <>
                <When iso={e.createdAt} />
                {e.actor?.email && e.actor.name ? ` · ${e.actor.email}` : null}
              </>
            }
            details={
              <div className="grid gap-3 md:grid-cols-2">
                <Json label="Before" value={e.before} />
                <Json label="After" value={e.after} />
                {e.before == null && e.after == null ? (
                  <p className="text-xs text-muted-foreground">No details recorded.</p>
                ) : null}
              </div>
            }
          />
        )
      }}
    />
  )
}

// ─── Jobs ──────────────────────────────────────────────────────────────────────

const STATE_STYLE: Record<JobState, "default" | "secondary" | "destructive" | "outline"> = {
  created: "outline",
  retry: "secondary",
  active: "secondary",
  completed: "outline",
  cancelled: "outline",
  failed: "destructive",
}
const QUEUE_LABEL: Record<string, string> = {
  ingest: "Ingest",
  filter: "Re-filter",
  "ai-draft": "AI draft",
  "notify-slack": "Slack",
  "send-reply": "Send reply",
  poll: "Sync",
  "token-refresh": "Token check",
  maintenance: "Clean-up",
}

function duration(job: JobDto): string | null {
  if (!job.startedOn || !job.completedOn) return null
  const ms = new Date(job.completedOn).getTime() - new Date(job.startedOn).getTime()
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

function JobsTab() {
  const [state, setState] = useState<JobState | "all">("all")
  const [queue, setQueue] = useState<string>("all")
  const query = useJobs(state === "all" ? undefined : state, queue === "all" ? undefined : queue)
  return (
    <PagedList
      query={query}
      toolbar={
        <>
          <SimpleSelect<JobState | "all">
            aria-label="State"
            size="sm"
            className="w-36"
            value={state}
            onChange={setState}
            options={[
              { value: "all", label: "Any state" },
              ...JOB_STATES.map((s) => ({ value: s, label: s[0]!.toUpperCase() + s.slice(1) })),
            ]}
          />
          <SimpleSelect<string>
            aria-label="Queue"
            size="sm"
            className="w-40"
            value={queue}
            onChange={setQueue}
            options={[
              { value: "all", label: "Every queue" },
              ...Object.values(QUEUES).map((q) => ({ value: q, label: QUEUE_LABEL[q] ?? q })),
            ]}
          />
        </>
      }
      empty={{
        icon: Workflow,
        title: "No background jobs",
        description:
          "Syncs, re-filters and clean-ups appear here once the worker runs them. Completed jobs are kept for a few days.",
      }}
      renderRow={(job) => {
        const out = job.output as { error?: string } | null
        const took = duration(job)
        return (
          <Row
            key={job.id}
            summary={
              <>
                <span className="font-medium">{QUEUE_LABEL[job.queue] ?? job.queue}</span>
                {typeof job.data.trigger === "string" ? (
                  <span className="text-muted-foreground">
                    {job.data.trigger === "manual" ? "Run now" : "Scheduled"}
                  </span>
                ) : null}
              </>
            }
            badges={
              <Badge variant={STATE_STYLE[job.state]} className="capitalize">
                {job.state}
              </Badge>
            }
            meta={
              <>
                <When iso={job.createdOn} />
                {took ? ` · took ${took}` : null}
                {job.retryCount > 0 ? ` · retry ${job.retryCount}/${job.retryLimit}` : null}
                {job.state === "failed" && out?.error ? (
                  <span className="mt-0.5 block truncate text-destructive">{out.error}</span>
                ) : null}
              </>
            }
            details={
              <div className="grid gap-3 md:grid-cols-2">
                <Json label="Data" value={job.data} />
                <Json label={job.state === "failed" ? "Error" : "Result"} value={job.output} />
              </div>
            }
          />
        )
      }}
    />
  )
}

// ─── Webhooks ──────────────────────────────────────────────────────────────────

function WebhooksTab({ canReplay }: { canReplay: boolean }) {
  const query = useWebhookEvents()
  const replay = useReplayWebhook()
  return (
    <PagedList
      query={query}
      empty={{
        icon: Webhook,
        title: "No webhook deliveries yet",
        description:
          "Events from Meta, Google and LinkedIn are listed here once a platform is connected and the app has a public URL.",
      }}
      renderRow={(e: WebhookEventDto) => (
        <Row
          key={e.id}
          summary={<span className="font-medium capitalize">{e.source}</span>}
          badges={
            <>
              {!e.signatureValid ? (
                <Badge variant="destructive" className="gap-1">
                  <ShieldAlert className="size-3" />
                  Bad signature
                </Badge>
              ) : e.error ? (
                <Badge variant="destructive">Failed</Badge>
              ) : e.processedAt ? (
                <Badge variant="outline">Processed</Badge>
              ) : (
                <Badge variant="secondary">Pending</Badge>
              )}
            </>
          }
          meta={
            <>
              <When iso={e.receivedAt} />
              {e.attempts > 1 ? ` · ${e.attempts} attempts` : null}
              {e.error ? (
                <span className="mt-0.5 block truncate text-destructive">{e.error}</span>
              ) : null}
            </>
          }
          actions={
            canReplay && e.signatureValid ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => replay.mutate(e.id)}
                disabled={replay.isPending && replay.variables === e.id}
              >
                <RotateCcw />
                Replay
              </Button>
            ) : null
          }
          details={
            <>
              {e.dedupeKey ? (
                <p className="text-xs text-muted-foreground">
                  Delivery ID <code>{e.dedupeKey}</code>
                </p>
              ) : null}
              <Json label="Payload" value={e.payload} />
            </>
          }
        />
      )}
    />
  )
}
