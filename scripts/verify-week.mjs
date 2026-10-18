// Tests the read path end to end without touching the app's data directory:
// an in-memory Postgres, the real schema, the real seed, the real query, and
// the real rules from src/lib/week.ts.
//
// Usage: node --test scripts/verify-week.mjs
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";

import { migrate, seedDemoWeek, loadWeekFrom } from "../src/lib/db.ts";
import { eligibleDays, scoreForDay, weekScore } from "../src/lib/week.ts";

let db;
let week;

before(async () => {
  db = await PGlite.create(); // in-memory
  await migrate(db);
  await seedDemoWeek(db);
  week = await loadWeekFrom(db);
});

after(async () => {
  await db.close();
});

test("the week is seven days of buildable rows", () => {
  assert.equal(week.days.length, 7, "one row per day");
  assert.equal(week.habits.length, 3, "one keystone + two supporting habits");
  assert.equal(week.habits.filter((h) => h.keystone).length, 1, "exactly one keystone");
  assert.equal(week.days.at(-1).isToday, true, "the last day is today");
  assert.ok(
    week.days.every((d) => Object.keys(d.cells).length === 3),
    "every day carries a cell per habit",
  );
});

test("shares: keystone is worth half the day, supporting habits split the rest", () => {
  const keystone = week.habits.find((h) => h.keystone);
  const supporting = week.habits.filter((h) => !h.keystone);
  assert.equal(keystone.share, 0.5);
  for (const habit of supporting) assert.equal(habit.share, 0.25);
  const total = week.habits.reduce((sum, h) => sum + h.share, 0);
  assert.equal(Number(total.toFixed(6)), 1, "shares add up to a full day");
});

test("dates come from SQL, formatted for the UI", () => {
  for (const day of week.days) {
    assert.match(day.iso, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(day.dateLabel, /^[A-Z][a-z]{2} \d{1,2}$/, `bad label: ${day.dateLabel}`);
    assert.match(day.short, /^[A-Z][a-z]{2}$/);
    assert.ok(day.weekday.length > 3);
  }
});

test("the ghost day is present, flagged, and scores null", () => {
  const ghosts = week.days.filter((d) => d.isGhost);
  assert.equal(ghosts.length, 1, "exactly one paused day in the seeded week");
  assert.ok(
    Object.values(ghosts[0].cells).every((cell) => cell === "missed"),
    "a ghost day is never completed",
  );
  const scored = week.days.filter((d) => !d.isGhost);
  assert.equal(scored.length, 6, "six counted days");
});

test("bounce-backs skip over the ghost day and across the week boundary", () => {
  // Seeded story: last week ended on a keystone-only day, so Monday of this
  // week repairs both supporting habits (2). Tuesday is a keystone save, the
  // ghost day follows, and Thursday repairs both again (2). Saturday misses
  // reading, Sunday repairs it (1). Five in total.
  const perDay = week.days.map((d) => `${d.short}:${d.bounceBacks}`).join(" ");
  assert.deepEqual(
    week.days.map((d) => d.bounceBacks),
    [2, 0, 0, 2, 0, 0, 1],
    `comebacks per day — got ${perDay}`,
  );
  assert.equal(week.days.reduce((sum, d) => sum + d.bounceBacks, 0), 5);

  const ghostDay = week.days.find((d) => d.isGhost);
  assert.equal(ghostDay.bounceBacks, 0, "the paused day is never credited as a comeback");

  // The comeback two days after the miss is the proof that the trigger walks
  // back past a ghost day instead of only looking at D-1.
  assert.equal(week.days[3].bounceBacks, 2, "Thursday repairs Tuesday's misses");
  assert.equal(week.days[2].isGhost, true, "with the ghost day in between");
});

test("the week score matches the rules, not the mock", () => {
  assert.equal(weekScore(week.days, week.habits), 83, "83% across six counted days");
  const scores = eligibleDays(week.days).map((d) => scoreForDay(d, week.habits));
  assert.deepEqual(scores, [100, 50, 100, 100, 75, 75]);
});

test("last week is measured with the same rules", () => {
  assert.equal(week.previousWeekScore, 68, "the seeded previous week is weaker");
});

test("the seed is idempotent", async () => {
  await seedDemoWeek(db);
  await seedDemoWeek(db);
  const logs = await db.query("SELECT COUNT(*)::int AS n FROM daily_logs");
  assert.equal(logs.rows[0].n, 42, "14 days × 3 habits, with no duplicates on re-seed");
  const habits = await db.query("SELECT COUNT(*)::int AS n FROM habits");
  assert.equal(habits.rows[0].n, 3);
  const locked = await db.query("SELECT COUNT(DISTINCT day)::int AS n FROM daily_logs");
  assert.equal(locked.rows[0].n, 14, "and no day was written twice");
});
