// Verifies the rendered dashboard in a real browser: geometry of the stacked
// bars, the 50% keystone width, the 85% target line, the ghost hatch, and that
// Tailwind actually applied. Writes a full-page screenshot next to this script.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";

const url = process.env.KINTSUGI_URL ?? "http://127.0.0.1:3111/dashboard";
const outDir = path.resolve(process.cwd(), "preview");
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1280, height: 1400 },
  deviceScaleFactor: 2,
});

const consoleErrors = [];
const failedRequests = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("requestfailed", (req) =>
  failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`),
);

await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(600);

const report = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("main ul > li")];
  const round = (n) => Math.round(n * 1000) / 1000;

  const measurements = rows.map((row) => {
    const label = row.querySelector("span")?.textContent?.trim() ?? "?";
    const day = row.querySelector("div > div")?.textContent?.trim() ?? label;
    const bar = row.querySelector("div.relative > div.relative");
    const segments = bar
      ? [...bar.children].map((child) => {
          const cs = getComputedStyle(child);
          const isHatch = cs.backgroundImage.includes("repeating-linear-gradient");
          return {
            w: round(child.getBoundingClientRect().width),
            bgImage: cs.backgroundImage.slice(0, 48),
            backgroundColor: cs.backgroundColor,
            hatch: isHatch,
          };
        })
      : [];
    const line = row.querySelector(".target-line");
    const barBox = bar?.getBoundingClientRect();
    const lineBox = line?.getBoundingClientRect();
    return {
      day: day.split("\n")[0],
      barWidth: barBox ? round(barBox.width) : null,
      widths: segments.map((s) => s.w),
      shares: barBox
        ? segments.map((s) => round(s.w / barBox.width))
        : [],
      hatchSegments: segments.filter((s) => s.hatch).length,
      keystoneGradient: segments[0]?.bgImage ?? null,
      targetLineRatio:
        barBox && lineBox ? round((lineBox.left - barBox.left) / barBox.width) : null,
    };
  });

  const probe = document.createElement("div");
  probe.className = "bg-gold";
  document.body.appendChild(probe);
  const goldApplied = getComputedStyle(probe).backgroundColor;
  probe.remove();

  const keystoneFill = document.querySelector(".keystone-fill");
  const targetLine = document.querySelector(".target-line");

  return {
    title: document.title,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    bodyFont: getComputedStyle(document.body).fontFamily.split(",")[0].trim(),
    goldUtilityResolves: goldApplied,
    weekScore: document.querySelector("main span.tabular-nums")
      ?.textContent?.trim(),
    keystoneFill: keystoneFill
      ? {
          backgroundImage: getComputedStyle(keystoneFill).backgroundImage.slice(0, 60),
          sheenAnimation: getComputedStyle(keystoneFill, "::after").animationName,
        }
      : null,
    targetLine: targetLine
      ? {
          width: round(targetLine.getBoundingClientRect().width),
          backgroundImage: getComputedStyle(targetLine).backgroundImage.slice(0, 48),
        }
      : null,
    headings: [...document.querySelectorAll("h1, h2")].map((h) => h.textContent.trim()),
    stats: [...document.querySelectorAll("main dl > div")].map((d) =>
      d.textContent.trim().replace(/\s+/g, " "),
    ),
    horizontalOverflow:
      document.documentElement.scrollWidth - window.innerWidth,
    heroMeter: (() => {
      const hero = document.querySelector("main section .target-line");
      const parent = hero?.parentElement?.getBoundingClientRect();
      const box = hero?.getBoundingClientRect();
      return parent && box
        ? { ratio: round((box.left - parent.left) / parent.width) }
        : null;
    })(),
    overlaps: (() => {
      const label = [...document.querySelectorAll("span")].find(
        (s) => s.textContent.trim() === "85% target",
      );
      if (!label) return { error: "target label missing" };
      const l = label.getBoundingClientRect();
      const others = [
        ...document.querySelectorAll(
          "main ul > li *, main .grid span, main h2",
        ),
      ].filter((el) => el !== label && el.textContent.trim().length > 0);
      const hits = others
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return (
            l.left < r.right &&
            l.right > r.left &&
            l.top < r.bottom &&
            l.bottom > r.top
          );
        })
        .map((el) => el.textContent.trim().slice(0, 24));
      return { labelRect: [l.top, l.bottom].map(round), hits };
    })(),
    measurements,
  };
});

// Prove the keystone actually paints gold pixels, not just a CSS declaration.
const keystoneBox = await page.locator(".keystone-fill").first().boundingBox();
const keystoneShot = await page.locator(".keystone-fill").first().screenshot();
const avg = await page.evaluate(
  ([dataUrl]) =>
    new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const { data } = ctx.getImageData(0, 0, img.width, img.height);
        let r = 0,
          g = 0,
          b = 0;
        for (let i = 0; i < data.length; i += 4) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
        }
        const px = data.length / 4;
        resolve([Math.round(r / px), Math.round(g / px), Math.round(b / px)]);
      };
      img.src = dataUrl;
    }),
  [`data:image/png;base64,${keystoneShot.toString("base64")}`],
);
report.keystoneAverageRgb = avg;
report.keystoneBox = keystoneBox;

report.consoleErrors = consoleErrors;
report.failedRequests = failedRequests;

const shot = path.join(outDir, "kintsugi-dashboard.png");
await page.screenshot({ path: shot, fullPage: true });
report.screenshot = shot;

console.log(JSON.stringify(report, null, 2));

await browser.close();
