# Kintsugi

A habit tracker built on one idea: repair the break with gold. One keystone
habit, ghost days that pause the count instead of resetting it, bounce-backs
that are treated as wins, and an 85% target instead of a 100% ceiling.

This repo contains the MVP in four pieces:

1. **A running dashboard** — `src/app/dashboard/` (server component for the
   query + an interactive client board), reading and writing real rows in Postgres.

Deployment, accounts and the remaining manual steps are in
[`HANDOFF.md`](HANDOFF.md).
2. **A complete Postgres schema** — [`prisma/schema.sql`](prisma/schema.sql).
3. **A data layer** — `src/lib/db.ts` (connection, migration, seed, week query)
   and `src/lib/week.ts` (the rules, as pure functions).
4. **The stack decision** — below.

## Stack (free tier)

| Layer    | Choice                                   | Why                                                                    |
| -------- | ---------------------------------------- | ---------------------------------------------------------------------- |
| Frontend | Next.js 16 (App Router) + React 19       | Custom SVG/CSS bars, no chart library, no bundle tax                    |
| Styling  | Tailwind CSS v4                          | Theme tokens + utility overrides; custom component classes stay in `@layer components` |
| Hosting  | Vercel Hobby                             | Free CI/CD from GitHub, preview deploys per branch, edge cache          |
| Data     | Supabase Free (Postgres + auth + RLS)    | `consistency_pct` windows, triggers for bounce-backs, auth on day one   |

Zero-service alternative: SQLite in a single serverless function via
`drizzle-orm` + `better-sqlite3`. Simpler for a single-device MVP, but you lose
auth, sync, and the in-database bounce-back trigger.

