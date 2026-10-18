import type { Metadata } from "next";

import { requireUserId } from "@/lib/auth";
import { loadWeek } from "@/lib/db";

import { FirstRun } from "./first-run";
import { WeekBoard } from "./week-board";

export const metadata: Metadata = {
  title: "This week · Kintsugi",
  description:
    "A seven-day stacked view of one keystone habit, two supporting habits, a ghost day, and the 85% target.",
};

// The week ends today, so this page is never cached as a snapshot.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const week = await loadWeek(await requireUserId());
  if (week.habits.length === 0) {
    return <FirstRun />;
  }
  return <WeekBoard week={week} />;
}
