"use client"

import { useMemo, useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { CircleCheck, CircleX, Info, Loader2, PlugZap, TriangleAlert } from "lucide-react"
import {
  Controller,
  useWatch,
  type Control,
  type FieldPath,
  type FieldValues,
} from "react-hook-form"
import {
  AI_PROVIDERS,
  AI_PROVIDER_LABELS,
  AI_MODEL_SUGGESTIONS,
  AI_PROVIDER_SECRET,
  AI_DEFAULT_BASE_URLS,
  PLATFORM_VERSIONS,
  type AiProvider,
  type SettingsResponse,
} from "@inbox/core"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { TagInput } from "@/components/app/tag-input"
import { SimpleSelect, type SelectOption } from "@/components/filters/simple-select"
import { api } from "@/lib/api"
import { ModelPicker } from "./model-picker"
import { CopyField, SecretField } from "./secret-field"
import {
  SectionFormShell,
  SettingsCard,
  SwitchField,
  TextField,
  useSectionForm,
} from "./section-form"

// ─── Shared field helpers ──────────────────────────────────────────────────────

export function SelectField<T extends FieldValues, V extends string>({
  control,
  name,
  label,
  description,
  options,
}: {
  control: Control<T>
  name: FieldPath<T>
  label: string
  description?: React.ReactNode
  options: SelectOption<V>[]
}) {
  const id = `settings-${name.replaceAll(".", "-")}`
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <SimpleSelect<V>
            id={id}
            aria-label={label}
            options={options}
            value={(field.value as V | undefined) ?? null}
            onChange={field.onChange}
            invalid={fieldState.invalid}
          />
          {description ? <FieldDescription>{description}</FieldDescription> : null}
          {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
        </Field>
      )}
    />
  )
}

function TextareaField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  placeholder,
  rows = 4,
}: {
  control: Control<T>
  name: FieldPath<T>
  label: string
  description?: React.ReactNode
  placeholder?: string
  rows?: number
}) {
  const id = `settings-${name.replaceAll(".", "-")}`
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <Field data-invalid={fieldState.invalid}>
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          <Textarea
            id={id}
            rows={rows}
            placeholder={placeholder}
            aria-invalid={fieldState.invalid || undefined}
            {...field}
            value={(field.value as string | undefined) ?? ""}
          />
          {description ? <FieldDescription>{description}</FieldDescription> : null}
          {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
        </Field>
      )}
    />
  )
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-5 sm:grid-cols-2">{children}</div>
}

// ─── General ───────────────────────────────────────────────────────────────────

const TIME_ZONES: string[] = (() => {
  try {
    return Intl.supportedValuesOf("timeZone")
  } catch {
    return ["UTC"]
  }
})()

export function GeneralTab({ data }: { data: SettingsResponse }) {
  const router = useRouter()
  // The org name shows in the sidebar, which is rendered from the server session.
  const sf = useSectionForm("general", data, { onSaved: () => router.refresh() })
  const { control } = sf.form
  return (
    <SectionFormShell sf={sf}>
      <SettingsCard title="Workspace">
        <Grid>
          <TextField control={control} name="organizationName" label="Workspace name" />
          <TextField
            control={control}
            name="timezone"
            label="Time zone"
            list="settings-timezones"
            description="Used for day boundaries in Analytics (Phase 10)."
          />
          <datalist id="settings-timezones">
            {TIME_ZONES.map((tz) => (
              <option key={tz} value={tz} />
            ))}
          </datalist>
        </Grid>
      </SettingsCard>
      <SettingsCard
        title="Who can sign in"
        description="Google accounts with these emails, or any account on these domains. Owners can always sign in, so you can’t lock yourself out. Removing someone takes effect at their next sign-in."
      >
        <Controller
          control={control}
          name="signInAllowlist.emails"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="settings-allow-emails">Emails</FieldLabel>
              <TagInput
                id="settings-allow-emails"
                value={(field.value as string[] | undefined) ?? []}
                onChange={field.onChange}
                normalize={(v) => v.trim().toLowerCase()}
                placeholder="name@company.com"
                invalid={fieldState.invalid}
              />
              {fieldState.invalid ? (
                <FieldError errors={[fieldState.error, ...errorsOf(fieldState.error)]} />
              ) : null}
            </Field>
          )}
        />
        <Controller
          control={control}
          name="signInAllowlist.domains"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor="settings-allow-domains">Domains</FieldLabel>
              <TagInput
                id="settings-allow-domains"
                value={(field.value as string[] | undefined) ?? []}
                onChange={field.onChange}
                normalize={(v) => v.trim().toLowerCase().replace(/^@/, "")}
                placeholder="company.com"
                invalid={fieldState.invalid}
              />
              <FieldDescription>Everyone with an address on these domains.</FieldDescription>
              {fieldState.invalid ? (
                <FieldError errors={[fieldState.error, ...errorsOf(fieldState.error)]} />
              ) : null}
            </Field>
          )}
        />
      </SettingsCard>
    </SectionFormShell>
  )
}

