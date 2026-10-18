// Generates the PWA icon set into public/ with no image dependencies:
// a raw RGBA canvas encoded straight to PNG (rounded-square app icon plus a
// full-bleed maskable variant). Run: node scripts/generate-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const INK = [5, 8, 26]; // --color-ink
const PANEL = [10, 17, 36]; // --color-panel, used behind the check
const GOLD = [255, 209, 102]; // --color-gold
const GOLD_DEEP = [184, 134, 11]; // --color-gold-deep

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    rgba.copy(raw, row + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function roundedRectCoverage(x, y, size, radius) {
  const nx = Math.min(x, size - x);
  const ny = Math.min(y, size - y);
  if (nx >= radius || ny >= radius) return 1;
  return Math.min(1, Math.max(0, radius - Math.hypot(radius - nx, radius - ny)));
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function drawIcon(size, { maskable }) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const scale = maskable ? 0.72 : 1; // keep maskable art inside the safe zone
  const ringRadius = size * 0.31 * scale;
  const ringWidth = size * 0.05 * scale;
  const checkWidth = size * 0.06 * scale;
  const corner = maskable ? 0 : size * 0.18;

  const ax = cx - size * 0.13 * scale;
  const ay = cy + size * 0.01 * scale;
  const bx = cx - size * 0.03 * scale;
  const by = cy + size * 0.12 * scale;
  const ex = cx + size * 0.16 * scale;
  const ey = cy - size * 0.13 * scale;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const alpha = maskable ? 1 : roundedRectCoverage(px, py, size, corner);
      if (alpha <= 0) continue;

      const d = Math.hypot(px - cx, py - cy);
      const onCheck =
        distToSegment(px, py, ax, ay, bx, by) <= checkWidth / 2 ||
        distToSegment(px, py, bx, by, ex, ey) <= checkWidth / 2;

      let rgb = INK;
      if (onCheck) rgb = GOLD;
      else if (Math.abs(d - ringRadius) <= ringWidth / 2) rgb = GOLD_DEEP;
      else if (d < ringRadius) rgb = PANEL;

      const i = (y * size + x) * 4;
      rgba[i] = rgb[0];
      rgba[i + 1] = rgb[1];
      rgba[i + 2] = rgb[2];
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, rgba);
}

const outDir = path.join(process.cwd(), "public");
mkdirSync(outDir, { recursive: true });

const files = [
  ["icon-192.png", drawIcon(192, { maskable: false })],
  ["icon-512.png", drawIcon(512, { maskable: false })],
  ["icon-512-maskable.png", drawIcon(512, { maskable: true })],
  ["apple-touch-icon.png", drawIcon(180, { maskable: true })],
];

for (const [name, bytes] of files) {
  writeFileSync(path.join(outDir, name), bytes);
  console.log(`wrote public/${name} (${bytes.length} bytes)`);
}
