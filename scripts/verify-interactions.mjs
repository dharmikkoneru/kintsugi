// Proves the write path in a real browser against the running app: a click
// updates the bar optimistically, survives a reload (so it reached Postgres),
// and — because the demo week matters — every change is reverted at the end.
//
// Usage: KINTSUGI_URL=http://127.0.0.1:3111/dashboard node scripts/verify-interactions.mjs
import { chromium } from "playwright";

const url = process.env.KINTSUGI_URL ?? "http://127.0.0.1:3111/dashboard";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✖"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error" && !msg.text().includes("hmr")) consoleErrors.push(msg.text());
});

/** Sunday (the last row) is the day the interactions touch. */
const row = () => page.locator("main ul > li").last();
const segments = () => row().locator("div.relative > div.relative button");
const heroScore = () => page.locator('[data-testid="hero-score"]');
const dayScore = () => row().locator('[data-testid="day-score"]');
const text = async (locator) => (await locator.innerText()).trim();

async function settle() {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);
}

await page.goto(url, { waitUntil: "networkidle" });

const baselineWeekScore = await text(heroScore());
const baselineDayScore = await text(dayScore());
const baselinePressed = await segments().evaluateAll((els) =>
  els.map((el) => el.getAttribute("aria-pressed")),
);

// The last supporting segment of the final day, whatever state it is in — the
// test flips it and puts it back, so it does not assume a pristine demo week.
const target = segments().last();
const targetWasDone = (await target.getAttribute("aria-pressed")) === "true";

await target.click();
await page.waitForTimeout(150);
const optimisticPressed = await target.getAttribute("aria-pressed");
const optimisticDayScore = await text(dayScore());
check(
  "clicking a segment flips it immediately",
  optimisticPressed === String(!targetWasDone),
  `aria-pressed ${baselinePressed.at(-1)} → ${optimisticPressed}`,
);
check(
  "and the day score updates without waiting for the server",
  optimisticDayScore !== baselineDayScore,
  `${baselineDayScore} → ${optimisticDayScore}`,
);

await settle();
await page.reload({ waitUntil: "networkidle" });

const afterReload = await text(dayScore());
const pressedAfterReload = await segments().last().getAttribute("aria-pressed");
check(
  "the write survived a reload, so it reached Postgres",
  pressedAfterReload === String(!targetWasDone) && afterReload === optimisticDayScore,
  `aria-pressed ${pressedAfterReload}, day ${afterReload}`,
);

const weekAfterReload = await text(heroScore());
check(
  "the week score moved with it",
  weekAfterReload !== baselineWeekScore,
  `${baselineWeekScore} → ${weekAfterReload}`,
);

// ── Pause a day, then resume it ───────────────────────────────────────────
// Compare against the state as it is now (the toggle above is still applied);
// the original baseline is restored at the end of the run.
const beforePause = await segments().evaluateAll((els) =>
  els.map((el) => el.getAttribute("aria-pressed")),
);
const pauseButton = row().locator('[data-testid="ghost-toggle"]');
const pauseLabel = (await pauseButton.innerText()).trim();
await pauseButton.click();
await page.waitForTimeout(150);
const ghostVisible = await row()
  .locator(".ghost-hatch")
  .isVisible()
  .catch(() => false);
check(
  "pausing a day turns its bar into a ghost day",
  ghostVisible,
  `the control read "${pauseLabel}"`,
);

await settle();
await page.reload({ waitUntil: "networkidle" });
const stillGhost = await row()
  .locator(".ghost-hatch")
  .isVisible()
  .catch(() => false);
const dayScoreWhilePaused = await text(dayScore());
check(
  "the paused day persisted and scores nothing",
  stillGhost && dayScoreWhilePaused === "—",
  `row shows ${dayScoreWhilePaused}`,
);

await row().locator('[data-testid="ghost-toggle"]').click();
await settle();
await page.reload({ waitUntil: "networkidle" });
const restoredPressed = await segments().evaluateAll((els) =>
  els.map((el) => el.getAttribute("aria-pressed")),
);
check(
  "resuming restored the day exactly as it was before the pause",
  restoredPressed.join(",") === beforePause.join(","),
  `${beforePause.join(",")} → ${restoredPressed.join(",")}`,
);

// ── Put the demo week back the way we found it ────────────────────────────
const stillToggled = (await segments().last().getAttribute("aria-pressed")) === "true";
if (stillToggled !== targetWasDone) {
  await segments().last().click();
  await settle();
  await page.reload({ waitUntil: "networkidle" });
}
const finalWeekScore = await text(heroScore());
check(
  "the demo week is back to its original score",
  finalWeekScore === baselineWeekScore,
  `${baselineWeekScore} → ${finalWeekScore}`,
);

check("no application console errors", consoleErrors.length === 0, consoleErrors.join(" | "));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
