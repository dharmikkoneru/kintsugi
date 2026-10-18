"use server";

import { revalidatePath } from "next/cache";

import { requireUserId } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { setGhostDay, toggleHabit, type MutationResult } from "@/lib/mutations";
import { asUser } from "@/lib/scope";

export type ActionState = MutationResult;

/** Completes or un-completes one habit on one day. */
export async function toggleHabitAction(
  habitId: string,
  isoDay: string,
  completed: boolean,
): Promise<ActionState> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDay)) {
    return { ok: false, reason: "Unrecognized day." };
  }

  try {
    const userId = await requireUserId();
    const db = await getDb();
    const result = await asUser(db, userId, (client) =>
      toggleHabit(client, habitId, isoDay, completed),
    );
    if (result.ok) revalidatePath("/dashboard");
    return result;
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "The write failed.",
    };
  }
}

/** Pauses or un-pauses an entire day. */
export async function setGhostDayAction(
  isoDay: string,
  isGhost: boolean,
): Promise<ActionState> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDay)) {
    return { ok: false, reason: "Unrecognized day." };
  }

  try {
    const userId = await requireUserId();
    const db = await getDb();
    const result = await asUser(db, userId, (client) =>
      setGhostDay(client, isoDay, isGhost),
    );
    if (result.ok) revalidatePath("/dashboard");
    return result;
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "The write failed.",
    };
  }
}

/** First-run setup: creates the account's three habits and today's rows. */
export async function createInitialHabitsAction(
  labels: string[],
): Promise<ActionState> {
  const cleaned = labels.map((label) => label.trim()).filter(Boolean).slice(0, 3);
  if (cleaned.length === 0) {
    return { ok: false, reason: "Give at least the keystone habit a name." };
  }

  try {
    const userId = await requireUserId();
    const db = await getDb();
    await asUser(db, userId, async (client) => {
      for (const [index, label] of cleaned.entries()) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO habits (user_id, label, is_keystone)
           VALUES ($1, $2, $3) RETURNING id`,
          [userId, label, index === 0],
        );
        // Today exists as a row from the start, so the board renders the
        // current day immediately.
        await client.query(
          `INSERT INTO daily_logs (habit_id, day, completed)
           VALUES ($1, current_date, false)`,
          [rows[0].id],
        );
      }
    });
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "The write failed.",
    };
  }
}
