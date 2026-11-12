"use client"

import { useEffect, useMemo, useState } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2 } from "lucide-react"
import { Controller, useForm, useWatch, type Resolver } from "react-hook-form"
import { toast } from "sonner"
import {
  filterRuleInputSchema,
  ITEM_TYPES,
  PLATFORMS,
  validateConditionTree,
  type FilterRuleInput,
  type ItemType,
  type Platform,
} from "@inbox/core"
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
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { PlatformIcon, PLATFORM_LABELS } from "@/components/app/platform-icon"
import { TYPE_LABELS } from "@/components/app/item-badges"
import { ApiError } from "@/lib/api"
import { ActionsEditor, type RuleFormValues } from "./actions-editor"
import { ConditionBuilder } from "./condition-builder"
import { conditionIssuesFrom } from "./helpers"
import { TestPanel } from "./test-panel"
import { useSaveRule } from "./use-filters"

export type EditorTarget =
  | { key: string; mode: "new" | "duplicate"; initial: FilterRuleInput }
  | { key: string; mode: "edit"; ruleId: string; isDefault: boolean; initial: FilterRuleInput }

export function RuleEditor({
  target,
  onClose,
  readOnly,
}: {
  target: EditorTarget | null
  onClose: () => void
  readOnly: boolean
}) {
  const [dirty, setDirty] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const requestClose = () => {
    if (dirty && !readOnly) setConfirmDiscard(true)
    else onClose()
  }

  return (
    <>
      <Sheet open={target !== null} onOpenChange={(open) => (open ? undefined : requestClose())}>
        <SheetContent
          side="right"
          className="w-full gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-5xl"
        >
          {target ? (
            <RuleForm
              key={target.key}
              target={target}
              readOnly={readOnly}
              onDirtyChange={setDirty}
              onCancel={requestClose}
              onSaved={() => {
                setDirty(false)
                onClose()
              }}
            />
          ) : null}
        </SheetContent>
      </Sheet>
      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>Your edits to this rule will be lost.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmDiscard(false)
                setDirty(false)
                onClose()
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

const PRESSED =
  "data-pressed:border-primary data-pressed:bg-primary data-pressed:text-primary-foreground hover:data-pressed:bg-primary/90"

function ScopeToggle<T extends string>({
  value,
  options,
  onChange,
  allLabel,
  label,
  disabled,
  render,
}: {
  value: "all" | T[]
  options: readonly T[]
  onChange: (next: "all" | T[]) => void
  allLabel: string
  label: string
  disabled: boolean
  render: (v: T) => React.ReactNode
}) {
  const current = value === "all" ? ["all"] : value
  return (
    <ToggleGroup
      multiple
      variant="outline"
      size="sm"
      spacing={1}
      className="flex-wrap"
      aria-label={label}
      value={current}
      disabled={disabled}
      onValueChange={(next: string[]) => {
        const picked = next.filter((v): v is T => v !== "all")
        if (next.includes("all") && value !== "all") onChange("all")
        else if (picked.length === 0) onChange("all")
        else onChange(picked)
      }}
    >
      <ToggleGroupItem value="all" className={PRESSED}>
        {allLabel}
      </ToggleGroupItem>
      {options.map((o) => (
        <ToggleGroupItem key={o} value={o} className={PRESSED}>
          {render(o)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

function RuleForm({
  target,
  readOnly,
  onDirtyChange,
  onCancel,
  onSaved,
}: {
  target: EditorTarget
  readOnly: boolean
  onDirtyChange: (dirty: boolean) => void
  onCancel: () => void
  onSaved: () => void
}) {
  const form = useForm<RuleFormValues, unknown, FilterRuleInput>({
    resolver: zodResolver(filterRuleInputSchema) as unknown as Resolver<
      RuleFormValues,
      unknown,
      FilterRuleInput
    >,
    defaultValues: target.initial,
    mode: "onSubmit",
  })
  const save = useSaveRule()
  const [showTreeErrors, setShowTreeErrors] = useState(false)
  const [serverIssues, setServerIssues] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const ruleId = target.mode === "edit" ? target.ruleId : null

  const conditions = useWatch({ control: form.control, name: "conditions" })
  const treeIssues = useMemo(() => {
    const map: Record<string, string> = {}
    for (const i of validateConditionTree(conditions)) map[i.conditionId] ??= i.message
    return map
  }, [conditions])
  const issues = showTreeErrors ? { ...serverIssues, ...treeIssues } : serverIssues

  const isDirty = form.formState.isDirty
  // Report dirtiness up for the close guard.
  useEffect(() => {
    onDirtyChange(isDirty)
  }, [isDirty, onDirtyChange])

  /** Validates the whole draft (schema + condition tree) for save and test. */
  const validated = (): FilterRuleInput | null => {
    const parsed = filterRuleInputSchema.safeParse(form.getValues())
    const tree = validateConditionTree(form.getValues("conditions"))
    if (!parsed.success || tree.length > 0) {
      setShowTreeErrors(true)
      void form.trigger()
      toast.error("Fix the highlighted fields first")
      return null
    }
    return parsed.data
  }

  const onSubmit = form.handleSubmit(
    async (values) => {
      setFormError(null)
      setServerIssues({})
      if (validateConditionTree(values.conditions).length > 0) {
        setShowTreeErrors(true)
        return
      }
      try {
        await save.mutateAsync({ id: ruleId, rule: values })
        toast.success(ruleId ? "Rule saved" : "Rule created", {
          description: "Existing items are being re-filtered.",
        })
        onSaved()
      } catch (err) {
        if (err instanceof ApiError) {
          setServerIssues(conditionIssuesFrom(err.issues))
          setFormError(err.message)
        } else setFormError("Couldn’t save the rule")
      }
    },
    () => setShowTreeErrors(true),
  )

  const title =
    target.mode === "edit"
      ? readOnly
        ? "View rule"
        : "Edit rule"
      : target.mode === "duplicate"
        ? "Duplicate rule"
        : "New rule"
  const disabled = readOnly || form.formState.isSubmitting

  return (
    <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col" noValidate>
      <SheetHeader className="border-b px-4 py-3 sm:px-6">
        <SheetTitle>{title}</SheetTitle>
        <SheetDescription>
          {target.mode === "edit" && target.isDefault
            ? "A default rule. You can edit or disable it; re-seeding never overwrites your changes."
            : "Rules run in order. The first matching rule with “Stop processing” ends evaluation."}
        </SheetDescription>
      </SheetHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <FieldGroup className="min-w-0">
            <Controller
              name="name"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="rule-name">Name</FieldLabel>
                  <Input
                    {...field}
                    id="rule-name"
                    disabled={disabled}
                    aria-invalid={fieldState.invalid}
                    placeholder="e.g. Archive giveaway spam"
                  />
                  {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                </Field>
              )}
            />
            <Controller
              name="description"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="rule-description">Description</FieldLabel>
                  <Textarea
                    {...field}
                    value={field.value ?? ""}
                    id="rule-description"
                    rows={2}
                    disabled={disabled}
                    placeholder="What does this rule catch, and why?"
                  />
                  {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
                </Field>
              )}
            />

            <FieldSet>
              <FieldLegend variant="label">Applies to</FieldLegend>
              <Controller
                name="platforms"
                control={form.control}
                render={({ field }) => (
                  <ScopeToggle<Platform>
                    label="Platforms"
                    allLabel="All platforms"
                    value={field.value}
                    options={PLATFORMS}
                    onChange={field.onChange}
                    disabled={disabled}
                    render={(p) => (
                      <span className="flex items-center gap-1.5">
                        <PlatformIcon platform={p} title={false} className="size-4" />
                        <span className="hidden sm:inline">{PLATFORM_LABELS[p]}</span>
                      </span>
                    )}
                  />
                )}
              />
              <Controller
                name="itemTypes"
                control={form.control}
                render={({ field }) => (
                  <ScopeToggle<ItemType>
                    label="Item types"
                    allLabel="All types"
                    value={field.value}
                    options={ITEM_TYPES}
                    onChange={field.onChange}
                    disabled={disabled}
                    render={(t) => `${TYPE_LABELS[t]}s`}
                  />
                )}
              />
            </FieldSet>

            <FieldSet>
              <FieldLegend variant="label">When</FieldLegend>
              <Controller
                name="conditions"
                control={form.control}
                render={({ field }) => (
                  <ConditionBuilder
                    value={field.value}
                    onChange={field.onChange}
                    issues={issues}
                    disabled={disabled}
                  />
                )}
              />
            </FieldSet>

            <FieldSet>
              <FieldLegend variant="label">Then</FieldLegend>
              <ActionsEditor
                control={form.control}
                disabled={disabled}
                error={
                  form.formState.errors.actions?.message ??
                  form.formState.errors.actions?.root?.message
                }
              />
            </FieldSet>

            <FieldSet>
              <FieldLegend variant="label">Options</FieldLegend>
              {(
                [
                  ["enabled", "Enabled", "Disabled rules are skipped."],
                  [
                    "dryRun",
                    "Dry run",
                    "Logs matches (shown in the match count) without applying any actions. Use it to try a rule safely.",
                  ],
                  [
                    "stopProcessing",
                    "Stop processing",
                    "When this rule matches, later rules don’t run.",
                  ],
                ] as const
              ).map(([name, label, description]) => (
                <Controller
                  key={name}
                  name={name}
                  control={form.control}
                  render={({ field }) => (
                    <Field orientation="horizontal">
                      <FieldContent>
                        <FieldLabel htmlFor={`rule-${name}`}>{label}</FieldLabel>
                        <FieldDescription>{description}</FieldDescription>
                      </FieldContent>
                      <Switch
                        id={`rule-${name}`}
                        checked={field.value === true}
                        onCheckedChange={field.onChange}
                        disabled={disabled}
                      />
                    </Field>
                  )}
                />
              ))}
            </FieldSet>
          </FieldGroup>

          <div className="lg:sticky lg:top-0 lg:self-start">
            <TestPanel
              ruleId={ruleId}
              getRule={validated}
              onIssues={(list) => {
                setServerIssues(conditionIssuesFrom(list))
                setShowTreeErrors(true)
              }}
            />
          </div>
        </div>
      </div>

      <SheetFooter className="flex-row items-center justify-end gap-2 border-t px-4 py-3 sm:px-6">
        {formError ? (
          <p role="alert" className="mr-auto text-sm text-destructive">
            {formError}
          </p>
        ) : null}
        <Button type="button" variant="outline" onClick={onCancel}>
          {readOnly ? "Close" : "Cancel"}
        </Button>
        {readOnly ? null : (
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? <Loader2 className="animate-spin" /> : null}
            {ruleId ? "Save rule" : "Create rule"}
          </Button>
        )}
      </SheetFooter>
    </form>
  )
}