/** Array fields report errors per entry (`emails.2`); surface them under the input. */
function errorsOf(error: unknown): ({ message?: string } | undefined)[] {
  if (!error || typeof error !== "object") return []
  return Object.values(error as Record<string, unknown>).filter((e): e is { message?: string } =>
    Boolean(e && typeof e === "object" && "message" in e),
  )
}

// ─── Connections ───────────────────────────────────────────────────────────────

export function ConnectionsTab({ data }: { data: SettingsResponse }) {
  const sf = useSectionForm("connections", data)
  const { control } = sf.form
  const secrets = data.sections.connections.secrets
  const { meta } = data
  const noPublicUrl = !meta.apiPublicUrl || meta.apiPublicUrl.startsWith("http://localhost")
  return (
    <SectionFormShell sf={sf}>
      <Alert>
        <Info />
        <AlertTitle>App credentials for platform connections</AlertTitle>
        <AlertDescription>
          These are your own developer apps at Meta, Google and LinkedIn. The Connect buttons on the
          Connections page use them (from Phase 4). Secrets are encrypted and can’t be read back.
        </AlertDescription>
      </Alert>
      {noPublicUrl ? (
        <Alert>
          <TriangleAlert />
          <AlertTitle>No public API URL yet</AlertTitle>
          <AlertDescription>
            Webhooks need a public HTTPS address. Set <code>API_PUBLIC_URL</code> once the app is
            deployed; until then, the URLs below only work on this machine.
          </AlertDescription>
        </Alert>
      ) : null}

      <SettingsCard
        title="Meta (Facebook + Instagram)"
        description="One Meta app covers Facebook Pages and Instagram business accounts."
      >
        <Grid>
          <TextField control={control} name="meta.appId" label="App ID" placeholder="1234567890" />
          <TextField
            control={control}
            name="meta.graphApiVersion"
            label="Graph API version"
            description={`Default ${PLATFORM_VERSIONS.metaGraphApiVersion}.`}
          />
          <TextField
            control={control}
            name="meta.loginConfigId"
            label="Login configuration ID (optional)"
            description="For “Facebook Login for Business” apps. Blank = ask for permissions directly."
          />
        </Grid>
        <Grid>
          <SecretField
            label="App secret"
            status={secrets.metaAppSecret}
            draft={sf.secrets.metaAppSecret}
            onDraft={(v) => sf.setSecret("metaAppSecret", v)}
            error={sf.secretErrors.metaAppSecret}
          />
          <SecretField
            label="Webhook verify token"
            description="Any random string; paste the same value in the Meta app’s webhook setup."
            status={secrets.metaVerifyToken}
            draft={sf.secrets.metaVerifyToken}
            onDraft={(v) => sf.setSecret("metaVerifyToken", v)}
            error={sf.secretErrors.metaVerifyToken}
          />
        </Grid>
        <Grid>
          <CopyField label="Webhook callback URL" value={meta.webhookUrls.meta} />
          <CopyField label="OAuth redirect URI" value={meta.oauthRedirectUrls.meta} />
        </Grid>
      </SettingsCard>

      <SettingsCard
        title="Google (Business Profile + YouTube)"
        description="An OAuth client in your Google Cloud project. This is separate from the sign-in client."
      >
        <Grid>
          <TextField
            control={control}
            name="google.clientId"
            label="OAuth client ID"
            placeholder="…apps.googleusercontent.com"
          />
          <SecretField
            label="OAuth client secret"
            status={secrets.googleClientSecret}
            draft={sf.secrets.googleClientSecret}
            onDraft={(v) => sf.setSecret("googleClientSecret", v)}
            error={sf.secretErrors.googleClientSecret}
          />
        </Grid>
        <Grid>
          <TextField
            control={control}
            name="google.pubsubTopic"
            label="Pub/Sub topic"
            placeholder="projects/my-project/topics/gbp-reviews"
            description="New and edited reviews are pushed here. Grant mybusiness-api-pubsub@system.gserviceaccount.com the Publisher role on it."
          />
          <TextField
            control={control}
            name="google.pubsubAudience"
            label="Pub/Sub push audience"
            placeholder={meta.webhookUrls.google}
            description="Leave empty to use the push endpoint URL."
          />
          <TextField
            control={control}
            name="google.pushServiceAccountEmail"
            label="Push service account"
            type="email"
            placeholder="pubsub-push@project.iam.gserviceaccount.com"
            description="Only pushes signed by this account are accepted."
          />
        </Grid>
        <Grid>
          <CopyField label="Pub/Sub push endpoint" value={meta.webhookUrls.google} />
          <CopyField label="OAuth redirect URI" value={meta.oauthRedirectUrls.google} />
        </Grid>
        <details className="group">
          <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
            Advanced: API base URLs
          </summary>
          <div className="mt-4">
            <Grid>
              <TextField
                control={control}
                name="google.reviewsBaseUrl"
                label="Reviews API"
                type="url"
              />
              <TextField
                control={control}
                name="google.notificationsBaseUrl"
                label="Notifications API"
                type="url"
              />
            </Grid>
          </div>
        </details>
      </SettingsCard>

      <SettingsCard
        title="LinkedIn"
        description="Needs Community Management API access for your LinkedIn app (Phase 9)."
      >
        <Grid>
          <TextField control={control} name="linkedin.clientId" label="Client ID" />
          <SecretField
            label="Client secret"
            status={secrets.linkedinClientSecret}
            draft={sf.secrets.linkedinClientSecret}
            onDraft={(v) => sf.setSecret("linkedinClientSecret", v)}
            error={sf.secretErrors.linkedinClientSecret}
          />
        </Grid>
        <Grid>
          <TextField
            control={control}
            name="linkedin.apiVersion"
            label="API version"
            description={`YYYYMM. Default ${PLATFORM_VERSIONS.linkedinApiVersion}.`}
          />
          <CopyField label="Webhook URL" value={meta.webhookUrls.linkedin} />
        </Grid>
        <CopyField label="OAuth redirect URI" value={meta.oauthRedirectUrls.linkedin} />
      </SettingsCard>
    </SectionFormShell>
  )
}

