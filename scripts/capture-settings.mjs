#!/usr/bin/env node
/**
 * Settings and Store screenshot capture.
 *
 * The screen sweep photographs ten states at the window's default size. This
 * script answers two gaps that a release reviewer asks about by name:
 *
 *   * every settings tab has its own picture (`evidence/screens/settings/`),
 *     because "Settings" is where a release is judged and one screenshot of the
 *     first tab proves nothing about the other eleven;
 *   * the Store listing needs images at 1366x768 or larger, so the same session
 *     resizes the window before capturing the six screens a listing uses
 *     (`evidence/screens/store/`).
 *
 * It also fails when the resized window develops horizontal overflow, which is
 * the layout defect a screenshot-only pass would happily save.
 *
 * Usage: node scripts/capture-settings.mjs --app target/release/zenith.exe \
 *          --driver %TEMP%\zenith-e2e\msedgedriver.exe
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (token.startsWith("--")) args.set(token.slice(2), process.argv[i + 1]);
}
const app = args.get("app") ?? "target/release/zenith.exe";
const driverPath = args.get("driver") ?? process.env.ZENITH_MSEDGEDRIVER ?? "";
const root = args.get("out") ?? join("evidence", "screens");
const WIDTH = 1366;
const HEIGHT = 768;

const TABS = [
  "appearance",
  "accessibility",
  "general",
  "language",
  "shortcuts",
  "notifications",
  "data",
  "trash",
  "cli",
  "webhook",
  "legal",
  "about",
];

const STORE_SCREENS = [
  { file: "01-actions", nav: "actions", expect: "[data-action-card]" },
  { file: "02-snapshots", nav: "snapshots", expect: "h2" },
  { file: "03-trust", nav: "trust", expect: "h2" },
  { file: "04-help", nav: "help", expect: "h2" },
  { file: "05-activity", nav: "activity", expect: "ol.log" },
];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const chosen = address && typeof address === "object" ? address.port : 0;
      server.close(() => resolve(chosen));
    });
  });
}

function pngSize(file) {
  const bytes = readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const port = await freePort();
const nativePort = await freePort();
const base = `http://127.0.0.1:${port}`;

const intermediary = spawn(
  "tauri-driver",
  ["--native-driver", driverPath, "--port", String(port), "--native-port", String(nativePort)],
  { stdio: "ignore" },
);

let sessionId = null;

async function wd(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 240)}`);
  return json;
}

async function js(script) {
  const result = await wd("POST", `/session/${sessionId}/execute/sync`, { script, args: [] });
  return result.value;
}

async function shot(file) {
  // A boot-time diagnosis raises its own notification, and a toast that lands
  // over a settings panel makes the screenshot describe the moment rather than
  // the screen. Dismissing first keeps every capture of the same surface
  // comparable, and the notification itself is evidenced by the delivery tests
  // rather than by whether a toast happened to be up at capture time.
  await js(`
    for (const button of document.querySelectorAll('.toast-hub .toast-close')) {
      button.click();
    }
    return null;
  `);
  await sleep(320);
  const result = await wd("GET", `/session/${sessionId}/screenshot`);
  writeFileSync(file, Buffer.from(result.value, "base64"));
  return pngSize(file);
}

const problems = [];

try {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`${base}/status`)).ok) break;
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }

  const created = await wd("POST", "/session", {
    capabilities: {
      alwaysMatch: { "tauri:options": { application: app }, browserName: "wry" },
    },
  });
  sessionId = created.value?.sessionId ?? created.sessionId;

  for (let attempt = 0; attempt < 120; attempt += 1) {
    if ((await js("return document.querySelectorAll('[data-action-card]').length;")) === 22) break;
    await sleep(500);
  }
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if ((await js("return document.querySelectorAll('.health-actions button.btn-quiet').length;")) === 0) break;
    await sleep(500);
  }

  // The first launch of a fresh profile opens the welcome guide, which covers
  // every screen behind a modal. A reviewer's screenshot pack starts from the
  // application a returning user sees, so the guide is dismissed first and the
  // run reports whether it was there at all.
  const onboarded = await js(`
    const skip = document.querySelector('.onboarding .btn-quiet');
    if (skip) { skip.click(); return true; }
    return false;
  `);
  if (onboarded) {
    console.log("dismissed the welcome guide (first launch of this profile)");
    await sleep(900);
  }

  await wd("POST", `/session/${sessionId}/window/rect`, { width: WIDTH, height: HEIGHT });
  await sleep(600);

  const settingsDir = join(root, "settings");
  const storeDir = join(root, "store");
  mkdirSync(settingsDir, { recursive: true });
  mkdirSync(storeDir, { recursive: true });

  // --- settings tabs -------------------------------------------------------
  await js("document.querySelector('[data-nav=\"settings\"]')?.click(); return null;");
  await sleep(300);

  for (const tab of TABS) {
    const clicked = await js(`
      const button = document.querySelector('[data-tab=${JSON.stringify(tab)}]');
      if (!button) return false;
      button.click();
      return true;
    `);
    if (!clicked) {
      problems.push(`settings/${tab}: no tab button`);
      continue;
    }
    await sleep(260);
    const heading = await js(
      "return document.querySelector('[role=tabpanel] .set-panel-title')?.textContent?.trim() ?? '';",
    );
    const file = join(settingsDir, `${tab}.png`);
    const size = await shot(file);
    const overflow = await js(
      "return document.documentElement.scrollWidth - document.documentElement.clientWidth;",
    );
    if (size.width < WIDTH || size.height < HEIGHT) {
      problems.push(`settings/${tab}.png is ${size.width}x${size.height}, below ${WIDTH}x${HEIGHT}`);
    }
    if (overflow > 0) problems.push(`settings/${tab}: ${overflow}px horizontal overflow`);
    if (!heading) problems.push(`settings/${tab}: the panel has no heading`);
    console.log(`settings/${tab}.png  ${size.width}x${size.height}  "${heading}"`);
  }

  // --- Store screens -------------------------------------------------------
  for (const state of STORE_SCREENS) {
    await js(`document.querySelector('[data-nav=${JSON.stringify(state.nav)}]')?.click(); return null;`);
    await sleep(320);
    const present = await js(`return document.querySelectorAll(${JSON.stringify(state.expect)}).length;`);
    if (present === 0) {
      problems.push(`store/${state.file}: nothing matched ${state.expect}`);
      continue;
    }
    const file = join(storeDir, `${state.file}.png`);
    const size = await shot(file);
    const overflow = await js(
      "return document.documentElement.scrollWidth - document.documentElement.clientWidth;",
    );
    if (size.width < WIDTH || size.height < HEIGHT) {
      problems.push(`store/${state.file}.png is ${size.width}x${size.height}, below ${WIDTH}x${HEIGHT}`);
    }
    if (overflow > 0) problems.push(`store/${state.file}: ${overflow}px horizontal overflow`);
    console.log(`store/${state.file}.png  ${size.width}x${size.height}`);
  }
} finally {
  if (sessionId) {
    try {
      await wd("DELETE", `/session/${sessionId}`);
    } catch {
      /* the app may already be gone */
    }
  }
  intermediary.kill();
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`\n${TABS.length} settings tabs and ${STORE_SCREENS.length} Store screens at ${WIDTH}x${HEIGHT}`);
