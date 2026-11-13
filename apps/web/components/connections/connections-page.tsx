"use client"

import { Suspense, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  CircleAlert,
  ExternalLink,
  Lock,
  Loader2,
  Plug,
  PlugZap,
  RefreshCw,
  Unplug,
} from "lucide-react"
import { toast } from "sonner"
import type { ConnectionDto, ConnectionsResponse, Platform } from "@inbox/core"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { EmptyState } from "@/components/app/empty-state"
import { useIsAdmin } from "@/components/app/me-context"
import { PlatformIcon, PLATFORM_LABELS } from "@/components/app/platform-icon"
import { api } from "@/lib/api"
import { relativeTime } from "@/lib/format"
import { qk } from "@/lib/query-keys"

interface Provider {
  key: string
  title: string
  platforms: Platform[]
  description: string
  /** Built in this phase; others show when they arrive. */
  phase: number | null
  startUrl?: string
  configuredKey?: keyof ConnectionsResponse["configured"]
}

const PROVIDERS: Provider[] = [
  {
    key: "google",
    title: "Google Business Profile",
    platforms: ["google_business"],
    description:
      "Reviews for every location you manage. Sign in with a Google account that owns or manages them.",
    phase: null,
    startUrl: "/api/oauth/google/start",
    configuredKey: "google",
  },
  {
    key: "meta",
    title: "Facebook & Instagram",
    platforms: ["facebook", "instagram"],
    description: "Page and Instagram business account comments and DMs, through one Meta app.",
    phase: 5,
  },
  {
    key: "youtube",
    title: "YouTube",
    platforms: ["youtube"],
    description: "Comments on your channel’s videos.",
    phase: 6,
  },
  {
    key: "linkedin",
    title: "LinkedIn Company Page",
    platforms: ["linkedin"],
    description: "Comments on your organization’s posts (needs LinkedIn API approval).",
    phase: 9,
  },
]

const STATUS: Record<
  ConnectionDto["status"],
  { label: string; variant: "outline" | "secondary" | "destructive" }
> = {
  connected: { label: "Connected", variant: "outline" },
  expiring: { label: "Expiring", variant: "secondary" },
  error: { label: "Needs attention", variant: "destructive" },
  disconnected: { label: "Disconnected", variant: "outline" },
}

export function ConnectionsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
      <ConnectionsGate />
    </Suspense>
  )
}

function ConnectionsGate() {
  const isAdmin = useIsAdmin()
  if (!isAdmin) {
    return (
      <EmptyState
        icon={Lock}
        title="Owners and admins only"
        description="Ask an owner or admin to connect or change platform accounts."
      />
    )
  }
  return <ConnectionsContent />
}

/** Shows the result of an OAuth round trip (?connected / ?error / ?warning) once. */
function useOAuthResult() {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const shown = useRef(false)
  useEffect(() => {
    if (shown.current) return
    const connected = params.get("connected")
    const error = params.get("error")
    const warning = params.get("warning")
    if (!connected && !error) return
    shown.current = true
    if (error) toast.error("Couldn’t connect", { description: error, duration: 15_000 })
    if (connected) {
      const count = Number(params.get("count") ?? 0)
      toast.success(
        count > 0
          ? `Connected ${count} location${count === 1 ? "" : "s"}`
          : "Connected, but no locations were found",
        {
          description:
            count > 0
              ? "The first sync starts within 30 seconds."
              : "Check that this Google account manages a Business Profile.",
        },
      )
    }
    if (warning) toast.warning("Connected with a note", { description: warning, duration: 20_000 })
    router.replace(pathname, { scroll: false })
  }, [params, router, pathname])
}

