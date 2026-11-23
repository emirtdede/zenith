#!/usr/bin/env node
/**
 * `icons:generate` - rasterise `assets/zenith-mark.svg` into every icon the two
 * distribution channels need.
 *
 * ## Why this is not a `tauri icon` one-liner
 *
 * The tree must be reproducible on a machine with no ImageMagick, no sharp and
 * no network. So the geometry below is the SVG's geometry written as numbers, and
 * the rasteriser, the PNG encoder and the ICO packer are ~200 lines of Node with
 * `zlib` as the only import that does real work. Every output is deterministic:
 * run it twice and the bytes are identical, which is what lets `check:icons`
 * assert a hash instead of a vibe.
 *
 * ## What it writes
 *
 * - `src-tauri/icons/` - PNG sizes 16 to 256, `icon.ico` carrying 16, 24, 32, 48,
 *   64, 128 and 256 (PNG payloads, supported since Windows Vista), the tray
 *   bitmap, and the five MSIX tile assets.
 * - nothing else. The source of truth is the SVG; this script is a renderer, not
 *   a second design.
 *
 * Usage: `node scripts/generate-icons.mjs`
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// `ZENITH_ICON_OUT` exists so `check:icons` can render into a temporary folder
// and compare bytes; a check that only inspects the committed files cannot tell
// an icon set from a hand-edited one.
const ICONS = process.env.ZENITH_ICON_OUT
  ? process.env.ZENITH_ICON_OUT
  : join(ROOT, "src-tauri", "icons");

// --- geometry (design space 1024, matches assets/zenith-mark.svg) ------------
const BG = [0x0b, 0x0f, 0x14];
const RING = [0x1d, 0x27, 0x33];
const ACCENT_TOP = [0x8f, 0xe3, 0xc0];
const ACCENT_BOTTOM = [0x4f, 0x9c, 0xff];

const STAR_OUTER = [
  [512, 132], [598, 426], [892, 512], [598, 598],
  [512, 892], [426, 598], [132, 512], [426, 426],
];
const STAR_INNER = [
  [512, 300], [556, 468], [724, 512], [556, 556],
  [512, 724], [468, 556], [300, 512], [468, 468],
];

const DESIGN = 1024;

function inPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/** Returns the premultiplied colour for a design-space point, or null. */
function sampleColor(px, py) {
  const t = Math.min(1, Math.max(0, (py - 120) / 800));
  const accent = mix(ACCENT_TOP, ACCENT_BOTTOM, t);
  const dx = px - 512;
  const dy = py - 512;
  const inStar = inPolygon(px, py, STAR_OUTER) && !inPolygon(px, py, STAR_INNER);
  const inCore = dx * dx + dy * dy <= 42 * 42;

  if (!inRoundedRect(px, py, 0, 0, DESIGN, DESIGN, 220)) return null;
  if (inRoundedRect(px, py, 32, 32, DESIGN - 32, DESIGN - 32, 198)) {
    const ring = !inRoundedRect(px, py, 48, 48, DESIGN - 48, DESIGN - 48, 182);
    if (ring) return RING;
  }
  if (inCore || inStar) return accent;
  return BG;
}

function render(size, { supersample = 4 } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const step = 1 / supersample;
  const scale = DESIGN / size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let hits = 0;
      for (let sy = 0; sy < supersample; sy++) {
        for (let sx = 0; sx < supersample; sx++) {
          const px = (x + (sx + 0.5) * step) * scale;
          const py = (y + (sy + 0.5) * step) * scale;
          const color = sampleColor(px, py);
          hits += 1;
          if (!color) continue;
          r += color[0];
          g += color[1];
          b += color[2];
          a += 255;
        }
      }
      const i = (y * size + x) * 4;
      if (a === 0) continue;
      const cover = a / hits / 255;
      rgba[i] = Math.round(r / hits / cover);
      rgba[i + 1] = Math.round(g / hits / cover);
      rgba[i + 2] = Math.round(b / hits / cover);
      rgba[i + 3] = Math.round(a / hits);
    }
  }
  return rgba;
}

