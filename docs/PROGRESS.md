# Progress

> Read alongside [`PLAN.md`](./PLAN.md). Update at the end of every phase.

## Status

| Phase                           | Status      | Notes                                                                                              |
| ------------------------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| 0. Plan                         | ✅ Done     | Questions answered 2026-11-12 (see PLAN §18)                                                       |
| 1. Foundation                   | 🟡 Built    | 2026-11-12. One acceptance step left: a real Google sign-in (needs your OAuth client)              |
| 2. Filters + Inbox on seed data | ✅ Done     | 2026-11-12. Acceptance verified in the browser and in API integration tests                        |
| 3. Settings + scheduler         | ✅ Done     | 2026-11-13. Acceptance verified in the browser and in API integration tests                        |
| 4. Google reviews + AI drafts   | 🟡 Built    | 2026-11-13. Code + tests done. Acceptance needs your GBP API access, OAuth client and a public URL |
| 5. Meta comments                | 🟡 Built    | 2026-11-13. Code + tests; webhook path checked locally with signed fixtures. Needs your Meta app   |
| 6. YouTube                      | 🟡 Built    | 2026-11-13. Code + tests. Acceptance needs your Google OAuth client + a channel                    |
| 7. Meta DMs                     | 🟡 Built    | 2026-11-13. Code + tests; DM → reply checked locally on demo accounts. Needs your Meta app         |
| 8. Slack                        | 💤 Deferred | Not in MVP                                                                                         |
| 9. LinkedIn comments            | ⏳          | Needs Community Management API approval + Phase D                                                  |
| 10. Analytics                   | ⏳          |                                                                                                    |
| D. Deploy to Railway            | 💤 Deferred | Run when requested; required before real webhooks                                                  |

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

## Inbox workflow changes (2026-11-13)

Requested after Phase 2: a separate section for people you already interacted with, a better reply surface than the sheet, open-in-app, and hiding generic praise. Design in PLAN §19.

| Check            | Result                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Follow-ups       | ✅ Later activity in a resolved/replied thread leaves Open and shows under Follow-ups ("New activity" first). API integration test + seed (FB DM, IG comment thread, YT reply-to-our-reply)                  |
| Full item page   | ✅ `/items/[id]`: thread incl. our replies, composer, `j`/`k` within the source list, auto-advance after resolve. Checked in headless Chrome at 1400px and 390px (no horizontal scroll, no console errors)   |
| Quick preview    | ✅ Space / eye button opens the sheet; Reply there goes to the full page                                                                                                                                     |
| Open in app      | ✅ `link` on every item (YT comment, IG post, FB/IG inbox, Google reviews); "Copy & open in <app>" in the composer. 9 unit tests                                                                             |
| Low-value filter | ✅ "Good content bro, keep it up 👏", "Thanks for sharing!", "Great video sir, very informative 🙏" archived; questions/links/substantive praise kept. "Hide similar" learns + re-filters (integration test) |
| Whole repo       | ✅ lint, typecheck, 559 tests (core 522, api 30, auth 7)                                                                                                                                                     |

- **Migration** `item_threads_followups_links`: adds `Item.threadKey`, `isFollowUp` and `externalUrl`, with a backfill. Run `pnpm db:migrate` locally. Run `pnpm db:seed` to add the new rule and phrase list to an existing org (it only creates missing ones).
- **Test DB:** apply migrations to `TEST_DATABASE_URL` too (`DATABASE_URL=$TEST_DATABASE_URL pnpm --filter @inbox/db migrate:deploy`).
- **Not changed:** the existing "≤ 2 words" rule still hides one-word questions such as "When?" on comments. Consider exempting `?` or `isReplyToOurReply`.

## Phase 3: Settings + scheduler (2026-11-13)

**Acceptance:** "Changing an interval changes `nextRunAt` immediately without a redeploy."