function ConnectionsContent() {
  useOAuthResult()
  const qc = useQueryClient()
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: qk.connections,
    queryFn: () => api<ConnectionsResponse>("/connections"),
  })
  const [toDisconnect, setToDisconnect] = useState<ConnectionDto | null>(null)

  const patch = useMutation({
    mutationFn: ({ id, included }: { id: string; included: boolean }) =>
      api(`/connections/${id}`, { method: "PATCH", body: { included } }),
    onMutate: async ({ id, included }) => {
      await qc.cancelQueries({ queryKey: qk.connections })
      const prev = qc.getQueryData<ConnectionsResponse>(qk.connections)
      qc.setQueryData<ConnectionsResponse>(qk.connections, (d) =>
        d ? { ...d, accounts: d.accounts.map((a) => (a.id === id ? { ...a, included } : a)) } : d,
      )
      return { prev }
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.connections, ctx.prev)
      toast.error("Couldn’t update", {
        description: err instanceof Error ? err.message : undefined,
      })
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.connections }),
  })
  const test = useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; message: string }>(`/connections/${id}/test`, { method: "POST" }),
    onSuccess: (r) =>
      r.ok
        ? toast.success(r.message)
        : toast.error("The connection doesn’t work", { description: r.message }),
    onError: (err) =>
      toast.error("Couldn’t test", { description: err instanceof Error ? err.message : undefined }),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.connections }),
  })
  const disconnect = useMutation({
    mutationFn: (id: string) => api(`/connections/${id}/disconnect`, { method: "POST" }),
    onSuccess: () => toast.success("Disconnected"),
    onError: (err) =>
      toast.error("Couldn’t disconnect", {
        description: err instanceof Error ? err.message : undefined,
      }),
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.connections }),
  })

  if (isPending) return <Skeleton className="mx-auto h-96 w-full max-w-5xl rounded-xl" />
  if (isError) {
    return (
      <Alert variant="destructive" className="mx-auto max-w-5xl">
        <CircleAlert />
        <AlertDescription className="flex flex-wrap items-center gap-2">
          Couldn’t load connections: {error.message}
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      {PROVIDERS.map((p) => {
        const accounts = data.accounts.filter((a) => p.platforms.includes(a.platform))
        const configured = p.configuredKey ? data.configured[p.configuredKey] : false
        const hasReal = accounts.some((a) => !a.demo)
        return (
          <Card key={p.key}>
            <CardHeader className="flex flex-wrap items-start gap-3">
              <div className="flex shrink-0 gap-1 pt-0.5">
                {p.platforms.map((pl) => (
                  <PlatformIcon key={pl} platform={pl} className="size-6" />
                ))}
              </div>
              <div className="min-w-0 flex-1 space-y-1">
                <CardTitle>{p.title}</CardTitle>
                <CardDescription>{p.description}</CardDescription>
              </div>
              <div className="flex w-full flex-col items-start gap-1 sm:w-auto sm:items-end">
                {p.phase !== null ? (
                  <Badge variant="outline">Coming in phase {p.phase}</Badge>
                ) : configured ? (
                  <Button nativeButton={false} render={<a href={p.startUrl} />}>
                    <Plug />
                    {hasReal ? "Connect more / reconnect" : "Connect"}
                  </Button>
                ) : (
                  <>
                    <Button disabled>
                      <Plug />
                      Connect
                    </Button>
                    <Link
                      href="/settings?tab=connections"
                      className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    >
                      Add your OAuth client in Settings first
                    </Link>
                  </>
                )}
              </div>
            </CardHeader>
            {accounts.length ? (
              <CardContent>
                <ul className="divide-y rounded-lg border">
                  {accounts.map((a) => (
                    <AccountRow
                      key={a.id}
                      account={a}
                      reconnectUrl={configured ? p.startUrl : undefined}
                      onInclude={(included) => patch.mutate({ id: a.id, included })}
                      onTest={() => test.mutate(a.id)}
                      testing={test.isPending && test.variables === a.id}
                      onDisconnect={() => setToDisconnect(a)}
                    />
                  ))}
                </ul>
              </CardContent>
            ) : null}
          </Card>
        )
      })}

      <AlertDialog
        open={toDisconnect !== null}
        onOpenChange={(open) => (open ? undefined : setToDisconnect(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect “{toDisconnect?.displayName}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Syncing and replying stop and the stored access is deleted. Items already in the inbox
              stay. To revoke the app completely, also remove its access in your Google account.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (toDisconnect) disconnect.mutate(toDisconnect.id)
                setToDisconnect(null)
              }}
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function AccountRow({
  account: a,
  reconnectUrl,
  onInclude,
  onTest,
  testing,
  onDisconnect,
}: {
  account: ConnectionDto
  reconnectUrl: string | undefined
  onInclude: (included: boolean) => void
  onTest: () => void
  testing: boolean
  onDisconnect: () => void
}) {
  const status = STATUS[a.status]
  const switchId = `include-${a.id}`
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
      <PlatformIcon platform={a.platform} className="size-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <span className="truncate font-medium">{a.displayName}</span>
          {a.demo ? (
            <Badge variant="outline" className="text-[10px]">
              Demo
            </Badge>
          ) : (
            <Badge variant={status.variant}>{status.label}</Badge>
          )}
          {a.url ? (
            <a
              href={a.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground"
              aria-label={`Open ${a.displayName} in ${PLATFORM_LABELS[a.platform]}`}
            >
              <ExternalLink className="size-3.5" />
            </a>
          ) : null}
        </div>
        <div className="text-xs text-muted-foreground">
          {a.demo
            ? "Seed data: syncs run but fetch nothing, and replies aren’t posted."
            : [a.parentName, `added ${relativeTime(a.createdAt)}`].filter(Boolean).join(" · ")}
        </div>
        {a.lastError && !a.demo ? (
          <p className="mt-1 text-xs text-destructive">{a.lastError}</p>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Switch
          id={switchId}
          checked={a.included}
          onCheckedChange={onInclude}
          aria-label={`Sync ${a.displayName}`}
        />
        <label htmlFor={switchId} className="text-xs text-muted-foreground">
          Sync
        </label>
      </div>
      {!a.demo ? (
        <div className="flex items-center gap-1">
          {a.status === "error" || a.status === "disconnected" ? (
            reconnectUrl ? (
              <Button
                size="sm"
                variant="outline"
                nativeButton={false}
                render={<a href={reconnectUrl} />}
              >
                <RefreshCw />
                Reconnect
              </Button>
            ) : null
          ) : (
            <Button size="sm" variant="ghost" onClick={onTest} disabled={testing}>
              {testing ? <Loader2 className="animate-spin" /> : <PlugZap />}
              Test
            </Button>
          )}
          {a.status !== "disconnected" ? (
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={onDisconnect}
              aria-label={`Disconnect ${a.displayName}`}
            >
              <Unplug />
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}
