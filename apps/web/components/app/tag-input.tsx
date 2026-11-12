"use client"

import { X } from "lucide-react"
import { useId, useState, type KeyboardEvent } from "react"
import { Badge } from "@/components/ui/badge"
import { cn } from "cn"

/**
 * Chips + text input. Enter or comma adds a value, Backspace on an empty input removes the last.
 * Pasting "a, b, c" adds all three.
 */
export function TagInput({
  value,
  onChange,
  placeholder = "Type and press Enter",
  disabled,
  invalid,
  normalize = (v) => v.trim(),
  className,
  id,
  "aria-label": ariaLabel,
}: {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  disabled?: boolean
  invalid?: boolean
  normalize?: (v: string) => string
  className?: string
  id?: string
  "aria-label"?: string
}) {
  const [draft, setDraft] = useState("")
  const autoId = useId()
  const inputId = id ?? autoId

  const add = (raw: string) => {
    const parts = raw.split(",").map(normalize).filter(Boolean)
    if (parts.length === 0) return
    const next = [...value]
    for (const p of parts) if (!next.includes(p)) next.push(p)
    onChange(next)
    setDraft("")
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault()
      add(draft)
    } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
      onChange(value.slice(0, -1))
    }
  }

  return (
    <div
      className={cn(
        "flex min-h-9 w-full flex-wrap items-center gap-1 rounded-lg border border-input bg-transparent px-2 py-1 text-sm transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
        invalid && "border-destructive ring-destructive/20",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
      onClick={() => document.getElementById(inputId)?.focus()}
    >
      {value.map((v) => (
        <Badge key={v} variant="secondary" className="gap-1 pr-1">
          <span className="max-w-48 truncate">{v}</span>
          <button
            type="button"
            className="rounded-sm opacity-60 hover:opacity-100"
            aria-label={`Remove ${v}`}
            onClick={(e) => {
              e.stopPropagation()
              onChange(value.filter((x) => x !== v))
            }}
          >
            <X className="size-3" />
          </button>
        </Badge>
      ))}
      <input
        id={inputId}
        aria-label={ariaLabel}
        className="min-w-24 flex-1 bg-transparent py-0.5 outline-none placeholder:text-muted-foreground"
        value={draft}
        placeholder={value.length === 0 ? placeholder : ""}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => add(draft)}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text")
          if (text.includes(",")) {
            e.preventDefault()
            add(text)
          }
        }}
      />
    </div>
  )
}
