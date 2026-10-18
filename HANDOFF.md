# Handoff — the steps only you can do

Everything in the app is finished and verified locally. What's left needs an
account, a credential, a decision, or a network this machine can't reach.

Current state, for orientation: the dashboard runs at
`http://127.0.0.1:3111/dashboard` (production build), and there are now seven
test suites, all passing: `test:week` (8), `test:mutations` (5), `test:schema`
(11), `test:interactions` (9, Chromium), `test:dashboard` (Chromium),
`test:supabase` (5, real Supabase RLS isolation) and `test:accounts` (9,
Chromium against a real Supabase account). ESLint, `tsc` and `next build` are
clean.

**Status:** steps 1–4 are done. Supabase accounts are fully wired: sign-in
(magic link + 6-digit code), first-run habit creator, auth-gated dashboard,
PWA manifest and icons. `src/lib/db.ts` uses Postgres when `DATABASE_URL` is
set (and `KINTSUGI_DB=pglite` forces demo mode for offline browser tests),
`prisma/schema.sql` is applied to the live project, and `verify-schema.mjs`
plus `verify-supabase.mjs` prove from the database's side that one account
sees nothing of another and cannot write into it. CI is green on `1841faf`
(every step: install, lint, typecheck, the three database suites, build,
Chromium, both browser suites). Remaining: deploy (step 5) and device QA
(step 6).

Do these in order. Each one unblocks the next.

---

## 0. Lockfile rule — read before touching dependencies

The lockfile was hand-repaired in `14aac26` (and again in `1841faf`) to carry
`node_modules/@emnapi/core@1.11.3` and `node_modules/@emnapi/runtime@1.11.3`
(optional wasm dependencies of `sharp` and `tailwindcss/oxide`). The GitHub
runner's npm (11.19+) requires those entries; the local npm on this machine
(11.6.1) silently prunes them whenever it rewrites the lock, and the next CI
run then dies at `Install` with `npm error Missing: @emnapi/...`. **After any
dependency change, before pushing, verify the lock with the same npm CI uses:**

```powershell
npx -y npm@11.19.0 ci --dry-run
```

If it prints a `Missing: @emnapi/...` error, re-add the two entries (they must
keep the integrity hashes already in git history — `git show 1841faf --
package-lock.json`) or regenerate the lock with npm 11.19.0 itself.

---

## 1. Put it in git — DONE

The repo is public at <https://github.com/dharmikkoneru/kintsugi>. Kept below as
the record of what was run. First CI run failed at `Install` because the
lockfile was missing `@emnapi/runtime@1.11.3` and `@emnapi/core@1.11.3` (optional
wasm dependencies of `sharp` and `tailwindcss/oxide`); both entries were added
with real registry integrity hashes in `14aac26`, and run #2 passed.

```bash
cd kintsugi
git init -b main
git add .
# Confirm nothing private is staged — this must print nothing:
git status --short | grep -E "\.data|\.env"
git commit -m "Kintsugi habit tracker MVP"
```

`.gitignore` already covers `.data/`, `.env*`, `.next/`, `node_modules/`, so
the commit should be a few dozen files rather than thousands.

Then create an **empty** repo on GitHub (no README, no .gitignore — both exist
here) and push over HTTPS. This machine has no SSH key (`ssh -T git@github.com`
returns `Permission denied (publickey)`), so the `git@github.com:` form will
fail; use the HTTPS remote and let Git Credential Manager open a browser to
authorize the first push.

```bash
git remote add origin https://github.com/<your-user>/kintsugi.git
git push -u origin main
```

CI runs on push to `main` and on pull requests: install → lint → typecheck →
schema, week and mutation tests → `next build` → both Chromium suites against a
server it starts itself. No secrets are needed: without Supabase env vars the
app and middleware fall back to local PGlite demo mode, which the suites cover.

---

## 2. Reinstall dependencies on a normal network — DONE (in CI)

This is the highest-risk unknown. Installs time out on this machine, so
`package-lock.json` was regenerated from registry metadata and `@electric-sql/pglite`,
`@tailwindcss/postcss` and `playwright` were unpacked from tarballs by hand. The
lockfile is internally consistent (verified: `npm ci` will not fail on a
version mismatch), but a real install has not happened here.

```bash
rm -rf node_modules .next
npm ci
npm run build
```

If `npm ci` objects, run `npm install` once and commit the new lockfile. Either
way, tell me the outcome — if a version floats, I'll pin it.