**What runs today is a third option:** real Postgres, in-process, via
[PGlite](https://pglite.dev) (Postgres compiled to WASM). It is file-backed at
`.data/pg` (gitignored), so there is nothing to install and nothing to pay for,
while the SQL, triggers, and views are the same ones Supabase will run. Swapping
providers means replacing `connect()` in `src/lib/db.ts` with a `pg` client —
every query there is plain SQL. The first request seeds a demo week if the
database is empty.

## The three design rules

- **Keystone = 50% of the day.** The gold segment is always exactly half of a
  day's stacked bar; the supporting habits split the other half. The keystone
  can never be drowned out by bonus habits.
- **Ghost day = paused, not failed.** `is_ghost` rows are removed from both the
  numerator and denominator of every consistency calculation, and skipped when
  detecting bounce-backs.
- **85% target, not 100%.** Every bar carries a vertical target line at 85%.
  The hero meter measures the week against the same line.

## Logging

The board is the write path. Each bar segment is a button: tapping it toggles that
habit for that day, with an optimistic update so the day's score, the keystone-save
badge, and the weekly figure move before the server answers. Bounce-back chips settle
from the database instead, because a comeback is decided by rows that can sit outside
the visible week. Every day row has a `pause` / `resume` control for a ghost day.

Writes go through `src/app/dashboard/actions.ts` (thin, `"use server"`) into
`src/lib/mutations.ts` (plain SQL over a database handle, so it is testable without a
Next runtime). Three rules hold at the database level:

- the trigger records a comeback when a row is written;
- `resync_bounce_backs()` rebuilds a window authoritatively, and pauses call it, so
  retracting a day fixes the days after it;
- pausing is an overlay: the row keeps whatever was logged, `(completed AND NOT
  is_ghost)` is the effective value everywhere, and resuming restores the week exactly.

## Run it

```bash
npm run dev      # http://localhost:3000 → redirects to /dashboard
npm run build    # production build (also type-checks)
```

The dashboard is `ƒ Dynamic — server-rendered on demand`, because a week always
ends today. Delete `.data/` to get a fresh seeded database on the next request.

## Schema at a glance

`prisma/schema.sql` (Postgres / Supabase):

- `users` — one row per account.
- `habits` — `is_keystone` flag, plus a trigger enforcing one keystone per user.
- `daily_logs` — one row per habit per day, with `completed` and `is_ghost`.
- `bounce_back_events` — materialized at write time by a trigger: previous
  logged day missed, today completed. Ghost days never create a bounce-back.
- `v_weekly_habit_summary` — the 7-day view the dashboard reads.
- `consistency_pct(start_date, end_date, habit_id)` — ghost-excluded percentage,
  returns `NULL` when a window has no eligible days.
- `current_user_id()` — resolves the caller from the JWT claim (Supabase) or the
  `app.user_id` setting (plain Postgres, tests).

### Per-user isolation

Row Level Security is on for `users`, `habits`, `daily_logs` and
`bounce_back_events`: a habit is visible only when `user_id = current_user_id()`,
and a log is visible only through a habit the caller owns. The view is
`security_invoker`, so it cannot be used to read around the policies.

Table owners bypass RLS, so the app does not query as the owner: `src/lib/scope.ts`
puts every read and write inside a transaction that assumes the `authenticated`
role and publishes the user id — the same posture Supabase gives a signed-in user.
Both settings are transaction-local, so two accounts can share one connection.

`verify-schema.mjs` asserts this from the database's side, as a second account:
no rows from the first account are visible, an inserted log against its habits is
rejected by the policy, and an `UPDATE` that would pause its day matches nothing.

A **keystone save** (keystone done, every other habit missed) is a read-time
concept — it needs no table, just the week's rows.

## Verification

```bash
npm run test:schema       # schema rules, in-memory Postgres — no server needed
npm run test:week         # read path + scoring rules
npm run test:mutations    # write path, ghost repair
npm run test:dashboard    # UI invariants; needs a server (KINTSUGI_URL)
npm run test:interactions # clicks a bar, reloads to prove it persisted
npm run build             # includes the TypeScript check
npm run lint
```

`KINTSUGI_URL` defaults to `http://127.0.0.1:3111/dashboard`, so the two browser
suites can point at any running server: `KINTSUGI_URL=http://127.0.0.1:3222/dashboard
npm run test:interactions`. CI (`.github/workflows/ci.yml`) starts its own server and
runs all of the above.

**`scripts/verify-mutations.mjs`** covers the write path: pausing retracts the comeback
that followed (without destroying the log), resuming reproduces the previous week
exactly, a paused day refuses a completion, and toggling a habit adds and removes its
own comeback.

**`scripts/verify-interactions.mjs`** is the only end-to-end proof: it clicks a real
segment, checks the optimistic update, reloads the page to confirm the row reached
Postgres, pauses and resumes a day, then puts the demo week back.

**`scripts/verify-week.mjs`** migrates, seeds, and queries through the same
functions the app uses (`src/lib/db.ts`), then asserts the shape and the rules:
seven days × three habits, shares of `0.5 / 0.25 / 0.25`, SQL-formatted dates,
one ghost day that scores `null`, five bounce-backs (two of which sit on the far
side of the ghost day), a week score of `83%`, the same rules applied to last
week (`68%`), and an idempotent seed.

**`scripts/verify-schema.mjs`** runs `prisma/schema.sql` against a real Postgres
17 (PGlite, WASM, in-memory) and asserts the product rules on a seeded week:

- a second keystone habit for the same user is rejected by the trigger
- bounce-backs are recorded per missed habit, and a ghost day is never the
  recorded miss (Tuesday miss → Wednesday ghost → Thursday comeback counts)
- un-completing a day retracts its bounce-back row
- `consistency_pct` drops ghost days from numerator *and* denominator, and
  returns `NULL` for an all-ghost window
- exactly one keystone save is detected, and `v_weekly_habit_summary` still
  surfaces the ghost day with its flag

**`scripts/verify-dashboard.mjs`** renders the running dashboard in Chromium and
asserts the UI invariants:

- keystone segment share is exactly `0.5` of the bar, supporting habits `0.25`
- the 85% target line sits at `0.85` of every bar
- the ghost day renders a hatched background and no score
- the keystone paints real gold pixels (average RGB of the segment)
- Tailwind utilities resolve, nothing overflows horizontally, no console errors

It writes `preview/kintsugi-dashboard.png` next to the script.

> The schema tests run in an in-process Postgres, so they verify the SQL itself;
> they do not verify Supabase's auth/RLS wiring, which does not exist yet.

## Gotchas worth knowing

- **Never run `next build` while `next dev` is running.** They share `.next`, and on
  Windows the build dies with `EPERM: unlink .next/server/app/...`; the dev bundle can
  also be left half-written, which shows up as a page that renders but never hydrates.
- **If a client component renders but ignores clicks, check production.** In a
  sandboxed or proxied environment the dev server's HMR websocket can fail to connect
  (`ERR_INVALID_HTTP_RESPONSE`), and this Next version then never hydrates the page.
  A minimal `useState` button reproduces it, so it is not app code: verify with
  `npm run build && npm run start`.
- **Schema changes need a server restart.** The connection is cached per process, so
  `prisma/schema.sql` (including its `DROP ... IF EXISTS` migrations) is applied on
  first connect, not on every request.
- **Delete `.data/` for a fresh seed.** The next request recreates and re-seeds it.