| Check                  | Result                                                                                                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interval → `nextRunAt` | ✅ In headless Chrome: YouTube 10 → 7 min on Settings → Sync moved `nextRunAt` from 19:38:51 to 19:35:51 (last run 19:28:51 + 7 min) in the same save, and the status table showed it live. Also an API integration test                  |
| Scheduler              | ✅ Live worker against the dev DB: all 7 demo streams polled once and rescheduled on their own intervals; "Run now" in the browser → poll job completed → row updated over SSE. Token check and retention ran once each across 3 restarts |
| Settings               | ✅ 9 tabs. Min intervals and the YouTube quota block (>90%) are enforced in the UI and the api; a stale version gets 409; secrets are encrypted, shown as last 4 only, and never logged in the audit trail                                |
| Activity log           | ✅ Audit log (with actors and before/after), Jobs (pg-boss, filter by state/queue), Webhooks (Replay, admins only; bad signatures can't be replayed)                                                                                      |
| Whole repo             | ✅ lint, typecheck, Prettier, production build, 621 tests (core 563, api 42, pipeline 9, auth 7). No console errors; no horizontal scroll at 390 px                                                                                       |

### What was built

- **`@inbox/core`:** `crypto.ts` (AES-256-GCM, key ids, `ENCRYPTION_KEYS_PREVIOUS` for rotation), a zod schema per Settings tab with secret handling, sync stream definitions and scheduler math (backoff, YouTube quota estimate and Pacific quota day), and the platform API version defaults.
- **`@inbox/pipeline`:** `ensureSyncStates`, `applySyncSettings` (recompute `nextRunAt` in the save transaction), `claimDueSyncStates` / `claimSyncState` leases, `recordPollResult`, `applyRetention`, `checkTokenExpiry`, `loadSettingsSection` / `loadSettingsSecret`.
- **API:** `GET /api/settings`, `PUT /api/settings/:section`, `GET /api/sync`, `POST /api/sync/:id/run`, `GET /api/activity/{audit,jobs,webhooks}`, `POST /api/webhooks/:id/replay`. Rule/list changes respect Settings → Filters → "Re-apply rules automatically".
- **Worker:** scheduler tick, `poll`, `ingest` (webhook replay), `token-refresh`, `maintenance` workers. New `maintenance` queue.
- **Web:** Settings (9 tabs, `?tab=` in the URL, edits survive switching tabs, sticky save bar, field errors from the server, write-only secret fields, copyable webhook/redirect URLs, live YouTube quota meter, sync status with Run now) and Activity log (3 tabs, expandable rows, load more). SSE `sync.changed` / `settings.changed` refresh both.
- **Migration** `activity_sync_indexes` (indexes for the Activity log and sync list).

### Decisions and deviations

- **UTC in raw SQL** (see PLAN §12 "As built"): found while running the worker locally; a session time zone of Asia/Kolkata made schedules due 5.5 h early.
- **Periodic jobs throttled by pg-boss** instead of extra columns: no migration, safe with several worker replicas.
- **`poll` without pg-boss retries;** failed polls also go to `poll-dlq`, which is harmless but grows until pg-boss's retention clears it.
- **Slack tab** is visible but labelled "comes later (Phase 8)"; its settings save but do nothing yet.
- **Audit diffs** are per top-level key, so a Sync change records the whole `streams` object.
- **Toasts sit over the save bar's Save button** for a few seconds after saving (Sonner, bottom-right). Not changed; only matters for an immediate second save.

### Known notes

- **Local Postgres:** Homebrew upgraded `postgresql@18` to 18.7 while 18.6 was running, which broke `plpgsql` (and pg-boss) until the service was restarted (`brew services restart postgresql@18`). Done on 2026-11-13.
- **Seeded demo accounts** run on schedule and fetch nothing. Run `pnpm db:seed` (or start the worker: the token check creates missing schedules) to get sync states on an existing dev DB.

## Phase 4: Google reviews + AI drafts (in progress, 2026-11-13)

**Acceptance:** "A real review arrives, gets drafts, and is replied to from the dashboard." **Not run yet.** It needs things only you can set up (see "Needed from you" below). Everything up to Google's servers is built and tested against stubs.

| Check              | Result                                                                                                                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI drafts          | ✅ Prompt builder (customer text fenced as untrusted data), structured output, de-duplication, per-platform length limits. Integration-tested with the AI SDK's mock model; no real provider call made yet (no key on this machine) |
| Replies            | ✅ In headless Chrome on a demo account: Send → "Reply queued" + Undo (5 s) → Undo restores the text; Send again → worker → `sent`, item `Replied`, reply in the thread over SSE                                                    |
| Double-post safety | ✅ Tests: retries never re-post a sent reply; a non-idempotent send interrupted mid-call fails instead of retrying; Google's PUT is idempotent                                                                                      |
| Google OAuth       | ✅ Tests (Google stubbed): offline + consent + PKCE, state single-use and bound to the signed-in admin, tokens encrypted per location, sync schedules created, Pub/Sub notifications set per account                                |
| Google sync/tokens | ✅ Tests: newest-first paging to the cursor, first-sync backfill, token refresh before expiry, `invalid_grant` → "Reconnect", zero-quota 429 explained                                                                              |
| Pub/Sub push       | ✅ Tests with a locally signed RS256 JWT: valid → stored + ingest queued; wrong audience/sender/unverified email/no token → 401 and stored as bad signature; redelivery de-duplicated                                               |
| Connections page   | ✅ Connect (needs the OAuth client in Settings), include toggle, Test, Reconnect, Disconnect; OAuth results as toasts. Checked at 1400 px and 390 px, no console errors                                                             |
| Whole repo         | ✅ lint, typecheck, Prettier, production build, 661 tests (core 578, api 52, pipeline 24, auth 7)                                                                                                                                   |

### What was built

- **AI drafts:**
  - `@inbox/core` `ai/drafts.ts`: prompt, output schema, `cleanDrafts`, `replyLengthError` (Google counts **bytes**).
  - `@inbox/pipeline` `ai.ts`: provider factory (Claude/ChatGPT/Gemini via AI SDK 7), `draftRepliesForItem`, availability check, key test.
  - Worker `ai-draft` job; drafts on arrival (after a sync) or on open, per Settings.
  - API: `POST /api/items/:id/drafts` (Regenerate; overrides a rule's "no drafts" for that item), `POST /api/settings/ai/test`, `ItemDetail.ai`.
  - Web: drafts panel (Use / Regenerate / why not), and "Test connection" on Settings → AI replies.
- **Replies:**
  - `@inbox/pipeline` `replies.ts`: validation (reply window, length, one in flight, own/filtered items), signature, undo, and the send state machine.
  - Worker `send-reply` job with a sender registry. Demo accounts "send" without posting.
  - API: `POST /api/items/:id/reply`, `POST /api/items/:id/replies/:replyId/cancel`.
  - Web: Send, Undo toast, "after sending" (next/stay), in-flight and failed states.
- **Google Business Profile:**
  - `@inbox/core` `adapters/google`: zod wire schemas, `normalizeGbpReview` (keeps the original text of Google-translated reviews), defensive Pub/Sub parsing, fixture.
  - `@inbox/pipeline` `google.ts`: OAuth + PKCE, token storage/refresh, accounts/locations/reviews/reply/notifications calls, `fetchNewGbpReviews`.
  - Worker: `gbp_reviews` poll adapter, Google reply sender, Pub/Sub handler (a push triggers an immediate reconcile of that location).
  - API: `GET /api/oauth/google/{start,callback}`, `GET/PATCH /api/connections`, `POST /api/connections/:id/{test,disconnect}`, `POST /webhooks/google`.
  - Settings → Connections: new **Pub/Sub topic** field.
- **Dependencies** (exact pins, newest patch at least 2 weeks old): `ai` 7.0.157, `@ai-sdk/anthropic` 4.0.92, `@ai-sdk/openai` 4.0.105, `@ai-sdk/google` 4.0.108, `jose` 6.2.14.

### Decisions and deviations

- **OAuth redirect URI is on the web domain:** `WEB_URL/api/oauth/google/callback`, proxied to the api, instead of the api's public domain. The session cookie comes along, so the callback is bound to the admin who started it. State and the PKCE verifier are kept server-side (encrypted, single use, 10 min). Settings shows this URI to paste into the Google OAuth client.
- **Tokens per location:** each location row stores the (same) Google tokens, encrypted with AAD `orgId|platform_account|google_business:<locationId>:<access|refresh>`. Disconnecting one location doesn't revoke the Google grant, because the other locations share it.
- **Pub/Sub is a hint:** the payload format isn't documented, so a push only triggers an immediate reconcile poll for that location. The poll is the single source of review data.
- **Reconcile cursor** = the newest `updateTime` seen. A first backfill with over 1,000 reviews skips the older ones (logged).
- **Permanent AI errors** (bad key/model, 4xx) complete the job with the error in its output instead of burning retries.
- **Demo accounts can "send"** (nothing is posted), so the reply flow can be tried locally. The composer says so.
- **Draft schema is loose** (up to 10 strings); trimming to the requested count and platform length happens after, so one extra draft doesn't fail the call.

### Needed from you (to run the acceptance)

1. **GBP API access:** the profile must be verified and active for 60+ days and have a website. Submit Google's access form with the GCP project number. Quota is 0 until approved.
2. **A GCP OAuth client** (Web application) with redirect URI `<WEB_URL>/api/oauth/google/callback`. Enable the Business Profile APIs (Account Management, Business Information, My Business Notifications, plus v4 reviews). **Publish the OAuth app**: in "Testing", Google refresh tokens expire after 7 days.
3. **Pub/Sub** (optional; without it, reviews arrive on the 30-min reconcile): a topic with `mybusiness-api-pubsub@system.gserviceaccount.com` as Publisher, and a push subscription to `<API_PUBLIC_URL>/webhooks/google` with OIDC auth (a service account; put its email in Settings). This needs a **public HTTPS URL**, i.e. Phase D.
4. **An AI key** (Claude, ChatGPT or Gemini) and a model ID in Settings → AI replies, then "Test connection".

### Known notes

- The browser checks sent replies on two seeded demo reviews in the dev DB (nothing was posted anywhere). `pnpm db:seed --reset` restores the demo data.
- **Not built yet:** marking an item handled when its owner reply was posted in Google directly (the reply is kept in `raw.reviewReply`), and deleting a reply.

## Phases 5–7: Meta comments, YouTube, Meta DMs + Connections hub (2026-11-13)

**Acceptance (not run yet: needs your apps):** 5 "Comments arrive by webhook and replies post" · 6 "Comments within one interval; quota meter accurate" · 7 "DM threads shown as conversations; expired window blocks send". Everything up to the platforms' servers is built and tested against stubs, and the webhook → inbox → reply path was run on the local stack with signed fixtures.

| Check                  | Result                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Meta webhooks          | ✅ Tests: handshake only with the right verify token; `X-Hub-Signature-256` HMAC on the raw body; Meta retries de-duplicated (body hash); bad signatures stored, 401, never ingested                                                       |
| Meta connect           | ✅ Test (Graph stubbed): code → long-lived user token → Pages with non-expiring Page tokens + linked IG accounts; Pages subscribed to `feed,messages,message_echoes`; declined permissions and Pages without a token reported as a warning |
| Comments + DMs → inbox | ✅ Local stack: `pnpm simulate:webhook meta {fb-comment,ig-comment,fb-dm,ig-dm}` → Activity log (valid, processed) → items in the inbox; DMs grouped by customer with the reply-window clock set from the message time                     |
| Replies                | ✅ Local: DM reply on the demo Page → queued → worker → `sent`, item `Replied`. Tests: comment/DM endpoints, closed messaging window (#10/2018278) is final with a hint, rate limits retry, code 190 → "Reconnect"                         |
| Reconcile              | ✅ Tests: FB comments (recent posts updated since the cursor), IG comments + replies, Messenger/IG conversations (`platform=instagram`); webhook and reconcile produce the same ids (no duplicates)                                        |
| YouTube                | ✅ Tests: connect via the Google callback with the YouTube scope; polling newest-first to the cursor, inline + paged replies, quota units counted (1/page, 50/reply), `quotaExceeded` is final with a reset hint                           |
| Connections page       | ✅ Headless Chromium at 1400 px (light) and 390 px (dark): no console errors, no horizontal scroll                                                                                                                                         |
| Whole repo             | ✅ lint, typecheck, Prettier, production build, 689 tests (core 588, api 57, pipeline 37, auth 7)                                                                                                                                          |

### What was built

- **`@inbox/core`:** `adapters/meta` (webhook + Graph schemas, normalizers for feed comments, IG comments, Messenger/IG DMs incl. echoes/edits/attachments, reconcile nodes) and `adapters/youtube` (schemas, `normalizeYtComment`, `YOUTUBE_SCOPE`). DM length limits (Messenger 2000, IG DM 1000) in `replyLengthError`/drafts. Fixtures in `fixtures/meta` and `fixtures/youtube`.
- **`@inbox/pipeline`:** `meta.ts` (Graph client with `appsecret_proof`, OAuth, Page subscription, signature verify, reconcile fetchers, comment/DM replies, error mapping) and `youtube.ts` (channels, polling with quota, `comments.insert`, `addYoutubeQuota`). Reply senders now get the item's parent comment and DM conversation. The DM window runs from the customer's message time (`platformCreatedAt`).
- **Worker:** `meta/` (webhook handler for comments + DMs, 4 reconcile adapters, FB/IG senders) and `youtube/` (poll adapter, sender). Polls and webhooks share one `ingestItems` (filter → store → NOTIFY → drafts).
- **API:** `GET/POST /webhooks/meta`; `/api/oauth/meta/{start,callback}` and `/api/oauth/youtube/start` (finishes on the Google callback); Test works for every platform (Meta Test re-subscribes missing webhook fields); `GET /api/connections` returns per-account sync streams, webhook health and setup URLs.
- **Web, Connections hub:** a summary bar (connected / syncing / problems, public-URL warning), a **Setup checklist** per provider (credentials, redirect URI and webhook URL to copy, verify token, last webhook received, App Review note, YouTube quota today), and per-account **stream status** (last sync, next run, failures) with **Sync now**. Settings → Connections → Meta has an optional Facebook Login for Business **configuration ID**.
- **Dev tool:** `pnpm simulate:webhook meta <fixture> [--account <id>] [--text "…"]` signs a fixture with the workspace's Meta app secret and posts it to the local api (fresh ids each run). Seeded demo accounts accept simulated deliveries.

### Decisions and deviations

- **Instagram through Facebook Login** (Pages' linked IG professional accounts, Page token, `graph.facebook.com`), not "Instagram API with Unified Login": one connect button and one token covers FB + IG comments and DMs. IG DMs are sent via `POST /{page-id}/messages`.
- **Meta redirect URI on the web domain** (`WEB_URL/api/oauth/meta/callback`), like Google. **YouTube reuses the Google callback** (state says which product), so the Google OAuth client needs one redirect URI.
- **Replies to replies** go under the top-level comment (FB, IG and YouTube nest one level).
- **Meta deliveries are de-duplicated by a SHA-256 of the raw body** (Meta sends no delivery id; retries resend the same bytes).
- **Page tokens don't expire** (`tokenExpiresAt` null); an invalid token (code 190) marks the account "Reconnect".
- **YouTube polling** reads up to `pagesPerPoll` pages of threads newest-first and stops at the cursor, so replies on threads older than those pages are missed until a new top-level comment pushes them in. Quota failures of a partial poll aren't counted.

### Needed from you (to run the acceptance)

1. **Meta app** (Business type) with Facebook Login (or Login for Business + a configuration ID), Webhooks, Messenger and Instagram products. App ID + secret + a verify token in Settings → Connections. Add the redirect URI and the webhook URL shown on the Connections page; subscribe Page fields `feed, messages, message_echoes` and Instagram fields `comments, messages`.
2. **A public HTTPS API URL** (Phase D) for real webhooks. Without it, comments and DMs still arrive on the reconcile schedule (60 min by default; "Sync now" on the Connections page).
3. **App Review / Advanced Access** for other people's Pages and for IG comment webhooks. Until then, connect with an account that has a role on the app.
4. **YouTube:** enable YouTube Data API v3 in the same GCP project and click Connect on the YouTube card.

### Known notes

- Simulated items are in the dev DB (5 items, 2 conversations, 1 demo reply). `pnpm db:seed --reset` removes them.
- Own-account echoes and comments are dropped by the default "own activity" rule, so a DM thread shows replies sent from here, not ones typed in the Meta inbox.

## Open questions

- Phase 4 acceptance is blocked on the items under "Needed from you" above (GBP API access, OAuth client, AI key; a public URL for real-time push).
- Not answered yet, and not blocking: which platforms and how many pages/locations/channels exist, and whether a Meta app, GCP project, or LinkedIn app already exists. Needed before Phase 4.

## Decisions log

| Date       | Decision                                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-12 | Prisma pinned to 7.10.1 (8.x is RC and outside better-auth's peer range)                                                                                  |
| 2026-11-12 | TypeScript pinned to 6.0.3 (typescript-eslint does not support 7.x yet)                                                                                   |
| 2026-11-12 | TanStack Table v9 (matches the current shadcn data-table guide)                                                                                           |
| 2026-11-12 | Live fan-out via Postgres LISTEN/NOTIFY: no Redis                                                                                                         |
| 2026-11-12 | Blocklist/Allowlist/keyword lists stored in one `ListEntry` table                                                                                         |
| 2026-11-12 | Platform connections use custom one-click OAuth flows, not better-auth `linkSocial` (org-owned, derived Page tokens, IG Unified Login)                    |
| 2026-11-12 | Sign-in: better-auth Google One Tap plugin + "Continue with Google" fallback                                                                              |
| 2026-11-12 | AI providers: Claude, ChatGPT, Gemini via Vercel AI SDK (`@ai-sdk/anthropic`/`openai`/`google`)                                                           |
| 2026-11-12 | Slack deferred (Phase 8); Railway deploy deferred (Phase D); no custom domain yet                                                                         |
| 2026-11-12 | MVP is one org + one user; organization plugin and roles kept for later expansion                                                                         |
| 2026-11-12 | `dashboard/` (bun scaffold) replaced by `apps/web` on pnpm                                                                                                |
| 2026-11-12 | ESLint 9.39 (not 10) until eslint-config-next's plugins support 10                                                                                        |
| 2026-11-12 | shadcn `base-nova` style (Base UI primitives), the CLI default                                                                                            |
| 2026-11-12 | Owners always pass the sign-in check; first-owner bootstrap serialized with a Postgres advisory lock; optional `BOOTSTRAP_OWNER_EMAILS`                   |
| 2026-11-12 | Web reads the session via `'use cache: private'` `getCurrentMe()` → api `/api/me`; `proxy.ts` is an optimistic cookie check only                          |
| 2026-11-12 | `DEV_AUTH_BYPASS` local preview mode (virtual user, no DB writes, refused in production/Railway), requested to check the UI without login                 |
| 2026-11-12 | `resolved` status (done without reply); `filtered` (rule) vs `archived` (person)                                                                          |
| 2026-11-12 | First sign-in claims an ownerless (seeded) org as owner                                                                                                   |
| 2026-11-12 | Re-filter touches only `new`/`filtered` items without `manualOverride`; stored items are never deleted by a later drop rule                               |
| 2026-11-12 | `@inbox/pipeline` package for DB-aware pipeline code shared by api, worker and seed                                                                       |
| 2026-11-12 | React Query for client data; SSE invalidates query prefixes                                                                                               |
| 2026-11-13 | Follow-ups: threads we replied to/resolved get their own tab; later items in them skip the Open tab (`Item.threadKey`, `isFollowUp`)                      |
| 2026-11-13 | Opening an item goes to a full page (`/items/[id]`); the side sheet is a quick preview without a composer                                                 |
| 2026-11-13 | "Open in <app>" links built per platform (`itemLink`), adapter permalinks preferred; "Copy & open" for replying in the native app                         |
| 2026-11-13 | Low-value filter: `isLowValue` field + editable Low-value phrases list + `archive_low_value` default rule; "Hide similar" learns phrases (admins)         |
| 2026-11-13 | Scheduler compares times in UTC in raw SQL; per-org periodic jobs throttled with pg-boss `singletonSeconds`; `poll` retried by the scheduler, not pg-boss |
| 2026-11-13 | Settings secrets stored inside the section JSON as `{enc,last4}`; write-only in the UI; version compare-and-swap on save                                  |
| 2026-11-13 | Google OAuth redirect URI on the web domain (`/api/oauth/google/callback`), state + PKCE stored server-side; tokens stored per location row               |
| 2026-11-13 | AI SDK 7 + providers and `jose` pinned exactly to patches ≥ 2 weeks old                                                                                   |
| 2026-11-13 | Pub/Sub pushes only trigger a reconcile poll (payload undocumented); demo accounts can "send" replies (nothing posted)                                    |
| 2026-11-13 | Instagram via Facebook Login (linked IG accounts, Page token) instead of Unified Login; Meta + YouTube redirect URIs on the web domain                    |
| 2026-11-13 | Meta webhook dedupe = SHA-256 of the raw body; polls and webhooks share one ingest path; `simulate:webhook` dev script for local checks                   |
