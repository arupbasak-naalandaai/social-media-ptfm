"use client"

import { IfCan } from "@/components/app/me-context"
import { useState } from "react"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"

export interface RestoreTarget {
  id: string
  authorName: string | null
  authorHandle: string | null
  filterReason: string | null
}

/** "Not spam / restore": moves the item back to the inbox, optionally allowlisting its author. */
export function RestoreDialog({
  target,
  onClose,
  onConfirm,
}: {
  target: RestoreTarget | null
  onClose: () => void
  onConfirm: (id: string, addToAllowlist: boolean) => void
}) {
  const [allowlist, setAllowlist] = useState(false)
  const author = target?.authorName ?? (target?.authorHandle ? `@${target.authorHandle}` : null)
  const canAllowlist = Boolean(target?.authorHandle || target?.authorName)

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose()
          setAllowlist(false)
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Restore to the inbox?</AlertDialogTitle>
          <AlertDialogDescription>
            {target?.filterReason ? `It was hidden by: ${target.filterReason}. ` : ""}
            The item moves back to the inbox and filter rules won&apos;t hide it again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {canAllowlist ? (
          <IfCan request={{ filter: ["manage"] }}>
            <div className="flex items-start gap-2">
              <Checkbox
                id="restore-allowlist"
                checked={allowlist}
                onCheckedChange={(v) => setAllowlist(v === true)}
              />
              <Label htmlFor="restore-allowlist" className="leading-snug font-normal">
                Also add {author ?? "this author"} to the allowlist, so future items from them
                always show at high priority
              </Label>
            </div>
          </IfCan>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            onClick={() => {
              if (target) onConfirm(target.id, allowlist)
              setAllowlist(false)
            }}
          >
            Restore
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
