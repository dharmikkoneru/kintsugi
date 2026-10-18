// Runs prisma/schema.sql against a real Postgres (PGlite, WASM — no server
// needed) and asserts the rules the product depends on:
//   1. exactly one keystone habit per user
//   2. a bounce-back is recorded for a miss → completion
//   3. a ghost day never counts, never breaks a streak, never fakes a comeback
//   4. consistency_pct drops ghost days from numerator AND denominator
//   5. a keystone save is detectable from the same rows
//
// Usage: node --test scripts/verify-schema.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(path.join(here, "..", "prisma", "schema.sql"), "utf8");

const db = await PGlite.create();
await db.exec(schema);
after(async () => {
  await db.close();
});

const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const many = async (sql, params) => (await db.query(sql, params)).rows;
const iso = (d) => d.toISOString().slice(0, 10);

// ── Fixtures: one week, Mon(0) .. Sun(6), relative to today ────────────────
const {
  rows: [{ id: user }],
} = await db.query("INSERT INTO users (name) VALUES ($1) RETURNING id", ["Ada"]);
const { rows: habits } = await db.query(
  `INSERT INTO habits (user_id, label, is_keystone) VALUES
     ($1, 'Morning meditation', TRUE),
     ($1, 'Read 10 pages', FALSE),
     ($1, 'Evening walk', FALSE)
   RETURNING id, label, is_keystone`,
  [user],
);
const [KEYSTONE, READ, WALK] = habits;

// day offset → which habits were completed. -4 is the ghost day (paused).
const WEEK = [
  { offset: -6, done: [KEYSTONE, READ, WALK] }, // Mon: everything
  { offset: -5, done: [KEYSTONE] }, //             Tue: keystone save
  { offset: -4, ghost: true }, //                  Wed: ghost day
  { offset: -3, done: [KEYSTONE, READ, WALK] }, // Thu: came back
  { offset: -2, done: [KEYSTONE, READ, WALK] }, // Fri
  { offset: -1, done: [KEYSTONE, WALK] }, //       Sat: read missed
  { offset: 0, done: [KEYSTONE, READ] }, //        Sun: read came back
];

for (const day of WEEK) {
  for (const habit of habits) {
    await db.query(
      `INSERT INTO daily_logs (habit_id, day, completed, is_ghost)
       VALUES ($1, current_date + $2::int, $3, $4)`,
      [
        habit.id,
        day.offset,
        day.ghost ? false : day.done.some((h) => h.id === habit.id),
        Boolean(day.ghost),
      ],
    );
  }
}

test("only one keystone habit per user", async () => {
  await assert.rejects(
    () =>
      db.query(
        "INSERT INTO habits (user_id, label, is_keystone) VALUES ($1, 'Second keystone', TRUE)",
        [user],
      ),
    /already has a keystone habit/,
  );
});

test("bounce-backs are recorded per missed habit, skipping ghost days", async () => {
  const rows = await many(
    `SELECT h.label, b.bounced_on, b.missed_on
     FROM bounce_back_events b
     JOIN habits h ON h.id = b.habit_id
     ORDER BY b.bounced_on, h.label`,
  );
  const summary = rows.map(
    (r) => `${r.label}: missed ${iso(r.missed_on)} → back ${iso(r.bounced_on)}`,
  );

  // Tue missed read + walk, Wed was a ghost day, Thu completed both → 2 comebacks.
  // Sat missed read, Sun completed it → 1 more.
  assert.equal(rows.length, 3, `expected 3 bounce-backs, got:\n  ${summary.join("\n  ")}`);
  assert.equal(
    rows.filter((r) => r.label === "Read 10 pages").length,
    2,
    "read comes back on Thu and Sun",
  );
  assert.equal(
    rows.filter((r) => r.label === "Evening walk").length,
    1,
    "walk comes back on Thu only",
  );

  // The ghost day is never the recorded miss, even though it sits between the
  // Tuesday miss and the Thursday comeback.
  const ghostOrigin = await one(
    `SELECT COUNT(*)::int AS n
     FROM bounce_back_events b
     JOIN daily_logs g ON g.habit_id = b.habit_id AND g.day = b.missed_on
     WHERE g.is_ghost`,
  );
  assert.equal(ghostOrigin.n, 0, "a ghost day must never be logged as the missed day");
});

test("ghost rows carry no completion", async () => {
  const ghost = await many(
    "SELECT completed, is_ghost FROM daily_logs WHERE day = current_date - 4",
  );
  assert.equal(ghost.length, 3);
  assert.ok(
    ghost.every((r) => r.is_ghost && !r.completed),
    "ghost rows are flagged and never completed",
  );
});

test("consistency_pct drops ghost days from numerator and denominator", async () => {
  // Read: 6 eligible days (the ghost day is out), completed Mon/Thu/Fri/Sun → 4/6.
  const read = await one("SELECT consistency_pct(current_date - 6, current_date, $1) AS pct", [
    READ.id,
  ]);
  assert.equal(Number(read.pct), 66.7, "ghost day excluded from both sides");

  // Keystone: completed on every eligible day.
  const keystone = await one(
    "SELECT consistency_pct(current_date - 6, current_date, $1) AS pct",
    [KEYSTONE.id],
  );
  assert.equal(Number(keystone.pct), 100);

  // A window made only of ghost days has no eligible days at all.
  const ghostOnly = await one(
    "SELECT consistency_pct(current_date - 4, current_date - 4, $1) AS pct",
    [READ.id],
  );
  assert.equal(ghostOnly.pct, null, "all-ghost window returns NULL, not 0");
});

test("a keystone save is detectable from the same week", async () => {
  const { rows } = await db.query(
    `SELECT d.day,
       EXISTS (
         SELECT 1
         FROM daily_logs other
         JOIN habits oh ON oh.id = other.habit_id
         WHERE NOT oh.is_keystone
           AND NOT other.is_ghost
           AND other.completed
           AND other.day = d.day
           AND oh.user_id = $1
       ) AS has_support
     FROM daily_logs d
     JOIN habits k ON k.id = d.habit_id AND k.is_keystone
     WHERE d.completed AND NOT d.is_ghost
     ORDER BY d.day`,
    [user],
  );
  const saves = rows.filter((r) => !r.has_support);
  assert.equal(saves.length, 1, "exactly one keystone save in the week");
  assert.equal(iso(saves[0].day), iso(rows[1].day), "and it is Tuesday");
});

test("v_weekly_habit_summary exposes the window with bounce flags", async () => {
  const rows = await many("SELECT * FROM v_weekly_habit_summary ORDER BY day, label");
  assert.equal(rows.length, 21, "7 days × 3 habits");
  assert.equal(rows.filter((r) => r.is_bounce_back).length, 3, "3 flagged comebacks");
  assert.equal(
    rows.filter((r) => r.is_ghost).length,
    3,
    "the ghost day still appears, flagged",
  );
});
