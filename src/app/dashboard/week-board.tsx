"use client";

// Presentational + interactive: the rules that decide what a day is worth live
// in src/lib/week.ts, the SQL lives in src/lib/db.ts and src/lib/mutations.ts,
// and this file only renders a Week and dispatches writes.
//
// Optimistic behaviour: toggling a cell updates its score, the streak, and the
// keystone-save badge immediately, because those are pure functions of the
// cells. Bounce-back chips deliberately do *not* update optimistically — the
// database decides them, including comebacks that reach back before the visible
// week — so they settle when the server refresh lands.
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  bounceBackTotal,
  daysAboveTarget,
  eligibleDays,
  isKeystoneSave,
  keystoneStreak,
  scoreForDay,
  weekScore,
  KEYSTONE_SHARE,
  TARGET,
  type CellState,
  type DayView,
  type HabitView,
  type Week,
} from "@/lib/week";

import { setGhostDayAction, toggleHabitAction, type ActionState } from "./actions";

const cellKey = (habitId: string, iso: string) => `${habitId}:${iso}`;

export function WeekBoard({ week }: { week: Week }) {
  const router = useRouter();
  const [overrides, setOverrides] = useState<Record<string, CellState>>({});
  const [ghostOverrides, setGhostOverrides] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  // The week as the user currently believes it to be.
  const view = useMemo<Week>(
    () => ({
      ...week,
      days: week.days.map((day) => ({
        ...day,
        isGhost: ghostOverrides[day.iso] ?? day.isGhost,
        cells: Object.fromEntries(
          Object.entries(day.cells).map(([habitId, state]) => [
            habitId,
            overrides[cellKey(habitId, day.iso)] ?? state,
          ]),
        ),
      })),
    }),
    [week, overrides, ghostOverrides],
  );

  const { days, habits, previousWeekScore } = view;
  const score = weekScore(days, habits);
  const counted = eligibleDays(days);
  const delta = previousWeekScore === null ? null : score - previousWeekScore;
  const comebacks = bounceBackTotal(days);

  async function run(key: string, action: () => Promise<ActionState>) {
    setPending((p) => ({ ...p, [key]: true }));
    setError(null);
    try {
      const result = await action();
      if (!result.ok) setError(result.reason ?? "That didn't save.");
    } catch {
      setError("That didn't save. Check the connection and try again.");
    } finally {
      setPending((p) => ({ ...p, [key]: false }));
      // Server truth wins: drop the optimistic value once it has landed.
      setOverrides({});
      setGhostOverrides({});
      router.refresh();
    }
  }

  function toggleCell(day: DayView, habit: HabitView) {
    if (day.isGhost) return;
    const current = day.cells[habit.id] === "done";
    const key = cellKey(habit.id, day.iso);
    setOverrides((o) => ({ ...o, [key]: current ? "missed" : "done" }));
    void run(key, () => toggleHabitAction(habit.id, day.iso, !current));
  }

  function toggleGhost(day: DayView) {
    const next = !day.isGhost;
    setGhostOverrides((g) => ({ ...g, [day.iso]: next }));
    void run(`ghost:${day.iso}`, () => setGhostDayAction(day.iso, next));
  }

  const stats = [
    { label: "Bounce-backs", value: comebacks },
    {
      label: "Keystone saves",
      value: days.filter((day) => isKeystoneSave(day, habits)).length,
    },
    {
      label: "Days above line",
      value: `${daysAboveTarget(days, habits)}/${counted.length}`,
    },
    { label: "Keystone streak", value: `${keystoneStreak(days, habits)}d` },
  ];

  const first = days[0];
  const last = days[days.length - 1];
  const supportingShare = Math.round(
    ((1 - KEYSTONE_SHARE) * 100) / Math.max(habits.length - 1, 1),
  );

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-4 pb-14 pt-6 sm:px-6">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="relative grid h-10 w-10 place-items-center rounded-xl border border-gold/25 bg-panel">
            <svg
              viewBox="0 0 24 24"
              className="relative h-5 w-5"
              fill="none"
              stroke="url(#kintsugi-gold)"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <defs>
                <linearGradient id="kintsugi-gold" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="#8a6508" />
                  <stop offset="50%" stopColor="#ffd166" />
                  <stop offset="100%" stopColor="#8a6508" />
                </linearGradient>
              </defs>
              <path d="M5 3.5l4.5 6L7 13l5.5 4.5L10 21" />
              <path d="M19 4l-3.5 6.5L19 14l-4 5" />
            </svg>
            <div
              aria-hidden="true"
              className="absolute inset-0 -z-10 rounded-xl bg-gold/15 blur-lg"
            />
          </div>
          <div>
            <h1 className="text-base font-semibold tracking-tight text-white">
              Kintsugi
            </h1>
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-dim">
              repair your habits with gold
            </p>
          </div>
        </div>

        <div className="hidden items-center gap-2 rounded-full border border-line bg-panel/70 px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-mist/80 sm:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-gold shadow-[0_0_6px_1px_#ffd166]" />
          {TARGET}% sweet spot
        </div>
      </header>

      <main className="mt-6 flex flex-1 flex-col gap-5">
        {/* Weekly summary */}
        <section className="relative overflow-hidden rounded-2xl border border-line/80 bg-panel p-5 sm:p-7">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-24 -top-28 h-64 w-64 rounded-full bg-gold/10 blur-3xl"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-32 -left-20 h-56 w-56 rounded-full bg-indigo-500/10 blur-3xl"
          />

          <div className="relative flex flex-wrap items-end justify-between gap-x-8 gap-y-6">
            <div>
              <p className="eyebrow">
                This week · {first?.dateLabel} – {last?.dateLabel}
              </p>
              <div className="mt-2 flex items-end gap-3">
                <span
                  data-testid="hero-score"
                  className="font-mono text-6xl font-semibold leading-none tracking-tight text-white tabular-nums"
                >
                  {score}
                  <span className="text-3xl text-gold">%</span>
                </span>
                {delta !== null && delta !== 0 && (
                  <span
                    className={`mb-1.5 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium ${
                      delta > 0
                        ? "border-jade/25 bg-jade/10 text-jade"
                        : "border-[#e08a8a]/25 bg-[#e08a8a]/10 text-[#e08a8a]"
                    }`}
                  >
                    {delta > 0 ? "↑" : "↓"} {Math.abs(delta)} pts
                  </span>
                )}
              </div>
              <p className="mt-2 max-w-[34ch] text-xs leading-relaxed text-mist/75">
                Ghost-adjusted consistency across {counted.length} counted days.
                One pause doesn&apos;t count against you.
              </p>
            </div>

            <dl className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
              {stats.map((stat) => (
                <div key={stat.label} className="flex flex-col gap-1">
                  <dt className="font-mono text-[9px] uppercase tracking-widest text-dim">
                    {stat.label}
                  </dt>
                  <dd className="font-mono text-lg font-medium tabular-nums text-white">
                    {stat.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Progress toward the target line */}
          <div className="relative mt-7">
            <div className="relative h-1.5 rounded-full bg-white/[0.06]">
              <div
                className="h-full rounded-full bg-gradient-to-r from-gold-deep via-gold to-[#ffe9a8]"
                style={{ width: `${score}%` }}
              />
            </div>
            <div
              aria-hidden="true"
              className="target-line absolute -top-1.5 h-4 w-px"
              style={{ left: `${TARGET}%` }}
            />
            <div className="mt-2 flex justify-between font-mono text-[9px] uppercase tracking-widest text-dim">
              <span>0%</span>
              <span className="text-gold/75">{TARGET}% target</span>
              <span>100%</span>
            </div>
          </div>
        </section>

        {/* 7-day stacked bars */}
        <section className="rounded-2xl border border-line/80 bg-panel/80">
          <div className="flex flex-wrap items-start justify-between gap-3 px-4 pb-2 pt-5 sm:px-6">
            <div>
              <h2 className="text-sm font-semibold text-white">7-day rhythm</h2>
              <p className="mt-1 max-w-[46ch] text-[11px] leading-relaxed text-mist/60">
                Tap a segment to log it, or pause a day you couldn&apos;t live.
                The keystone is half the bar; the rest is bonus, never the point.
              </p>
            </div>
            <div className="flex items-center gap-3 font-mono text-[9px] uppercase tracking-widest text-dim">
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-4 rounded-sm bg-gradient-to-r from-gold-deep to-gold" />
                keystone {Math.round(KEYSTONE_SHARE * 100)}%
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-4 rounded-sm bg-slate-400/60" />
                habit {supportingShare}%
              </span>
            </div>
          </div>

          <div className="px-4 pb-5 sm:px-6">
            {error && (
              <p
                role="alert"
                className="mb-3 rounded-lg border border-[#e08a8a]/30 bg-[#e08a8a]/10 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[#e08a8a]"
              >
                {error}
              </p>
            )}

            <div className="grid grid-cols-[56px_1fr_40px] gap-2 border-b border-line/60 pt-2 pb-7 font-mono text-[9px] uppercase tracking-widest text-dim sm:grid-cols-[84px_1fr_56px] sm:gap-4">
              <span>Day</span>
              <span>Stacked</span>
              <span className="text-right">score</span>
            </div>

            <ul className="divide-y divide-line/40 pt-2">
              {days.map((day, index) => (
                <DayRow
                  key={day.iso}
                  day={day}
                  habits={habits}
                  showTargetLabel={index === 0}
                  pending={pending}
                  onToggleCell={toggleCell}
                  onToggleGhost={toggleGhost}
                />
              ))}
            </ul>

            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line/60 pt-4">
              {[
                {
                  swatch:
                    "bg-gradient-to-r from-gold-deep to-gold shadow-[0_0_8px_rgba(255,209,102,0.5)]",
                  label: `Keystone · ${Math.round(KEYSTONE_SHARE * 100)}%`,
                },
                {
                  swatch: "bg-slate-400/60",
                  label: `Supporting habit · ${supportingShare}%`,
                },
                {
                  swatch: "ghost-hatch border border-line",
                  label: "Ghost day · excluded",
                },
                { swatch: "bg-gold/70", label: `${TARGET}% target` },
              ].map((item) => (
                <div
                  key={item.label}
                  className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-wider text-dim"
                >
                  <span className={`h-2.5 w-2.5 rounded-sm ${item.swatch}`} />
                  {item.label}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Two notes */}
        <section className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-gold/20 bg-gold/[0.05] p-4">
            <p className="eyebrow text-gold/70">The crack</p>
            <p className="mt-2 text-sm leading-relaxed text-mist">
              {comebacks} comeback{comebacks === 1 ? "" : "s"} this week. A ghost
              day interrupts the count without erasing the habit.
            </p>
          </div>
          <div className="rounded-2xl border border-line/80 bg-panel/60 p-4">
            <p className="eyebrow">The rule</p>
            <p className="mt-2 text-sm leading-relaxed text-mist">
              A ghost day pauses the count. It never resets the habit, and it
              never flatters the score.
            </p>
          </div>
        </section>

        <footer className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-2 font-mono text-[9px] uppercase tracking-widest text-dim/70">
          <span>Live from Postgres · tap a segment to log it</span>
          <span>
            {score}% ghost-adjusted
            {previousWeekScore !== null && ` · last week ${previousWeekScore}%`}
          </span>
        </footer>
      </main>
    </div>
  );
}

function DayRow({
  day,
  habits,
  showTargetLabel,
  pending,
  onToggleCell,
  onToggleGhost,
}: {
  day: DayView;
  habits: HabitView[];
  showTargetLabel: boolean;
  pending: Record<string, boolean>;
  onToggleCell: (day: DayView, habit: HabitView) => void;
  onToggleGhost: (day: DayView) => void;
}) {
  const score = scoreForDay(day, habits);
  const keystone = habits.filter((habit) => habit.keystone);
  const supporting = habits.filter((habit) => !habit.keystone);
  const keystoneDone =
    keystone.length > 0 && keystone.every((h) => day.cells[h.id] === "done");
  const save = isKeystoneSave(day, habits);
  const keystoneWidth = keystone.length > 0 ? `${KEYSTONE_SHARE * 100}%` : "0%";
  const ghostPending = pending[`ghost:${day.iso}`] ?? false;

  const scoreTone =
    score === null
      ? "text-dim/50"
      : score >= TARGET
        ? "text-gold"
        : score >= 50
          ? "text-mist"
          : "text-[#e08a8a]";

  // Position is deliberately NOT part of this shared string: the keystone
  // segment is `absolute inset-0` and the supporting ones are `relative`. Put
  // `relative` here and it wins over `absolute` in the cascade, collapsing the
  // gold block to zero width — the invariant test exists to catch that.
  const segment =
    "h-full cursor-pointer transition-[filter] hover:brightness-125 focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-0 disabled:cursor-wait";

  return (
    <li
      className="group grid grid-cols-[56px_1fr_40px] items-center gap-2 py-3 sm:grid-cols-[84px_1fr_56px] sm:gap-4"
      aria-label={
        score === null
          ? `${day.weekday}: ghost day, excluded from stats`
          : `${day.weekday}: ${score}% of the day completed`
      }
    >
      {/* Day label + pause control */}
      <div className="min-w-0">
        <div
          className={`flex items-baseline gap-1 text-sm font-medium tracking-wide ${
            day.isToday ? "text-gold" : "text-mist"
          }`}
        >
          <span>{day.short}</span>
          {day.isToday && (
            <span className="h-1 w-1 rounded-full bg-gold shadow-[0_0_6px_1px_#ffd166]" />
          )}
        </div>
        <div className="font-mono text-[10px] tabular-nums text-dim">
          {day.dateLabel}
        </div>
        {day.bounceBacks > 0 && (
          <div className="mt-1 font-mono text-[9px] uppercase tracking-wider text-gold/80">
            ↩ {day.bounceBacks} comeback{day.bounceBacks === 1 ? "" : "s"}
          </div>
        )}
        <button
          type="button"
          data-testid="ghost-toggle"
          onClick={() => onToggleGhost(day)}
          disabled={ghostPending}
          aria-pressed={day.isGhost}
          aria-label={
            day.isGhost
              ? `Resume ${day.weekday} — count it again`
              : `Pause ${day.weekday} as a ghost day`
          }
          className="mt-1 font-mono text-[9px] uppercase tracking-wider text-dim underline decoration-dotted underline-offset-2 transition-colors hover:text-gold/80 disabled:opacity-50"
        >
          {day.isGhost ? "resume" : "pause"}
        </button>
      </div>

      {/* Stacked bar + target line */}
      <div className="relative">
        {!day.isGhost && keystoneDone && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-1/2 h-7 w-1/2 -translate-y-1/2 rounded-full bg-gold/20 blur-xl"
          />
        )}

        <div className="relative flex h-9 w-full overflow-hidden rounded-lg bg-[#070c1c] ring-1 ring-inset ring-white/[0.06]">
          {day.isGhost ? (
            <div className="ghost-hatch flex h-full w-full items-center justify-center">
              <span className="font-mono text-[9px] uppercase tracking-[0.22em] text-mist/45">
                ghost day · paused
              </span>
            </div>
          ) : (
            <>
              {/* Keystone: always exactly half of the bar */}
              <div className="relative h-full overflow-hidden" style={{ width: keystoneWidth }}>
                {keystone.map((habit) => {
                  const done = day.cells[habit.id] === "done";
                  const busy = pending[cellKey(habit.id, day.iso)] ?? false;
                  return (
                    <button
                      type="button"
                      key={habit.id}
                      onClick={() => onToggleCell(day, habit)}
                      disabled={busy}
                      aria-pressed={done}
                      aria-label={`${habit.label} on ${day.weekday} — ${
                        done ? "completed" : "missed"
                      }`}
                      className={`${segment} absolute inset-0 ${
                        done
                          ? "keystone-fill keystone-sheen"
                          : "border-r border-dashed border-gold/25 bg-gold/[0.04]"
                      }`}
                    >
                      <span
                        className={`absolute inset-0 hidden items-center justify-center gap-1.5 text-[9px] font-bold uppercase tracking-[0.18em] sm:flex ${
                          done ? "text-[#3d2b00]" : "text-gold/40"
                        }`}
                      >
                        {done ? (
                          <>
                            <svg
                              viewBox="0 0 24 24"
                              className="h-3 w-3"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.4"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M5 12.5l4.5 4.5L19 7.5" />
                            </svg>
                            Keystone
                          </>
                        ) : (
                          "keystone missed"
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Supporting habits split the other half */}
              {supporting.map((habit) => {
                const done = day.cells[habit.id] === "done";
                const busy = pending[cellKey(habit.id, day.iso)] ?? false;
                return (
                  <button
                    type="button"
                    key={habit.id}
                    onClick={() => onToggleCell(day, habit)}
                    disabled={busy}
                    aria-pressed={done}
                    aria-label={`${habit.label} on ${day.weekday} — ${
                      done ? "completed" : "missed"
                    }`}
                    style={{ width: `${habit.share * 100}%` }}
                    className={`relative ${segment} border-l border-black/30 ${
                      done
                        ? "bg-gradient-to-b from-slate-300/70 via-slate-400/55 to-slate-500/60"
                        : "bg-[#0b1226]"
                    }`}
                  >
                    <span
                      className={`absolute inset-0 hidden items-center justify-center font-mono text-[9px] font-semibold uppercase tracking-[0.12em] sm:flex ${
                        done ? "text-[#0b1226]" : "text-dim/45"
                      }`}
                    >
                      {habit.short}
                    </span>
                  </button>
                );
              })}
            </>
          )}
        </div>

        {/* 85% target line — crosses every row, labelled once at the top */}
        <div
          aria-hidden="true"
          data-testid="target-line"
          className="target-line pointer-events-none absolute -bottom-3 -top-3 left-[85%] w-px"
        />
        {showTargetLabel && (
          <span className="pointer-events-none absolute -top-5 left-[85%] z-10 -translate-x-1/2 whitespace-nowrap font-mono text-[9px] font-semibold uppercase tracking-widest text-gold/80">
            {TARGET}% target
          </span>
        )}
      </div>

      {/* Score */}
      <div className="text-right">
        <div
          data-testid="day-score"
          className={`font-mono text-sm tabular-nums ${scoreTone}`}
        >
          {score === null ? "—" : `${score}%`}
        </div>
        {save && (
          <div className="font-mono text-[9px] uppercase tracking-wider text-gold/70">
            save
          </div>
        )}
      </div>
    </li>
  );
}
