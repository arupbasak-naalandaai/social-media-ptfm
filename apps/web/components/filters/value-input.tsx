"use client"

import { AlertTriangle, Check } from "lucide-react"
import {
  FIELD_DEFS,
  isSafeRegex,
  operatorValueKind,
  type Condition,
  type ConditionValue,
} from "@inbox/core"
import { Input } from "@/components/ui/input"
import { TagInput } from "@/components/app/tag-input"
import { MultiSelect, SimpleSelect } from "./simple-select"

/** The value control for one condition, adapting to the field type and operator. */
export function ValueInput({
  condition,
  onChange,
  disabled,
  invalid,
}: {
  condition: Condition
  onChange: (value: ConditionValue | undefined) => void
  disabled?: boolean
  invalid?: boolean
}) {
  const def = FIELD_DEFS[condition.field]
  const kind = operatorValueKind(condition.field, condition.operator)
  const label = `${def.label} value`
  const v = condition.value

  switch (kind) {
    case "none":
      return null

    case "number":
      return (
        <div className="flex items-center gap-1.5">
          <Input
            type="number"
            inputMode="decimal"
            aria-label={label}
            className="w-28"
            min={def.min}
            max={def.max}
            step={def.max !== undefined && def.max <= 1 ? 0.05 : 1}
            value={typeof v === "number" ? v : ""}
            disabled={disabled}
            aria-invalid={invalid || undefined}
            onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          />
          {def.unit ? <span className="text-xs text-muted-foreground">{def.unit}</span> : null}
        </div>
      )

    case "stringArray":
      if (def.enumValues) {
        return (
          <MultiSelect
            aria-label={label}
            className="w-full"
            placeholder="Choose values"
            value={Array.isArray(v) ? v : []}
            options={def.enumValues.map((e) => ({ value: e, label: e }))}
            onChange={onChange}
            disabled={disabled ?? false}
            invalid={invalid ?? false}
          />
        )
      }
      return (
        <TagInput
          aria-label={label}
          className="w-full"
          value={Array.isArray(v) ? v : []}
          onChange={onChange}
          placeholder="Type a value, press Enter"
          disabled={disabled ?? false}
          invalid={invalid ?? false}
        />
      )

    case "regex": {
      const pattern = typeof v === "string" ? v : ""
      const safe = pattern === "" || isSafeRegex(pattern)
      return (
        <div className="flex w-full flex-col gap-1">
          <Input
            aria-label={`${def.label} regular expression`}
            className="font-mono"
            placeholder="e.g. ^order\s*#\d+"
            value={pattern}
            disabled={disabled}
            aria-invalid={!safe || invalid || undefined}
            onChange={(e) => onChange(e.target.value)}
          />
          {pattern !== "" ? (
            <span
              className={
                safe
                  ? "flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400"
                  : "flex items-center gap-1 text-xs text-destructive"
              }
            >
              {safe ? <Check className="size-3" /> : <AlertTriangle className="size-3" />}
              {safe ? "Valid pattern" : "Invalid or potentially slow pattern"}
            </span>
          ) : null}
        </div>
      )
    }

    case "string":
      if (def.enumValues) {
        return (
          <SimpleSelect
            aria-label={label}
            className="w-full"
            value={typeof v === "string" ? v : null}
            options={def.enumValues.map((e) => ({ value: e, label: e }))}
            onChange={onChange}
            disabled={disabled ?? false}
            invalid={invalid ?? false}
          />
        )
      }
      return (
        <Input
          aria-label={label}
          className="w-full"
          placeholder={condition.field === "language" ? "e.g. en" : "Value"}
          value={typeof v === "string" ? v : ""}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )
  }
}
