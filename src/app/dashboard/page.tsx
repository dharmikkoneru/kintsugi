import type { Metadata } from "next";

import { loadWeek } from "@/lib/db";

import { WeekBoard } from "./week-board";

export const metadata: Metadata = {
  title: "This week · Kintsugi",
  description:
    "A seven-day stacked view of one keystone habit, two supporting habits, a ghost day, and the 85% target.",
};

// The week ends today, so this page is never cached as a snapshot.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const week = await loadWeek();
  return <WeekBoard week={week} />;
}
