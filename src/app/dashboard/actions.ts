"use server";

import { revalidatePath } from "next/cache";

import { getDb } from "@/lib/db";
import { setGhostDay, toggleHabit, type MutationResult } from "@/lib/mutations";

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
    const result = await toggleHabit(await getDb(), habitId, isoDay, completed);
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
    const result = await setGhostDay(await getDb(), isoDay, isGhost);
    if (result.ok) revalidatePath("/dashboard");
    return result;
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "The write failed.",
    };
  }
}
