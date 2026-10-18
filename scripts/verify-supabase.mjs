// Proves per-user isolation against the real Supabase Postgres, exercising the
// same posture the app uses (`SET LOCAL ROLE authenticated` + `app.user_id`):
//
//   1. two accounts get rows in auth.users the way signup leaves them (the
//      direct insert is the signup path's effect, without the confirmation
//      email — the free tier's email rate limit would otherwise throttle
//      repeated runs and send mail to addresses nobody owns);
//   2. the first account writes a habit and a log through `asUser`;
//   3. the second account must see none of it, cannot write into it, and
//      cannot pause it;
//   4. everything created here is deleted again — the local PGlite demo
//      database is never touched.
//
// Usage: node scripts/verify-supabase.mjs
// Needs DATABASE_URL in .env.local.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { createPgDb } from "../src/lib/db.ts";
import { asUser, userClient } from "../src/lib/scope.ts";

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

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const db = createPgDb(env.DATABASE_URL);
const created = [];

async function createAccount(label) {
  const id = randomUUID();
  const email = `kintsugi-verify-${label}-${id}@gmail.com`;
  await db.pool.query(
    `INSERT INTO auth.users (id, instance_id, aud, role, email)
     VALUES ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2)`,
    [id, email],
  );
  return id;
}

try {
  const alice = await createAccount("alice");
  const bob = await createAccount("bob");
  created.push(alice, bob);

  // Profile rows, written in the app's posture.
  await asUser(db, alice, (c) =>
    c.query("INSERT INTO users (id, name) VALUES ($1, $2)", [alice, "Alice"]),
  );
  await asUser(db, bob, (c) =>
    c.query("INSERT INTO users (id, name) VALUES ($1, $2)", [bob, "Bob"]),
  );

  // Alice logs a keystone habit and today's row.
  const habitId = await asUser(db, alice, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO habits (user_id, label, is_keystone)
       VALUES ($1, 'Verify habit', TRUE) RETURNING id`,
      [alice],
    );
    await c.query(
      "INSERT INTO daily_logs (habit_id, day, completed) VALUES ($1, current_date, TRUE)",
      [rows[0].id],
    );
    return rows[0].id;
  });

  const aliceClient = userClient(db, alice);
  const bobClient = userClient(db, bob);

  const ownHabits = await aliceClient.query("SELECT id FROM habits");
  check(
    "the signed-in account sees its own rows",
    ownHabits.rows.length === 1 && ownHabits.rows[0].id === habitId,
  );

  let clean = true;
  for (const table of ["habits", "daily_logs", "bounce_back_events", "v_weekly_habit_summary"]) {
    const { rows } = await bobClient.query(`SELECT * FROM ${table}`);
    if (rows.length !== 0) {
      clean = false;
      console.log(`  ${table} leaked ${rows.length} row(s)`);
    }
  }
  check("a second account sees none of the first account's rows", clean);

  let rejected = false;
  try {
    await bobClient.query(
      "INSERT INTO daily_logs (habit_id, day, completed) VALUES ($1, current_date + 30, TRUE)",
      [habitId],
    );
  } catch (error) {
    rejected = /row-level security|violates row-level/i.test(String(error));
  }
  check("a second account cannot write into the first account's history", rejected);

  await bobClient.query("UPDATE daily_logs SET is_ghost = TRUE WHERE day = current_date");
  const { rows: ghostRows } = await aliceClient.query(
    "SELECT is_ghost FROM daily_logs WHERE habit_id = $1 AND day = current_date",
    [habitId],
  );
  check(
    "a second account cannot pause the first account's day",
    ghostRows.length === 1 && ghostRows[0].is_ghost === false,
  );

  const { rows: stillOne } = await aliceClient.query("SELECT COUNT(*)::int AS n FROM daily_logs");
  check("the first account's data is intact after the isolation checks", stillOne[0].n === 1);
} finally {
  // Undo: profile rows cascade to habits/logs/events; auth rows go directly.
  for (const id of created) {
    await asUser(db, id, (c) =>
      c.query("DELETE FROM users WHERE id = $1", [id]),
    ).catch(() => {});
    await db.pool
      .query("DELETE FROM auth.users WHERE id = $1", [id])
      .catch((error) => console.log(`cleanup: auth.users ${id} left behind (${String(error)})`));
  }
  await db.end();
  console.log("cleanup: test accounts removed");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