// ─── Filters ───────────────────────────────────────────────────────────────────

export function FiltersTab({ data }: { data: SettingsResponse }) {
  const sf = useSectionForm("filters", data)
  const { control } = sf.form
  return (
    <SectionFormShell sf={sf}>
      <SettingsCard title="Filtering">
        <SwitchField
          control={control}
          name="autoRefilter"
          label="Re-apply rules automatically"
          description="After a rule or list change, re-run the rules over items still waiting in the inbox. Off: use “Apply to existing items” on the Filters page."
        />
        <SwitchField
          control={control}
          name="aiChecks"
          label="AI checks"
          description="Score spam, sentiment and toxicity with your AI provider so rules can use them. Needs AI replies set up (Phase 4)."
        />
      </SettingsCard>
    </SectionFormShell>
  )
}

// ─── AI replies ────────────────────────────────────────────────────────────────

const AI_KEY = AI_PROVIDER_SECRET

export function AiTab({ data }: { data: SettingsResponse }) {
  const sf = useSectionForm("ai", data)
  const { control } = sf.form
  const provider = useWatch({ control, name: "provider" }) ?? "anthropic"
  const model = useWatch({ control, name: `models.${provider}` })
  const baseUrl = useWatch({ control, name: `baseUrls.${provider}` }) ?? ""
  const secrets = data.sections.ai.secrets
  const typedKey = sf.secrets[AI_KEY[provider]] ?? undefined
  const keySaved = secrets[AI_KEY[provider]].set && sf.secrets[AI_KEY[provider]] !== null
  const providerOptions = useMemo(
    () => AI_PROVIDERS.map((p) => ({ value: p, label: AI_PROVIDER_LABELS[p] })),
    [],
  )
  return (
    <SectionFormShell sf={sf}>
      <SettingsCard
        title="AI reply drafts"
        description="Drafts are suggestions: every public reply still needs a person to press Send. Drafting starts in Phase 4."
      >
        <SwitchField control={control} name="enabled" label="Draft replies with AI" />
        <Grid>
          <SelectField
            control={control}
            name="provider"
            label="Provider"
            options={providerOptions}
          />
          <Controller
            key={provider}
            control={control}
            name={`models.${provider}`}
            render={({ field, fieldState }) => (
              <Field data-invalid={fieldState.invalid}>
                <FieldLabel htmlFor={`settings-models-${provider}`}>
                  {AI_PROVIDER_LABELS[provider]} model
                </FieldLabel>
                <ModelPicker
                  id={`settings-models-${provider}`}
                  provider={provider}
                  value={String(field.value ?? "")}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  invalid={fieldState.invalid}
                  placeholder={AI_MODEL_SUGGESTIONS[provider] || "Choose a model"}
                  typedKey={typedKey}
                  keySaved={keySaved}
                  baseUrl={String(baseUrl)}
                />
                <FieldDescription>
                  Pick from the provider’s live list, or type any model ID into the search box.
                </FieldDescription>
                {fieldState.invalid ? <FieldError errors={[fieldState.error]} /> : null}
              </Field>
            )}
          />
        </Grid>
        <SecretField
          key={provider}
          label={`${AI_PROVIDER_LABELS[provider]} API key`}
          status={secrets[AI_KEY[provider]]}
          draft={sf.secrets[AI_KEY[provider]]}
          onDraft={(v) => sf.setSecret(AI_KEY[provider], v)}
          error={sf.secretErrors[AI_KEY[provider]]}
        />
        <TextField
          key={`base-${provider}`}
          control={control}
          name={`baseUrls.${provider}`}
          label={`${AI_PROVIDER_LABELS[provider]} API endpoint`}
          type="url"
          placeholder={AI_DEFAULT_BASE_URLS[provider]}
          description="Leave blank for the default. Set it to route through a proxy or AI gateway that speaks the same API. Model list, test and drafts all use it."
        />
        <TestAiButton
          provider={provider}
          model={String(model ?? "")}
          typedKey={typedKey}
          keySaved={keySaved}
          baseUrl={String(baseUrl)}
        />
        <p className="text-xs text-muted-foreground">
          Keys saved for other providers:{" "}
          {AI_PROVIDERS.filter((p) => p !== provider)
            .map((p) => `${AI_PROVIDER_LABELS[p]}: ${secrets[AI_KEY[p]].set ? "saved" : "none"}`)
            .join(" · ")}
        </p>
      </SettingsCard>
      <SettingsCard title="Drafting">
        <Grid>
          <TextField
            control={control}
            name="draftsPerItem"
            label="Drafts per item"
            type="number"
            min={1}
            max={3}
          />
          <SelectField
            control={control}
            name="generateOn"
            label="When to draft"
            options={[
              { value: "arrival", label: "As soon as an item arrives" },
              { value: "open", label: "When someone opens the item (cheaper)" },
            ]}
          />
        </Grid>
        <TextareaField
          control={control}
          name="brandVoice"
          label="Brand voice"
          placeholder="Warm and brief. Sign off with the first name. Never offer discounts in public replies."
          description="Instructions added to every draft (up to 2,000 characters)."
        />
        <SwitchField
          control={control}
          name="replyInCustomerLanguage"
          label="Reply in the customer’s language"
        />
      </SettingsCard>
    </SectionFormShell>
  )
}

