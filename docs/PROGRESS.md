# Progress

> Read alongside [`PLAN.md`](./PLAN.md). Update at the end of every phase.

## Status

| Phase                           | Status      | Notes                                                                                 |
| ------------------------------- | ----------- | ------------------------------------------------------------------------------------- |
| 0. Plan                         | ✅ Done     | Questions answered 2026-11-12 (see PLAN §18)                                          |
| 1. Foundation                   | 🟡 Built    | 2026-11-12. One acceptance step left: a real Google sign-in (needs your OAuth client) |
| 2. Filters + Inbox on seed data | ✅ Done     | 2026-11-12. Acceptance verified in the browser and in API integration tests           |
| 3. Settings + scheduler         | ⏳ Next     |                                                                                       |
| 4. Google reviews + AI drafts   | ⏳          | Needs GBP API access + a public URL (Phase D)                                         |
| 5. Meta comments                | ⏳          | Needs Meta App Review + Phase D                                                       |
| 6. YouTube                      | ⏳          | Polling only: works locally                                                           |
| 7. Meta DMs                     | ⏳          | Needs Meta App Review (messaging)                                                     |
| 8. Slack                        | 💤 Deferred | Not in MVP                                                                            |
| 9. LinkedIn comments            | ⏳          | Needs Community Management API approval + Phase D                                     |
| 10. Analytics                   | ⏳          |                                                                                       |
| D. Deploy to Railway            | 💤 Deferred | Run when requested; required before real webhooks                                     |

## Phase 1: Foundation (2026-11-12)

**Acceptance:** "Locally, the owner signs in with one click and sees the empty app shell; a non-allowlisted Google account is rejected."

| Check                                                                                                                             | Result                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Monorepo (pnpm + turbo), strict TS, ESLint, Prettier                                                                              | ✅ `pnpm lint typecheck test build`: 16/16 tasks green                                                              |
| Prisma 7 + Postgres, first migration (`init_auth_settings`)                                                                       | ✅ Applied to local `social_inbox`                                                                                  |
| Hono api: `/health`, better-auth at `/api/auth/*`, session + org + role middleware, `/api/me`                                     | ✅ 10 route tests; smoke-tested on IPv4 + IPv6 (`::`)                                                               |
| Worker: pg-boss with 7 queues + dead-letter queues, `/health`, scheduler tick stub                                                | ✅ Queues created; restart is idempotent                                                                            |
| Allowlist + roles (first user → owner, allowlist on sign-up and every sign-in, owners never locked out, `BOOTSTRAP_OWNER_EMAILS`) | ✅ 6 integration tests through better-auth's real hooks + 20 unit tests                                             |
| Next shell: sidebar layout, dark mode, theme toggle, user menu + sign out, role-filtered nav, empty/loading/error states, mobile  | ✅ Checked in headless Chrome (desktop light, mobile dark, member vs owner); no console errors                      |
| `/api/*` rewrite → api with same-origin cookies; proxy redirects; signed-in shell from a real session                             | ✅ Verified with a session created through better-auth (preview data wiped afterwards)                              |
| **One-click Google sign-in (One Tap + button), end to end**                                                                       | ⏳ **Needs your Google OAuth client** in `.env` (see README step 2). Everything up to Google's redirect is in place |

### What was built

- **`apps/web`:**
  - The old `dashboard/` scaffold, moved and switched to pnpm.
  - Sign-in page with One Tap and the "Continue with Google" fallback, plus plain-language error messages.
  - `(app)` shell: sidebar, header, theme, user menu, and one empty-state page per section.
  - `/no-access` page, `/healthz`, and the `/api/*` rewrite.
- **`apps/api`:**
  - Env validation (zod), request IDs, structured pino logs.
  - better-auth mount, `sessionMiddleware` / `requireAuth` / `requireRole`, `/api/me`, `/health`.
- **`apps/worker`:** pg-boss startup (`pgboss` schema), queue upsert with retry/backoff/DLQ, `/health`, graceful shutdown.
- **`packages/auth`:** better-auth config (Google + One Tap + organization plugin, encrypted OAuth tokens) and the access policy.
- **`packages/db`:** Prisma schema (better-auth tables + `Settings` + `AuditLog`), client factory using the pg adapter.
- **`packages/core`:** roles, allowlist schema and matching, general-settings schema, queue config, logger with secret redaction.
- **Repo:** `.env.example` (every variable documented), `docker-compose.yml` (optional Postgres), README.

### Deviations from the plan (all recorded in PLAN.md)

