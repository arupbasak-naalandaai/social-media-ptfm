"use client"

import { useId, useState } from "react"
import { Check, Copy, KeyRound, Undo2 } from "lucide-react"
import { toast } from "sonner"
import type { SecretStatus } from "@inbox/core"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

/**
 * A write-only secret. The stored value never reaches the browser: the field shows whether
 * one is set (and its last 4 characters), and lets you replace or remove it on the next save.
 *
 * `draft`: undefined = unchanged, string = new value ("" = editing, nothing typed), null = remove.
 */
export function SecretField({
  label,
  description,
  status,
  draft,
  onDraft,
  error,
  placeholder,
}: {
  label: string
  description?: React.ReactNode
  status: SecretStatus
  draft: string | null | undefined
  onDraft: (value: string | null | undefined) => void
  error?: string | undefined
  placeholder?: string
}) {
  const id = useId()
  // "" = editor open with nothing typed yet. A successful save resets drafts to undefined,
  // which closes the editor and shows the new status.
  const showInput = typeof draft === "string"

  return (
    <Field data-invalid={Boolean(error)}>
      {/* Points at the input only while it's shown; the buttons carry their own names. */}
      <FieldLabel htmlFor={showInput ? id : undefined}>{label}</FieldLabel>
      {showInput ? (
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            autoFocus
            placeholder={placeholder ?? (status.set ? "New value" : "Paste the value")}
            value={draft ?? ""}
            aria-invalid={Boolean(error) || undefined}
            onChange={(e) => onDraft(e.target.value)}
          />
          <Button type="button" variant="ghost" size="sm" onClick={() => onDraft(undefined)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {draft === null ? (
            <Badge variant="destructive">Will be removed on save</Badge>
          ) : status.set ? (
            <Badge variant="secondary" className="gap-1 font-mono">
              <KeyRound className="size-3" />
              Saved{status.last4 ? ` · ends in ${status.last4}` : ""}
            </Badge>
          ) : (
            <Badge variant="outline">Not set</Badge>
          )}
          {draft === null ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => onDraft(undefined)}>
              <Undo2 />
              Keep it
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`${status.set ? "Replace" : "Add"} ${label}`}
                onClick={() => onDraft("")}
              >
                {status.set ? "Replace" : "Add"}
              </Button>
              {status.set ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${label}`}
                  onClick={() => onDraft(null)}
                >
                  Remove
                </Button>
              ) : null}
            </>
          )}
        </div>
      )}
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  )
}

/** A read-only value (webhook or redirect URL) with a copy button. */
export function CopyField({
  label,
  value,
  description,
}: {
  label: string
  value: string
  description?: React.ReactNode
}) {
  const id = useId()
  const [copied, setCopied] = useState(false)
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex items-center gap-2">
        <Input id={id} readOnly value={value} className="font-mono text-xs" />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={`Copy ${label}`}
          onClick={() => {
            void navigator.clipboard.writeText(value).then(
              () => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              },
              () => toast.error("Couldn’t copy. Select the text and copy it instead."),
            )
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  )
}
