"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { createInitialHabitsAction, type ActionState } from "./actions";

const DEFAULTS = ["Morning meditation", "Read 10 pages", "Evening walk"];

export function FirstRun() {
  const router = useRouter();
  const [labels, setLabels] = useState(DEFAULTS);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (index: number, value: string) =>
    setLabels((current) => current.map((l, i) => (i === index ? value : l)));

  async function submit() {
    setPending(true);
    setError(null);
    let result: ActionState;
    try {
      result = await createInitialHabitsAction(labels);
    } catch {
      result = { ok: false, reason: "That didn't save. Check the connection and try again." };
    }
    setPending(false);
    if (!result.ok) {
      setError(result.reason ?? "That didn't save.");
      return;
    }
    router.refresh();
  }

  const canSubmit = labels.every((l) => l.trim().length > 0) && !pending;

  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center px-6 py-16">
      <div className="rounded-2xl border border-line bg-panel p-8">
        <p className="eyebrow">First run</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">
          Name your three habits
        </h1>
        <p className="mt-2 text-sm text-mist">
          The keystone is worth half of every day — choose the one habit the
          others hang from. You can rename or reorder nothing yet, so make them
          count.
        </p>

        <div className="mt-6 space-y-4">
          <label className="block space-y-2">
            <span className="eyebrow text-gold">Keystone · worth half the day</span>
            <input
              type="text"
              maxLength={60}
              value={labels[0]}
              onChange={(e) => set(0, e.target.value)}
              className="w-full rounded-lg border border-gold/40 bg-panel-2 px-3.5 py-2.5 text-sm text-white placeholder:text-dim"
            />
          </label>
          {[1, 2].map((index) => (
            <label key={index} className="block space-y-2">
              <span className="eyebrow">Supporting habit {index}</span>
              <input
                type="text"
                maxLength={60}
                value={labels[index]}
                onChange={(e) => set(index, e.target.value)}
                className="w-full rounded-lg border border-line bg-panel-2 px-3.5 py-2.5 text-sm text-white placeholder:text-dim"
              />
            </label>
          ))}
        </div>

        {error && <p className="mt-4 text-sm text-[#f87171]">{error}</p>}

        <button
          type="button"
          onClick={submit}
          disabled={!canSubmit}
          className="mt-6 w-full rounded-lg bg-gold px-4 py-2.5 text-sm font-semibold text-ink transition-colors hover:bg-gold-deep disabled:opacity-50"
        >
          {pending ? "Creating…" : "Start this week"}
        </button>
      </div>
    </main>
  );
}
