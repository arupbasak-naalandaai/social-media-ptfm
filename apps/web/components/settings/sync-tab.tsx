"use client"

import { useEffect, useState } from "react"
import { CircleAlert, CirclePause, Loader2, Play, RefreshCw } from "lucide-react"
import { Controller, useWatch } from "react-hook-form"
import {
  SYNC_MODE_LABELS,
  SYNC_STREAMS,
  SYNC_STREAM_KEYS,
  YOUTUBE_QUOTA_BLOCK_RATIO,
  estimateYoutubeDailyUnits,
  type SettingsResponse,
  type SyncStateDto,
} from "@inbox/core"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { PlatformIcon } from "@/components/app/platform-icon"
import { SimpleSelect } from "@/components/filters/simple-select"
import { absoluteTime, relativeTime } from "@/lib/format"
import { cn } from "cn"
import {
  SectionFormShell,
  SettingsCard,
  SwitchField,
  TextField,
  useSectionForm,
} from "./section-form"
import { useRunSync, useSyncStatus } from "./use-settings"

const fmt = (n: number) => n.toLocaleString("en-US")
const STREAM_NAME = { reviews: "Reviews", comments: "Comments", dms: "DMs" } as const

export function SyncTab({ data, canRun }: { data: SettingsResponse; canRun: boolean }) {
  const sf = useSectionForm("sync", data)
  const { control } = sf.form
  const [ytInterval, pagesPerPoll, dailyQuota] = useWatch({
    control,
    name: ["streams.yt_comments.intervalMinutes", "youtube.pagesPerPoll", "youtube.dailyQuota"],
  })

  return (
    <div className="flex flex-col gap-4">
      <SyncStatusCard canRun={canRun} />
      <SectionFormShell sf={sf}>
        <SettingsCard
          title="Schedules"
          description="How often each stream is checked. Webhook streams also reconcile on this interval to catch missed events. A new interval applies at the next scheduler tick (within 30 seconds), no restart needed."
        >
          <SwitchField
            control={control}
            name="paused"
            label="Pause all syncing"
            description="Stops scheduled and manual polling. Webhooks are still received and stored."
          />
          <div className="-mx-4 overflow-x-auto px-4">
            <Table className="min-w-140">
              <TableHeader>
                <TableRow>
                  <TableHead>Stream</TableHead>
                  <TableHead className="w-52">Mode</TableHead>
                  <TableHead className="w-40">Every</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {SYNC_STREAM_KEYS.map((key) => {
                  const def = SYNC_STREAMS[key]
                  return (
                    <TableRow key={key}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <PlatformIcon platform={def.platform} className="size-5" />
                          <div className="min-w-0">
                            <div className="font-medium">{def.label}</div>
                            <div className="text-xs text-muted-foreground">
                              Real time: {def.realtime}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Controller
                          control={control}
                          name={`streams.${key}.mode`}
                          render={({ field, fieldState }) => (
                            <>
                              <SimpleSelect
                                aria-label={`${def.label} mode`}
                                size="sm"
                                value={field.value ?? def.modes[0]}
                                onChange={field.onChange}
                                disabled={def.modes.length === 1}
                                invalid={fieldState.invalid}
                                options={def.modes.map((m) => ({
                                  value: m,
                                  label: SYNC_MODE_LABELS[m],
                                }))}
                              />
                              {fieldState.invalid ? (
                                <FieldError errors={[fieldState.error]} />
                              ) : null}
                            </>
                          )}
                        />
                      </TableCell>
                      <TableCell>
                        <Controller
                          control={control}
                          name={`streams.${key}.intervalMinutes`}
                          render={({ field, fieldState }) => (
                            <>
                              <div className="flex items-center gap-1.5">
                                <Input
                                  aria-label={`${def.label} interval in minutes`}
                                  type="number"
                                  inputMode="numeric"
                                  min={def.minMinutes}
                                  max={1440}
                                  className="h-7 w-20"
                                  aria-invalid={fieldState.invalid || undefined}
                                  name={field.name}
                                  ref={field.ref}
                                  onBlur={field.onBlur}
                                  value={field.value ?? ""}
                                  onChange={(e) =>
                                    field.onChange(
                                      e.target.value === "" ? undefined : Number(e.target.value),
                                    )
                                  }
                                />
                                <span className="text-xs text-muted-foreground">
                                  min (≥ {def.minMinutes})
                                </span>
                              </div>
                              {fieldState.invalid ? (
                                <FieldError className="text-xs" errors={[fieldState.error]} />
                              ) : null}
                            </>
                          )}
                        />
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </SettingsCard>

        <SettingsCard
          title="YouTube quota"
          description="YouTube has no webhooks, so comments are polled. Each poll costs quota; replies cost 50 units each."
        >
          <QuotaMeter
            estimated={estimateYoutubeDailyUnits({
              intervalMinutes: Number(ytInterval) || 0,
              channels: data.meta.youtubeChannels,
              pagesPerPoll: Number(pagesPerPoll) || 1,
            })}
            quota={Number(dailyQuota) || 0}
            channels={data.meta.youtubeChannels}
          />
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField
              control={control}
              name="youtube.dailyQuota"
              label="Daily quota"
              type="number"
              suffix="units"
              description="10,000 unless Google raised it for your project."
            />
            <TextField
              control={control}
              name="youtube.pagesPerPoll"
              label="Pages per poll"
              type="number"
              min={1}
              max={20}
              description="Comment pages fetched per channel per poll (100 threads a page)."
            />
          </div>
        </SettingsCard>

        <SettingsCard title="Other">
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField
              control={control}
              name="tokenRefreshHours"
              label="Check connection tokens every"
              type="number"
              min={1}
              max={24}
              suffix="hours"
            />
            <TextField
              control={control}
              name="backfillDays"
              label="First sync reaches back"
              type="number"
              min={1}
              max={60}
              suffix="days"
              description="For newly connected accounts."
            />
          </div>
        </SettingsCard>
      </SectionFormShell>
    </div>
  )
}

function QuotaMeter({
  estimated,
  quota,
  channels,
}: {
  estimated: number
  quota: number
  channels: number
}) {
  const ratio = quota > 0 ? estimated / quota : 0
  const blocked = ratio > YOUTUBE_QUOTA_BLOCK_RATIO
  const warn = ratio > 0.6
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span>
          Polling uses about <strong>{fmt(estimated)}</strong> of {fmt(quota)} units a day
        </span>
        <span className="text-muted-foreground">
          {channels === 0
            ? "No YouTube channels connected"
            : `${channels} channel${channels === 1 ? "" : "s"}`}
        </span>
      </div>
      <div
        role="meter"
        aria-label="Estimated YouTube quota use"
        aria-valuemin={0}
        aria-valuemax={quota}
        aria-valuenow={Math.min(estimated, quota)}
        className="relative h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            blocked ? "bg-destructive" : warn ? "bg-amber-500" : "bg-primary",
          )}
          style={{ width: `${Math.min(100, ratio * 100)}%` }}
        />
        <div
          className="absolute inset-y-0 w-px bg-foreground/40"
          style={{ left: `${YOUTUBE_QUOTA_BLOCK_RATIO * 100}%` }}
          aria-hidden
        />
      </div>
      {blocked ? (
        <p className="text-sm text-destructive">
          Over 90% of the quota, leaving too little for replies. Saving is blocked: use a longer
          YouTube interval or fewer pages per poll.
        </p>
      ) : null}
    </div>
  )
}

// ─── Live status ───────────────────────────────────────────────────────────────

/** Re-render every 30 s so "in 4 min" stays accurate. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

function StatusBadge({ s, now }: { s: SyncStateDto; now: number }) {
  if (s.running)
    return (
      <Badge variant="secondary" className="gap-1">
        <Loader2 className="size-3 animate-spin" />
        Running
      </Badge>
    )
  if (!s.scheduled) {
    const reason = !s.account.included
      ? "Account excluded"
      : s.mode === "webhook"
        ? "Webhook only"
        : s.account.status === "disconnected"
          ? "Disconnected"
          : "Paused"
    return (
      <Badge variant="outline" className="gap-1">
        <CirclePause className="size-3" />
        {reason}
      </Badge>
    )
  }
  if (s.consecutiveFailures > 0)
    return (
      <Tooltip>
        <TooltipTrigger render={<Badge variant="destructive" className="gap-1" />}>
          <CircleAlert className="size-3" />
          Failed{s.consecutiveFailures > 1 ? ` ×${s.consecutiveFailures}` : ""}
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{s.lastError ?? "Unknown error"}</TooltipContent>
      </Tooltip>
    )
  const due = new Date(s.nextRunAt).getTime() <= now
  return <Badge variant="outline">{due ? "Due" : "OK"}</Badge>
}

function SyncStatusCard({ canRun }: { canRun: boolean }) {
  const { data, isPending, isError, error, refetch, isFetching } = useSyncStatus()
  const run = useRunSync()
  const now = useNow()

  return (
    <SettingsCard
      title="Sync status"
      description="Every account stream and when it runs next. Updates live."
      action={
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Refresh sync status"
          onClick={() => void refetch()}
          disabled={isFetching}
        >
          <RefreshCw className={cn(isFetching && "animate-spin")} />
        </Button>
      }
    >
      {isPending ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : isError ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertDescription className="flex flex-wrap items-center gap-2">
            Couldn’t load the sync status: {error.message}
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : data.states.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No accounts yet. Schedules appear here once you connect an account on the Connections
          page.
        </p>
      ) : (
        <>
          {data.paused ? (
            <Alert>
              <CirclePause />
              <AlertDescription>
                Syncing is paused for this workspace. Turn it back on under Schedules below.
              </AlertDescription>
            </Alert>
          ) : null}
          {data.states.some((s) => s.account.demo) ? (
            <p className="text-xs text-muted-foreground">
              Demo accounts from the seed data run on schedule but fetch nothing.
            </p>
          ) : null}
          <div className="-mx-4 overflow-x-auto px-4">
            <Table className="min-w-160">
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Stream</TableHead>
                  <TableHead>Last run</TableHead>
                  <TableHead>Next run</TableHead>
                  <TableHead>Status</TableHead>
                  {canRun ? <TableHead className="w-10" /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.states.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <div className="flex min-w-0 items-center gap-2">
                        <PlatformIcon platform={s.account.platform} className="size-5" />
                        <span className="truncate">{s.account.displayName}</span>
                        {s.account.demo ? (
                          <Badge variant="outline" className="text-[10px]">
                            Demo
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {STREAM_NAME[SYNC_STREAMS[s.stream].stream]}
                      <span className="block text-xs">
                        {SYNC_MODE_LABELS[s.mode]} · every {Math.round(s.intervalSeconds / 60)} min
                      </span>
                    </TableCell>
                    <TableCell>
                      {s.lastRunAt ? (
                        <time dateTime={s.lastRunAt} title={absoluteTime(s.lastRunAt)}>
                          {relativeTime(s.lastRunAt, now)}
                        </time>
                      ) : (
                        <span className="text-muted-foreground">Never</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {s.scheduled ? (
                        <time dateTime={s.nextRunAt} title={absoluteTime(s.nextRunAt)}>
                          {new Date(s.nextRunAt).getTime() <= now
                            ? "Now"
                            : relativeTime(s.nextRunAt, now)}
                        </time>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <StatusBadge s={s} now={now} />
                    </TableCell>
                    {canRun ? (
                      <TableCell className="text-right">
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="icon-sm"
                                variant="outline"
                                aria-label={`Run now: ${s.account.displayName}, ${SYNC_STREAMS[s.stream].label}`}
                                disabled={
                                  s.running ||
                                  data.paused ||
                                  (s.account.status === "disconnected" && !s.account.demo) ||
                                  (run.isPending && run.variables === s.id)
                                }
                                onClick={() => run.mutate(s.id)}
                              />
                            }
                          >
                            <Play />
                          </TooltipTrigger>
                          <TooltipContent>Run now</TooltipContent>
                        </Tooltip>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </SettingsCard>
  )
}
