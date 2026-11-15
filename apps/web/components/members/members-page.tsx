"use client"

import { Suspense, useState } from "react"
import Link from "next/link"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { CircleAlert, Lock, Pencil, ShieldCheck, Trash2, Users } from "lucide-react"
import {
  APP_PERMISSION_LABELS,
  appStatement,
  type AppPermissionMap,
  type AppResource,
  type MemberDto,
  type MemberRemovedResponse,
  type MembersResponse,
  type MemberUpdate,
  type Platform,
} from "@inbox/core"
import { EmptyState } from "@/components/app/empty-state"
import { useCan } from "@/components/app/me-context"
import { PlatformIcon } from "@/components/app/platform-icon"
import { SimpleSelect } from "@/components/filters/simple-select"
import { Alert, AlertDescription } from "@/components/ui/alert"
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { api } from "@/lib/api"
import { relativeTime } from "@/lib/format"

const QK = ["members"] as const
const RESOURCES = Object.keys(appStatement) as AppResource[]
const ROLE_LABELS = { owner: "Owner", admin: "Admin", member: "Member" } as const
type AssignableRole = "admin" | "member"

export function MembersPage() {
  return (
    <Suspense fallback={<MembersSkeleton />}>
      <MembersGate />
    </Suspense>
  )
}

function MembersGate() {
  const canManage = useCan({ member: ["update"] })
  if (!canManage) {
    return (
      <EmptyState
        icon={Lock}
        title="You don’t have access"
        description="Ask an owner or admin to change who can do what."
      />
    )
  }
  return <MembersContent />
}

function MembersSkeleton() {
  return <Skeleton className="mx-auto h-96 w-full max-w-4xl rounded-xl" />
}