- **ESLint 9.39** instead of 10: eslint-config-next's plugins don't support 10 yet.
- **shadcn's current default style is `base-nova` (Base UI).** Components use `render={...}` instead of `asChild`.
- **Workspace scope `@inbox/*`.**
- **New optional env vars:** `BOOTSTRAP_OWNER_EMAILS` and `TEST_DATABASE_URL`, plus local port vars `WEB_PORT`, `API_PORT`, `WORKER_PORT`.
- **Session read in Next:** uses `'use cache: private'` + per-component Suspense, per Next 16's "Authentication with Cache Components" guide.

### Known notes

- **Preview mode:** `DEV_AUTH_BYPASS=true` is set in the local `.env`, so the UI is browsable without signing in. Turn it off to test the real sign-in flow and the redirects.

- **Port 3000** is used by another app on the dev machine. The stack was verified on `WEB_PORT=3100`. Either stop that app or set `WEB_PORT` and update the URLs and Google client.
- **Node 26 locally:** Prisma's installer warns that Node 26 is unsupported, but generate, migrate and runtime all work. Deploys target Node 24 (`.nvmrc`).
- **`pnpm auth:generate` rewrites `schema.prisma`.** Afterwards, re-check the `Organization` back-relations to `Settings` and `AuditLog`.

## Phase 2: Filters + Inbox on seed data (2026-11-12)

**Acceptance:** "Editing a rule changes what appears in the inbox, and all filter tests pass."

| Check                            | Result                                                                                                                                                                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Editing a rule changes the inbox | ✅ In headless Chrome: toggling "Archive emoji-only…" on /filters made "nice" appear in an open /inbox tab **141 ms later without a reload**, and re-enabling hid it again (108 ms). Also covered by an API integration test (PATCH rule → refilter → list) |
| Filter tests                     | ✅ 457 core tests: every field × operator (a coverage test fails if a pair is missing), derive, evaluate semantics, all 13 default rules on all 5 platforms                                                                                                 |
| Whole repo                       | ✅ lint + typecheck (15 tasks), 492 tests (core 457, api 28, auth 7), production web build                                                                                                                                                                  |

### What was built

- **Data model:**
  - New models: `PlatformAccount`, `SyncState`, `WebhookEvent`, `Item`, `Conversation`, `AiDraft`, `Reply`, `FilterRule`, `RuleMatch`, `ListEntry`.
  - New `resolved` status.
  - `ListEntry` uniqueness uses `NULLS NOT DISTINCT`.
  - Migrations: `inbox_domain`, `list_entry_nulls_not_distinct`, `item_status_resolved`.
- **`@inbox/core` filter engine:** zod contract, field/operator metadata (shared with the UI), derived fields, `evaluate`, 13 default rules, and default keyword/domain lists.
- **`@inbox/pipeline` (new):**
  - ingest: normalize → filter → store. It is idempotent; edits and deletions update the existing item.
  - re-filter after rule or list changes.
  - Postgres NOTIFY.
  - seed (`pnpm db:seed [--reset]`): demo org, 5 demo accounts, rules, lists, and 100 items (92 stored, 8 dropped as noise).
- **API:**
  - items: list with filters, sort, pagination and counts; detail with thread, matched rules and reply window; resolve, ignore, reopen, archive, restore (+ allowlist).
  - filters: CRUD, toggles, reorder, read-only test panel, re-apply.
  - lists.
  - SSE `/api/stream` (one LISTEN connection per process).
  - Every rule and list change is audited and queues a re-filter.
- **Worker:** handles the `filter` queue. pg-boss LISTEN/NOTIFY is on, so jobs start immediately.
- **Web:**
  - Inbox (Open/Done) and Filtered: URL-synced filters, TanStack v9 table, "load more".
  - Item sheet: DM thread, reply-window state, matched rules, AI-drafts placeholder, disabled reply box with a hint, actions, and "Not spam" with an optional allowlist entry.
  - Shortcuts: j/k, Enter/o, r, e, i, Esc.
  - Filters page:
    - Sortable rules (mouse and keyboard), toggles, dry run, and a delete dialog that suggests "Disable instead" for defaults.
    - Rule editor with nested All/Any/None groups and inputs that adapt to the field, list references and regex safety; the actions editor warns when Drop is chosen.
    - Test panel (sample text / last 200 items); lists editor.
  - Header dot showing whether live updates are connected.
  - Every page has empty, loading and error states. Mobile layouts were checked.

### Decisions and deviations