/** Checks the key and model with one tiny request (typed key first, else the saved one). */
function TestAiButton({
  provider,
  model,
  typedKey,
  keySaved,
  baseUrl,
}: {
  provider: AiProvider
  model: string
  typedKey: string | undefined
  keySaved: boolean
  baseUrl: string
}) {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const test = useMutation({
    mutationFn: () =>
      api<{ ok: true; reply: string }>("/settings/ai/test", {
        method: "POST",
        body: {
          provider,
          model,
          baseUrl: baseUrl.trim(),
          ...(typedKey?.trim() ? { apiKey: typedKey.trim() } : {}),
        },
      }),
    onMutate: () => setResult(null),
    onSuccess: () => setResult({ ok: true, message: "Connected. The key and model work." }),
    onError: (err) =>
      setResult({ ok: false, message: err instanceof Error ? err.message : "Test failed" }),
  })
  const canTest = model.trim() !== "" && (keySaved || Boolean(typedKey?.trim()))
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!canTest || test.isPending}
        onClick={() => test.mutate()}
      >
        {test.isPending ? <Loader2 className="animate-spin" /> : <PlugZap />}
        Test connection
      </Button>
      {result ? (
        <span
          role="status"
          className={`flex min-w-0 items-center gap-1.5 text-sm ${result.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}
        >
          {result.ok ? (
            <CircleCheck className="size-4 shrink-0" />
          ) : (
            <CircleX className="size-4 shrink-0" />
          )}
          <span className="min-w-0 break-words">{result.message}</span>
        </span>
      ) : !canTest ? (
        <span className="text-xs text-muted-foreground">Add a key and a model to test.</span>
      ) : null}
    </div>
  )
}

// ─── Replies ───────────────────────────────────────────────────────────────────

export function RepliesTab({ data }: { data: SettingsResponse }) {
  const sf = useSectionForm("replies", data)
  const { control } = sf.form
  const autoReply = useWatch({ control, name: "allowAutoReplyRules" })
  return (
    <SectionFormShell sf={sf}>
      <SettingsCard title="Sending">
        <Grid>
          <TextField
            control={control}
            name="undoSeconds"
            label="Undo window"
            type="number"
            min={0}
            max={30}
            suffix="seconds"
            description="How long a sent reply can still be cancelled before it posts. 0 sends at once."
          />
          <SelectField
            control={control}
            name="afterSend"
            label="After sending"
            options={[
              { value: "next", label: "Open the next item" },
              { value: "stay", label: "Stay on the item" },
            ]}
          />
        </Grid>
      </SettingsCard>
      <SettingsCard
        title="Signature"
        description="Added to the end of replies of the chosen types."
      >
        <TextareaField
          control={control}
          name="signature"
          label="Signature"
          rows={2}
          placeholder="– The Demo Bistro team"
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <SwitchField control={control} name="signatureOn.review" label="Reviews" />
          <SwitchField control={control} name="signatureOn.comment" label="Comments" />
          <SwitchField control={control} name="signatureOn.dm" label="DMs" />
        </div>
      </SettingsCard>
      <SettingsCard title="Automatic replies">
        <SwitchField
          control={control}
          name="allowAutoReplyRules"
          label="Allow auto-reply rules"
          description="Filter rules marked “auto-reply” post without a person pressing Send. Off: those rules only draft."
        />
        {autoReply ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>
              Auto-replies post publicly with no review. Keep those rules narrow and test them with
              dry run first.
            </AlertDescription>
          </Alert>
        ) : null}
      </SettingsCard>
    </SectionFormShell>
  )
}

// ─── Slack ─────────────────────────────────────────────────────────────────────

export function SlackTab({ data }: { data: SettingsResponse }) {
  const sf = useSectionForm("slack", data)
  const { control } = sf.form
  const secrets = data.sections.slack.secrets
  return (
    <SectionFormShell sf={sf}>
      <Alert>
        <Info />
        <AlertTitle>Slack comes later (Phase 8)</AlertTitle>
        <AlertDescription>
          You can save these settings now, but nothing is posted to Slack until the Slack phase is
          built.
        </AlertDescription>
      </Alert>
      <SettingsCard title="Slack">
        <SwitchField control={control} name="enabled" label="Post new items to Slack" />
        <Grid>
          <TextField
            control={control}
            name="defaultChannelId"
            label="Default channel ID"
            placeholder="C0123456789"
          />
          <TextField
            control={control}
            name="priorityChannelId"
            label="Urgent channel ID"
            placeholder="C0123456789"
          />
        </Grid>
        <TextField
          control={control}
          name="sendPrefix"
          label="Send prefix"
          description="A thread reply that starts with this text is posted as the reply."
          className="max-w-40"
        />
        <Grid>
          <SecretField
            label="Bot token"
            placeholder="xoxb-…"
            status={secrets.botToken}
            draft={sf.secrets.botToken}
            onDraft={(v) => sf.setSecret("botToken", v)}
            error={sf.secretErrors.botToken}
          />
          <SecretField
            label="Signing secret"
            status={secrets.signingSecret}
            draft={sf.secrets.signingSecret}
            onDraft={(v) => sf.setSecret("signingSecret", v)}
            error={sf.secretErrors.signingSecret}
          />
        </Grid>
        <CopyField label="Events and interactivity URL" value={data.meta.webhookUrls.slack} />
      </SettingsCard>
    </SectionFormShell>
  )
}

// ─── Notifications ─────────────────────────────────────────────────────────────

export function NotificationsTab({ data }: { data: SettingsResponse }) {
  const sf = useSectionForm("notifications", data)
  const { control } = sf.form
  return (
    <SectionFormShell sf={sf}>
      <SettingsCard title="While the app is open">
        <SelectField
          control={control}
          name="browser"
          label="Desktop notifications"
          options={[
            { value: "off", label: "Off" },
            { value: "urgent", label: "Urgent items only" },
            { value: "all", label: "Every new inbox item" },
          ]}
          description="Your browser asks for permission the first time."
        />
        <SwitchField control={control} name="sound" label="Play a sound" />
      </SettingsCard>
      <SettingsCard title="Connections">
        <TextField
          control={control}
          name="tokenExpiryWarningDays"
          label="Warn before a connection expires"
          type="number"
          min={1}
          max={30}
          suffix="days"
          className="max-w-28"
          description="Connections whose access expires within this window are marked “Expiring”."
        />
      </SettingsCard>
    </SectionFormShell>
  )
}

// ─── Data ──────────────────────────────────────────────────────────────────────

export function DataTab({ data }: { data: SettingsResponse }) {
  const sf = useSectionForm("data", data)
  const { control } = sf.form
  return (
    <SectionFormShell sf={sf}>
      <SettingsCard
        title="Retention"
        description="A clean-up job runs once a day and deletes data older than these windows."
      >
        <TextField
          control={control}
          name="filteredRetentionDays"
          label="Filtered items"
          type="number"
          min={0}
          suffix="days"
          className="max-w-28"
          description="Items a rule filtered out and nobody restored. 0 keeps them forever; otherwise at least 90."
        />
        <TextField
          control={control}
          name="webhookRetentionDays"
          label="Webhook deliveries"
          type="number"
          min={1}
          max={365}
          suffix="days"
          className="max-w-28"
          description="Raw deliveries shown in the Activity log. Unprocessed ones are kept."
        />
        <TextField
          control={control}
          name="auditRetentionDays"
          label="Audit log"
          type="number"
          min={30}
          suffix="days"
          className="max-w-28"
        />
      </SettingsCard>
    </SectionFormShell>
  )
}
