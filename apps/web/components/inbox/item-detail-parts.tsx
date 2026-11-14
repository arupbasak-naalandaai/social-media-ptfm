"use client"

/**
 * Building blocks shared by the quick-preview sheet and the full item page.
 */
import { Suspense, useEffect, useRef, useState, type ReactNode } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import Link from "next/link"
import { toast } from "sonner"
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  CircleSlash,
  Clock,
  Copy,
  CornerDownLeft,
  ExternalLink,
  EyeOff,
  MessageSquareOff,
  Loader2,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  Undo2,
} from "lucide-react"
import {
  OPEN_STATUSES,
  PLATFORM_APP_NAMES,
  type ItemDetail,
  type ItemLink,
  type ItemStatus,
  type ReplyQueuedResponse,
  type ThreadEntry,
} from "@inbox/core"
import { useIsAdmin } from "@/components/app/me-context"
import { PLATFORM_LABELS } from "@/components/app/platform-icon"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Textarea } from "@/components/ui/textarea"
import { api } from "@/lib/api"
import { qk } from "@/lib/query-keys"
import { absoluteTime, relativeTime } from "@/lib/format"
import { cn } from "cn"
import type { RestoreTarget } from "./restore-dialog"
import type { ItemAction } from "./use-item-actions"

export function authorLabel(item: Pick<ItemDetail, "authorName" | "authorHandle">): string {
  return item.authorName ?? (item.authorHandle ? `@${item.authorHandle}` : "Unknown author")
}

export function isHiddenStatus(status: ItemStatus): boolean {
  return status === "filtered" || status === "archived"
}

export function isOpenStatus(status: ItemStatus): boolean {
  return (OPEN_STATUSES as readonly ItemStatus[]).includes(status)
}

export function Section({
  title,
  icon,
  action,
  children,
}: {
  title: string
  icon?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="space-y-2">
      <h3 className="flex items-center justify-between gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        <span className="flex items-center gap-1.5">
          {icon}
          {title}
        </span>
        {action ? <span className="font-normal tracking-normal normal-case">{action}</span> : null}
      </h3>
      {children}
    </section>
  )
}

// ─── Open in app ──────────────────────────────────────────────────────────────

export function OpenInAppButton({
  link,
  variant = "outline",
  size = "sm",
  iconOnly = false,
  className,
}: {
  link: ItemLink | null
  variant?: "outline" | "ghost" | "secondary" | "default"
  size?: "sm" | "default" | "icon-sm"
  iconOnly?: boolean
  className?: string
}) {
  if (!link) return null
  return (
    <Button
      variant={variant}
      size={iconOnly ? "icon-sm" : size}
      className={className}
      nativeButton={false}
      aria-label={iconOnly ? link.label : undefined}
      title={iconOnly ? link.label : undefined}
      render={<a href={link.url} target="_blank" rel="noreferrer" />}
    >
      <ExternalLink />
      {iconOnly ? null : link.label}
    </Button>
  )
}

// ─── Thread ───────────────────────────────────────────────────────────────────

export function placeholder(
  entry: Pick<ThreadEntry, "eventKind">,
  type: ItemDetail["type"],
): string {
  if (entry.eventKind === "story_mention") return "Mentioned you in their story"
  if (entry.eventKind === "story_reaction") return "Reacted to your story"
  if (entry.eventKind === "deleted") return "Deleted on the platform"
  return type === "review" ? "Rating only, no text" : "No text"
}

/**
 * The item and everything around it: earlier and later messages from the person, and the
 * replies we sent, oldest first. A lone item renders as plain text.
 */
