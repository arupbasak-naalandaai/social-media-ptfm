"use client"

import { useState } from "react"
import { ArrowRight, FlaskConical, Info, Loader2, Sparkles } from "lucide-react"
import {
  EVENT_KINDS,
  ITEM_TYPES,
  PLATFORMS,
  type Decision,
  type EventKind,
  type FilterRuleInput,
  type ItemType,
  type Platform,
  type RuleTestOutcome,
  type RuleTestResponse,
} from "@inbox/core"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { PlatformIcon, PLATFORM_LABELS } from "@/components/app/platform-icon"
import { PriorityBadge, TYPE_LABELS } from "@/components/app/item-badges"
import { ApiError } from "@/lib/api"
import { cn } from "cn"
import { SimpleSelect } from "./simple-select"
import { useTestRule } from "./use-filters"

const DECISION_STYLE: Record<Decision, string> = {
  show: "border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  archive: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  drop: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400",
}
const DECISION_LABEL: Record<Decision, string> = {
  show: "Inbox",
  archive: "Filtered",
  drop: "Dropped",
}

function Outcome({ o }: { o: RuleTestOutcome }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Badge variant="outline" className={DECISION_STYLE[o.decision]}>
        {DECISION_LABEL[o.decision]}
      </Badge>
      {o.decision !== "drop" ? <PriorityBadge priority={o.priority} /> : null}
    </span>
  )
}

type Mode = "sample" | "recent"

/** Runs the current draft against a pasted sample or the last 200 items. Read-only. */
export function TestPanel({
  getRule,
  ruleId,
  onIssues,
}: {
  /** Returns the validated draft, or null (and surfaces errors in the form). */
  getRule: () => FilterRuleInput | null
  ruleId: string | null
  onIssues: (issues: { conditionId?: string; message: string }[]) => void
}) {
  const [mode, setMode] = useState<Mode>("sample")
  const [text, setText] = useState("")
  const [platform, setPlatform] = useState<Platform>("instagram")
  const [type, setType] = useState<ItemType>("comment")
  const [eventKind, setEventKind] = useState<EventKind>("created")
  const [rating, setRating] = useState<string>("5")
  const [handle, setHandle] = useState("")
  const [result, setResult] = useState<{ mode: Mode; data: RuleTestResponse } | null>(null)
  const test = useTestRule()

  const run = () => {
    const rule = getRule()
    if (!rule) return
    const base = { rule, ...(ruleId ? { ruleId } : {}) }
    const req =
      mode === "sample"
        ? {
            ...base,
            mode: "sample" as const,
            sample: {
              text,
              platform,
              type,
              eventKind,
              rating: type === "review" ? Number(rating) : null,
              authorHandle: handle.trim() || null,
            },
          }
        : { ...base, mode: "recent" as const }
    test.mutate(req, {
      onSuccess: (data) => setResult({ mode, data }),
      onError: (err) => {
        if (err instanceof ApiError) onIssues(err.issues)
      },
    })
  }

  return (
    <section
      className="flex flex-col gap-3 rounded-xl border bg-muted/20 p-3"
      aria-labelledby="test-panel-title"
    >
      <div className="flex items-center gap-2">
        <FlaskConical className="size-4 text-muted-foreground" />
        <h3 id="test-panel-title" className="font-medium">
          Test this rule
        </h3>
      </div>
      <p className="text-xs text-muted-foreground">
        Runs your unsaved draft. Nothing is changed by a test.
      </p>

      <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
        <TabsList className="w-full">
          <TabsTrigger value="sample">Sample</TabsTrigger>
          <TabsTrigger value="recent">Last 200 items</TabsTrigger>
        </TabsList>
      </Tabs>

      {mode === "sample" ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor="test-sample-text">Sample text</Label>
          <Textarea
            id="test-sample-text"
            rows={3}
            placeholder="Paste a comment, review or message…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="grid grid-cols-2 gap-2">
            <SimpleSelect
              aria-label="Sample platform"
              value={platform}
              options={PLATFORMS.map((p) => ({
                value: p,
                label: (
                  <span className="flex items-center gap-1.5">
                    <PlatformIcon platform={p} title={false} className="size-4" />{" "}
                    {PLATFORM_LABELS[p]}
                  </span>
                ),
              }))}
              onChange={setPlatform}
            />
            <SimpleSelect
              aria-label="Sample type"
              value={type}
              options={ITEM_TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] }))}
              onChange={setType}
            />
            <SimpleSelect
              aria-label="Sample event kind"
              value={eventKind}
              options={EVENT_KINDS.map((k) => ({ value: k, label: k }))}
              onChange={setEventKind}
            />
            {type === "review" ? (
              <SimpleSelect
                aria-label="Sample rating"
                value={rating}
                options={["1", "2", "3", "4", "5"].map((r) => ({ value: r, label: `${r} ★` }))}
                onChange={setRating}
              />
            ) : (
              <Input
                aria-label="Sample author handle"
                placeholder="author handle"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
              />
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Shows which of the 200 most recent stored items this rule matches, and where each would
          end up if you saved it.
        </p>
      )}

      <Button type="button" variant="secondary" onClick={run} disabled={test.isPending}>
        {test.isPending ? <Loader2 className="animate-spin" /> : <FlaskConical />}
        Run test
      </Button>

      {test.isError && !(test.error instanceof ApiError && test.error.issues.length > 0) ? (
        <p role="alert" className="text-sm text-destructive">
          {test.error.message}
        </p>
      ) : null}

      {result ? <Results mode={result.mode} data={result.data} /> : null}
    </section>
  )
}

function Results({ mode, data }: { mode: Mode; data: RuleTestResponse }) {
  const aiUnknown = data.rows.some((r) => r.aiUnknown)
  return (
    <div className="flex flex-col gap-2" aria-live="polite">
      <div className="flex flex-wrap gap-1.5 text-xs">
        <Badge variant="secondary">{data.matched} matched</Badge>
        <Badge variant="secondary">{data.wouldChange} would change</Badge>
        <Badge variant="outline">{data.total} tested</Badge>
      </div>
      {aiUnknown ? (
        <Alert>
          <Sparkles />
          <AlertDescription>
            This rule uses AI fields that aren’t available in a test, so results may differ once AI
            checks run.
          </AlertDescription>
        </Alert>
      ) : null}
      {mode === "recent" && data.rows.length === 0 ? (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Info className="size-4" /> No recent items match, and nothing would change.
        </p>
      ) : null}
      <ul className="flex max-h-96 flex-col gap-1.5 overflow-y-auto">
        {data.rows.map((row, i) => (
          <li key={row.item?.id ?? i} className="rounded-lg border bg-background p-2 text-sm">
            <div className="flex items-center gap-2">
              <Badge
                variant="outline"
                className={cn(
                  row.matched
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    : "text-muted-foreground",
                )}
              >
                {row.matched ? "Matches" : "No match"}
              </Badge>
              {row.item ? (
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <PlatformIcon platform={row.item.platform} className="size-4" />
                  <span className="truncate">{row.item.authorName ?? "Unknown"}</span>
                  <span>· {TYPE_LABELS[row.item.type]}</span>
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">Sample</span>
              )}
            </div>
            {row.item?.text ? <p className="mt-1 line-clamp-2 text-xs">{row.item.text}</p> : null}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
              <Outcome o={row.before} />
              <ArrowRight className="size-3 text-muted-foreground" aria-label="would become" />
              <Outcome o={row.after} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
