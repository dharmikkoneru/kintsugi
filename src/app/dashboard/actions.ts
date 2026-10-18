"use server";

import { revalidatePath } from "next/cache";

import { currentUserId, getDb } from "@/lib/db";
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
    const db = await getDb();
    const userId = await currentUserId(db);
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
    const db = await getDb();
    const userId = await currentUserId(db);
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