export function ItemBody({
  item,
  now,
  large = false,
}: {
  item: ItemDetail
  now: number
  large?: boolean
}) {
  const entries = item.thread.length > 0 ? item.thread : []
  const lone = entries.length <= 1

  if (lone) {
    return (
      <p
        className={cn(
          "leading-relaxed break-words whitespace-pre-wrap",
          large ? "text-base" : "text-sm",
        )}
      >
        {item.text?.trim() || (
          <span className="text-muted-foreground italic">{placeholder(item, item.type)}</span>
        )}
      </p>
    )
  }

  return (
    <ol className="space-y-3" aria-label="Conversation">
      {entries.map((m, i) => {
        const current = m.kind === "item" && m.id === item.id
        const prev = entries[i - 1]
        const showName = !prev || prev.ours !== m.ours || prev.authorName !== m.authorName
        const hidden = !m.ours && isHiddenStatus(m.status as ItemStatus)
        return (
          <li
            key={`${m.kind}-${m.id}`}
            className={cn("flex flex-col gap-0.5", m.ours ? "items-end" : "items-start")}
          >
            {showName ? (
              <span className="px-1 text-[11px] font-medium text-muted-foreground">
                {m.ours ? `You (${m.authorName ?? "us"})` : (m.authorName ?? "Them")}
              </span>
            ) : null}
            <div
              className={cn(
                "max-w-[85%] rounded-2xl px-3 py-2 break-words whitespace-pre-wrap",
                large ? "text-[15px] leading-relaxed" : "text-sm",
                m.ours
                  ? "rounded-br-sm bg-primary text-primary-foreground"
                  : "rounded-bl-sm bg-muted",
                current && "ring-2 ring-primary/40 ring-offset-2 ring-offset-background",
                hidden && "opacity-60",
              )}
            >
              {m.text?.trim() || (
                <span className="italic opacity-70">{placeholder(m, item.type)}</span>
              )}
            </div>
            <span className="px-1 text-[11px] text-muted-foreground" title={absoluteTime(m.at)}>
              {relativeTime(m.at, now)}
              {hidden ? " · hidden by filters" : ""}
              {m.kind === "reply" && m.status !== "sent" ? ` · ${m.status}` : ""}
              {current && entries.length > 1 ? " · this message" : ""}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** Where the item lives, why it's hidden, and which rules matched it. */
export function ItemContext({ item }: { item: ItemDetail }) {
  const hidden = isHiddenStatus(item.status)
  return (
    <>
      {item.postUrl || item.postTitle ? (
        <Section title={item.type === "review" ? "Location" : "On post"}>
          {item.postUrl ? (
            <a
              href={item.postUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-primary underline-offset-4 hover:underline"
            >
              {item.postTitle ?? "View original"}
              <ExternalLink className="size-3.5" />
            </a>
          ) : (
            <span className="text-sm">{item.postTitle}</span>
          )}
        </Section>
      ) : null}

      {hidden && item.filterReason ? (
        <Alert>
          <EyeOff />
          <AlertTitle>Hidden from the inbox</AlertTitle>
          <AlertDescription>{item.filterReason}</AlertDescription>
        </Alert>
      ) : null}

      {item.matchedRules.length > 0 ? (
        <Section title="Matched rules">
          <div className="flex flex-wrap gap-1.5">
            {item.matchedRules.map((r) => (
              <Badge
                key={`${r.id}-${r.dryRun}`}
                variant="outline"
                className={cn(r.dryRun && "border-dashed text-muted-foreground")}
                render={<Link href="/filters" />}
              >
                {r.name}
                {r.dryRun ? " (dry run)" : ""}
              </Badge>
            ))}
          </div>
        </Section>
      ) : null}
    </>
  )
}

// ─── Actions ──────────────────────────────────────────────────────────────────

export function ItemActionButtons({
  item,
  onAction,
  onRestore,
  onHideSimilar,
  hideSimilarPending = false,
  showShortcuts = true,
}: {
  item: ItemDetail
  onAction: (id: string, action: ItemAction) => void
  onRestore: (target: RestoreTarget) => void
  onHideSimilar?: ((id: string) => void) | undefined
  hideSimilarPending?: boolean
  showShortcuts?: boolean
}) {
  const hidden = isHiddenStatus(item.status)
  const open = isOpenStatus(item.status)
  return (
    <>
      {hidden ? (
        <Button
          onClick={() =>
            onRestore({
              id: item.id,
              authorName: item.authorName,
              authorHandle: item.authorHandle,
              filterReason: item.filterReason,
            })
          }
        >
          <Undo2 /> Not spam / restore
        </Button>
      ) : null}
      {open ? (
        <>
          <Button onClick={() => onAction(item.id, "resolve")}>
            <CheckCircle2 /> Resolve
            {showShortcuts ? <Kbd className="ml-1 hidden sm:inline-flex">e</Kbd> : null}
          </Button>
          <Button variant="outline" onClick={() => onAction(item.id, "ignore")}>
            <CircleSlash /> Ignore
            {showShortcuts ? <Kbd className="ml-1 hidden sm:inline-flex">i</Kbd> : null}
          </Button>
        </>
      ) : null}
      {!hidden && !open ? (
        <Button variant="outline" onClick={() => onAction(item.id, "reopen")}>
          <RotateCcw /> Reopen
        </Button>
      ) : null}
      {!hidden && item.type === "comment" && onHideSimilar ? (
        <Suspense fallback={null}>
          <HideSimilarButton onClick={() => onHideSimilar(item.id)} pending={hideSimilarPending} />
        </Suspense>
      ) : null}
      {!hidden ? (
        <Button variant="ghost" onClick={() => onAction(item.id, "archive")}>
          <Archive /> Archive
        </Button>
      ) : null}
    </>
  )
}

/** Admins only: it edits the Low-value phrases list. */
function HideSimilarButton({ onClick, pending }: { onClick: () => void; pending: boolean }) {
  const isAdmin = useIsAdmin()
  if (!isAdmin) return null
  return (
    <Button
      variant="ghost"
      onClick={onClick}
      disabled={pending}
      title="Archive this and filter comments with the same wording from now on"
    >
      <MessageSquareOff /> Hide similar
    </Button>
  )
}

// ─── Reply composer ───────────────────────────────────────────────────────────

function readDraft(key: string): string {
  try {
    return typeof window === "undefined" ? "" : (sessionStorage.getItem(key) ?? "")
  } catch {
    return ""
  }
}

function writeDraft(key: string, text: string) {
  try {
    if (text) sessionStorage.setItem(key, text)
    else sessionStorage.removeItem(key)
  } catch {
    // storage unavailable (private mode): drafts just aren't kept
  }
}

/**
 * Reply box with AI drafts. Drafts are kept per item for this browser tab, so moving between
 * items doesn't lose text. "Copy & open" puts the reply on the clipboard and opens the item in
 * its own app, for platforms or accounts we can't post to.
 */
export function ReplyComposer({
  item,
  focusToken,
  now,
  rows = 6,
  onSent,
}: {
  item: ItemDetail
  /** Changes whenever something asks to focus the reply box. */
  focusToken: number
  now: number
  rows?: number
  /** Called once a reply is queued (e.g. to open the next item). */
  onSent?: (res: ReplyQueuedResponse) => void
}) {
  const storageKey = `reply-draft:${item.id}`
  const [text, setText] = useState(() => readDraft(storageKey))
  const [draftId, setDraftId] = useState<string | null>(null)
  const qc = useQueryClient()
  const inFlight = item.replies.find((r) => r.status === "queued" || r.status === "sending")
  const lastFailed = [...item.replies]
    .reverse()
    .find((r) => r.status !== "queued" && r.status !== "sending")
  const failed = lastFailed?.status === "failed" ? lastFailed : null

  const send = useMutation({
    mutationFn: () =>
      api<ReplyQueuedResponse>(`/items/${item.id}/reply`, {
        method: "POST",
        body: { text, draftId },
      }),
    onSuccess: (res) => {
      setText("")
      setDraftId(null)
      void qc.invalidateQueries({ queryKey: qk.item(item.id) })
      const undo = async () => {
        try {
          const r = await api<{ text: string }>(`/items/${item.id}/replies/${res.replyId}/cancel`, {
            method: "POST",
          })
          // Saved too, in case "after sending" already moved to the next item.
          writeDraft(storageKey, r.text)
          setText(r.text)
          toast.success("Reply cancelled", {
            description: "It’s back in that item’s reply box.",
          })
        } catch (err) {
          toast.error("Couldn’t undo", {
            description: err instanceof Error ? err.message : undefined,
          })
        }
        void qc.invalidateQueries({ queryKey: qk.item(item.id) })
      }
      if (res.undoSeconds > 0) {
        toast.success(item.demoAccount ? "Reply queued (demo: not posted)" : "Reply queued", {
          description: `Sends in ${res.undoSeconds} s.`,
          duration: res.undoSeconds * 1000,
          action: { label: "Undo", onClick: () => void undo() },
        })
      } else {
        toast.success(item.demoAccount ? "Reply sent (demo: not posted)" : "Reply sending…")
      }
      onSent?.(res)
    },
    onError: (err) =>
      toast.error("Couldn’t send the reply", {
        description: err instanceof Error ? err.message : undefined,
      }),
  })
  const ref = useRef<HTMLTextAreaElement>(null)
  const expired = item.replyWindow?.expired === true
  const app = PLATFORM_APP_NAMES[item.platform]

  useEffect(() => writeDraft(storageKey, text), [storageKey, text])
  useEffect(() => {
    if (focusToken > 0) ref.current?.focus()
  }, [focusToken])

  const disabledReason = expired
    ? null
    : !item.canReply
      ? `Sending from here needs ${PLATFORM_LABELS[item.platform]} connected (Connections). Until then, copy your reply and open it in ${app}.`
      : null

  const copyAndOpen = () => {
    if (!item.link) return
    const reply = text.trim()
    // Open first, inside the click, so the popup isn't blocked; the copy can finish after.
    window.open(item.link.url, "_blank", "noopener,noreferrer")
    if (!reply) return
    navigator.clipboard.writeText(reply).then(
      () => toast.success(`Reply copied. Paste it in ${app}.`),
      () => toast.error("Couldn't copy the reply", { description: "Select the text and copy it." }),
    )
  }

  return (
    <section className="space-y-3" aria-label="Reply">
      <AiDrafts
        item={item}
        onUse={(d) => {
          setText(d.text)
          setDraftId(d.id)
        }}
      />

      {inFlight ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          <Loader2 className="size-3.5 animate-spin" />
          {inFlight.status === "queued"
            ? "Your reply is queued and sends shortly."
            : "Sending your reply…"}
        </p>
      ) : failed ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>The last reply didn’t send</AlertTitle>
          <AlertDescription>
            {failed.error ?? "Unknown error"}
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => setText(failed.text)}
            >
              Put it back in the reply box
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {expired ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>Reply window expired, reply in {app}.</AlertTitle>
          <AlertDescription>
            {app} only allows replies within {item.replyWindow?.hours} hours of the customer&apos;s
            last message.
          </AlertDescription>
        </Alert>
      ) : item.replyWindow?.expiresAt ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="size-3.5" />
          Reply window closes {relativeTime(item.replyWindow.expiresAt, now)}
        </p>
      ) : null}

      <Textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={expired ? `Write it here, then copy it into ${app}` : "Write a reply…"}
        rows={rows}
        className="min-h-32 resize-y"
        aria-label="Reply text"
      />

      <div className="flex flex-wrap items-center justify-end gap-2">
        {item.link ? (
          <Button variant="outline" size="sm" onClick={copyAndOpen}>
            {text.trim() ? <Copy /> : <ExternalLink />}
            {text.trim() ? `Copy & open in ${app}` : `Open in ${app}`}
          </Button>
        ) : null}
        <Button
          size="sm"
          disabled={
            expired || !item.canReply || text.trim() === "" || Boolean(inFlight) || send.isPending
          }
          onClick={() => send.mutate()}
        >
          {send.isPending ? <Loader2 className="animate-spin" /> : <Send />} Send
        </Button>
      </div>
      {disabledReason ? <p className="text-xs text-muted-foreground">{disabledReason}</p> : null}
      {item.platform === "google_business" && item.replies.some((r) => r.status === "sent") ? (
        <p className="text-xs text-muted-foreground">
          Google keeps one reply per review: sending again replaces the current one.
        </p>
      ) : null}
      {item.demoAccount ? (
        <p className="text-xs text-muted-foreground">
          Demo account: sending runs the real flow, but nothing is posted anywhere.
        </p>
      ) : null}
    </section>
  )
}

/** How long to show "Drafting…" before assuming the job failed (see Activity → Jobs). */
const DRAFT_WAIT_MS = 90_000

/**
 * AI drafts for the composer. Drafts arrive over SSE (items.changed → the item refetches);
 * while a request is out, the panel shows a placeholder until the draft set changes.
 */
function AiDrafts({
  item,
  onUse,
}: {
  item: ItemDetail
  onUse: (draft: { id: string; text: string }) => void
}) {
  const draftKey = item.aiDrafts.map((d) => d.id).join(",")
  const [waiting, setWaiting] = useState<{ since: number; key: string } | null>(null)
  const regenerate = useMutation({
    mutationFn: () => api(`/items/${item.id}/drafts`, { method: "POST" }),
    onMutate: () => setWaiting({ since: Date.now(), key: draftKey }),
    onError: (err) => {
      setWaiting(null)
      toast.error("Couldn’t draft replies", {
        description: err instanceof Error ? err.message : undefined,
      })
    },
  })

  // Pending until the draft set changes (new drafts arrived over SSE) or we give up waiting.
  const pending = waiting !== null && waiting.key === draftKey
  useEffect(() => {
    if (!pending || !waiting) return
    const t = setTimeout(
      () => {
        setWaiting(null)
        toast.error("Drafting is taking too long", {
          description: "Check Activity → Jobs for an error, then try again.",
        })
      },
      Math.max(0, waiting.since + DRAFT_WAIT_MS - Date.now()),
    )
    return () => clearTimeout(t)
  }, [pending, waiting])

  if (item.isOwnAccount) return null

  if (!item.ai.available) {
    return (
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Sparkles className="mt-px size-3.5 shrink-0" />
        <span>
          {item.ai.message}{" "}
          <Suspense fallback={null}>
            <AiSettingsLink />
          </Suspense>
        </span>
      </p>
    )
  }

  const action = (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => regenerate.mutate()}
      disabled={pending}
      aria-label={item.aiDrafts.length ? "Regenerate drafts" : "Draft replies with AI"}
    >
      {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
      {item.aiDrafts.length
        ? "Regenerate"
        : item.aiDraftsAllowed
          ? "Draft replies"
          : "Draft anyway"}
    </Button>
  )

  return (
    <Section title="AI drafts" icon={<Sparkles className="size-3.5" />}>
      <div className="space-y-2" aria-busy={pending}>
        {pending ? (
          <div className="flex items-center gap-2 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Drafting replies…
          </div>
        ) : null}
        {!pending && item.aiDrafts.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {item.aiDraftsAllowed
              ? "No drafts yet. They’re written when an item arrives, or ask for them now."
              : "A filter rule turned off AI drafts for this item."}
          </p>
        ) : null}
        {item.aiDrafts.map((d) => (
          <button
            key={d.id}
            type="button"
            onClick={() => onUse(d)}
            disabled={pending}
            className="group block w-full rounded-lg border bg-background px-3 py-2.5 text-left text-sm transition-colors outline-none hover:bg-accent/50 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
          >
            <span className="block leading-relaxed whitespace-pre-wrap">{d.text}</span>
            <span className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted-foreground group-hover:text-foreground">
              <CornerDownLeft className="size-3" /> Use this draft
            </span>
          </button>
        ))}
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[11px] text-muted-foreground">
            {item.aiDrafts[0]
              ? `Drafted by ${item.aiDrafts[0].model}. Check facts before sending.`
              : ""}
          </span>
          {action}
        </div>
      </div>
    </Section>
  )
}

function AiSettingsLink() {
  const isAdmin = useIsAdmin()
  if (!isAdmin) return <>Ask an owner or admin to set it up.</>
  return (
    <Link href="/settings?tab=ai" className="underline underline-offset-2 hover:text-foreground">
      Set it up
    </Link>
  )
}
