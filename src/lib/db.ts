// Data layer. Today it runs Postgres in-process via PGlite (WASM, file-backed
// at .data/pg) so the app works offline and a fresh clone needs no service.
// Swapping in Supabase means replacing `connect()` with a pg/postgres client —
// every query below is plain SQL and stays as it is.
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

import {
  assembleWeek,
  weekScore,
  type RawLogRow,
  type Week,
} from "./week.ts";
import { asUser, type SqlClient } from "./scope.ts";

const DATA_DIR = path.join(process.cwd(), ".data", "pg");
const SCHEMA_FILE = path.join(process.cwd(), "prisma", "schema.sql");

declare global {
  // Survives dev-server hot reloads, which would otherwise reopen the database
  // on every module update.
  var __kintsugiDb: Promise<PGlite> | undefined;
}

const ALL = ["Morning meditation", "Read 10 pages", "Evening walk"];
const KEYSTONE_ONLY = ["Morning meditation"];

/** Day offsets from today → which habits were completed. */
const SEED_DAYS: { offset: number; done: string[]; ghost?: boolean }[] = [
  // A weaker week before this one, so "vs last week" is a real comparison.
  { offset: -13, done: ALL },
  { offset: -12, done: KEYSTONE_ONLY },
  { offset: -11, done: ["Morning meditation", "Read 10 pages"] },
  { offset: -10, done: KEYSTONE_ONLY },
  { offset: -9, done: ["Morning meditation", "Read 10 pages"] },
  { offset: -8, done: ["Morning meditation", "Evening walk"] },
  { offset: -7, done: KEYSTONE_ONLY },
  // This week.
  { offset: -6, done: ALL },
  { offset: -5, done: KEYSTONE_ONLY }, // keystone save
  { offset: -4, done: [], ghost: true }, // ghost day
  { offset: -3, done: ALL }, // came back
  { offset: -2, done: ALL },
  { offset: -1, done: ["Morning meditation", "Evening walk"] }, // read missed
  { offset: 0, done: ["Morning meditation", "Read 10 pages"] }, // read repaired
];

const SEED_HABITS = [
  { label: ALL[0], short: "Meditate", keystone: true },
  { label: ALL[1], short: "Read", keystone: false },
  { label: ALL[2], short: "Walk", keystone: false },
];

async function seedIfEmpty(db: PGlite): Promise<string | null> {
  const { rows } = await db.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM habits",
  );
  if ((rows[0]?.n ?? 0) > 0) {
    const existing = await db.query<{ id: string }>(
      "SELECT id FROM users ORDER BY created_at LIMIT 1",
    );
    return existing.rows[0]?.id ?? null;
  }

  const {
    rows: [{ id: userId }],
  } = await db.query<{ id: string }>(
    "INSERT INTO users (name) VALUES ($1) RETURNING id",
    ["You"],
  );

  const idByLabel = new Map<string, string>();
  for (const habit of SEED_HABITS) {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO habits (user_id, label, short_label, is_keystone)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, habit.label, habit.short, habit.keystone],
    );
    idByLabel.set(habit.label, rows[0].id);
  }

  for (const day of SEED_DAYS) {
    for (const habit of SEED_HABITS) {
      await db.query(
        `INSERT INTO daily_logs (habit_id, day, completed, is_ghost)
         VALUES ($1, current_date + $2::int, $3, $4)`,
        [
          idByLabel.get(habit.label),
          day.offset,
          day.done.includes(habit.label),
          Boolean(day.ghost),
        ],
      );
    }
  }

  return userId;
}

/** Applies prisma/schema.sql. Re-runnable: the schema drops its triggers first. */
export async function migrate(db: PGlite): Promise<void> {
  await db.exec(readFileSync(SCHEMA_FILE, "utf8"));
}

/** Inserts the demo week once; a no-op on every later call. Returns the owner. */
export async function seedDemoWeek(db: PGlite): Promise<string | null> {
  return seedIfEmpty(db);
}

