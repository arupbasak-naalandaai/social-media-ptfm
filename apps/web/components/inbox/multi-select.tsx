"use client"

import { ChevronDown } from "lucide-react"
import type { ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export interface Option<T extends string> {
  value: T
  label: string
  icon?: ReactNode
}

/** Toolbar filter: a button that opens a checkbox list; shows the selection count. */
export function MultiSelect<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: Option<T>[]
  value: T[]
  onChange: (next: T[]) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="sm" className="h-8 gap-1.5 border-dashed" />}
      >
        {label}
        {value.length > 0 ? (
          <Badge variant="secondary" className="h-5 rounded-sm px-1.5 font-normal">
            {value.length === 1 ? options.find((o) => o.value === value[0])?.label : value.length}
          </Badge>
        ) : null}
        <ChevronDown className="size-3.5 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          {options.map((o) => (
            <DropdownMenuCheckboxItem
              key={o.value}
              checked={value.includes(o.value)}
              onCheckedChange={(checked) =>
                onChange(checked ? [...value, o.value] : value.filter((v) => v !== o.value))
              }
            >
              {o.icon}
              {o.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
        {value.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onChange([])}>Clear</DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
