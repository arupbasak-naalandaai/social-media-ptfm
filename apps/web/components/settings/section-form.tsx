"use client"

import { useState, type ReactNode } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2 } from "lucide-react"
import {
  Controller,
  useForm,
  type Control,
  type FieldPath,
  type FieldValues,
  type Resolver,
  type UseFormReturn,
} from "react-hook-form"
import {
  SECTION_SCHEMAS,
  type SecretKey,
  type SettingsInputValues,
  type SettingsResponse,
  type SettingsSection,
  type SettingsValues,
} from "@inbox/core"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { ApiError } from "@/lib/api"
import { useSaveSection } from "./use-settings"

export type SecretDrafts<S extends SettingsSection> = Partial<Record<SecretKey<S>, string | null>>

export interface SectionForm<S extends SettingsSection> {
  section: S
  form: UseFormReturn<SettingsInputValues[S], unknown, SettingsValues[S]>
  secrets: SecretDrafts<S>
  setSecret: (key: SecretKey<S>, value: string | null | undefined) => void
  secretErrors: Partial<Record<SecretKey<S>, string>>
  dirty: boolean
  saving: boolean
  submit: () => Promise<void>
  discard: () => void
  data: SettingsResponse
}

/**
 * One settings tab: react-hook-form validated by the same zod schema the api uses, secrets kept
 * apart (only sent when replaced or cleared), and server-side issues mapped back onto fields.
 * Values refreshed by someone else (SSE → refetch) replace untouched fields only.
 */
export function useSectionForm<S extends SettingsSection>(
  section: S,
  data: SettingsResponse,
  opts: { onSaved?: (values: SettingsValues[S]) => void } = {},
): SectionForm<S> {
  const schema = SECTION_SCHEMAS[section]
  const form = useForm<SettingsInputValues[S], unknown, SettingsValues[S]>({
    resolver: zodResolver(schema as never) as unknown as Resolver<
      SettingsInputValues[S],
      unknown,
      SettingsValues[S]
    >,
    values: data.sections[section].values as SettingsInputValues[S],
    resetOptions: { keepDirtyValues: true },
    mode: "onTouched",
  })
  const [secrets, setSecrets] = useState<SecretDrafts<S>>({})
  const [secretErrors, setSecretErrors] = useState<Partial<Record<SecretKey<S>, string>>>({})
  const save = useSaveSection()

  const setSecret = (key: SecretKey<S>, value: string | null | undefined) => {
    setSecretErrors((e) => ({ ...e, [key]: undefined }))
    setSecrets((s) => {
      const next = { ...s }
      if (value === undefined) delete next[key]
      else next[key] = value
      return next
    })
  }

  const submit = form.handleSubmit(async (values) => {
    const secretPayload = Object.fromEntries(
      Object.entries(secrets).filter(([, v]) => v === null || (typeof v === "string" && v.trim())),
    ) as Record<string, string | null>
    try {
      const res = await save.mutateAsync({ section, values, secrets: secretPayload })
      setSecrets({})
      form.reset(res.section.values as SettingsInputValues[S])
      opts.onSaved?.(res.section.values as SettingsValues[S])
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 400) return
      let mapped = false
      for (const issue of err.issues) {
        const path = issue.path ?? ""
        if (path.startsWith("values.")) {
          form.setError(path.slice("values.".length) as FieldPath<SettingsInputValues[S]>, {
            message: issue.message,
          })
          mapped = true
        } else if (path.startsWith("secrets.")) {
          setSecretErrors((e) => ({ ...e, [path.slice("secrets.".length)]: issue.message }))
          mapped = true
        }
      }
      if (!mapped) form.setError("root", { message: err.message })
    }
  })

  return {
    section,
    form,
    secrets,
    setSecret,
    secretErrors,
    dirty:
      form.formState.isDirty ||
      Object.values(secrets).some((v) => v === null || (typeof v === "string" && v.trim() !== "")),
    saving: save.isPending,
    submit,
    discard: () => {
      form.reset(data.sections[section].values as SettingsInputValues[S])
      setSecrets({})
      setSecretErrors({})
    },
    data,
  }
}

