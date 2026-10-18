// The product rules, in one place and free of I/O: a keystone habit is worth
// half of a day, supporting habits split the other half, and ghost days are
// paused — never counted, never a break. Everything here is a pure function of
// rows that came out of Postgres.

export type CellState = "done" | "missed";

/** Shape of the row returned by the week query in db.ts. */
export interface RawLogRow {
  iso_day: string;
  short_day: string;
  weekday: string;
  date_label: string;
  is_today: boolean;
  is_ghost: boolean;
  completed: boolean;
  habit_id: string;
  habit_label: string;
  habit_short: string;
  is_keystone: boolean;
}

export interface HabitView {
  id: string;
  label: string;
  short: string;
  keystone: boolean;
  /** Fraction of a day this habit is worth. */
  share: number;
}

export interface DayView {
  iso: string;
  short: string;
  weekday: string;
  dateLabel: string;
  isToday: boolean;
  isGhost: boolean;
  cells: Record<string, CellState>;
  /** Habits completed today that were missed on the previous counted day. */
  bounceBacks: number;
}

export interface Week {
  days: DayView[];
  habits: HabitView[];
  /** Same rules applied to the seven days before this one, when they exist. */
  previousWeekScore: number | null;
}

export const KEYSTONE_SHARE = 0.5;
export const TARGET = 85;

/** Turns flat (day × habit) rows into the week the UI renders. */
export function assembleWeek(
  rows: RawLogRow[],
  comebacksByDay: Map<string, number>,
  previousWeekScore: number | null = null,
): Week {
  const habitsById = new Map<string, HabitView>();
  for (const row of rows) {
    if (!habitsById.has(row.habit_id)) {
      habitsById.set(row.habit_id, {
        id: row.habit_id,
        label: row.habit_label,
        short: row.habit_short,
        keystone: row.is_keystone,
        share: 0, // filled in below
      });
    }
  }
  const habits = [...habitsById.values()].sort(
    (a, b) => Number(b.keystone) - Number(a.keystone) || a.label.localeCompare(b.label),
  );

  const keystone = habits.filter((habit) => habit.keystone);
  const supporting = habits.length - keystone.length;
  // With a keystone present it is worth half the day and the supporting habits
  // split the other half. Without one, the day is split evenly.
  const keystonePortion = keystone.length > 0 ? KEYSTONE_SHARE : 0;
  for (const habit of habits) {
    habit.share = habit.keystone
      ? keystonePortion / keystone.length
      : supporting > 0
        ? (1 - keystonePortion) / supporting
        : 0;
  }

  const days: DayView[] = [];
  for (const row of rows) {
    let day = days.find((d) => d.iso === row.iso_day);
    if (!day) {
      day = {
        iso: row.iso_day,
        short: row.short_day,
        weekday: row.weekday,
        dateLabel: row.date_label,
        isToday: row.is_today,
        isGhost: row.is_ghost,
        cells: {},
        bounceBacks: comebacksByDay.get(row.iso_day) ?? 0,
      };
      days.push(day);
    }
    day.cells[row.habit_id] = row.completed ? "done" : "missed";
  }

  return { days, habits, previousWeekScore };
}

export function eligibleDays(days: DayView[]): DayView[] {
  return days.filter((day) => !day.isGhost);
}

/** Weighted completion for a day, or null for a ghost day. */
export function scoreForDay(day: DayView, habits: HabitView[]): number | null {
  if (day.isGhost) return null;
  const points = habits.reduce(
    (sum, habit) => sum + (day.cells[habit.id] === "done" ? habit.share : 0),
    0,
  );
  return Math.round(points * 100);
}

export function weekScore(days: DayView[], habits: HabitView[]): number {
  const counted = eligibleDays(days);
  if (counted.length === 0) return 0;
  const total = counted.reduce((sum, day) => sum + (scoreForDay(day, habits) ?? 0), 0);
  return Math.round(total / counted.length);
}

/** Keystone done and every supporting habit missed: the day still counted. */
export function isKeystoneSave(day: DayView, habits: HabitView[]): boolean {
  if (day.isGhost) return false;
  const keystone = habits.filter((habit) => habit.keystone);
  if (keystone.length === 0) return false;
  const keystoneDone = keystone.every((habit) => day.cells[habit.id] === "done");
  const supportMissed = habits
    .filter((habit) => !habit.keystone)
    .every((habit) => day.cells[habit.id] !== "done");
  return keystoneDone && supportMissed;
}

export function daysAboveTarget(
  days: DayView[],
  habits: HabitView[],
  target = TARGET,
): number {
  return eligibleDays(days).filter((day) => (scoreForDay(day, habits) ?? 0) >= target)
    .length;
}

/** Counted days in a row, ending at the most recent day, with the keystone done. */
export function keystoneStreak(days: DayView[], habits: HabitView[]): number {
  const keystone = habits.filter((habit) => habit.keystone);
  if (keystone.length === 0) return 0;
  const counted = eligibleDays(days);
  let streak = 0;
  for (let i = counted.length - 1; i >= 0; i -= 1) {
    const day = counted[i];
    if (!keystone.every((habit) => day.cells[habit.id] === "done")) break;
    streak += 1;
  }
  return streak;
}

export function bounceBackTotal(days: DayView[]): number {
  return days.reduce((sum, day) => sum + day.bounceBacks, 0);
}
