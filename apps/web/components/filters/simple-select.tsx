"use client"

import type { ReactNode } from "react"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "cn"

export interface SelectOption<T extends string> {
  value: T
  label: ReactNode
  disabled?: boolean
}

export interface SelectOptionGroup<T extends string> {
  label: string
  options: SelectOption<T>[]
}

type Common<T extends string> = {
  options?: SelectOption<T>[]
  groups?: SelectOptionGroup<T>[]
  placeholder?: string
  "aria-label": string
  id?: string
  size?: "sm" | "default"
  className?: string
  disabled?: boolean
  invalid?: boolean
}

function allOptions<T extends string>(p: Common<T>): SelectOption<T>[] {
  return [...(p.options ?? []), ...(p.groups ?? []).flatMap((g) => g.options)]
}

function Items<T extends string>(p: Common<T>) {
  return (
    <>
      {p.options?.map((o) => (
        <SelectItem key={o.value} value={o.value} disabled={o.disabled ?? false}>
          {o.label}
        </SelectItem>
      ))}
      {p.groups?.map((g) => (
        <SelectGroup key={g.label}>
          <SelectLabel>{g.label}</SelectLabel>
          {g.options.map((o) => (
            <SelectItem key={o.value} value={o.value} disabled={o.disabled ?? false}>
              {o.label}
            </SelectItem>
          ))}
        </SelectGroup>
      ))}
    </>
  )
}

/** Single-value select with labels rendered in the trigger. */
export function SimpleSelect<T extends string>(
  p: Common<T> & { value: T | null; onChange: (value: T) => void },
) {
  const items = Object.fromEntries(allOptions(p).map((o) => [o.value, o.label]))
  return (
    <Select
      items={items}
      value={p.value}
      onValueChange={(v) => {
        if (v !== null) p.onChange(v as T)
      }}
      disabled={p.disabled ?? false}
    >
      <SelectTrigger
        id={p.id}
        size={p.size ?? "default"}
        aria-label={p["aria-label"]}
        aria-invalid={p.invalid || undefined}
        className={cn("w-full min-w-0", p.className)}
      >
        <SelectValue placeholder={p.placeholder} />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        <Items {...p} />
      </SelectContent>
    </Select>
  )
}

/** Multi-value select (checkmarks), trigger shows a comma-separated summary. */
export function MultiSelect<T extends string>(
  p: Common<T> & { value: T[]; onChange: (value: T[]) => void },
) {
  const labels = new Map(allOptions(p).map((o) => [o.value, o.label]))
  return (
    <Select
      multiple
      value={p.value}
      onValueChange={(v) => p.onChange((v ?? []) as T[])}
      disabled={p.disabled ?? false}
    >
      <SelectTrigger
        id={p.id}
        size={p.size ?? "default"}
        aria-label={p["aria-label"]}
        aria-invalid={p.invalid || undefined}
        className={cn("w-full min-w-0", p.className)}
      >
        <SelectValue placeholder={p.placeholder}>
          {(value: T[] | null) =>
            value && value.length > 0 ? (
              <span className="truncate">{value.map((v) => labels.get(v) ?? v).join(", ")}</span>
            ) : (
              <span className="text-muted-foreground">{p.placeholder ?? "Select…"}</span>
            )
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        <Items {...p} />
      </SelectContent>
    </Select>
  )
}
