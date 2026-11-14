# Code review — Social Inbox

**Date:** 2026-11-14
**Scope:** whole monorepo (`apps/api`, `apps/web`, `apps/worker`, `packages/{core,db,auth,pipeline}`), including the uncommitted changes in `apps/web/components/inbox/item-page.tsx` and `item-detail-parts.tsx`.
**Method:** full read of every non-generated source file, plus targeted verification (Node/WHATWG URL probes, V8 regex benchmarks, Prisma schema/migration review, pg-boss 12.38.2 internals for `singletonKey` semantics). Findings below were checked against the code; line numbers are from the current working tree.

**Checks run**

| Command          | Result                                                                     |
| ---------------- | -------------------------------------------------------------------------- |
| `pnpm typecheck` | ✅ 8/8 packages                                                            |
| `pnpm lint`      | ✅ 8/8 packages                                                            |
| `pnpm test`      | ✅ 689 tests (core 588, pipeline 37, api 57, auth 7) — integration DB used |

**Verdict.** The foundation is genuinely good: tenant scoping is consistent, secrets are encrypted with AAD binding, webhook HMAC/OIDC verification is correct, settings use compare-and-swap, and the filter engine is pure and well-tested. There is **no critical unauthenticated cross-tenant data access** in a correct production configuration.

The risk is concentrated in five places: (1) the public webhook path stores unauthenticated data forever, (2) preview mode is a writable owner with a weak production guard, (3) a non-idempotent reply can be posted twice, (4) several list/thread queries silently lose data, and (5) the filter engine over-archives ordinary content (empty groups, keyword substrings, CJK, punctuation).

Priority order for fixes: **S1, S2, D3, D4, D1, D6, D2**, then the medium items.

---

## Security

### S1 — `DEV_AUTH_BYPASS` is a write-capable owner, and the guard is weak · **High**

`apps/api/src/middleware/session.ts:59-68`, `apps/api/src/env.ts:41-45`, `apps/api/src/index.ts:54,63`

When the flag is on, any request without a session becomes `PREVIEW_USER` with `DEV_AUTH_ROLE` (default **owner**) acting in the **oldest real organization** (`session.ts:44-51`). The README promises "nothing is written to the database", but the only consumer of `c.get("preview")` is `/api/me` — every mutating route treats the preview as a real owner: `PUT /api/settings/general` (including the sign-in allowlist), `POST /api/items/:id/reply` (queues a real public reply with the stored platform token), `POST /api/connections/:id/disconnect`, `POST /api/webhooks/:id/replay`.

The production guard rejects only `NODE_ENV === "production"` **or** `RAILWAY_ENVIRONMENT_NAME`; `NODE_ENV` defaults to `development`, so any other host (Fly, Render, a VPS, Docker) that forgets it ships a no-auth owner. The API also binds `::`, so it is reachable from the LAN.

*Fix:* require loopback `WEB_URL`/`API_PUBLIC_URL` when the flag is on, bind `127.0.0.1`, return the virtual org (`dev-preview-org`) instead of a real one, and reject non-idempotent methods for preview principals. At minimum, correct the README.

### S2 — Public webhooks: unauthenticated storage growth, CPU amplification, cross-tenant payloads · **High**

`apps/api/src/routes/webhooks.ts:104-141,151-187`, `packages/pipeline/src/maintenance.ts:47-55`

