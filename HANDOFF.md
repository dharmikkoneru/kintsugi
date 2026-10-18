# Handoff — the steps only you can do

Everything in the app is finished and verified locally. What's left needs an
account, a credential, a decision, or a network this machine can't reach.

Current state, for orientation: the dashboard runs at
`http://127.0.0.1:3222/dashboard` (production build), the four test suites pass,
ESLint and `next build` are clean, and **the folder is not a git repository yet**
(no `.git`, no remote).

Do these in order. Each one unblocks the next.

---

## 1. Put it in git (5 min) — unblocks CI

There is no repository here, so `.github/workflows/ci.yml` has never run.

```bash
cd kintsugi
git init -b main
git add .
git commit -m "Kintsugi habit tracker MVP"
```

Before committing, confirm nothing private is staged:

```bash
git status --short | grep -E "\.data|\.env"   # must print nothing
```

`.gitignore` already covers `.data/`, `.env*`, `.next/`, `node_modules/`.

Then create an **empty** repo on GitHub (no README, no .gitignore — both exist
here) and push:

```bash
git remote add origin git@github.com:<your-user>/kintsugi.git
git push -u origin main
```

CI runs on push to `main` and on pull requests: install → lint → schema, week
and mutation tests → `next build` → both Chromium suites against a server it
starts itself. No secrets are needed. Watch the Actions tab; if a step fails
there that passed here, the cause is almost certainly step 2.

---

## 2. Reinstall dependencies on a normal network (5 min)

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

## 3. Decide: single-user, or accounts from day one (one word)

This is the only product decision blocking real work, and it changes onboarding
and the database policies, not just a login screen.

- **Single-user** — one account row, no sign-in, no RLS. Fastest path to
  something live. Fine if this is a personal tracker, and fine behind a private
  URL. You cannot share it, and anyone with the URL sees your data.
- **Accounts** — Supabase auth, `user_id` on every row, RLS policies so one
  account can never read another's habits, a sign-in page, and a first-run flow
  to create your own habits instead of the seeded demo week. Roughly a day of my
  work, none of it from you beyond the project in step 4.

Reply with `single-user` or `accounts`. **Recommended: accounts** — retrofitting
`user_id` and RLS after habits exist means a data migration on live rows.

---

## 4. Create the Supabase project (10 min, free tier)

I cannot create an account or a project for you. Do this only if you chose
accounts, or if you want a real deployment (see step 5).

1. Go to <https://supabase.com/dashboard>, sign in with GitHub.
2. **New project** → organization: personal → name: `kintsugi` → region: closest
   to you → **Generate a password** and save it in your password manager. It is
   shown once and you need it in step 4.5.
3. Wait for provisioning (~2 min).
4. **Project Settings → Database → Connection string → URI.** Use the
   **connection pooler** host (`...pooler.supabase.com`, port `6543`) — the
   direct connection on `5432` will exhaust connections from serverless
   functions. Replace `[YOUR-PASSWORD]` with the saved password and make sure
   the URL ends with `?sslmode=require`.
5. **Project Settings → API:** copy the **Project URL** and the **anon public**
   key. You do not need the service-role key for what's planned — every query
   will be scoped by the signed-in user via RLS instead.
6. Create `kintsugi/.env.local` (gitignored — **do not paste these in chat**):

   ```
   DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres?sslmode=require
   NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon public key>
   ```

7. Tell me **"env ready"**.

I'll take it from there: swap `connect()` in `src/lib/db.ts` for a Postgres
client, run `prisma/schema.sql` against the project, add `user_id` and the RLS
policies, wire Supabase auth and the sign-in route, replace the demo seed with a
first-run habit creator, and re-run all four suites against the real database
plus a two-account isolation test. You won't need to touch SQL.

**Free-tier cautions worth knowing now:** idle projects pause after about a week
with no traffic (the first request afterwards is slow, and scheduled jobs stop),
and backup retention is limited — check *Dashboard → Database → Backups*. If the
history starts to matter, I'll add a nightly export.

---

## 5. Deploy (10 min) — do step 4 first

**Do not deploy to Vercel before the Supabase swap.** PGlite keeps the database
in a local file, and serverless filesystems are ephemeral, so a Vercel deploy
today would reseed a fresh demo week on every cold start. Deploying first is only
sensible if you instead put this on a single always-on machine (a VPS or a
Raspberry Pi with `npm run build && npm run start` behind Caddy) — the same
PGlite code works unchanged there.

Once step 4 is done:

1. <https://vercel.com/new> → import the GitHub repo from step 1.
2. Framework is detected as Next.js. Leave build settings alone.
3. **Environment Variables** → add the same three names from step 4.5, for
   Production, Preview and Development. Values must not be quoted.
4. Deploy, then open the URL and tell me it's live — I'll run the browser
   suites against the real domain, check console/network errors and the auth
   flow, and tell you what's actually broken rather than assuming it's fine.
5. Optional: Settings → Domains for a custom domain.

---

## 6. Five minutes of QA only you can do

Local tests use headless Chromium at fixed viewports. Real phones differ.

- iPhone Safari and Android Chrome: tap a segment, hard-reload, confirm it
  persisted. Rotate the device. Confirm no sideways scrolling.
- Tap `pause` on a day, reload, then `resume`: the week total must come back to
  exactly what it was.
- Add to home screen (Safari → Share → Add to Home Screen). There is no web app
  manifest or icon set yet, so it will install as a plain page — say the word and
  I'll add a manifest, icons and an offline shell.
- After accounts exist: sign in on two devices, toggle on one, refresh the other;
  then sign in as a second account and confirm it sees none of the first's rows.

---

## What I need from you, in the fewest possible words

1. `git push` (step 1) — I don't commit or push without being asked.
2. The `npm ci` result (step 2).
3. One word: `single-user` or `accounts` (step 3).
4. "env ready" once `.env.local` exists (step 4).
5. "deployed" once Vercel gives you a URL (step 5).

Nothing else in the app is waiting on you. The three known gaps — no accounts,
no first-run habit creation, no web app manifest — are all things I can build the
moment you answer item 3.