function MembersContent() {
  const qc = useQueryClient()
  const canRemove = useCan({ member: ["delete"] })
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: QK,
    queryFn: () => api<MembersResponse>("/members"),
  })
  const [editing, setEditing] = useState<MemberDto | null>(null)
  const [removing, setRemoving] = useState<MemberDto | null>(null)

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: MemberUpdate }) =>
      api<MemberDto>(`/members/${id}`, { method: "PATCH", body: patch }),
    onSuccess: (m) => {
      toast.success(`Saved access for ${m.name}`)
      setEditing(null)
    },
    onError: (err) =>
      toast.error("Couldn’t save", { description: err instanceof Error ? err.message : undefined }),
    onSettled: () => void qc.invalidateQueries({ queryKey: QK }),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api<MemberRemovedResponse>(`/members/${id}`, { method: "DELETE" }),
    onSuccess: (r) =>
      r.stillAllowedByDomain
        ? toast.warning("Removed, but their domain is still on the sign-in allowlist", {
            description: "They’ll join again at their next sign-in. Edit Settings → General.",
          })
        : toast.success("Removed and signed out"),
    onError: (err) =>
      toast.error("Couldn’t remove", {
        description: err instanceof Error ? err.message : undefined,
      }),
    onSettled: () => void qc.invalidateQueries({ queryKey: QK }),
  })

  if (isPending) return <MembersSkeleton />
  if (isError) {
    return (
      <Alert variant="destructive" className="mx-auto max-w-4xl">
        <CircleAlert />
        <AlertDescription className="flex flex-wrap items-center gap-2">
          Couldn’t load members: {error.message}
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Members</h1>
        <p className="text-sm text-muted-foreground">
          Roles set the defaults. Give anyone except an owner custom access: only some platforms, no
          AI drafts, view-only, and so on. Changes apply on their next click.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="size-4" /> {data.members.length} people
          </CardTitle>
          <CardDescription>
            To add someone, put their email (or domain) on the{" "}
            <Link
              href="/settings?tab=general"
              className="underline underline-offset-2 hover:text-foreground"
            >
              sign-in allowlist
            </Link>
            . They join as a Member when they first sign in, then you can change their access here.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <ul className="divide-y border-t">
            {data.members.map((m) => (
              <MemberRow
                key={m.id}
                member={m}
                canRemove={canRemove}
                onEdit={() => setEditing(m)}
                onRemove={() => setRemoving(m)}
              />
            ))}
          </ul>
        </CardContent>
      </Card>

      {editing ? (
        <AccessDialog
          key={editing.id}
          member={editing}
          data={data}
          saving={update.isPending}
          onClose={() => setEditing(null)}
          onSave={(patch) => update.mutate({ id: editing.id, patch })}
        />
      ) : null}

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => (open ? undefined : setRemoving(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              They’re signed out now and their email comes off the sign-in allowlist. Their past
              replies and audit entries stay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing) remove.mutate(removing.id)
                setRemoving(null)
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function MemberRow({
  member: m,
  canRemove,
  onEdit,
  onRemove,
}: {
  member: MemberDto
  canRemove: boolean
  onEdit: () => void
  onRemove: () => void
}) {
  const locked = m.role === "owner" || m.isSelf
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <Avatar className="size-8">
        {m.image ? <AvatarImage src={m.image} alt="" referrerPolicy="no-referrer" /> : null}
        <AvatarFallback>{initials(m.name)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="truncate font-medium">{m.name}</span>
          {m.isSelf ? <Badge variant="secondary">You</Badge> : null}
          <Badge variant={m.role === "member" ? "outline" : "default"}>
            {m.role !== "member" ? <ShieldCheck /> : null}
            {ROLE_LABELS[m.role]}
          </Badge>
          {m.custom ? <Badge variant="outline">Custom access</Badge> : null}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {m.email} · joined {relativeTime(m.joinedAt)}
        </div>
      </div>
      <AccessSummary permissions={m.permissions} />
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="outline"
          onClick={onEdit}
          disabled={locked}
          title={
            m.role === "owner"
              ? "Owners always have full access"
              : m.isSelf
                ? "You can’t change your own access"
                : undefined
          }
        >
          <Pencil /> Access
        </Button>
        {canRemove ? (
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onRemove}
            disabled={locked}
            aria-label={`Remove ${m.name}`}
          >
            <Trash2 />
          </Button>
        ) : null}
      </div>
    </li>
  )
}

/** Platform icons plus a short note about what's missing. */
function AccessSummary({ permissions: p }: { permissions: AppPermissionMap }) {
  const platforms = (p.platform ?? []) as Platform[]
  const notes: string[] = []
  if (!p.inbox?.includes("read")) notes.push("no inbox")
  else if (!p.inbox.includes("reply")) notes.push("can’t reply")
  if (!p.ai?.includes("draft")) notes.push("no AI")
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <div className="flex gap-0.5">
        {platforms.length === 0 ? (
          <span>No platforms</span>
        ) : (
          platforms.map((pl) => <PlatformIcon key={pl} platform={pl} className="size-4" />)
        )}
      </div>
      {notes.length ? <span>{notes.join(" · ")}</span> : null}
    </div>
  )
}

function AccessDialog({
  member,
  data,
  saving,
  onClose,
  onSave,
}: {
  member: MemberDto
  data: MembersResponse
  saving: boolean
  onClose: () => void
  onSave: (patch: MemberUpdate) => void
}) {
  const [role, setRole] = useState<AssignableRole>(member.role === "admin" ? "admin" : "member")
  const [custom, setCustom] = useState(member.custom)
  const [perms, setPerms] = useState<AppPermissionMap>(member.permissions)
  const shown = custom ? perms : data.roleDefaults[role]

  const grantable = (r: AppResource, a: string) =>
    (data.grantable[r] as string[] | undefined)?.includes(a) ?? false

  function toggle(r: AppResource, a: string, on: boolean) {
    setPerms((prev) => {
      const current = (prev[r] ?? []) as string[]
      let next = on ? [...new Set([...current, a])] : current.filter((x) => x !== a)
      // "Manage"/"reply"/… without "read" makes no sense: keep them consistent.
      const actions = appStatement[r] as readonly string[]
      if (actions.includes("read")) {
        if (on && a !== "read") next = [...new Set([...next, "read"])]
        if (!on && a === "read") next = []
      }
      return { ...prev, [r]: actions.filter((x) => next.includes(x)) }
    })
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Access for {member.name}</DialogTitle>
          <DialogDescription>{member.email}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-1.5">
          <Label htmlFor="member-role">Role</Label>
          <SimpleSelect<AssignableRole>
            id="member-role"
            aria-label="Role"
            value={role}
            onChange={setRole}
            options={[
              { value: "member", label: "Member: works the inbox" },
              {
                value: "admin",
                label: "Admin: also manages members, filters, connections and settings",
              },
            ]}
          />
        </div>

        <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
          <div className="space-y-0.5">
            <Label htmlFor="member-custom">Custom access</Label>
            <p className="text-xs text-muted-foreground">
              {custom
                ? "Only what’s ticked below. Member management still comes from the role."
                : `Uses the ${ROLE_LABELS[role]} defaults shown below.`}
            </p>
          </div>
          <Switch
            id="member-custom"
            checked={custom}
            onCheckedChange={(on) => {
              setCustom(on)
              if (on) setPerms(data.roleDefaults[role])
            }}
          />
        </div>

        <div className="space-y-4">
          {RESOURCES.map((r) => {
            const meta = APP_PERMISSION_LABELS[r]
            const actions = appStatement[r] as readonly string[]
            return (
              <fieldset key={r} className="space-y-2">
                <legend className="text-sm font-medium">{meta.label}</legend>
                <p className="text-xs text-muted-foreground">{meta.description}</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {actions.map((a) => {
                    const id = `perm-${r}-${a}`
                    const checked = ((shown[r] ?? []) as string[]).includes(a)
                    const allowed = grantable(r, a)
                    return (
                      <div key={a} className="flex items-center gap-2">
                        <Checkbox
                          id={id}
                          checked={checked}
                          disabled={!custom || (!allowed && !checked)}
                          onCheckedChange={(v) => toggle(r, a, v === true)}
                        />
                        <Label
                          htmlFor={id}
                          className="flex items-center gap-1.5 font-normal"
                          title={allowed ? undefined : "You don’t have this yourself"}
                        >
                          {r === "platform" ? (
                            <PlatformIcon platform={a as Platform} className="size-4" />
                          ) : null}
                          {(meta.actions as Record<string, string>)[a]}
                        </Label>
                      </div>
                    )
                  })}
                </div>
              </fieldset>
            )
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={saving}
            onClick={() => onSave({ role, permissions: custom ? perms : null })}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?"
  )
}