- The body is read with `c.req.arrayBuffer()` / `c.req.text()` **before** the size check (`webhooks.ts:105,153`); a 1 GB POST is buffered before the 413. The Google path also compares UTF-16 `text.length`, not bytes.
- The `WebhookEvent` row is inserted **before** verification is enforced, with `organizationId: null` and `dedupeKey: null` (`:128,131,173,176`). Postgres treats NULLs as distinct, so every forged delivery creates a row.
- Retention only deletes rows with an `organizationId` and `processedAt != null` (`maintenance.ts:48-53`), so forged rows are kept forever.
- Every request to `/webhooks/*` scans **all** organizations' settings and decrypts each org's Meta secret / tries a JWKS verify (`webhooks.ts:48-83`) — O(#orgs) crypto per unauthenticated request.

A loop of signed-nothing POSTs grows the table indefinitely and burns CPU; there is no rate limiting anywhere in the Hono app. Those rows are also returned to every org's admins (`S2b` below).

*Fix:* add `hono/body-limit` before reading; verify before persisting (or store only a hash + headers on failure); add per-IP rate limiting; add a null-org TTL cleanup; cache the decrypted app secret.

### S2b — Failed-signature payloads are readable by every workspace's admin · **Low/Medium**

`apps/api/src/routes/activity.ts:161-163,196`, `apps/api/src/routes/connections.ts:154-160`

`GET /api/activity/webhooks` returns `organizationId: null` rows to any org's admin, including the full `payload` (DM/comment text, author names). Replay is correctly refused for unverified events, so this is a read-only leak. In a single-tenant install it is "our own bad deliveries"; the schema supports multiple orgs, so it becomes cross-tenant PII exposure. The `invalidLast24h` counter in `connections.ts` is global for the same reason.

*Fix:* only include null-org events when exactly one org exists; scope the counter.

### S3 — Open redirect after sign-in and from the item page · **Medium**

`apps/web/app/sign-in/sign-in-card.tsx:15-18`, `apps/web/components/inbox/list-state.ts:91-94`

Both `safeNext` and `safeListHref` accept any string starting with `/` that does not start with `//`. The WHATWG URL parser normalizes `\` to `/`, so `/\evil.com` passes the check and resolves to `https://evil.com` (verified). Next's router treats it as external and hard-navigates. A crafted `/sign-in?next=/%5Cevil.com` plus one Google sign-in lands the user on an attacker clone; `…/items/<id>?from=/%5Cevil.com` does the same on "Back".

*Fix:* resolve with `new URL(value, origin)` and require `origin === location.origin`, or allowlist internal prefixes. Add tests for `//`, `/\`, `%5C`, `https://`.

### S4 — First sign-in becomes owner by default · **Medium**

`packages/auth/src/access.ts:56-67,82-119`, `apps/api/src/env.ts:15`

`BOOTSTRAP_OWNER_EMAILS` is optional, and `db:seed` creates an org with no members. Any fresh deployment that is reachable before the operator's first sign-in can be claimed by whoever gets there first — including the sign-in allowlist being widened with their own email.

*Fix:* refuse to start in production without `BOOTSTRAP_OWNER_EMAILS` (or a one-time bootstrap token); replace `role: { contains: "owner" }` with a parsed exact role.

### S5 — Admin-settable base URLs can exfiltrate stored secrets / SSRF · **Medium**

`packages/core/src/settings/sections.ts:47-51,92-93,195-207`, `apps/api/src/routes/settings.ts:141-189`, `packages/pipeline/src/google.ts:294,332-346,365-384`

`google.reviewsBaseUrl` / `notificationsBaseUrl` and `ai.baseUrls.*` are validated only as `https://` any host. An admin (not just owner) can point them at their own host and press "Test" to receive the stored Google access token (with `business.manage` for everything that Google user manages) or the AI API key. The same primitive reaches internal HTTPS services from the API network.

*Fix:* pin Google hosts to `*.googleapis.com`/`*.google.com` and gate the override behind non-production; make AI endpoint changes owner-only and audited, or validate against a deny-list of private/link-local ranges.

### S6 — Removing someone from the allowlist does not revoke their session · **Medium**

`packages/auth/src/auth.ts:44-48`, `packages/auth/src/access.ts:150-179`, `apps/api/src/middleware/session.ts:56-77`

The allowlist is enforced at `session.create.before` only. Sessions live 30 days and daily `updateAge` refreshes the same row without re-running the hook; the `Member` row is never deleted. A departing contractor keeps full access for up to 30 days.

*Fix:* on a `general` settings save, delete sessions/memberships for emails no longer allowed; or re-validate `canStartSession` periodically.

### S7 — Smaller security items

| Item                                                                                                                         | Where                                                          | Severity |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------- |
| Meta `access_token`/`client_secret` sent in query strings (proxies/APM leak long-lived Page tokens)                          | `packages/pipeline/src/meta.ts:88-91,197-209`                  | Low      |
| Meta verify-token compared with `===` (HMAC path is timing-safe)                                                             | `apps/api/src/routes/webhooks.ts:94`                           | Low      |
| OAuth state `findFirst` → `delete` is not atomic (concurrent double-submit can both proceed)                                 | `apps/api/src/routes/oauth.ts:88-95`                           | Low      |
| No CSP / `frame-ancestors` / HSTS / `nosniff`; `WEB_URL` may be `http` in production (non-Secure cookies)                    | `apps/web/next.config.ts`, `apps/api/src/env.ts:11`            | Low      |
| `member` can post public replies and spend AI credits (PLAN says "validate role"; may be intended)                           | `apps/api/src/routes/items.ts:485-527`                         | Low      |
| `.env` is correctly ignored; no secret in the repo (verified)                                                                | —                                                              | ✅       |

---

## Data correctness and robustness

### D1 — An empty condition group matches everything · **High**

`packages/core/src/filters/types.ts:192-195`, `packages/core/src/filters/fields.ts:385-408`, `packages/core/src/filters/evaluate.ts:262-270`

`children` has `.max(50)` but no `.min(1)`, and `validateConditionTree` never rejects an empty group. `every([])` is `true`, so `{kind:"group",combinator:"and",children:[]}` matches every item; a rule with `drop` then drops the entire inbox. The API accepts it even if the builder UI would not produce it.

*Fix:* `.min(1)` on `children` plus an explicit validation issue; treat an empty group as non-matching in the engine.

### D2 — Unknown AI conditions are inverted by "none of", so items are archived before the AI pass · **High**

`packages/core/src/filters/evaluate.ts:241-259,262-270,352-358`

When AI signals are absent, `evaluateCondition` returns `false` and only sets `trace.aiUnknown` — which `evaluate()` never passes or consumes. Under `negate` that `false` becomes `true`, so "none of: aiToxicity ≥ 0.7" matches everything on the first pass. Because `needsAi` is only set when `decision === "show"`, the item is already archived and the AI pass never runs.

*Fix:* three-valued logic (true/false/unknown) propagated through combinators and negation; skip a rule's actions while any AI condition is unknown, and force `needsAi` regardless of other rules' decisions.

### D3 — ReDoS: polynomial regexes pass `isSafeRegex` · **High**

`packages/core/src/filters/fields.ts:326-339`, `packages/core/src/filters/evaluate.ts:188-195`

The guard rejects nested quantified groups, backreferences and lookbehind, but not adjacent unbounded quantifiers. Verified: `.*.*.*.*x` is accepted and takes **3.7 s on a 200-character input** (26 ms at 50, 172 ms at 100), and it runs over up to 500 items per refilter batch with no text-length cap. Secondary bug: validation compiles without flags while evaluation uses `iu`, so a pattern can validate and then silently never match.

*Fix:* use RE2/`re2-wasm` or a vetted safe-regex; reject adjacent unbounded quantifiers; cap tested text length; compile with the runtime flags during validation.

### D4 — A non-idempotent reply can be posted twice when a send fails transiently · **High**

`packages/pipeline/src/replies.ts:263-273`

`retryable = err instanceof ReplySendError ? err.retryable : sender.idempotent` ignores `sender.idempotent`. Meta and YouTube wrap timeouts and 5xx as `retryable: true` (`meta.ts:103-104`, `youtube.ts:55-57`), and both senders are declared `idempotent: false` (`apps/worker/src/meta/index.ts:56`, `apps/worker/src/youtube/index.ts:34`). A POST that timed out after the platform accepted it is set back to `queued` and sent again → duplicate public comment/DM.

*Fix:* for non-idempotent senders, only auto-retry errors that are provably pre-send (e.g. 429/connection refused); treat timeout/5xx as "may have posted" and surface a manual-check state.

### D5 — Two concurrent reply requests can both be queued · **Medium**

`packages/pipeline/src/replies.ts:76-99,120-140`, `packages/db/prisma/schema.prisma:322-342`

The "already sending" guard is a read outside the transaction, `Reply` has no unique constraint on active replies, and the `idempotencyKey` is random (`Math.random`, `:137`), so it prevents nothing. A double-click or a retry after a slow response creates two queued replies → two public posts. Separately, if `enqueueSendReply` throws after the row is committed, the reply stays `queued` and blocks the item with 409.

*Fix:* partial unique index `ON reply(itemId) WHERE status IN ('queued','sending')`; catch P2002 and return 409; derive the key from the request; enqueue via an outbox or re-enqueue pending replies on start.

Related: `apps/api/src/lib/jobs.ts:53-58` passes `singletonKey: replyId` without `singletonSeconds` on a `standard` queue — in pg-boss 12 the dedupe index only exists for `singleton` policy (`job_i2`) or `singleton_on` (`job_i4`), so the guard is a no-op. Same for `enqueuePoll`.

### D6 — Meta reconcile silently skips comments/DMs and then advances the cursor past them · **High**

`packages/pipeline/src/meta.ts:409-451,454-488,492-529`

- IG: `{media-id}/comments` is fetched **once** with `limit=50`, `paging.next` is never followed, and inline `replies` are only page 1. The cursor is then set to `newestOf()` the returned page (`:488`), so anything older than the newest returned comment but not read is permanently skipped.
- FB: the feed is one `limit=25` call, comment pages are capped at 5, conversations at 50 with `messages.limit(25)`; the cursor again jumps to the newest item seen.

This is data loss for any busy account, not a transient gap.

*Fix:* follow `paging.next` with a bound until the cursor is reached; only advance the cursor when the scan actually reached it (the GBP `complete` flag pattern); fetch replies via `{comment-id}/replies`.

### D7 — Item detail returns the **oldest** 200 messages · **Medium**

`apps/api/src/routes/items.ts:367-385`

`orderBy: { receivedAt: "asc" }, take: 200` means a long DM/comment thread loses its newest messages — including the item the user opened. The composer then replies to something that isn't visible in the thread.

*Fix:* fetch newest-first with `take: 200`, then reverse; or paginate the thread.

### D8 — Follow-ups: capped at 200, count is items not threads, page size contract broken · **Medium**

`apps/api/src/routes/items.ts:227-259,278-305`

`active` is `take: 200` with no pagination and is prepended only on the first page; `nextCursor` is derived from `rest` alone, so page 1 can contain `200 + limit` threads while advancing by `limit`. Beyond 200 open follow-up threads, the excess is unreachable. `countViews` counts **items** with `isFollowUp`, while the tab renders **threads**, so the badge disagrees with the list.

*Fix:* paginate the active set too (or merge both into one cursor query) and count threads.

### D9 — Edits never re-run filters · **Medium**

`packages/pipeline/src/ingest.ts:44-56`

An `edited` event updates text/rating only. A review edited 5★ → 1★ keeps its old priority, tags, rule matches and `filtered`/`archived` decision. The code even notes reviews can change rating.

*Fix:* re-evaluate on edits, write `filterColumns`/`writeRuleMatches`, and preserve manual overrides deliberately.

### D10 — Token expiry check mislabels healthy Google/YouTube accounts · **Medium**

`packages/pipeline/src/maintenance.ts:87-114`, `packages/pipeline/src/google.ts:242-290`

`tokenExpiresAt` is the ~1-hour **access**-token expiry, but the check uses a 7-day warning window (`notifications.tokenExpiryWarningDays` default 7) and flips accounts to `expiring`, then `error`/"Reconnect" when it lapses. Refreshable accounts are therefore permanently "expiring" (or briefly "error" if polling is paused), and `googleAccessToken` only promotes `expiring → connected`, not `error → connected`.

*Fix:* skip accounts with a stored refresh token; base warnings on actual refresh failure.

### D11 — Scheduler leases are taken before enqueue and can strand work · **Medium**

`apps/api/src/routes/sync.ts:144-152`, `apps/worker/src/scheduler.ts:36-44`, `packages/pipeline/src/sync.ts:140-160`

`Run now` claims a 5-minute lease and only then enqueues; if the enqueue throws, the row stays leased for 5 minutes and every retry returns "already running". `schedulerTick` ignores `boss.send`'s return value, so a skipped send also strands the lease. Because `singletonKey` does not dedupe on a `standard` queue (D5), a poll still `created` past the 5-minute lease can be enqueued twice and the two runs overwrite each other's bookkeeping.

*Fix:* release the lease when the enqueue fails/skips, log `send() === null`, set the lease ≥ job expiry.

### D12 — A deduped webhook can be acknowledged without ever being queued · **Medium**

`apps/api/src/routes/webhooks.ts:134-137,179-183`

The event is inserted before `enqueueIngest`. If enqueue throws, the platform retries; the retry hits the unique `(source, dedupeKey)` conflict and returns 200/204 **without enqueueing**, leaving `processedAt: null` until a manual replay.

*Fix:* on P2002, look the event up and enqueue it when unprocessed.

### D13 — `GET /api/items/:id` has write side effects · **Low/Medium**

`apps/api/src/routes/items.ts:466-480`

Opening an item can enqueue an AI-draft job when `generateOn === "open"`. A prefetch/crawler can enqueue jobs the user never asked for, and a queue failure turns the read into a 500.

*Fix:* fire-and-forget with `.catch()`, or move it to the existing `POST /:id/drafts`.

### D14 — Reconnecting never detaches accounts that disappeared · **Low**

`apps/api/src/routes/oauth.ts:286-381,413-451,467-508`

The flows only upsert returned pages/channels/locations. A page/location that was removed keeps a `connected` row, its sync schedules, and keeps polling. `connectGbp` also aborts mid-way on a per-account API error after already writing the previous account, so the user gets no partial-success message.

*Fix:* mark rows not returned as `disconnected`; wrap per-account calls in warnings like the Meta path.

### D15 — Smaller data/API items

| Item                                                                                                             | Where                                                                 | Severity |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------- |
| `PUT /api/settings/:section` accepts partial `values` (all fields have defaults) and then replaces the whole section → omitted fields reset to defaults | `packages/core/src/settings/sections.ts:400-418`, `apps/api/src/routes/settings.ts:210-211,271-279` | Medium   |
| `parseGeneralSettings` uses `.parse` in the auth path: one corrupt `settings.general` makes every sign-in 500 (and `parseSectionValues` silently resets `general`, wiping the allowlist) | `packages/core/src/settings/general.ts:27-29`, `packages/auth/src/access.ts:44,100,144` | Medium   |
| `Member` has no unique `(organizationId, userId)`; `joinAsMember` is check-then-insert without the advisory lock in the auto-join path → duplicate memberships | `packages/db/prisma/schema.prisma:511-523`, `packages/auth/src/access.ts:171-194` | Low      |
| Cancel-reply ignores `:id` in the URL; unknown/already-sending both return 409 instead of 404/409 | `apps/api/src/routes/items.ts:530-548`, `packages/pipeline/src/replies.ts:145-159` | Low      |
| No index for item search (`ILIKE`), `tags has`, or priority sort; jobs view scans the shared `pgboss.job` table by JSON key | `packages/db/prisma/schema.prisma:273-279`, `apps/api/src/routes/activity.ts:109-153` | Low      |
| Migrations build indexes non-concurrently and run an unbatched full-table `UPDATE` + self-join | `packages/db/prisma/migrations/20261112183245_item_threads_followups_links/migration.sql` | Low (pre-launch) |
| `ENCRYPTION_KEY` validation accepts strings with invalid base64 characters (Buffer silently skips them) | `apps/api/src/env.ts:20-25`, `apps/worker/src/env.ts:8-13` | Low      |

---

## Filter engine semantics

### F1 — `wordCount` is whitespace-only, so CJK/Thai sentences are "very short" · **High (non-English markets)**

`packages/core/src/filters/derive.ts:83-86`, `packages/core/src/filters/defaults.ts:215-232`

`"この製品はとても良いです"` yields `wordCount: 1`, so the default `archive_emoji_short` rule (`wordCount lte 2`) archives a complete, valid review. `MENTION_RE` is also ASCII-`\w`-only, so `@ユーザー` is not counted.

*Fix:* `Intl.Segmenter(..., { granularity: "word" })` or a grapheme estimate for space-less scripts; use `[\p{L}\p{N}_]` in the mention regex; add non-Latin fixtures.

### F2 — Keyword lists use raw substring matching · **Medium**

`packages/core/src/filters/evaluate.ts:167-179`, `packages/core/src/filters/defaults.ts:14-28`

Default spam keyword `"collab"` matches "collaboration"; `"promote"` matches "promoted". Verified: "Great collaboration with the team…" is archived as spam with the seeded lists.

*Fix:* Unicode word-boundary matching for `keyword` list refs (keep substring only for `text` if desired).

### F3 — URLs keep trailing punctuation, corrupting `linkDomain` · **Medium**

`packages/core/src/filters/derive.ts:11,22-37`

`"watch www.youtube.com, thanks"` yields `["youtube.com,"]`; `"https://youtube.com!"` yields `["youtube.com!"]`. With trusted-domain lists the first is archived as an unknown domain; `inList` on a blocklisted domain followed by `)` fails to match.

*Fix:* strip trailing `),.!?;:'"»]` and validate the parsed hostname against a domain character class.

### F4 — Negative operators are `true` on null; `linkDomain notInList` is any/all · **Medium**

`packages/core/src/filters/evaluate.ts:129-203`

`notContains` / `notEquals` / `notInList` return `true` for null/empty values, so an exclusion rule matches every item with a missing field. `linkDomain notInList` returns true if **any** domain is outside the list, but `false` when there are no links — inconsistent with the string case.

*Fix:* decide on SQL-style three-valued semantics and make the any/all choice explicit (`noneIn` vs `anyNotIn`); update the tests that currently codify the ambiguous behaviour.

### F5 — Low-value normalizer collapses real words · **Medium**

`packages/core/src/filters/low-value.ts:213-214`

`token.replace(/(.)\1+/gu, "$1")` turns `"good"` → `"god"`, `"cool"` → `"col"`, `"too"` → `"to"`. "God is great" matches the `"good"` phrase and is archived by the default low-value rule.

*Fix:* only collapse elongation runs of 3+ (`(.)\1{2,}`) or match with an elongation-tolerant pattern.

### F6 — Allowlist domain validation is label-naive · **Low**

`packages/core/src/auth/allowlist.ts:3-8`

`(?!-)` only guards the first character of the whole string, so `acme.-evil.com` and `acme-.com` pass; labels have no 63-char cap; IDN domains (`münchen.de`) are rejected without a punycode hint. Matching itself is correct (exact, case-folded, no subdomain wildcarding).

*Fix:* validate per label, convert input with `domainToASCII`, normalize emails with NFKC, bound array sizes.

---

## Web app

### W1 — Inbox rows are click-only divs · **Medium (accessibility)**

`apps/web/components/inbox/item-row.tsx:94-104`, `apps/web/components/inbox/item-list.tsx:124-133`

The only way to open an item is `onClick` on a `<div>` with no `role`, `tabIndex` or key handler, so the list is unreachable by Tab and silent to screen readers. `j/k` changes React state but never moves DOM focus. The same pattern is in `follow-up-list.tsx:262-275`.

*Fix:* make the row a `<Link>`/`<button>` (or a `role="option"` listbox with `aria-activedescendant` and focus movement in `select()`).

### W2 — SSE invalidation storm · **Medium**

`apps/web/components/app/live-updates.tsx:29-36`

Every `items.changed` invalidates the root `qk.items` prefix — refetching every mounted list **and** every cached item detail — then redundantly invalidates each `qk.item(id)` again. Events are emitted per item (a 50-item sync with drafts = 50 bursts), with no debounce.

*Fix:* batch ids with a ~250 ms trailing debounce and invalidate once, or patch list caches from `event.itemIds`.

### W3 — Follow-ups inherits filters the view ignores · **Medium**

`apps/web/components/inbox/item-list.tsx:46-53`, `apps/web/components/inbox/toolbar.tsx:76-77,112-128`, `apps/web/components/inbox/use-item-filters.ts:49-56`

Switching to Follow-ups clears only `status`/`item`. `priority`, `tag` and `sort` persist but are ignored by `followUpQuery` and hidden from the toolbar, while `hasFilters` stays true → a stray "Clear filters", a misleading empty state, and invisible state.

*Fix:* drop unsupported filters in the tab handler and make `hasFilters` view-aware.

### W4 — `useListIds` reads the query cache during render (non-reactive) · **Medium**

`apps/web/components/inbox/item-page.tsx:54-74`

`queryClient.getQueryData` does not subscribe, so prev/next and "1 of N" come from whatever the cache held at that render; after an SSE refetch or an action that reorders they can point at the wrong neighbour. Lines 65-68 also duplicate the Follow-ups ordering owned by `follow-up-list.tsx:66-67`.

*Fix:* observe the query (`useQuery`/`useSyncExternalStore`) and export one ordering helper.

### W5 — Every settings panel mounts eagerly · **Medium**

`apps/web/components/settings/settings-page.tsx:214-225`

Panels are hidden with `hidden` (to preserve unsaved edits), so `SyncTab` mounts on every `/settings` visit and immediately polls `GET /api/sync` every 60 s while the user is on General; nine `useForm` instances are built eagerly.

*Fix:* gate the query with `enabled: tab === "sync"`; mount the active panel plus only panels with unsaved edits.

### W6 — No `global-error` for layout failures · **Medium**

`apps/web/app/(app)/layout.tsx:23-39`, `apps/web/app/(app)/error.tsx`

`getCurrentMe()` is started in the layout; its rejection surfaces in shell consumers outside the `(app)` error boundary, and there is no `app/global-error.tsx`, so users get Next's unstyled default page with no shell.

### W7 — Stale relative time and reply-window state · **Medium**

`apps/web/components/inbox/item-page.tsx:260-297`, `apps/web/components/inbox/item-detail-parts.tsx:436,497-535`

`now` is frozen at fetch time and nothing ticks. The composer's `expired` flag and "Reply window closes…" come from the fetch-time payload, so Send stays enabled after the window closed and the request fails. A working `useNow` exists in `sync-tab.tsx:282-289` (and is instantiated once per stream row in `connections-page.tsx:671`).

*Fix:* one shared `useNow()`; compute expiry from `expiresAt + now`.

### W8 — Smaller web items

| Item                                                                                                     | Where                                                                 | Severity |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------- |
| Filter/search changes keep scroll position (`scroll:false` on all URL writes), so a narrower list puts the load-more sentinel in view and auto-fetches page 2 | `apps/web/components/inbox/use-item-filters.ts:29-47`, `item-list.tsx:193-209` | Low/Medium |
| Activity filters (`entity`, `state`, `queue`) live in `useState` and are lost on tab switch (Base UI `Tabs.Panel` unmounts) | `apps/web/components/activity/activity-page.tsx:290-292,373-376` | Low/Medium |
| `error.tsx` uses `reset`; Next 16 also provides `retry` (which refreshes) — the button re-renders the same failed tree | `apps/web/app/(app)/error.tsx:9-25`                                    | Low      |
| API shutdown waits for open SSE connections before closing the bus/queue → forced `exit(1)` after 10 s | `apps/api/src/index.ts:67-75`                                         | Medium   |
| Refilter jobs are not coalesced: every rule/list toggle enqueues a full-org scan (500/batch), serialized | `apps/api/src/lib/jobs.ts:36-39`, `apps/api/src/routes/filters.ts:111-113`, `lists.ts:69-71` | Medium   |
| `*-dlq` queues are created but nothing consumes or re-drives them | `apps/worker/src/boss.ts:13-25`                                       | Low      |
| Worker health ignores `lastTickAt`, so a dead scheduler still reports `ok` | `apps/worker/src/health.ts:17-29`                                     | Low      |
| Four different `initials()` implementations render the same author differently in Inbox vs Follow-ups | `item-row.tsx:335-345`, `follow-up-list.tsx:276-281`, `item-page.tsx:79-89`, `user-menu.tsx:26-33` | Low |
| Two different components named `MultiSelect`; `cn` imported from `cn` 52× and from `@/lib/utils` once; `@tanstack/react-table` unused; `shadcn` (a CLI) in runtime deps | `multi-select.tsx:25`, `simple-select.tsx:95`, `package.json`          | Low      |
| `prefers-reduced-motion` respected for Motion list animations but not `animate-spin`/`animate-pulse`      | `globals.css`, `app-header.tsx:83-91`, `item-detail-parts.tsx:470-478` | Low      |
| SSE per-connection queue is unbounded and the 20 s heartbeat timer is never cleared | `apps/api/src/routes/stream.ts:30-52`                                 | Low      |

---

## Notes on the uncommitted item-page change

The redesign itself is good — one conversation panel plus a details sidebar, day dividers, grouped messages, avatar fallbacks, and the AI-draft card as a real `<button>` (better than the nested `Button`). Three things to tidy before committing:

1. **Duplicated renderers.** `Messages` (`item-page.tsx:331-371`) and `ItemBody` (`item-detail-parts.tsx:136-161,183`) both implement thread rendering with different grouping/placeholder rules, and `Details` (`item-page.tsx:471-573`) duplicates `ItemContext` (`item-detail-parts.tsx:209-258`). This is why `placeholder` had to be exported. Keep one thread renderer (parameterise compact/full) and one details renderer.
2. **Dead `large` prop.** No caller passes `large` any more (only the sheet uses `ItemBody` with defaults).
3. **`useListIds` + ordering duplication** — see W4; also `safeListHref` open redirect (S3).

Also: `ItemPage.runAction` (`item-page.tsx:161-170`) fires the mutation and immediately `moveOn()`, so on a failed action the user has already been navigated away from the item (the error toast appears over the next item).

---

## What is done well (worth keeping)

- **Tenant isolation.** Every data route derives `org.id` from the session and includes it in `where`; every update/delete-by-id first does an org-scoped read. The one raw-SQL site binds all values. No IDOR found.
- **Crypto.** AES-256-GCM, fresh 12-byte IV, 32-byte key enforcement, `org|model|field` AAD (plus platform/externalId/kind for tokens), key-id rotation with previous keys, authenticated tags. Secrets never leave the server; settings audits record only *which* secret changed.
- **Webhook verification.** Meta HMAC over the **raw bytes** with a strict hex and `timingSafeEqual`; Google Pub/Sub OIDC with issuer, per-org audience, service-account email and `email_verified`.
- **OAuth.** Random encrypted single-use state bound to user + org, 10-minute TTL, PKCE S256, Google scope re-check.
- **Settings writes.** Version compare-and-swap inside a transaction, readable diffs, no secret values in audit rows.
- **Scheduler.** Parameterized SQL, `FOR UPDATE SKIP LOCKED` leases, deliberate UTC normalization, failure backoff, quota-day, account-health transitions in one transaction.
- **Filter engine structure.** Pure/clock-free, deterministic priority ordering, drop > archive > show, dry-run/stopProcessing consistent, ReDoS guards at write *and* evaluate time (weakened only by D3).
- **Reply crash safety.** `queued → sending` before the call, external id stored in the same transaction as `replied`, `sending`-without-id resumed only for idempotent senders (weakened only by D4).
- **Web keyboard layer.** Global shortcut guard (typing/overlay/modifiers), ref-based handlers, visible `Kbd` hints.
- **Next 16 Cache Components** used correctly: `use cache: private` + `cookies()`, unawaited promise through context, `params.then()` in JSX, `useSearchParams` under Suspense.
- **UI polish.** Empty/loading/error states everywhere, optimistic updates with snapshot rollback, SSE/cache version coordination, no `dangerouslySetInnerHTML`/`eval`, all external links `noopener noreferrer`.

---

## Suggested order of work

1. **Before any deploy:** S1 (preview read-only + guard), contract limits on webhooks S2, D3 (regex), D4 (reply retry), D1 (empty group), D6 (Meta pagination), S4 (`BOOTSTRAP_OWNER_EMAILS` required).
2. **Next sprint:** D2 (AI unknown), D5/D5b (reply uniqueness + `singletonKey`), D7 (thread tail), D8 (follow-ups), D9 (re-filter edits), D10 (token expiry), D11 (leases), D12 (dedupe ack), S3 (redirect), S6 (session revocation), F1–F5 (filter false positives), W1 (row accessibility), W2 (SSE batching), W7 (expiry tick).
3. **Cleanup:** W3–W6, W8 table, the item-page duplication, and the small ops items.
