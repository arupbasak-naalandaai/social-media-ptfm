"use client"

import { Suspense, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  ExternalLink,
  Loader2,
  Lock,
  Play,
  Plug,
  PlugZap,
  RefreshCw,
  TriangleAlert,
  Unplug,
} from "lucide-react"
import { toast } from "sonner"
import type {
  ConnectionDto,
  ConnectionStreamDto,
  ConnectionsResponse,
  Platform,
  WebhookHealthDto,
} from "@inbox/core"
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
import { useCan, usePlatforms } from "@/components/app/me-context"
import { PlatformIcon, PLATFORM_LABELS } from "@/components/app/platform-icon"
import { CopyField } from "@/components/settings/secret-field"
import { useNow } from "@/components/settings/sync-tab"
import { useRunSync } from "@/components/settings/use-settings"
import { api } from "@/lib/api"
import { absoluteTime, relativeTime } from "@/lib/format"
import { qk } from "@/lib/query-keys"
import { cn } from "@/lib/utils"

type ProviderKey = "google" | "meta" | "youtube" | "linkedin"

interface Provider {
  key: ProviderKey
  title: string
  platforms: Platform[]
  description: string
  /** Not built yet: the phase it arrives in. */
  phase?: number
  startUrl?: string
  /** Disconnect dialog: where the grant itself is removed. */
  revokeHint: string
  /** What one connected thing is called, for the result toast. */
  noun: [string, string]
  emptyHint: string
}

const PROVIDERS: Provider[] = [
  {
    key: "google",
    title: "Google Business Profile",
    platforms: ["google_business"],
    description:
      "Reviews for every location you manage. Sign in with a Google account that owns or manages them.",
    startUrl: "/api/oauth/google/start",
    revokeHint: "your Google account (Security → Third-party access)",
    noun: ["location", "locations"],
    emptyHint: "Check that this Google account manages a Business Profile.",
  },
  {
    key: "meta",
    title: "Facebook & Instagram",
    platforms: ["facebook", "instagram"],
    description:
      "Comments and DMs for your Facebook Pages and the Instagram professional accounts linked to them, through one Meta app.",
    startUrl: "/api/oauth/meta/start",
    revokeHint: "Facebook (Settings → Business integrations)",
    noun: ["account", "accounts"],
    emptyHint: "Pick your Pages (and their Instagram accounts) on the Facebook dialog.",
  },
  {
    key: "youtube",
    title: "YouTube",
    platforms: ["youtube"],
    description:
      "Comments on your channel’s videos (polling: YouTube has no push for comments). Uses the Google OAuth client.",
    startUrl: "/api/oauth/youtube/start",
    revokeHint: "your Google account (Security → Third-party access)",
    noun: ["channel", "channels"],
    emptyHint: "For a brand channel, choose it on Google’s account picker.",
  },
  {
    key: "linkedin",
    title: "LinkedIn Company Page",
    platforms: ["linkedin"],
    description:
      "Comments on your Company Page’s posts, through your LinkedIn app (needs Community Management API access).",
    startUrl: "/api/oauth/linkedin/start",
    revokeHint: "LinkedIn (Settings → Data privacy → Permitted services)",
    noun: ["page", "pages"],
    emptyHint: "Sign in as a super admin of the Company Page.",
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
  const canView = useCan({ connection: ["read"] })
  const canManage = useCan({ connection: ["manage"] })
  const platforms = usePlatforms()
  if (!canView) {
    return (
      <EmptyState
        icon={Lock}
        title="You don’t have access"
        description="Ask an owner or admin to connect or change platform accounts."
      />
    )
  }
  return <ConnectionsContent canManage={canManage} platforms={platforms} />
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
      const p = PROVIDERS.find((x) => x.key === connected) ?? PROVIDERS[0]!
      const count = Number(params.get("count") ?? 0)
      toast.success(
        count > 0
          ? `Connected ${count} ${p.noun[count === 1 ? 0 : 1]}`
          : `Connected, but no ${p.noun[1]} were found`,
        { description: count > 0 ? "The first sync starts within 30 seconds." : p.emptyHint },
      )
    }
    if (warning) toast.warning("Connected with a note", { description: warning, duration: 20_000 })
    router.replace(pathname, { scroll: false })
  }, [params, router, pathname])
}

