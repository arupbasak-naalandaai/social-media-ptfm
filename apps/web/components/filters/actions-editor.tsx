"use client"

import { AlertTriangle, Plus, Trash2 } from "lucide-react"
import { useFieldArray, useWatch, type Control } from "react-hook-form"
import type { z } from "zod"
import {
  PRIORITIES,
  PRIORITY_SLACK_CHANNEL,
  type ConditionGroup,
  type filterRuleInputSchema,
  type Priority,
  type RuleAction,
  type RuleActionType,
} from "@inbox/core"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ACTION_META, defaultAction, PICKABLE_ACTIONS } from "./helpers"
import { SimpleSelect } from "./simple-select"

/** Form values: the schema input, with the (lazily typed) condition tree made concrete. */
export type RuleFormValues = Omit<z.input<typeof filterRuleInputSchema>, "conditions"> & {
  conditions: ConditionGroup
}

const MAX_ACTIONS = 10
const PRIORITY_LABELS: Record<Priority, string> = {
  urgent: "Urgent",
  high: "High",
  normal: "Normal",
  low: "Low",
}

export function ActionsEditor({
  control,
  disabled,
  error,
}: {
  control: Control<RuleFormValues>
  disabled?: boolean
  error?: string | undefined
}) {
  const { fields, append, remove, update } = useFieldArray({ control, name: "actions" })
  const actions = (useWatch({ control, name: "actions" }) ?? []) as RuleAction[]
  const used = new Set(actions.map((a) => a.type))
  const available = PICKABLE_ACTIONS.filter((t) => !ACTION_META[t].single || !used.has(t))
  const hasDrop = used.has("drop")

  return (
    <div className="flex flex-col gap-2">
      {fields.map((field, index) => {
        const action = actions[index] ?? (field as unknown as RuleAction)
        const meta = ACTION_META[action.type]
        const typeOptions = (meta.slack ? [action.type] : PICKABLE_ACTIONS)
          .filter((t) => t === action.type || !ACTION_META[t].single || !used.has(t))
          .map((t) => ({ value: t, label: ACTION_META[t].label }))
        return (
          <div key={field.id} className="flex flex-col gap-1.5 rounded-lg border bg-background p-2">
            <div className="flex flex-wrap items-center gap-2">
              <SimpleSelect
                aria-label={`Action ${index + 1}`}
                className="w-full sm:w-52"
                value={action.type}
                options={typeOptions}
                onChange={(t: RuleActionType) => update(index, defaultAction(t))}
                disabled={(disabled ?? false) || Boolean(meta.slack)}
              />
              <ActionValue
                action={action}
                disabled={disabled ?? false}
                onChange={(a) => update(index, a)}
                index={index}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="ml-auto"
                aria-label={`Remove action ${meta.label}`}
                onClick={() => remove(index)}
                disabled={disabled || fields.length <= 1}
              >
                <Trash2 />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {meta.slack
                ? "Slack isn’t enabled yet (Phase 8). This action is kept but has no effect."
                : meta.description}
            </p>
          </div>
        )
      })}

      {hasDrop ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Drop deletes data permanently</AlertTitle>
          <AlertDescription>
            Dropped items are never stored, so they can’t be reviewed or restored later. Prefer
            <strong> Archive</strong> unless this is pure noise (reactions, receipts, our own
            echoes).
          </AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || available.length === 0 || fields.length >= MAX_ACTIONS}
          onClick={() => append(defaultAction(available[0]!))}
        >
          <Plus /> Action
        </Button>
      </div>
    </div>
  )
}

function ActionValue({
  action,
  onChange,
  disabled,
  index,
}: {
  action: RuleAction
  onChange: (a: RuleAction) => void
  disabled: boolean
  index: number
}) {
  switch (action.type) {
    case "setPriority":
      return (
        <SimpleSelect
          aria-label={`Priority for action ${index + 1}`}
          className="w-full sm:w-36"
          value={action.value}
          options={PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))}
          onChange={(value: Priority) => onChange({ type: "setPriority", value })}
          disabled={disabled}
        />
      )
    case "addTag":
      return (
        <Input
          aria-label={`Tag for action ${index + 1}`}
          className="w-full sm:w-48"
          placeholder="tag name"
          maxLength={40}
          value={action.value}
          disabled={disabled}
          onChange={(e) => onChange({ type: "addTag", value: e.target.value })}
        />
      )
    case "routeSlackChannel":
      return (
        <span className="text-sm text-muted-foreground">
          {action.channelId === PRIORITY_SLACK_CHANNEL ? "Priority channel" : action.channelId}
        </span>
      )
    default:
      return null
  }
}
