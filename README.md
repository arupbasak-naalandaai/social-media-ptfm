# Social Inbox

One inbox for Google Business Profile reviews, Facebook/Instagram comments and DMs, YouTube comments, and LinkedIn Company Page comments.

- **Plan and decisions:** [`docs/PLAN.md`](docs/PLAN.md)
- **Status:** [`docs/PROGRESS.md`](docs/PROGRESS.md)

## Layout

| Path              | What                                                                                                                    |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `apps/web`        | Next.js 16 (App Router, Cache Components), Tailwind 4, shadcn/ui (Base UI). Talks only to the api via `/api/*` rewrites |
| `apps/api`        | Hono on Node: better-auth (`/api/auth/*`), REST, and later webhooks, Slack and SSE                                      |
| `apps/worker`     | pg-boss queues + DB-driven scheduler, `/health` server                                                                  |
| `packages/db`     | Prisma 7 schema, migrations, client (`@inbox/db`)                                                                       |
| `packages/auth`   | better-auth config + sign-in allowlist policy (`@inbox/auth`)                                                           |
| `packages/core`   | Shared zod schemas, roles, queue config, logger (`@inbox/core`)                                                         |
| `packages/config` | Shared tsconfig + ESLint                                                                                                |

## Local setup

Requirements: Node 24 (`.nvmrc`; 26 also works), pnpm 10, and Postgres 16+ (native, or `docker compose up -d db`).

1. Install and configure:
   ```sh
   pnpm install
   pnpm setup:env   # creates .env and fills BETTER_AUTH_SECRET + ENCRYPTION_KEY
   ```
   Check `DATABASE_URL` in `.env`.
2. Create one Google OAuth client (Google Cloud Console → Credentials → OAuth client ID → Web application). It's used for sign-in **and** for the Business Profile / YouTube connections:
   - Authorized JavaScript origins: `http://localhost:3000` and `http://localhost` (One Tap needs both).
   - Authorized redirect URI: `http://localhost:3000/api/auth/callback/google` (sign-in and the Business Profile / YouTube connections share it).
   - Put the ID in `GOOGLE_CLIENT_ID` and the secret in `GOOGLE_CLIENT_SECRET` (the browser gets the ID automatically).
   - To connect Business Profile / YouTube later, enable those APIs in the same project. Nothing else to enter.
3. Create the database schema:
   ```sh
   pnpm db:deploy     # apply migrations (use pnpm db:migrate when changing the schema)
   pnpm db:seed       # optional demo workspace: 5 demo accounts, default filter rules + lists, ~100 items
   ```
   The demo is its own workspace. Signing in with Google never shows it: your account gets a real, empty workspace with the default filter rules. You only see the demo signed out with `DEV_AUTH_BYPASS=true`. The seed runs every item through the real filter pipeline. Re-running it keeps rule edits; `pnpm db:seed --reset` replaces the seeded items. On a database where a real account already claimed the demo, `pnpm db:demo:remove` (add `--dry-run` to preview) removes the demo content from it.
4. Run everything:
   ```sh
   pnpm dev           # web :3000, api :3001, worker :3002
   ```
5. Open http://localhost:3000 and sign in with Google. **The first account to sign in becomes the owner** (set `BOOTSTRAP_OWNER_EMAILS` to restrict who that can be). Everyone else must be on the allowlist (Settings → General, Phase 3; for now, edit `settings.general.signInAllowlist` in the DB).

**Browse without signing in (local only):** set `DEV_AUTH_BYPASS=true` in `.env` and restart `pnpm dev`. Signed-out visits act as a virtual preview user (`DEV_AUTH_ROLE`, default `owner`), and a "Preview mode" badge appears in the header. Nothing is written to the database, so your first real Google sign-in still becomes the owner. The api refuses to start with this on in production or on Railway.

If port 3000 is taken, set `WEB_PORT`, `WEB_URL` and `BETTER_AUTH_URL` to the new port, and add it to the Google client.

## Commands

| Command                                      | What                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                   | All apps in watch mode                                                                                                     |
| `pnpm build`                                 | Production builds (web: `next build`, api/worker: tsdown → `dist/index.mjs`)                                               |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | Across the monorepo                                                                                                        |
| `pnpm db:migrate`                            | Create + apply a migration from schema changes                                                                             |
| `pnpm db:generate`                           | Regenerate the Prisma client                                                                                               |
| `pnpm auth:generate`                         | Regenerate better-auth's Prisma models after changing auth plugins (re-check the `Organization` back-relations afterwards) |
| `pnpm format`                                | Prettier                                                                                                                   |

Auth integration tests run against `TEST_DATABASE_URL` (a disposable, migrated database) and are skipped when it isn't set:

```sh
createdb social_inbox_test
DATABASE_URL=postgresql://localhost:5432/social_inbox_test pnpm db:deploy
```
