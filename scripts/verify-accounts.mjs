// End-to-end check of the accounts flow against the real Supabase project:
//
//   1. an unauthenticated visit to /dashboard is redirected to /sign-in;
//   2. a real session (password sign-in through @supabase/ssr, the same cookie
//      format the app writes) reaches the dashboard;
//   3. a fresh account sees the first-run creator, names its habits, and the
//      board renders from Supabase;
//   4. a toggle survives a reload, so the write reached the real database;
//   5. everything created here is deleted again.
//
// Usage: KINTSUGI_URL=http://127.0.0.1:3111 node scripts/verify-accounts.mjs
// The server must be running in Postgres mode (DATABASE_URL set).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { createServerClient } from "@supabase/ssr";

import { createPgDb } from "../src/lib/db.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(path.join(here, "..", ".env.local"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);

const base = process.env.KINTSUGI_URL ?? "http://127.0.0.1:3111";

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const db = createPgDb(env.DATABASE_URL);
const email = `kintsugi-verify-account-${randomUUID()}@gmail.com`;
const password = randomUUID() + randomUUID();
let userId = null;

try {
  // The signup path's effect: an auth user with a confirmed email and a
  // password these checks can sign in with. (Signup over the API would send a
  // confirmation email and hit the free tier's tight email rate limit.)
  const hashRow = await db.pool.query(
    "SELECT extensions.crypt($1, extensions.gen_salt('bf')) AS hash",
    [password],
  );
  userId = randomUUID();
  // created_at/updated_at matter: GoTrue scans them into non-nullable time
  // fields, and NULL there surfaces as the opaque "Database error querying
  // schema" from the auth API.
  await db.pool.query(
    `INSERT INTO auth.users
       (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
        raw_app_meta_data, raw_user_meta_data,
        confirmation_token, email_change, email_change_token_new, recovery_token,
        created_at, updated_at)
     VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
             $2, $3, now(),
             '{"provider":"email","providers":["email"]}', '{}',
             '', '', '', '',
             now(), now())`,
    [userId, email, hashRow.rows[0].hash],
  );
  // GoTrue's sign-in resolves the user through auth.identities; the email
  // identity's id and provider_id are the user id.
  await db.pool.query(
    `INSERT INTO auth.identities
       (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
     VALUES ($1, $1, jsonb_build_object('sub', $2::text, 'email', $3::text), 'email', $2::text, now(), now(), now())`,
    [userId, userId, email],
  );

  // A real session, captured from the SSR cookie adapter.
  const cookies = [];
  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll: () => cookies.map(({ name, value }) => ({ name, value })),
        setAll: (list) => {
          for (const { name, value, options } of list) {
            const existing = cookies.findIndex((c) => c.name === name);
            const cookie = { name, value, options };
            if (existing === -1) cookies.push(cookie);
            else cookies[existing] = cookie;
          }
        },
      },
    },
  );
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  check("password sign-in against Supabase Auth succeeds", !error, error?.message);
  if (error) throw error;
  check("the SSR client captured session cookies", cookies.length > 0, `${cookies.length} cookie(s)`);

  const browser = await chromium.launch();

  // 1. Signed out: redirected to sign-in.
  const anon = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const anonPage = await anon.newPage();
  await anonPage.goto(`${base}/dashboard`, { waitUntil: "networkidle" });
  check(
    "a signed-out visit to /dashboard lands on /sign-in",
    anonPage.url().includes("/sign-in"),
    anonPage.url(),
  );
  await anon.close();

  // 2. Signed in: the dashboard renders the first-run creator.
  const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  await context.addCookies(
    cookies.map(({ name, value }) => ({
      name,
      value,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    })),
  );
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && !msg.text().includes("hmr")) consoleErrors.push(msg.text());
  });

  await page.goto(`${base}/dashboard`, { waitUntil: "networkidle" });
  const firstRun = await page.getByText("Name your three habits").isVisible().catch(() => false);
  check("a fresh account sees the first-run creator", firstRun);

  // 3. Name the habits and land on the board. The refresh after the action is
  // asynchronous, so wait for the board rather than sampling once.
  await page.getByRole("button", { name: "Start this week" }).click();
  const boardVisible = await page
    .locator('[data-testid="hero-score"]')
    .waitFor({ state: "visible", timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  check("the board renders from the real database", boardVisible);
  if (!boardVisible) {
    const bodyText = await page.locator("body").innerText().catch(() => "(no body)");
    console.log(`  page url: ${page.url()}`);
    console.log(`  body starts: ${bodyText.slice(0, 300).replaceAll("\n", " | ")}`);
  }

  // 4. Toggle the keystone segment of today, then confirm the row landed in
  // Supabase before reloading (the action's round trip can outlast a reload).
  const row = page.locator("main ul > li").last();
  const segment = row.locator("div.relative > div.relative button").first();
  const before = await segment.getAttribute("aria-pressed");
  await segment.click();
  await page.waitForTimeout(150);
  const optimistic = await segment.getAttribute("aria-pressed");
  check(
    "clicking the keystone segment flips it",
    optimistic === String(before !== "true"),
    `${before} → ${optimistic}`,
  );

  let landed = false;
  for (let i = 0; i < 50 && !landed; i += 1) {
    const { rows } = await db.pool.query(
      `SELECT dl.completed
       FROM daily_logs dl
       JOIN habits h ON h.id = dl.habit_id
       WHERE h.user_id = $1 AND h.is_keystone AND dl.day = current_date`,
      [userId],
    );
    landed = rows[0]?.completed === true;
    if (!landed) await page.waitForTimeout(200);
  }
  check("the write reached Supabase", landed);

  await page.reload({ waitUntil: "networkidle" });
  const afterReload = await row
    .locator("div.relative > div.relative button")
    .first()
    .getAttribute("aria-pressed");
  check("the toggle survived a reload", afterReload === "true", `after reload: ${afterReload}`);

  check("no application console errors", consoleErrors.length === 0, consoleErrors.join(" | "));

  await context.close();
  await browser.close();
} finally {
  if (userId) {
    await db.pool.query("DELETE FROM public.users WHERE id = $1", [userId]).catch(() => {});
    await db.pool.query("DELETE FROM auth.users WHERE id = $1", [userId]).catch((error) =>
      console.log(`cleanup: auth.users row left behind (${String(error)})`),
    );
  }
  await db.end();
  console.log("cleanup: test account removed");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