/** Form wrapper with a sticky save bar that appears once something changed. */
export function SectionFormShell<S extends SettingsSection>({
  sf,
  children,
  disabled,
}: {
  sf: SectionForm<S>
  children: ReactNode
  disabled?: boolean
}) {
  const rootError = sf.form.formState.errors.root?.message
  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void sf.submit()
      }}
      className="flex flex-col gap-4"
    >
      <fieldset disabled={disabled || sf.saving} className="flex min-w-0 flex-col gap-4">
        {children}
      </fieldset>
      {rootError ? (
        <p role="alert" className="text-sm text-destructive">
          {rootError}
        </p>
      ) : null}
      <div
        data-visible={sf.dirty}
        className="sticky bottom-0 z-10 -mx-1 flex items-center justify-end gap-2 rounded-xl border bg-background/95 px-3 py-2 shadow-sm backdrop-blur transition-opacity data-[visible=false]:pointer-events-none data-[visible=false]:opacity-0"
        aria-hidden={!sf.dirty}
      >
        <span className="mr-auto text-sm text-muted-foreground">Unsaved changes</span>
        <Button
          type="button"
          variant="ghost"
          onClick={sf.discard}
          disabled={sf.saving}
          tabIndex={sf.dirty ? 0 : -1}
        >
          Discard
        </Button>
        <Button type="submit" disabled={sf.saving || disabled} tabIndex={sf.dirty ? 0 : -1}>
          {sf.saving ? <Loader2 className="animate-spin" /> : null}
          Save
        </Button>
      </div>
    </form>
  )
}

export function SettingsCard({
  title,
  description,
  children,
  action,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-5">{children}</CardContent>
    </Card>
  )
}

// ─── Field helpers ─────────────────────────────────────────────────────────────

interface BaseFieldProps<T extends FieldValues> {
  control: Control<T>
  name: FieldPath<T>
  label: string
  description?: ReactNode
}

const fieldId = (name: string) => `settings-${name.replaceAll(".", "-")}`

export function SwitchField<T extends FieldValues>({
  control,
  name,
  label,
  description,
}: BaseFieldProps<T>) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field orientation="horizontal" data-invalid={fieldState.invalid}>
          <FieldContent>
            <FieldLabel htmlFor={fieldId(name)}>{label}</FieldLabel>
            {description ? <FieldDescription>{description}</FieldDescription> : null}
            {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
          </FieldContent>
          <Switch
            id={fieldId(name)}
            checked={Boolean(field.value)}
            onCheckedChange={field.onChange}
            onBlur={field.onBlur}
          />
        </Field>
      )}
    />
  )
}

export function TextField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  placeholder,
  type = "text",
  suffix,
  min,
  max,
  className,
  list,
  autoComplete = "off",
}: BaseFieldProps<T> & {
  placeholder?: string
  type?: "text" | "number" | "email" | "url"
  suffix?: string
  min?: number
  max?: number
  className?: string
  list?: string
  autoComplete?: string
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={fieldId(name)}>{label}</FieldLabel>
          <div className="flex items-center gap-2">
            <Input
              id={fieldId(name)}
              type={type}
              inputMode={type === "number" ? "numeric" : undefined}
              min={min}
              max={max}
              list={list}
              autoComplete={autoComplete}
              placeholder={placeholder}
              aria-invalid={fieldState.invalid || undefined}
              className={className}
              name={field.name}
              ref={field.ref}
              onBlur={field.onBlur}
              value={field.value === undefined || field.value === null ? "" : String(field.value)}
              onChange={(e) => {
                if (type !== "number") return field.onChange(e.target.value)
                const raw = e.target.value
                // Keep "" as NaN-free empty so zod reports "Enter a number" instead of 0.
                field.onChange(raw === "" ? undefined : Number(raw))
              }}
            />
            {suffix ? (
              <span className="shrink-0 text-sm text-muted-foreground">{suffix}</span>
            ) : null}
          </div>
          {description ? <FieldDescription>{description}</FieldDescription> : null}
          {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
        </Field>
      )}
    />
  )
}
