"use client"

import { Sparkles, Trash2 } from "lucide-react"
import {
  FIELD_DEFS,
  LIST_REF_OPERATORS,
  OPERATOR_LABELS,
  type Condition,
  type ConditionField,
  type ListName,
  type Operator,
} from "@inbox/core"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { cn } from "cn"
import { defaultValueFor, FIELD_GROUPS, LIST_LABELS, listsForKind, omitKeys } from "./helpers"
import { SimpleSelect } from "./simple-select"
import { ValueInput } from "./value-input"

const CASE_OPS: readonly Operator[] = [
  "contains",
  "notContains",
  "containsAny",
  "equals",
  "notEquals",
  "regex",
  "inList",
  "notInList",
]

const FIELD_SELECT_GROUPS = FIELD_GROUPS.map((g) => ({
  label: g.label,
  options: g.fields.map((f) => ({
    value: f,
    label: (
      <span className="flex items-center gap-1.5">
        {FIELD_DEFS[f].label}
        {FIELD_DEFS[f].ai ? (
          <Sparkles className="size-3 text-violet-500" aria-label="needs AI checks" />
        ) : null}
      </span>
    ),
  })),
}))

export function ConditionRow({
  condition,
  onChange,
  onRemove,
  issue,
  disabled,
}: {
  condition: Condition
  onChange: (next: Condition) => void
  onRemove: () => void
  issue?: string | undefined
  disabled?: boolean
}) {
  const def = FIELD_DEFS[condition.field]
  const listKind = def.listKinds?.[0]
  const canUseList = listKind !== undefined && LIST_REF_OPERATORS.includes(condition.operator)
  const showCase =
    (def.type === "string" || def.type === "stringList") &&
    !def.enumValues &&
    CASE_OPS.includes(condition.operator)

  const setField = (field: ConditionField) => {
    const operator = FIELD_DEFS[field].operators[0]!
    const value = defaultValueFor(field, operator)
    onChange({
      id: condition.id,
      kind: "condition",
      field,
      operator,
      ...(value !== undefined ? { value } : {}),
    })
  }

  const setOperator = (operator: Operator) => {
    const { listRef } = condition
    const rest = omitKeys(condition, "value", "listRef")
    const value = defaultValueFor(condition.field, operator)
    const keepList = listRef && LIST_REF_OPERATORS.includes(operator)
    onChange({
      ...rest,
      operator,
      ...(keepList ? { listRef } : value !== undefined ? { value } : {}),
    })
  }

  const toggleList = (useList: boolean) => {
    const rest = omitKeys(condition, "value", "listRef")
    if (useList && listKind) {
      onChange({ ...rest, listRef: { list: listsForKind(listKind)[0]!, kind: listKind } })
    } else {
      const value = defaultValueFor(condition.field, condition.operator)
      onChange({ ...rest, ...(value !== undefined ? { value } : {}) })
    }
  }

  return (
    <div className={cn("rounded-lg border bg-background p-2", issue && "border-destructive/60")}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 sm:grid-cols-[minmax(0,11rem)_minmax(0,10rem)_minmax(0,1fr)_auto]">
        <SimpleSelect
          aria-label="Field"
          className="w-full sm:row-start-1"
          value={condition.field}
          groups={FIELD_SELECT_GROUPS}
          onChange={setField}
          disabled={disabled ?? false}
        />
        <SimpleSelect
          aria-label="Operator"
          className="col-start-1 w-full sm:col-start-2 sm:row-start-1"
          value={condition.operator}
          options={def.operators.map((op) => ({ value: op, label: OPERATOR_LABELS[op] }))}
          onChange={setOperator}
          disabled={disabled ?? false}
        />
        <div className="col-start-1 flex min-w-0 flex-wrap items-center gap-2 sm:col-start-3 sm:row-start-1 [&>*]:w-full">
          {condition.listRef && listKind ? (
            <SimpleSelect
              aria-label="List"
              className="w-full"
              value={condition.listRef.list}
              options={listsForKind(listKind).map((l) => ({
                value: l,
                label: `${LIST_LABELS[l]} list`,
              }))}
              onChange={(list: ListName) =>
                onChange({ ...condition, listRef: { list, kind: listKind } })
              }
              disabled={disabled ?? false}
            />
          ) : (
            <ValueInput
              condition={condition}
              disabled={disabled ?? false}
              invalid={Boolean(issue)}
              onChange={(value) => {
                const rest = omitKeys(condition, "value")
                onChange(value === undefined ? rest : { ...rest, value })
              }}
            />
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Remove condition"
          className="col-start-2 row-start-1 sm:col-start-4"
          onClick={onRemove}
          disabled={disabled}
        >
          <Trash2 />
        </Button>
      </div>
      {canUseList || showCase || def.ai ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {canUseList ? (
            <Label className="gap-1.5 text-xs font-normal">
              <Checkbox
                checked={Boolean(condition.listRef)}
                onCheckedChange={(v) => toggleList(v === true)}
                disabled={disabled}
              />
              Use a list
            </Label>
          ) : null}
          {showCase && !condition.listRef ? (
            <Label className="gap-1.5 text-xs font-normal">
              <Checkbox
                checked={condition.caseSensitive === true}
                onCheckedChange={(v) => onChange({ ...condition, caseSensitive: v === true })}
                disabled={disabled}
              />
              Case sensitive
            </Label>
          ) : null}
          {def.ai ? (
            <span className="flex items-center gap-1 text-violet-600 dark:text-violet-400">
              <Sparkles className="size-3" /> Only evaluated when AI checks are on (Settings →
              Filters)
            </span>
          ) : null}
        </div>
      ) : null}
      {issue ? (
        <p role="alert" className="mt-1.5 text-xs text-destructive">
          {issue}
        </p>
      ) : null}
    </div>
  )
}
