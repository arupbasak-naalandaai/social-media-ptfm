"use client"

/**
 * Building blocks shared by the quick-preview sheet and the full item page.
 */
import { Suspense, useEffect, useRef, useState, type ReactNode } from "react"
import Link from "next/link"
import { toast } from "sonner"
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  CircleSlash,
  Clock,
  Copy,
  ExternalLink,
  EyeOff,
  MessageSquareOff,
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
  type ThreadEntry,
} from "@inbox/core"
import { useIsAdmin } from "@/components/app/me-context"
import { PLATFORM_LABELS } from "@/components/app/platform-icon"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Textarea } from "@/components/ui/textarea"
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

function placeholder(entry: Pick<ThreadEntry, "eventKind">, type: ItemDetail["type"]): string {
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
}: {
  item: ItemDetail
  /** Changes whenever something asks to focus the reply box. */
  focusToken: number
  now: number
  rows?: number
}) {
  const storageKey = `reply-draft:${item.id}`
  const [text, setText] = useState(() => readDraft(storageKey))
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
      {item.aiDrafts.length > 0 ? (
        <Section title="AI drafts" icon={<Sparkles className="size-3.5" />}>
          <div className="space-y-2">
            {item.aiDrafts.map((d) => (
              <div key={d.id} className="space-y-2 rounded-lg border p-3 text-sm">
                <p className="whitespace-pre-wrap">{d.text}</p>
                <Button size="sm" variant="outline" onClick={() => setText(d.text)}>
                  Use this draft
                </Button>
              </div>
            ))}
          </div>
        </Section>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Sparkles className="size-3.5" />
          {item.aiDraftsAllowed
            ? "AI drafts arrive with Phase 4."
            : "No AI drafts for this item (rule: notify only)."}
        </p>
      )}

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
        <Button size="sm" disabled={expired || !item.canReply || text.trim() === ""}>
          <Send /> Send
        </Button>
      </div>
      {disabledReason ? <p className="text-xs text-muted-foreground">{disabledReason}</p> : null}
    </section>
  )
}