Browser tests also need a Chromium binary once per machine:

```bash
npx playwright install chromium
```

---

## 3. Decide: single-user, or accounts from day one — DECIDED: accounts — DONE

This is the only product decision blocking real work, and it changes onboarding
and the database policies, not just a login screen.

- **Single-user** — one account row, no sign-in, no RLS. Fastest path to
  something live. Fine if this is a personal tracker, and fine behind a private
  URL. You cannot share it, and anyone with the URL sees your data.
- **Accounts** — Supabase auth, `user_id` on every row, RLS policies so one
  account can never read another's habits, a sign-in page, and a first-run flow
  to create your own habits instead of the seeded demo week. Roughly a day of my
  work, none of it from you beyond the project in step 4.

Built and verified: sign-in page (magic link and 6-digit code), `/auth/callback`
and `/auth/confirm` routes, session refresh in middleware, `requireUserId()`
guarding the dashboard and server actions, first-run creator, and the SSR
cookie flow exercised end-to-end by `test:accounts`.

---

## 4. Create the Supabase project (10 min, free tier) — DONE

The project is provisioned, `.env.local` is in place (Supabase URL, publishable
key, pooled `DATABASE_URL`), `prisma/schema.sql` is applied, and both
`test:supabase` and `test:accounts` pass against it. Two implementation notes,
kept for the record:

- `sslmode=require` makes modern `pg` verify the full chain, which fails against
  Supabase's pooler certificate locally; `PgDb` strips the parameter and uses
  `ssl: { rejectUnauthorized: false }`.
- GoTrue scans `auth.users.created_at`/`updated_at` into non-nullable fields, so
  hand-inserted test users (in `verify-accounts.mjs`) must set them explicitly.

**Free-tier cautions worth knowing now:** idle projects pause after about a week
with no traffic (the first request afterwards is slow, and scheduled jobs stop),
and backup retention is limited — check *Dashboard → Database → Backups*. If the
history starts to matter, I'll add a nightly export.

---

## 5. Deploy (10 min)

The Supabase swap is done, so Vercel is now safe. (Before the swap, PGlite kept
the database in a local file and serverless filesystems are ephemeral, so a
deploy would have reseeded a fresh demo week on every cold start.)

1. <https://vercel.com/new> → import the GitHub repo from step 1.
2. Framework is detected as Next.js. Leave build settings alone.
3. **Environment Variables** → add the same three names from `.env.local`, for
   Production, Preview and Development:

   ```
   DATABASE_URL
   NEXT_PUBLIC_SUPABASE_URL
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
   ```

   Values must not be quoted.
4. In Supabase → **Authentication → URL Configuration**, add the Vercel domain
   to **Site URL / Redirect URLs** so the magic-link callback can return there.
5. Deploy, then open the URL and tell me it's live — I'll run the browser
   suites against the real domain, check console/network errors and the auth
   flow, and tell you what's actually broken rather than assuming it's fine.
6. Optional: Settings → Domains for a custom domain.

---

## 6. Five minutes of QA only you can do

Local tests use headless Chromium at fixed viewports. Real phones differ.

- iPhone Safari and Android Chrome: tap a segment, hard-reload, confirm it
  persisted. Rotate the device. Confirm no sideways scrolling.
- Tap `pause` on a day, reload, then `resume`: the week total must come back to
  exactly what it was.
- Add to home screen (Safari → Share → Add to Home Screen): the manifest and
  icon set now exist, so it should install with the proper name and icon — no
  address bar. Confirm it looks right and that the theme color fits.
- Sign in on two devices with the same account, toggle on one, refresh the
  other; then sign in as a second account and confirm it sees none of the
  first's rows.
- On your own account: sign in via magic link, run the first-run creator, and
  confirm the email arrives (free-tier email sends are rate-limited to a couple
  per hour, so don't spam the sign-in button).

---

## What I need from you, in the fewest possible words

1. **Rotate the database password.** It was pasted in chat, so it should be
   considered exposed: Supabase → Project Settings → Database → Reset database
   password, then update `DATABASE_URL` in `.env.local` (local only for now).
2. Try `/sign-in` yourself once (magic link) and say "works" or describe what
   happens.
3. `git push` when you're happy with the diff — I don't commit or push without
   being asked. All account work is uncommitted on top of `fa48928`.
4. "deployed" once Vercel gives you a URL (step 5).

Nothing else in the app is waiting on you. Accounts, first-run habit creation,
and the web app manifest are all built and verified.
