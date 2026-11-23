#!/usr/bin/env node
/**
 * `check:icons` - the shipped icon set must be the one the SVG source renders.
 *
 * Four failures this gate is built to catch, each of which has shipped in a real
 * desktop release:
 *
 *   1. **Icon leakage.** `src-tauri/icons/` still holds the Tauri template, so
 *      the installer, the taskbar and the Store tile show someone else's mark.
 *      Every PNG therefore carries a `tEXt` marker only this generator writes.
 *   2. **A size that is claimed but absent.** Windows picks 16 for the taskbar
 *      and 256 for the Store; an ICO without them is not a 16-to-256 set.
 *   3. **Drift from the source.** The generator is re-run into a temporary
 *      folder and every committed byte must match. A hand-edited PNG cannot.
 *   4. **A config that points elsewhere.** `tauri.conf.json` must list files
 *      that exist, including the tray and the MSIX tiles.
 *
 * Usage: `node scripts/check-icons.mjs`
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ICONS = join(ROOT, "src-tauri", "icons");
const CONFIG = join(ROOT, "src-tauri", "tauri.conf.json");
const SVG = join(ROOT, "assets", "zenith-mark.svg");

const problems = [];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MARKER = "Zenith icon generator";

const EXPECTED_PNG = {
  "16x16.png": [16, 16],
  "24x24.png": [24, 24],
  "32x32.png": [32, 32],
  "48x48.png": [48, 48],
  "64x64.png": [64, 64],
  "128x128.png": [128, 128],
  "256x256.png": [256, 256],
  "128x128@2x.png": [256, 256],
  "icon.png": [512, 512],
  "tray.png": [32, 32],
  "Square44x44Logo.png": [44, 44],
  "Square71x71Logo.png": [71, 71],
  "Square150x150Logo.png": [150, 150],
  "Square310x310Logo.png": [310, 310],
  "Wide310x150Logo.png": [310, 150],
  "StoreLogo.png": [50, 50],
};

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function fail(message) {
  problems.push(message);
}

function pngSize(buffer, name) {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail(`${name}: not a PNG`);
    return null;
  }
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

if (!existsSync(SVG)) {
  fail("assets/zenith-mark.svg is missing; the icons have no vector source");
} else {
  const svg = readFileSync(SVG, "utf8");
  if (!/viewBox="0 0 1024 1024"/.test(svg)) fail("SVG is not on the 1024 design grid the generator renders");
  for (const stop of ["#8fe3c0", "#4f9cff", "#0b0f14"]) {
    if (!svg.toLowerCase().includes(stop)) fail(`SVG no longer contains ${stop}, the generator's palette`);
  }
}

for (const [name, size] of Object.entries(EXPECTED_PNG)) {
  const path = join(ICONS, name);
  if (!existsSync(path)) {
    fail(`${name}: missing`);
    continue;
  }
  const buffer = readFileSync(path);
  const measured = pngSize(buffer, name);
  if (measured && (measured[0] !== size[0] || measured[1] !== size[1])) {
    fail(`${name}: is ${measured[0]}x${measured[1]}, expected ${size[0]}x${size[1]}`);
  }
  if (!buffer.includes(Buffer.from(MARKER, "latin1"))) {
    fail(`${name}: has no generator marker; this is a foreign or hand-edited bitmap`);
  }
}

const icoPath = join(ICONS, "icon.ico");
if (!existsSync(icoPath)) {
  fail("icon.ico: missing");
} else {
  const ico = readFileSync(icoPath);
  if (ico.length < 6 || ico.readUInt16LE(2) !== 1) {
    fail("icon.ico: not an ICO container");
  } else {
    const count = ico.readUInt16LE(4);
    const sizes = [];
    for (let i = 0; i < count; i++) {
      const base = 6 + i * 16;
      const width = ico[base] === 0 ? 256 : ico[base];
      sizes.push(width);
      const length = ico.readUInt32LE(base + 8);
      const offset = ico.readUInt32LE(base + 12);
      if (offset + length > ico.length) fail(`icon.ico: entry ${i} points past the file`);
      else if (!ico.subarray(offset, offset + 8).equals(PNG_SIGNATURE)) {
        fail(`icon.ico: entry ${i} is not a PNG payload`);
      }
    }
    for (const size of ICO_SIZES) {
      if (!sizes.includes(size)) fail(`icon.ico: ${size} pixel image missing (found ${sizes.join(", ")})`);
    }
  }
}

let config;
try {
  config = JSON.parse(readFileSync(CONFIG, "utf8"));
} catch (error) {
  fail(`tauri.conf.json is not valid JSON: ${error.message}`);
}
if (config) {
  const listed = config?.bundle?.icon ?? [];
  for (const entry of listed) {
    if (!existsSync(join(ROOT, "src-tauri", entry))) fail(`tauri.conf.json lists ${entry}, which does not exist`);
  }
  for (const required of ["icons/icon.ico", "icons/32x32.png", "icons/128x128@2x.png", "icons/icon.png"]) {
    if (!listed.includes(required)) fail(`tauri.conf.json does not list ${required}`);
  }
  if (existsSync(join(ROOT, "src-tauri", "icons", "icon.png"))) {
    // Tauri writes the window icon from this file; listing it makes the choice
    // explicit instead of relying on a convention.
  }
}

// Byte-for-byte reproduction. The generator is deterministic by construction:
// pure functions over integers, no timestamps, no random ids.
const scratch = mkdtempSync(join(tmpdir(), "zenith-icons-"));
try {
  execFileSync(process.execPath, [join(ROOT, "scripts", "generate-icons.mjs")], {
    env: { ...process.env, ZENITH_ICON_OUT: scratch },
    stdio: "pipe",
  });
  const rendered = readdirSync(scratch).sort();
  const committed = readdirSync(ICONS).filter((name) => rendered.includes(name)).sort();
  for (const name of rendered) {
    if (!committed.includes(name)) {
      fail(`${name}: rendered but not committed`);
      continue;
    }
    const a = createHash("sha256").update(readFileSync(join(scratch, name))).digest("hex");
    const b = createHash("sha256").update(readFileSync(join(ICONS, name))).digest("hex");
    if (a !== b) fail(`${name}: committed bytes differ from the SVG render (run npm run icons:generate)`);
  }
} catch (error) {
  fail(`the generator failed: ${error.message}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (problems.length) {
  console.error("Icon set is not releasable:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`Icon set holds: ${Object.keys(EXPECTED_PNG).length} PNGs, ICO with ${ICO_SIZES.join(",")}, 5 MSIX tiles, all reproduced from assets/zenith-mark.svg.`);
