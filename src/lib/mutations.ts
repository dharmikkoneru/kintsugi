// The write path. Same shape as the read path: plain SQL against a database
// handle, so the server actions are thin wrappers and the rules stay testable
// without a Next runtime.
import type { SqlClient } from "./scope.ts";

/** How far forward to repair bounce-backs after history changes. */
const RESYNC_WINDOW_DAYS = 14;

export interface MutationResult {
  ok: boolean;
  /** Human-readable reason when ok is false. */
  reason?: string;
}

interface DayRow {
  habit_id: string;
  day: string;
  completed: boolean;
  is_ghost: boolean;
}

async function dayRows(db: SqlClient, isoDay: string): Promise<DayRow[]> {
  const { rows } = await db.query<DayRow>(
    `SELECT dl.habit_id, to_char(dl.day, 'YYYY-MM-DD') AS day, dl.completed, dl.is_ghost
     FROM daily_logs dl
     JOIN habits h ON h.id = dl.habit_id
     WHERE dl.day = $1::date
       AND h.user_id = current_user_id()`,
    [isoDay],
  );
  return rows;
}

/**
 * Marks one habit complete/incomplete on one day.
 *
 * A paused day can never be completed — the schema's CHECK constraint enforces
 * that, and this returns a readable reason before the constraint has to.
 */
export async function toggleHabit(
  db: SqlClient,
  habitId: string,
  isoDay: string,
  completed: boolean,
): Promise<MutationResult> {
  // Ownership first: a habit id from another account must read as "no such
  // habit" rather than as a row RLS happens to hide.
  const owned = await db.query<{ id: string }>(
    "SELECT id FROM habits WHERE id = $1",
    [habitId],
  );
  if (!owned.rows[0]) {
    return { ok: false, reason: "That habit does not exist on this account." };
  }

  const { rows } = await db.query<{ is_ghost: boolean }>(
    "SELECT is_ghost FROM daily_logs WHERE habit_id = $1 AND day = $2::date",
    [habitId, isoDay],
  );
  if (rows[0]?.is_ghost && completed) {
    return { ok: false, reason: "That day is paused as a ghost day." };
  }

  await db.query(
    `INSERT INTO daily_logs (habit_id, day, completed)
     VALUES ($1, $2::date, $3)
     ON CONFLICT (habit_id, day)
     DO UPDATE SET completed = EXCLUDED.completed, updated_at = now()`,
    [habitId, isoDay, completed],
  );

  // The trigger handles this row; a resync keeps the days after it honest in
  // case this edit repaired (or created) a gap.
  await db.query("SELECT resync_bounce_backs($1, $2::date, $2::date + $3::int)", [
    habitId,
    isoDay,
    RESYNC_WINDOW_DAYS,
  ]);

  return { ok: true };
}

/**
 * Pauses or un-pauses a whole day. Ghost days are a day-level concept in the
 * product, so every habit for that day moves together.
 */
export async function setGhostDay(
  db: SqlClient,
  isoDay: string,
  isGhost: boolean,
): Promise<MutationResult> {
  const existing = await dayRows(db, isoDay);
  if (existing.length === 0) {
    return { ok: false, reason: "No habits are logged for that day." };
  }

  // Only the flag moves: whatever the user had logged that day stays in the
  // row and comes back untouched when the day is resumed.
  await db.query(
    `UPDATE daily_logs dl
     SET is_ghost = $2, updated_at = now()
     FROM habits h
     WHERE h.id = dl.habit_id
       AND dl.day = $1::date
       AND h.user_id = current_user_id()`,
    [isoDay, isGhost],
  );

  // Pausing a day rewrites history around it: the comeback after the pause may
  // disappear, and un-pausing may create one. Rebuild both directions.
  for (const id of existing.map((row) => row.habit_id)) {
    await db.query(
      `SELECT resync_bounce_backs($1, $2::date - 1, $2::date + $3::int)`,
      [id, isoDay, RESYNC_WINDOW_DAYS],
    );
  }

  return { ok: true };
}