function ConnectionsContent({
  canManage,
  platforms,
}: {
  canManage: boolean
  /** Platforms this member can see; providers outside them are hidden. */
  platforms: Platform[]
}) {
  useOAuthResult()
  const qc = useQueryClient()
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: qk.connections,
    queryFn: () => api<ConnectionsResponse>("/connections"),
    // Webhook health changes without a sync event; keep it reasonably fresh.
    refetchInterval: 30_000,
  })
  const [toDisconnect, setToDisconnect] = useState<{
    account: ConnectionDto
    provider: Provider
  } | null>(null)

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
  const run = useRunSync()

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
      <Overview data={data} />
      {PROVIDERS.filter((p) => p.platforms.some((pl) => platforms.includes(pl))).map((p) => {
        const accounts = data.accounts.filter((a) => p.platforms.includes(a.platform))
        const configured = data.configured[p.key]
        // Connecting brings in every platform of the provider (Meta: Facebook + Instagram).
        const canConnect = canManage && p.platforms.every((pl) => platforms.includes(pl))
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
                {p.phase ? (
                  <Badge variant="outline">Coming in phase {p.phase}</Badge>
                ) : !canConnect ? null : configured ? (
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
                      Add the app credentials in Settings first
                    </Link>
                  </>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {canManage ? (
                <SetupChecklist
                  provider={p.key}
                  data={data}
                  defaultOpen={!configured || !hasReal}
                />
              ) : null}
              {accounts.length ? (
                <ul className="divide-y rounded-lg border">
                  {accounts.map((a) => (
                    <AccountRow
                      key={a.id}
                      account={a}
                      canManage={canManage}
                      reconnectUrl={configured && canConnect ? p.startUrl : undefined}
                      onInclude={(included) => patch.mutate({ id: a.id, included })}
                      onTest={() => test.mutate(a.id)}
                      testing={test.isPending && test.variables === a.id}
                      onRun={(id) => run.mutate(id)}
                      running={run.isPending ? run.variables : null}
                      onDisconnect={() => setToDisconnect({ account: a, provider: p })}
                    />
                  ))}
                </ul>
              ) : null}
            </CardContent>
          </Card>
        )
      })}

      <AlertDialog
        open={toDisconnect !== null}
        onOpenChange={(open) => (open ? undefined : setToDisconnect(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect “{toDisconnect?.account.displayName}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Syncing and replying stop and the stored access is deleted. Items already in the inbox
              stay. To revoke the app completely, also remove its access in{" "}
              {toDisconnect?.provider.revokeHint}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (toDisconnect) disconnect.mutate(toDisconnect.account.id)
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

// ─── Overview ──────────────────────────────────────────────────────────────────

/** One line per problem across all connections, so nothing needs hunting for. */
function Overview({ data }: { data: ConnectionsResponse }) {
  const real = data.accounts.filter((a) => !a.demo)
  const problems: string[] = []
  for (const a of real) {
    if (a.status === "error") problems.push(`${a.displayName}: ${a.lastError ?? "needs attention"}`)
    else if (a.status === "expiring") problems.push(`${a.displayName}: access expires soon`)
    for (const s of a.streams) {
      if (a.included && s.consecutiveFailures > 0 && a.status !== "error")
        problems.push(`${a.displayName} · ${s.label}: ${s.lastError ?? "last sync failed"}`)
    }
  }
  if (data.webhooks.meta.invalidLast24h > 0)
    problems.push(
      `${data.webhooks.meta.invalidLast24h} Meta webhook deliveries failed the signature check in the last 24 h (check the app secret).`,
    )
  if (data.webhooks.google.invalidLast24h > 0)
    problems.push(
      `${data.webhooks.google.invalidLast24h} Google pushes failed verification in the last 24 h.`,
    )

  const connected = real.filter((a) => a.status !== "disconnected")
  const syncing = connected.filter((a) => a.included).length
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span>
            <span className="font-medium tabular-nums">{connected.length}</span> connected
          </span>
          <span>
            <span className="font-medium tabular-nums">{syncing}</span> syncing
          </span>
          <span className={cn(problems.length ? "text-destructive" : "text-muted-foreground")}>
            <span className="font-medium tabular-nums">{problems.length}</span>{" "}
            {problems.length === 1 ? "problem" : "problems"}
          </span>
          {!data.setup.publicUrlReachable ? (
            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
              <TriangleAlert className="size-3.5" />
              No public API URL: webhooks can’t reach this machine (polling still works)
            </span>
          ) : null}
        </div>
        {problems.length ? (
          <ul className="space-y-0.5 text-xs text-destructive">
            {problems.slice(0, 6).map((p) => (
              <li key={p} className="flex gap-1.5">
                <CircleAlert className="mt-0.5 size-3 shrink-0" />
                <span className="min-w-0 wrap-break-word">{p}</span>
              </li>
            ))}
            {problems.length > 6 ? <li>…and {problems.length - 6} more below</li> : null}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  )
}

// ─── Setup checklist ───────────────────────────────────────────────────────────

type CheckState = "ok" | "todo" | "warn" | "optional"

function CheckItem({
  state,
  title,
  children,
}: {
  state: CheckState
  title: React.ReactNode
  children?: React.ReactNode
}) {
  const Icon = state === "ok" ? CircleCheck : state === "warn" ? TriangleAlert : CircleDashed
  return (
    <li className="flex gap-2.5">
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          state === "ok" && "text-emerald-600 dark:text-emerald-400",
          state === "warn" && "text-amber-600 dark:text-amber-400",
          (state === "todo" || state === "optional") && "text-muted-foreground",
        )}
        aria-label={state === "ok" ? "Done" : state === "warn" ? "Check" : "To do"}
      />
      <div className="min-w-0 flex-1 space-y-2 text-sm">
        <div>
          {title}
          {state === "optional" ? (
            <span className="ml-1 text-xs text-muted-foreground">(optional)</span>
          ) : null}
        </div>
        {children}
      </div>
    </li>
  )
}

function webhookLine(h: WebhookHealthDto, what: string): { state: CheckState; text: string } {
  if (h.lastValidAt) {
    return {
      state: h.lastError ? "warn" : "ok",
      text: `Last ${what} ${relativeTime(h.lastValidAt)}${h.lastError ? `; last processing error: ${h.lastError}` : ""}`,
    }
  }
  if (h.lastReceivedAt) {
    return {
      state: "warn",
      text: `Deliveries arrive (last ${relativeTime(h.lastReceivedAt)}) but none passed verification.`,
    }
  }
  return { state: "todo", text: `No ${what} received yet.` }
}

function SetupChecklist({
  provider,
  data,
  defaultOpen,
}: {
  provider: ProviderKey
  data: ConnectionsResponse
  defaultOpen: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const { setup, configured, webhooks } = data
  const settingsLink = (
    <Link href="/settings?tab=connections" className="underline underline-offset-2">
      Settings → Connections
    </Link>
  )
  const items: React.ReactNode[] = []
  let done = 0
  let total = 0
  const add = (state: CheckState, node: React.ReactNode) => {
    if (state !== "optional") total++
    if (state === "ok") done++
    items.push(node)
  }

  if (provider === "meta") {
    const wh = webhookLine(webhooks.meta, "webhook")
    add(
      configured.meta ? "ok" : "todo",
      <CheckItem
        key="app"
        state={configured.meta ? "ok" : "todo"}
        title="Meta app ID and app secret"
      >
        <p className="text-xs text-muted-foreground">
          From developers.facebook.com → your app → App settings → Basic. Save them in{" "}
          {settingsLink}.
        </p>
      </CheckItem>,
    )
    add(
      "ok",
      <CheckItem key="redirect" state="ok" title="Facebook Login redirect URI">
        <CopyField
          label="Add to Facebook Login → Settings → Valid OAuth Redirect URIs"
          value={setup.redirectUris.meta}
        />
      </CheckItem>,
    )
    add(
      "ok",
      <CheckItem key="token" state="ok" title="Webhook verify token">
        {setup.metaVerifyToken.generated ? (
          <CopyField
            label="Paste in the Meta app’s webhook setup (generated for you)"
            value={setup.metaVerifyToken.generated}
          />
        ) : (
          <p className="text-xs text-muted-foreground">
            {setup.metaVerifyToken.custom ? (
              <>Using the token saved in {settingsLink}.</>
            ) : (
              "Generated automatically. An admin can copy it from here."
            )}
          </p>
        )}
      </CheckItem>,
    )
    add(
      wh.state,
      <CheckItem
        key="webhook"
        state={wh.state}
        title="Webhooks (Page: feed, messages, message_echoes · Instagram: comments, messages)"
      >
        <CopyField
          label="Callback URL (Meta app → Webhooks, for both Page and Instagram)"
          value={setup.webhookUrls.meta}
          description={
            setup.publicUrlReachable
              ? "Connecting a Page subscribes it automatically; Test re-subscribes it if needed."
              : "Needs a public HTTPS API URL (API_PUBLIC_URL). Until then, comments and DMs arrive on the reconcile schedule."
          }
        />
        <p className="text-xs text-muted-foreground">{wh.text}</p>
      </CheckItem>,
    )
    add(
      "optional",
      <CheckItem key="review" state="optional" title="App Review (Advanced Access)">
        <p className="text-xs text-muted-foreground">
          Without it, only people with a role on the Meta app can be connected, and Instagram
          comment webhooks don’t fire. Request the permissions the Connect dialog asks for.
        </p>
      </CheckItem>,
    )
  } else if (provider === "linkedin") {
    const wh = webhookLine(webhooks.linkedin, "webhook")
    add(
      configured.linkedin ? "ok" : "todo",
      <CheckItem
        key="app"
        state={configured.linkedin ? "ok" : "todo"}
        title="LinkedIn app client ID and client secret"
      >
        <p className="text-xs text-muted-foreground">
          From linkedin.com/developers → your app → Auth. Use a new app with only the Community
          Management API product. Save them in {settingsLink}.
        </p>
      </CheckItem>,
    )
    add(
      "ok",
      <CheckItem key="redirect" state="ok" title="Authorized redirect URL">
        <CopyField
          label="Add to the app’s Auth tab → Authorized redirect URLs"
          value={setup.redirectUris.linkedin}
        />
      </CheckItem>,
    )
    add(
      "optional",
      <CheckItem key="access" state="optional" title="Community Management API access approved">
        <p className="text-xs text-muted-foreground">
          Needs a registered legal entity and a Page super admin to verify the app. The Development
          tier allows 500 calls a day; Standard needs a screencast.
        </p>
      </CheckItem>,
    )
    add(
      "optional",
      <CheckItem
        key="webhook"
        state={setup.linkedinAppIdSet && wh.state === "ok" ? "ok" : "optional"}
        title="Real-time comments via webhook"
      >
        <CopyField
          label="Webhook URL (app → Webhooks tab)"
          value={setup.webhookUrls.linkedin}
          description={
            !setup.publicUrlReachable
              ? "Needs a public HTTPS API URL (LinkedIn doesn’t accept ngrok). Until then, comments arrive on the reconcile schedule."
              : setup.linkedinAppIdSet
                ? "Connecting a Page subscribes it automatically."
                : "Also save the app ID (the digits in the app’s URL) in Settings → Connections, then reconnect, to subscribe Pages."
          }
        />
        <p className="text-xs text-muted-foreground">{wh.text}</p>
      </CheckItem>,
    )
  } else {
    const isYoutube = provider === "youtube"
    add(
      configured.google ? "ok" : "todo",
      <CheckItem
        key="client"
        state={configured.google ? "ok" : "todo"}
        title="Google OAuth client (Web application)"
      >
        <p className="text-xs text-muted-foreground">
          {setup.googleClient === "sign-in" ? (
            <>
              Using the sign-in client (<code>GOOGLE_CLIENT_ID</code>). Nothing to enter: enable the
              API in that Google Cloud project and add the redirect URI below.
            </>
          ) : setup.googleClient === "settings" ? (
            <>Using the client saved in {settingsLink}.</>
          ) : (
            <>
              Set <code>GOOGLE_CLIENT_ID</code> / <code>GOOGLE_CLIENT_SECRET</code> (the sign-in
              client covers this too), or save a separate client in {settingsLink}.
            </>
          )}{" "}
          Publish the OAuth app: in “Testing”, access expires after 7 days.
        </p>
      </CheckItem>,
    )
    add(
      "ok",
      <CheckItem key="redirect" state="ok" title="Authorized redirect URI">
        <CopyField
          label="Add to the OAuth client (the same URI as Google sign-in)"
          value={setup.redirectUris.google}
        />
      </CheckItem>,
    )
    if (isYoutube) {
      const quota = data.accounts
        .filter((a) => a.platform === "youtube" && !a.demo)
        .reduce((sum, a) => sum + a.streams.reduce((s, x) => s + x.quotaUsedToday, 0), 0)
      add(
        "optional",
        <CheckItem key="api" state="optional" title="YouTube Data API v3 enabled in the project">
          <p className="text-xs text-muted-foreground">
            Quota used today: <span className="tabular-nums">{quota.toLocaleString()}</span> units
            (polls 1 unit/page, replies 50). The meter and limits are under{" "}
            <Link href="/settings?tab=sync" className="underline underline-offset-2">
              Settings → Sync
            </Link>
            .
          </p>
        </CheckItem>,
      )
    } else {
      const wh = webhookLine(webhooks.google, "push")
      add(
        "optional",
        <CheckItem
          key="pubsub"
          state={setup.googlePubsubTopicSet ? (wh.state === "ok" ? "ok" : "optional") : "optional"}
          title="Real-time reviews via Pub/Sub"
        >
          <CopyField
            label="Push endpoint (Pub/Sub push subscription, OIDC auth)"
            value={setup.webhookUrls.google}
          />
          <p className="text-xs text-muted-foreground">
            {setup.googlePubsubTopicSet
              ? wh.text
              : "No topic set: reviews arrive on the reconcile schedule."}
          </p>
        </CheckItem>,
      )
      add(
        "optional",
        <CheckItem key="access" state="optional" title="Business Profile API access approved">
          <p className="text-xs text-muted-foreground">
            Quota is 0 until Google approves the access form. Test shows a quota error until then.
          </p>
        </CheckItem>,
      )
    }
  }

  return (
    <div className="rounded-lg border bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
      >
        <ChevronDown
          className={cn("size-4 shrink-0 transition-transform", !open && "-rotate-90")}
        />
        <span className="font-medium">Setup</span>
        <span
          className={cn(
            "text-xs tabular-nums",
            done === total ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
          )}
        >
          {done}/{total} done
        </span>
      </button>
      {open ? <ul className="space-y-4 border-t px-3 py-3">{items}</ul> : null}
    </div>
  )
}

// ─── Accounts ──────────────────────────────────────────────────────────────────

function StreamLine({
  stream: s,
  included,
  canRun,
  onRun,
  running,
}: {
  stream: ConnectionStreamDto
  included: boolean
  canRun: boolean
  onRun: () => void
  running: boolean
}) {
  const now = useNow()
  const failing = s.consecutiveFailures > 0
  const due = new Date(s.nextRunAt).getTime() <= now
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          !included
            ? "bg-muted-foreground/40"
            : failing
              ? "bg-destructive"
              : s.lastSuccessAt
                ? "bg-emerald-500"
                : "bg-amber-500",
        )}
        aria-hidden
      />
      <span className="font-medium">{s.label}</span>
      <span className="text-muted-foreground">
        {s.lastSuccessAt ? (
          <span title={absoluteTime(s.lastSuccessAt)}>
            synced {relativeTime(s.lastSuccessAt, now)}
          </span>
        ) : (
          "never synced"
        )}
        {included ? (
          <>
            {" · "}
            <span title={absoluteTime(s.nextRunAt)}>
              {due ? "due now" : `next ${relativeTime(s.nextRunAt, now)}`}
            </span>
          </>
        ) : (
          " · paused (not synced)"
        )}
        {s.key === "yt_comments" && s.quotaUsedToday ? ` · ${s.quotaUsedToday} units today` : ""}
      </span>
      {included && canRun ? (
        <Button
          size="xs"
          variant="ghost"
          className="px-1.5"
          onClick={onRun}
          disabled={running}
          aria-label={`Sync ${s.label} now`}
        >
          {running ? <Loader2 className="animate-spin" /> : <Play />}
          Sync now
        </Button>
      ) : null}
      {failing && s.lastError ? (
        <span className="w-full pl-3.5 text-destructive">
          Failed {s.consecutiveFailures}× in a row: {s.lastError}
        </span>
      ) : null}
    </li>
  )
}

function AccountRow({
  account: a,
  canManage,
  reconnectUrl,
  onInclude,
  onTest,
  testing,
  onRun,
  running,
  onDisconnect,
}: {
  account: ConnectionDto
  canManage: boolean
  reconnectUrl: string | undefined
  onInclude: (included: boolean) => void
  onTest: () => void
  testing: boolean
  onRun: (syncStateId: string) => void
  running: string | null | undefined
  onDisconnect: () => void
}) {
  const status = STATUS[a.status]
  const switchId = `include-${a.id}`
  return (
    <li className="space-y-2 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {a.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- remote avatars, any host
          <img
            src={a.avatarUrl}
            alt=""
            referrerPolicy="no-referrer"
            className="size-6 shrink-0 rounded-full object-cover"
          />
        ) : (
          <PlatformIcon platform={a.platform} className="size-5 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            {a.avatarUrl ? <PlatformIcon platform={a.platform} className="size-3.5" /> : null}
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
            disabled={!canManage}
            onCheckedChange={onInclude}
            aria-label={`Sync ${a.displayName}`}
          />
          <label htmlFor={switchId} className="text-xs text-muted-foreground">
            Sync
          </label>
        </div>
        {!a.demo && canManage ? (
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
            ) : null}
            {a.status !== "disconnected" ? (
              <Button size="sm" variant="ghost" onClick={onTest} disabled={testing}>
                {testing ? <Loader2 className="animate-spin" /> : <PlugZap />}
                Test
              </Button>
            ) : null}
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
      </div>
      {a.streams.length && (a.demo || a.status !== "disconnected") ? (
        <ul className="space-y-1 pl-9">
          {a.streams.map((s) => (
            <StreamLine
              key={s.syncStateId}
              stream={s}
              included={a.included}
              canRun={canManage}
              onRun={() => onRun(s.syncStateId)}
              running={running === s.syncStateId}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}
