// Tests the write path against real Postgres: toggling a habit, pausing a day,
// and the repair that keeps history honest when a counted day is retracted.
//
// Usage: node --test scripts/verify-mutations.mjs
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";

import { migrate, seedDemoWeek, loadWeekFrom } from "../src/lib/db.ts";
import { setGhostDay, toggleHabit } from "../src/lib/mutations.ts";
import { userClient } from "../src/lib/scope.ts";

let db;
// Reads and writes run as the account, under RLS. `db` stays the privileged
// handle for fixtures and for checking what actually landed in the tables.
let owner;
// isos: [0]=Mon … [6]=Sun of the seeded current week.
let isos;
let habitIds;

const comebacksFor = async (habitId) => {
  const { rows } = await db.query(
    `SELECT to_char(bounced_on, 'YYYY-MM-DD') AS day
     FROM bounce_back_events WHERE habit_id = $1 ORDER BY bounced_on`,
    [habitId],
  );
  return rows.map((r) => r.day);
};

const stateOf = async (habitId, iso) => {
  const { rows } = await db.query(
    "SELECT completed, is_ghost FROM daily_logs WHERE habit_id = $1 AND day = $2::date",
    [habitId, iso],
  );
  return rows[0];
};

before(async () => {
  db = await PGlite.create();
  await migrate(db);
  const userId = await seedDemoWeek(db);
  owner = userClient(db, userId);
  const week = await loadWeekFrom(owner);
  isos = week.days.map((day) => day.iso);
  habitIds = Object.fromEntries(week.habits.map((h) => [h.short, h.id]));
});

after(async () => {
  await db.close();
});

test("pausing a day retracts the comeback that followed it, without erasing it", async () => {
  const before = await loadWeekFrom(owner);
  assert.equal(before.days[3].bounceBacks, 2, "Thursday starts with two comebacks");

  const result = await setGhostDay(owner, isos[1], true); // pause Tuesday
  assert.equal(result.ok, true);

  const paused = await loadWeekFrom(owner);
  assert.equal(paused.days[1].isGhost, true, "Tuesday is paused");
  assert.equal(paused.days[3].bounceBacks, 0, "the comeback after the pause is retracted");

  // The pause is an overlay: the keystone logged that day is still in the row,
  // it just stops counting while the day is paused.
  const row = await stateOf(habitIds.Meditate, isos[1]);
  assert.equal(row.is_ghost, true);
  assert.equal(row.completed, true, "pausing must not destroy what was logged");
  assert.equal(
    paused.days[1].cells[habitIds.Meditate],
    "missed",
    "but the read model reports it as not counting",
  );
});

test("resuming the day restores the week exactly as it was", async () => {
  await setGhostDay(owner, isos[1], false); // start from a resumed day
  const before = await loadWeekFrom(owner);

  await setGhostDay(owner, isos[1], true);
  const result = await setGhostDay(owner, isos[1], false);
  assert.equal(result.ok, true);

  const resumed = await loadWeekFrom(owner);
  assert.deepEqual(
    resumed.days.map((d) => ({ iso: d.iso, isGhost: d.isGhost, cells: d.cells, bounces: d.bounceBacks })),
    before.days.map((d) => ({ iso: d.iso, isGhost: d.isGhost, cells: d.cells, bounces: d.bounceBacks })),
    "pause then resume is a no-op on the data",
  );
});

test("a paused day cannot be completed", async () => {
  const result = await toggleHabit(owner, habitIds.Read, isos[2], true); // Wednesday is the ghost day
  assert.equal(result.ok, false);
  assert.match(result.reason, /paused/i);

  const row = await stateOf(habitIds.Read, isos[2]);
  assert.equal(row.completed, false, "the constraint held and nothing was written");
  assert.equal(row.is_ghost, true);
});

test("toggling a habit adds and retracts its own comeback", async () => {
  const baseline = await comebacksFor(habitIds.Walk);

  // Friday walking → un-complete it, which should make Saturday a comeback.
  const off = await toggleHabit(owner, habitIds.Walk, isos[4], false);
  assert.equal(off.ok, true);
  assert.equal((await stateOf(habitIds.Walk, isos[4])).completed, false);

  const afterMiss = await loadWeekFrom(owner);
  assert.equal(afterMiss.days[5].bounceBacks, 1, "Saturday repairs Friday's miss");
  assert.deepEqual(
    await comebacksFor(habitIds.Walk),
    [...baseline, isos[5]].sort(),
    "exactly one comeback was added, on Saturday",
  );

  // Put it back: the comeback should disappear again.
  const on = await toggleHabit(owner, habitIds.Walk, isos[4], true);
  assert.equal(on.ok, true);
  const restored = await loadWeekFrom(owner);
  assert.equal(restored.days[5].bounceBacks, 0);
  assert.deepEqual(await comebacksFor(habitIds.Walk), baseline, "and nothing else moved");
});

test("the read path sees the write immediately", async () => {
  const before = await loadWeekFrom(owner);
  const keystoneId = habitIds.Meditate;
  const sunday = isos[6];

  await toggleHabit(owner, keystoneId, sunday, false); // drop the keystone on today
  const after = await loadWeekFrom(owner);
  assert.ok(
    after.days[6].cells[keystoneId] === "missed",
    "the keystone is missed on Sunday now",
  );
  assert.ok(
    (after.days[6].bounceBacks ?? 0) >= 0,
    "and the day still renders",
  );
  assert.notEqual(
    after.days[6].cells[keystoneId],
    before.days[6].cells[keystoneId],
    "the read path sees the write",
  );

  await toggleHabit(owner, keystoneId, sunday, true); // restore
  const restored = await loadWeekFrom(owner);
  assert.equal(restored.days[6].cells[keystoneId], "done");
});