async function connect(): Promise<PGlite> {
  // PGlite creates its data directory but not the parents, so make the path
  // first; the data dir is gitignored and rebuilt by the seed when missing.
  mkdirSync(DATA_DIR, { recursive: true });
  const db = await PGlite.create(DATA_DIR);
  await migrate(db);
  await seedDemoWeek(db);
  return db;
}

export function getDb(): Promise<PGlite> {
  globalThis.__kintsugiDb ??= connect().catch((error) => {
    // Never cache a failed connection: the next request should retry.
    globalThis.__kintsugiDb = undefined;
    throw error;
  });
  return globalThis.__kintsugiDb;
}

// Dates are formatted in SQL so a DATE never travels through a
// timezone-sensitive JavaScript Date.
async function queryLogs(
  db: SqlClient,
  fromOffset: number,
  toOffset: number,
): Promise<RawLogRow[]> {
  const { rows } = await db.query<RawLogRow>(
    `SELECT
       to_char(dl.day, 'YYYY-MM-DD')    AS iso_day,
       to_char(dl.day, 'FMDy')          AS short_day,
       to_char(dl.day, 'FMDay')         AS weekday,
       to_char(dl.day, 'FMMon FMDD')    AS date_label,
       (dl.day = current_date)          AS is_today,
       dl.is_ghost,
       (dl.completed AND NOT dl.is_ghost) AS completed,   -- effective completion
       h.id                             AS habit_id,
       h.label                          AS habit_label,
       COALESCE(h.short_label, h.label) AS habit_short,
       h.is_keystone
     FROM daily_logs dl
     JOIN habits h ON h.id = dl.habit_id
     WHERE dl.day BETWEEN current_date + $1::int AND current_date + $2::int
       AND h.user_id = current_user_id()   -- RLS also enforces this; explicit keeps plans honest
     ORDER BY dl.day, h.is_keystone DESC, h.label`,
    [fromOffset, toOffset],
  );
  return rows;
}

async function queryComebacks(
  db: SqlClient,
  fromOffset: number,
  toOffset: number,
): Promise<Map<string, number>> {
  const { rows } = await db.query<{ iso_day: string; n: number }>(
    `SELECT to_char(b.bounced_on, 'YYYY-MM-DD') AS iso_day, COUNT(*)::int AS n
     FROM bounce_back_events b
     JOIN habits h ON h.id = b.habit_id
     WHERE b.bounced_on BETWEEN current_date + $1::int AND current_date + $2::int
       AND h.user_id = current_user_id()
     GROUP BY 1`,
    [fromOffset, toOffset],
  );
  return new Map(rows.map((r) => [r.iso_day, r.n]));
}

/**
 * The last seven days for every habit, including ghost rows. Takes the
 * connection so tests can run it against their own Postgres.
 */
export async function loadWeekFrom(db: SqlClient): Promise<Week> {
  const current = assembleWeek(
    await queryLogs(db, -6, 0),
    await queryComebacks(db, -6, 0),
  );

  // "Versus last week" is measured with the same rules, not estimated.
  const priorRows = await queryLogs(db, -13, -7);
  const prior = assembleWeek(priorRows, new Map());
  const previousWeekScore =
    prior.days.length > 0 ? weekScore(prior.days, prior.habits) : null;

  return { ...current, previousWeekScore };
}

/** The account the request is acting as. Until auth lands, the app is
 * single-user and this resolves to the seeded row; the auth swap replaces this
 * one function with the session lookup. */
export async function currentUserId(db: PGlite): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM users ORDER BY created_at LIMIT 1",
  );
  if (!rows[0]) throw new Error("No account exists yet.");
  return rows[0].id;
}

/** loadWeek() against the app's own connection, scoped to the signed-in user. */
export async function loadWeek(): Promise<Week> {
  const db = await getDb();
  const userId = await currentUserId(db);
  return asUser(db, userId, (client) => loadWeekFrom(client));
}