- **Bootstrap:** the first user to sign in claims an existing org that has no owner (the seeded demo workspace) instead of being locked out by it. Covered by an integration test.
- **Re-filtering:** only items still in the automatic flow are re-filtered (`new`/`filtered`, no `manualOverride`). An already-stored item that a rule now "drops" is set to `filtered`, never deleted.
- **Statuses:** `filtered` (by a rule) and `archived` (by a person) are distinct statuses. `resolved` means done without a reply.
- **Pagination:** the item list uses an offset cursor, which is simple and fine at this volume. Keyset pagination can replace it later.
- **SSE fix:** Hono's `streamSSE` overwrote `Cache-Control`, so Next's dev proxy gzipped and buffered the stream. The fix sets `no-cache, no-transform` on the response after `streamSSE`. A regression test covers it.
- **Test runs:** `pnpm test` runs packages serially (`--concurrency=1`) because the auth and api integration tests share `TEST_DATABASE_URL`.
- **Slack actions:** `routeSlackChannel` / `skipSlack` are kept in the schema and engine, but the rule editor can't add them while Slack is deferred (existing ones show as inactive).

### Known notes

- **Spam keywords:** the default list includes "collab" and "followers", which also catches business inquiries in DMs (one seeded DM lands in Filtered). It's editable on the Lists tab, and "Not spam" restores the item.
- **Replies and AI drafts:** sending is disabled until platforms connect (Phase 4+), and AI drafts are a placeholder.
- **Shared test database:** the integration tests truncate `TEST_DATABASE_URL`. Never point it at the dev database.

## Open questions

- None blocking Phase 3.
- Not answered yet, and not blocking: which platforms and how many pages/locations/channels exist, and whether a Meta app, GCP project, or LinkedIn app already exists. Needed before Phase 4.

## Decisions log

| Date       | Decision                                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-12 | Prisma pinned to 7.10.1 (8.x is RC and outside better-auth's peer range)                                                                  |
| 2026-11-12 | TypeScript pinned to 6.0.3 (typescript-eslint does not support 7.x yet)                                                                   |
| 2026-11-12 | TanStack Table v9 (matches the current shadcn data-table guide)                                                                           |
| 2026-11-12 | Live fan-out via Postgres LISTEN/NOTIFY: no Redis                                                                                         |
| 2026-11-12 | Blocklist/Allowlist/keyword lists stored in one `ListEntry` table                                                                         |
| 2026-11-12 | Platform connections use custom one-click OAuth flows, not better-auth `linkSocial` (org-owned, derived Page tokens, IG Unified Login)    |
| 2026-11-12 | Sign-in: better-auth Google One Tap plugin + "Continue with Google" fallback                                                              |
| 2026-11-12 | AI providers: Claude, ChatGPT, Gemini via Vercel AI SDK (`@ai-sdk/anthropic`/`openai`/`google`)                                           |
| 2026-11-12 | Slack deferred (Phase 8); Railway deploy deferred (Phase D); no custom domain yet                                                         |
| 2026-11-12 | MVP is one org + one user; organization plugin and roles kept for later expansion                                                         |
| 2026-11-12 | `dashboard/` (bun scaffold) replaced by `apps/web` on pnpm                                                                                |
| 2026-11-12 | ESLint 9.39 (not 10) until eslint-config-next's plugins support 10                                                                        |
| 2026-11-12 | shadcn `base-nova` style (Base UI primitives), the CLI default                                                                            |
| 2026-11-12 | Owners always pass the sign-in check; first-owner bootstrap serialized with a Postgres advisory lock; optional `BOOTSTRAP_OWNER_EMAILS`   |
| 2026-11-12 | Web reads the session via `'use cache: private'` `getCurrentMe()` → api `/api/me`; `proxy.ts` is an optimistic cookie check only          |
| 2026-11-12 | `DEV_AUTH_BYPASS` local preview mode (virtual user, no DB writes, refused in production/Railway), requested to check the UI without login |
| 2026-11-12 | `resolved` status (done without reply); `filtered` (rule) vs `archived` (person)                                                          |
| 2026-11-12 | First sign-in claims an ownerless (seeded) org as owner                                                                                   |
| 2026-11-12 | Re-filter touches only `new`/`filtered` items without `manualOverride`; stored items are never deleted by a later drop rule               |
| 2026-11-12 | `@inbox/pipeline` package for DB-aware pipeline code shared by api, worker and seed                                                       |
| 2026-11-12 | React Query for client data; SSE invalidates query prefixes                                                                               |