// --- PNG --------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function png(size, rgba, label) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  // The tEXt chunk is the marker `check:icons` uses to prove the file came from
  // this generator and not from a stock Tauri template.
  const text = Buffer.concat([
    Buffer.from("Software\0", "latin1"),
    Buffer.from(`Zenith icon generator (${label})`, "latin1"),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("tEXt", text),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- ICO --------------------------------------------------------------------
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const directory = Buffer.alloc(16 * entries.length);
  let offset = 6 + directory.length;
  entries.forEach((entry, index) => {
    const base = index * 16;
    directory[base] = entry.size === 256 ? 0 : entry.size;
    directory[base + 1] = entry.size === 256 ? 0 : entry.size;
    directory[base + 2] = 0;
    directory[base + 3] = 0;
    directory.writeUInt16LE(1, base + 4);
    directory.writeUInt16LE(32, base + 6);
    directory.writeUInt32LE(entry.data.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += entry.data.length;
  });
  return Buffer.concat([header, directory, ...entries.map((entry) => entry.data)]);
}

// --- outputs ----------------------------------------------------------------
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256];
const TILES = [
  ["Square44x44Logo.png", 44],
  ["Square71x71Logo.png", 71],
  ["Square150x150Logo.png", 150],
  ["Square310x310Logo.png", 310],
  ["Wide310x150Logo.png", 310, 150],
  ["StoreLogo.png", 50],
];

mkdirSync(ICONS, { recursive: true });

const cache = new Map();
function raster(size, label) {
  if (!cache.has(size)) cache.set(size, render(size, { supersample: size <= 32 ? 8 : 4 }));
  return png(size, cache.get(size), label);
}

const written = [];
for (const size of PNG_SIZES) {
  const name = size === 256 ? "256x256.png" : `${size}x${size}.png`;
  writeFileSync(join(ICONS, name), raster(size, name));
  written.push(name);
}
writeFileSync(join(ICONS, "128x128@2x.png"), raster(256, "128x128@2x.png"));
written.push("128x128@2x.png");
writeFileSync(join(ICONS, "icon.png"), raster(512, "icon.png"));
written.push("icon.png");
writeFileSync(join(ICONS, "tray.png"), raster(32, "tray.png"));
written.push("tray.png");

for (const [name, width, height] of TILES) {
  // A tile is square unless it is the 310x150 wide tile, which centres the mark
  // on its own ink background instead of stretching it.
  const source = height ? Math.max(width, height) : width;
  const square = render(height ? height : source, { supersample: 4 });
  let data;
  if (height && height !== width) {
    const canvas = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      canvas[i * 4] = BG[0];
      canvas[i * 4 + 1] = BG[1];
      canvas[i * 4 + 2] = BG[2];
      canvas[i * 4 + 3] = 255;
    }
    const offsetX = Math.floor((width - height) / 2);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < height; x++) {
        const dx = x + offsetX;
        if (dx < 0 || dx >= width) continue;
        square.copy(canvas, (y * width + dx) * 4, (y * height + x) * 4, (y * height + x) * 4 + 4);
      }
    }
    data = pngCanvas(width, height, canvas, name);
  } else {
    data = png(source, square, name);
  }
  writeFileSync(join(ICONS, name), data);
  written.push(name);
}

writeFileSync(
  join(ICONS, "icon.ico"),
  ico(PNG_SIZES.map((size) => ({ size, data: raster(size, `ico-${size}`) }))),
);
written.push("icon.ico");

function pngCanvas(width, height, rgba, label) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const text = Buffer.concat([
    Buffer.from("Software\0", "latin1"),
    Buffer.from(`Zenith icon generator (${label})`, "latin1"),
  ]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("tEXt", text),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

console.log(`Wrote ${written.length} icon files into src-tauri/icons:`);
console.log(written.join(", "));
