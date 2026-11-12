"use client"

import { FolderPlus, Plus, Trash2 } from "lucide-react"
import { MAX_CONDITIONS_PER_RULE, MAX_GROUP_DEPTH, type ConditionGroup } from "@inbox/core"
import { Button } from "@/components/ui/button"
import { cn } from "cn"
import { ConditionRow } from "./condition-row"
import {
  countConditions,
  makeCondition,
  makeGroup,
  omitKeys,
  removeNode,
  updateNode,
} from "./helpers"
import { SimpleSelect } from "./simple-select"

type GroupMode = "all" | "any" | "none"

function modeOf(g: ConditionGroup): GroupMode {
  if (g.negate) return "none"
  return g.combinator === "and" ? "all" : "any"
}

function withMode(g: ConditionGroup, mode: GroupMode): ConditionGroup {
  const rest = omitKeys(g, "negate")
  if (mode === "none") return { ...rest, combinator: "or", negate: true }
  return { ...rest, combinator: mode === "all" ? "and" : "or" }
}

const MODE_OPTIONS = [
  { value: "all" as const, label: "All of" },
  { value: "any" as const, label: "Any of" },
  { value: "none" as const, label: "None of" },
]

/** Nested AND / OR / NOT condition groups (controlled). */
export function ConditionBuilder({
  value,
  onChange,
  issues,
  disabled,
}: {
  value: ConditionGroup
  onChange: (next: ConditionGroup) => void
  issues: Record<string, string>
  disabled?: boolean
}) {
  const total = countConditions(value)
  return (
    <GroupEditor
      group={value}
      root={value}
      depth={1}
      onRootChange={onChange}
      issues={issues}
      atLimit={total >= MAX_CONDITIONS_PER_RULE}
      disabled={disabled ?? false}
    />
  )
}

function GroupEditor({
  group,
  root,
  depth,
  onRootChange,
  onRemove,
  issues,
  atLimit,
  disabled,
}: {
  group: ConditionGroup
  root: ConditionGroup
  depth: number
  onRootChange: (next: ConditionGroup) => void
  onRemove?: () => void
  issues: Record<string, string>
  atLimit: boolean
  disabled: boolean
}) {
  const set = (next: ConditionGroup) =>
    onRootChange(group.id === root.id ? next : updateNode(root, group.id, () => next))
  const add = (child: ConditionGroup["children"][number]) =>
    set({ ...group, children: [...group.children, child] })

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-xl border p-3",
        depth === 1 ? "bg-muted/30" : depth % 2 === 0 ? "bg-background" : "bg-muted/30",
        issues[group.id] && "border-destructive/60",
      )}
      role="group"
      aria-label={depth === 1 ? "Conditions" : "Condition group"}
    >
      <div className="flex items-center gap-2">
        <SimpleSelect
          aria-label="Group match mode"
          size="sm"
          className="w-28"
          value={modeOf(group)}
          options={MODE_OPTIONS}
          onChange={(m) => set(withMode(group, m))}
          disabled={disabled}
        />
        <span className="text-xs text-muted-foreground">
          {group.children.length === 0
            ? "No conditions yet: an empty “All of” group matches everything."
            : "these conditions"}
        </span>
        {onRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="Remove group"
            onClick={onRemove}
            disabled={disabled}
          >
            <Trash2 />
          </Button>
        ) : null}
      </div>

      {group.children.map((child) =>
        child.kind === "group" ? (
          <GroupEditor
            key={child.id}
            group={child}
            root={root}
            depth={depth + 1}
            onRootChange={onRootChange}
            onRemove={() => onRootChange(removeNode(root, child.id))}
            issues={issues}
            atLimit={atLimit}
            disabled={disabled}
          />
        ) : (
          <ConditionRow
            key={child.id}
            condition={child}
            issue={issues[child.id]}
            disabled={disabled}
            onChange={(next) => onRootChange(updateNode(root, child.id, () => next))}
            onRemove={() => onRootChange(removeNode(root, child.id))}
          />
        ),
      )}

      {issues[group.id] ? (
        <p role="alert" className="text-xs text-destructive">
          {issues[group.id]}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => add(makeCondition())}
          disabled={disabled || atLimit}
        >
          <Plus /> Condition
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => add(makeGroup())}
          disabled={disabled || atLimit || depth >= MAX_GROUP_DEPTH}
          title={
            depth >= MAX_GROUP_DEPTH
              ? `Groups can be nested at most ${MAX_GROUP_DEPTH} levels`
              : undefined
          }
        >
          <FolderPlus /> Group
        </Button>
        {atLimit ? (
          <span className="self-center text-xs text-muted-foreground">
            Maximum of {MAX_CONDITIONS_PER_RULE} conditions reached
          </span>
        ) : null}
      </div>
    </div>
  )
}
