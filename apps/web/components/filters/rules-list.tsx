"use client"

import { useState } from "react"
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import { restrictToVerticalAxis } from "./dnd-modifiers"
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { AlertTriangle, Filter, Plus, RefreshCw } from "lucide-react"
import type { RuleWithStats } from "@inbox/core"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState } from "@/components/app/empty-state"
import { cloneWithNewIds, emptyRule, newId, ruleToInput } from "./helpers"
import { RuleEditor, type EditorTarget } from "./rule-editor"
import { RuleRow } from "./rule-row"
import {
  useApplyRules,
  useDeleteRule,
  usePatchRule,
  useReorderRules,
  useRules,
} from "./use-filters"

export function RulesList({ canEdit }: { canEdit: boolean }) {
  const rules = useRules()
  const patch = usePatchRule()
  const reorder = useReorderRules()
  const remove = useDeleteRule()
  const apply = useApplyRules()
  const [editor, setEditor] = useState<EditorTarget | null>(null)
  const [toDelete, setToDelete] = useState<RuleWithStats | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const list = rules.data?.rules ?? []

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = list.findIndex((r) => r.id === active.id)
    const to = list.findIndex((r) => r.id === over.id)
    if (from < 0 || to < 0) return
    reorder.mutate(arrayMove(list, from, to).map((r) => r.id))
  }

  const openNew = () => setEditor({ key: newId(), mode: "new", initial: emptyRule() })
  const openEdit = (r: RuleWithStats) =>
    setEditor({
      key: newId(),
      mode: "edit",
      ruleId: r.id,
      isDefault: r.isDefault,
      initial: ruleToInput(r),
    })
  const openDuplicate = (r: RuleWithStats) => {
    const input = ruleToInput(r)
    setEditor({
      key: newId(),
      mode: "duplicate",
      initial: {
        ...input,
        name: `Copy of ${r.name}`.slice(0, 120),
        conditions: cloneWithNewIds(input.conditions),
      },
    })
  }

  return (
    <section className="flex flex-col gap-3" aria-labelledby="rules-title">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="rules-title" className="text-base font-semibold">
            Rules
          </h2>
          <p className="text-sm text-muted-foreground">
            Run top to bottom on every new item. Drag to change the order.
          </p>
        </div>
        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => apply.mutate()} disabled={apply.isPending}>
              <RefreshCw className={apply.isPending ? "animate-spin" : undefined} />
              Re-apply to existing items
            </Button>
            <Button onClick={openNew}>
              <Plus /> New rule
            </Button>
          </div>
        ) : null}
      </div>

      {rules.isPending ? (
        <div
          className="space-y-2 rounded-xl border p-3"
          aria-busy="true"
          aria-label="Loading rules"
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : rules.isError ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Couldn’t load rules</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            {rules.error.message}
            <Button size="sm" variant="outline" onClick={() => void rules.refetch()}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : list.length === 0 ? (
        <EmptyState
          icon={Filter}
          title="No rules yet"
          description="Rules decide what the team never needs to see: spam, reactions, emoji-only comments."
        >
          {canEdit ? (
            <Button onClick={openNew}>
              <Plus /> New rule
            </Button>
          ) : null}
        </EmptyState>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={list.map((r) => r.id)} strategy={verticalListSortingStrategy}>
            <ul
              className="overflow-hidden rounded-xl border"
              aria-label="Filter rules in evaluation order"
            >
              {list.map((rule, i) => (
                <RuleRow
                  key={rule.id}
                  rule={rule}
                  index={i}
                  canEdit={canEdit}
                  canDrag={canEdit && !reorder.isPending}
                  onEdit={() => openEdit(rule)}
                  onDuplicate={() => openDuplicate(rule)}
                  onToggle={(enabled) => patch.mutate({ id: rule.id, patch: { enabled } })}
                  onToggleDryRun={() =>
                    patch.mutate({ id: rule.id, patch: { dryRun: !rule.dryRun } })
                  }
                  onDelete={() => setToDelete(rule)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}

      <RuleEditor target={editor} onClose={() => setEditor(null)} readOnly={!canEdit} />

      <AlertDialog
        open={toDelete !== null}
        onOpenChange={(open) => (open ? undefined : setToDelete(null))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{toDelete?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {toDelete?.isDefault
                ? "This is a default rule. Disabling it keeps it around in case you want it back; deleting can’t be undone."
                : "This can’t be undone. Items it filtered will be re-checked against the remaining rules."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {toDelete?.isDefault && toDelete.enabled ? (
              <AlertDialogAction
                variant="outline"
                onClick={() => {
                  patch.mutate({ id: toDelete.id, patch: { enabled: false } })
                  setToDelete(null)
                }}
              >
                Disable instead
              </AlertDialogAction>
            ) : null}
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (toDelete) remove.mutate(toDelete.id)
                setToDelete(null)
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
