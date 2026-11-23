#!/usr/bin/env node
/**
 * End-to-end journeys against the real Tauri shell (DEF-048).
 *
 * Why this exists: the vitest suite renders React in jsdom, so it can prove the
 * reducer, the ICU formatter and the components, but it cannot prove that the
 * packaged WebView2 app boots, talks to the Rust core over IPC, and finishes a
 * real action with a real snapshot. Those are the three journeys below:
 *
 *   1. diagnose  - boot hands over measurement, the health strip renders numbers
 *   2. run       - a reversible action executes through IPC and reports success
 *   3. rollback  - the snapshot the action committed is restored and disappears
 *
 * Driver stack (Tauri v2 on Windows):
 *   - `tauri-driver` (intermediary)  ->  `msedgedriver` (native)  ->  WebView2
 *   - tauri-driver sets TAURI_WEBVIEW_AUTOMATION=true, which is what makes
 *     WebView2 accept a WebDriver connection at all.
 *
 * Prerequisites on the host (not vendored: they are platform binaries and the
 * msedgedriver build must match the installed WebView2 runtime):
 *   - `cargo install tauri-driver --locked`
 *   - msedgedriver.exe, version equal to the WebView2 runtime
 *
 * Usage:
 *   node scripts/e2e-journeys.mjs --app target/release/zenith.exe \
 *        --driver %TEMP%\zenith-e2e\msedgedriver.exe
 *
 * Exit codes: 0 all journeys passed, 1 a journey failed, 2 the harness could
 * not start (missing binary/driver) - distinct so a real failure is never
 * confused with a missing prerequisite.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (token.startsWith("--")) args.set(token.slice(2), process.argv[i + 1]);
}

const app = args.get("app") ?? "target/release/zenith.exe";
const driverPath = args.get("driver") ?? process.env.ZENITH_MSEDGEDRIVER ?? "";
const keepFixture = args.has("keep-fixture");

// The driver binds two ports. Do not default to the WebDriver-canonical 4444:
// Windows reserves blocks of ports (`netsh int ipv4 show excludedportrange`),
// and on the reference host 4414-4513 is excluded, so a hardcoded 4444 fails
// with "can not listen to address" and looks like a broken harness. Unless the
// caller pins a port, ask the OS for two free ones.
const requestedPort = args.get("port") ? Number(args.get("port")) : null;
let port = requestedPort;
let nativePort = requestedPort ? requestedPort + 1 : null;
let base = port ? `http://127.0.0.1:${port}` : "";

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

function bail(message) {
  console.error(`HARNESS: ${message}`);
  process.exit(2);
}

if (!existsSync(app)) bail(`app binary not found: ${app} (build it first)`);
if (!driverPath || !existsSync(driverPath)) {
  bail("msedgedriver not found (pass --driver or set ZENITH_MSEDGEDRIVER)");
}

const journal = [];
function step(journey, name, detail = "") {
  const line = `  PASS  ${journey} :: ${name}${detail ? ` - ${detail}` : ""}`;
  journal.push(line);
  console.log(line);
}

// The seeded input for the run/rollback journey. Declared here so the cleanup
// in `finally` runs even when the app crashes halfway through.
const screenshotsDir = join(homedir(), "Pictures", "Screenshots");
const fixture = join(screenshotsDir, "zenith-e2e-fixture.png");
const createdScreenshotsDir = !existsSync(screenshotsDir);

// ---------------------------------------------------------------- transport

async function wd(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 400)}`);
    error.payload = parsed;
    throw error;
  }
  return parsed;
}

let sessionId = null;

async function session(path, body) {
  return wd("POST", `/session/${sessionId}${path}`, body ?? {});
}

async function find(selector) {
  const result = await session("/element", { using: "css selector", value: selector });
  const key = "element-6066-11e4-a52e-4f735466cecf";
  const id = result?.value?.[key];
  if (!id) throw new Error(`element not found: ${selector}`);
  return id;
}

async function click(selector) {
  const id = await find(selector);
  await session(`/element/${id}/click`, {});
}

async function count(selector) {
  const result = await session("/elements", { using: "css selector", value: selector });
  return (result?.value ?? []).length;
}

async function js(script) {
  const result = await session("/execute/sync", { script, args: [] });
  return result?.value;
}

// `execute/sync` cannot await a promise, and the snapshot list is IPC. This
// wraps the callback-style async execute WebDriver offers so a journey can read
// the store the same way the renderer does.
async function asyncJs(script) {
  const result = await session("/execute/async", { script, args: [] });
  return result?.value;
}

async function snapshotsFor(actionId) {
  return asyncJs(
    `const done = arguments[arguments.length - 1];
     (async () => {
       const rows = await window.__TAURI_INTERNALS__.invoke('snapshot_list', { limit: 100 });
       done(rows.filter((row) => row.actionId === '${actionId}'));
     })().catch((error) => done({ error: String(error) }));`,
  );
}

async function waitFor(label, predicate, timeoutMs = 30_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) {
      last = String(error.message ?? error);
    }
    await sleep(intervalMs);
  }
  // A timeout is the one failure that is hard to read from a log line, so the
  // DOM state at the moment of timeout is captured rather than guessed at.
  let dump;
  try {
    dump = JSON.stringify(
      await js(`return {
        dialog: document.querySelectorAll('.dialog[role="dialog"]').length,
        statuses: Array.from(document.querySelectorAll('[data-action-id] .status')).map((el) => ({
          id: el.closest('[data-action-id]').getAttribute('data-action-id'),
          cls: el.className,
          text: el.textContent,
        })),
        logs: Array.from(document.querySelectorAll('.console li')).slice(-6).map((el) => el.textContent),
        alerts: Array.from(document.querySelectorAll('.banner, .warn-box, [role="alert"]')).map((el) => el.textContent),
      };`),
    );
  } catch {
    dump = "DOM unreachable (window closed?)";
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})\n  state: ${dump}`);
}

// ---------------------------------------------------------------- lifecycle

// tauri-driver spawns the native driver itself (with TAURI_WEBVIEW_AUTOMATION=true,
// which is what makes WebView2 accept a WebDriver connection). Only the
// intermediary is started here.
if (!port) {
  port = await freePort();
  nativePort = await freePort();
  base = `http://127.0.0.1:${port}`;
}

const intermediary = spawn(
  "tauri-driver",
  ["--native-driver", driverPath, "--port", String(port), "--native-port", String(nativePort)],
  { stdio: "ignore" },
);

async function stop() {
  try {
    if (sessionId) await wd("DELETE", `/session/${sessionId}`);
  } catch {
    // The session is already gone if the app crashed; stopping still matters.
  }
  intermediary.kill();
}

try {
  await waitFor(
    "tauri-driver",
    async () => {
      try {
        const status = await fetch(`${base}/status`);
        return status.ok;
      } catch {
        return false;
      }
    },
    30_000,
    400,
  );

  const created = await wd("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        "tauri:options": { application: app },
      },
    },
  });
  sessionId = created?.value?.sessionId ?? created?.sessionId;
  if (!sessionId) throw new Error(`no session id in ${JSON.stringify(created).slice(0, 300)}`);

  // -------------------------------------------------------------- journey 1
  const cards = await waitFor("[data-action-card] cards", async () => {
    const seen = await count("[data-action-card]");
    return seen === 22 ? seen : 0;
  }, 60_000);
  step("diagnose", "app booted with the full catalog", `${cards} cards`);

  await waitFor(
    "native host (bridge is not the simulator)",
    async () => (await js("return '__TAURI_INTERNALS__' in window;")) === true,
    15_000,
  );
  step("diagnose", "renderer is attached to the native host", "__TAURI_INTERNALS__ present");

  // REQ-F-002 means a diagnosis may already be running by the time the session
  // attaches, and while it runs the primary button is replaced by "Cancel".
  // Waiting for the button is therefore waiting for the boot diagnosis to finish,
  // which is exactly the state this journey wants to observe. Clicking it here
  // would race the first-launch run and measure a button that is not rendered.
  const score = await waitFor(
    "health score",
    async () => {
      const text = await js(
        "const el = document.querySelector('.health-score .score'); return el ? el.textContent : null;",
      );
      return text && /\d/.test(text) ? text : null;
    },
    240_000,
    500,
  );
  const metricCount = await js("return document.querySelectorAll('.health-metrics dd').length;");
  if (metricCount < 4) throw new Error(`expected 4 health metrics, saw ${metricCount}`);
  step(
    "diagnose",
    "first launch diagnosed without any interaction (REQ-F-002)",
    `score=${score.trim()}, metrics=${metricCount}`,
  );

  // The manual path still has to work after the automatic run: the primary
  // button is back, clicking it starts a second scan, and the score is replaced.
  await waitFor(
    "diagnose button after the boot run",
    async () => (await count(".health-actions button.btn-primary")) === 1,
    30_000,
  );
  await click(".health-actions button.btn-primary");
  const rescanned = await waitFor(
    "second diagnosis",
    async () => {
      const text = await js(
        "const el = document.querySelector('.health-score .score'); return el ? el.textContent : null;",
      );
      const running = await count(".health-actions button.btn-quiet");
      return !running && text && /\d/.test(text) ? text : null;
    },
    240_000,
    500,
  );
  step("diagnose", "manual re-run completes", `score=${rescanned.trim()}`);

  // -------------------------------------------------------------- journey 2
  // `archive-screenshots` is chosen because it is the only reversible action
  // whose snapshot is file-backed and whose input can be created and removed by
  // this script: the harness seeds one old screenshot, the app archives it, and
  // journey 3 proves the bytes come back. Nothing outside the seeded fixture is
  // touched, and a machine without a Screenshots folder gets one for the run and
  // loses it again afterwards.
  const target = "archive-screenshots";
  mkdirSync(screenshotsDir, { recursive: true });
  // 1x1 transparent PNG: small, valid, and unmistakably ours.
  const fixtureBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  );
  writeFileSync(fixture, fixtureBytes);
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  utimesSync(fixture, old, old);
  const fixtureSha = createHash("sha256").update(fixtureBytes).digest("hex");
  step("run", "seeded one 40-day-old screenshot as the action's input", fixture);

  if ((await count(`[data-action-id="${target}"]`)) !== 1) {
    throw new Error(`card for ${target} missing`);
  }
  await click(`[data-action-id="${target}"] [data-card-run]`);
  await waitFor("confirm dialog", async () => (await count(".dialog[role='dialog']")) > 0, 15_000);
  const dialogInfo = await js(
    `const d = document.querySelector('.dialog[role="dialog"]');
     const btns = d ? Array.from(d.querySelectorAll('.dialog-actions button')) : [];
     return {
       label: d ? d.getAttribute('aria-label') : null,
       buttons: btns.map((b) => ({ text: b.textContent.trim(), cls: b.className, disabled: b.disabled })),
       rect: d ? (() => { const r = d.getBoundingClientRect(); return { top: Math.round(r.top), height: Math.round(r.height) }; })() : null,
     };`,
  );
  step("run", "confirmation dialog opened for the reversible action", JSON.stringify(dialogInfo));

  // Bring the confirm button into view inside the dialog before clicking it.
  // The dialog scrolls independently of the page, so a raw driver click on an
  // off-screen button lands on the backdrop (which is a dismiss gesture) rather
  // than on the button.
  await js(
    `const btn = document.querySelector('.dialog[role="dialog"] .dialog-actions .btn-primary');
     if (btn) btn.scrollIntoView({ block: 'center' });
     return !!btn;`,
  );
  await click(".dialog[role='dialog'] .dialog-actions .btn-primary");
  // The toast is transient, so it is sampled while waiting rather than read at
  // the end: an error that is dismissed after a few seconds must still be
  // reported by the harness instead of surfacing as a bare timeout.
  const seenAlerts = new Set();
  const runStatus = await waitFor(
    `${target} terminal phase`,
    async () => {
      const probe = await js(`return {
        cls: (() => { const el = document.querySelector('[data-action-id="${target}"] .status'); return el ? el.className : null; })(),
        alert: (() => { const el = document.querySelector('.error-toast'); return el ? el.textContent : null; })(),
        dialog: document.querySelectorAll('.dialog[role="dialog"]').length,
      };`);
      if (probe.alert) seenAlerts.add(probe.alert.trim());
      if (probe.alert && probe.dialog === 0 && !probe.cls?.includes("is-running")) {
        throw new Error(`IPC error surfaced: ${probe.alert.trim()}`);
      }
      return probe.cls && (probe.cls.includes("is-ok") || probe.cls.includes("is-bad")) ? probe.cls : null;
    },
    180_000,
    400,
  );
  if (!runStatus.includes("is-ok")) throw new Error(`action ended in ${runStatus}`);
  step("run", "action executed through IPC and finished successfully", runStatus.trim());

  const archived = await waitFor(
    "fixture to be consumed by the action",
    async () => !existsSync(fixture),
    30_000,
  );
  step("run", "the seeded file was archived (it is gone from the source folder)", String(archived));

  // The snapshot *this run* created, not merely "a rollback button exists": a
  // machine that has been used before legitimately shows rollback affordances
  // for older snapshots, and a journey that waited for all of them to vanish
  // would fail for a reason that has nothing to do with this run.
  const ours = await waitFor(
    "a committed snapshot for this run",
    async () => {
      const rows = await snapshotsFor(target);
      const fresh = rows.filter((row) => !row.isRestored && row.status === "committed");
      // Newest first: the list is ordered by created_at descending.
      return fresh.length > 0 ? fresh[0].snapshotId : null;
    },
    30_000,
    500,
  );
  step("run", "a committed snapshot is attached to this run", ours);

  // -------------------------------------------------------------- journey 3
  await click(`[data-action-id="${target}"] [data-card-rollback]`);
  const restored = await waitFor(
    `snapshot ${ours} to be marked restored`,
    async () => {
      const rows = await snapshotsFor(target);
      const row = rows.find((entry) => entry.snapshotId === ours);
      return row?.isRestored === true ? row : null;
    },
    180_000,
    500,
  );
  const phaseNow = await js(
    `const el = document.querySelector('[data-action-id="${target}"] .status');
     return el ? { cls: el.className, text: el.textContent } : null;`,
  );
  if (phaseNow?.cls?.includes("is-running") || phaseNow?.cls?.includes("is-bad")) {
    throw new Error(`the card did not settle after a successful rollback: ${JSON.stringify(phaseNow)}`);
  }
  const errors = await js("return document.querySelectorAll('.toast.danger, .banner.danger').length;");
  if (errors > 0) throw new Error(`rollback surfaced ${errors} error element(s)`);
  if (!existsSync(fixture)) throw new Error("rollback reported success but the file is still missing");
  const restoredSha = createHash("sha256").update(readFileSync(fixture)).digest("hex");
  if (restoredSha !== fixtureSha) throw new Error(`restored bytes differ: ${restoredSha} != ${fixtureSha}`);
  if (statSync(fixture).size !== fixtureBytes.length) throw new Error("restored size differs");
  step(
    "rollback",
    "the run's snapshot was restored and the card settled",
    `sha256=${restoredSha.slice(0, 16)}… phase=${phaseNow?.text ?? "none"}`,
  );

  // Leave the machine as it was found. The `finally` block repeats this for the
  // failure path; doing it here too means the success transcript ends with the
  // restored file actually removed rather than promised.
  rmSync(fixture, { force: true });
  if (createdScreenshotsDir) {
    try {
      rmdirSync(screenshotsDir);
    } catch {
      // A concurrent screenshot or another file keeps the folder alive; that is
      // correct, so an empty directory is removed and a used one is not.
    }
  }
  step("rollback", "fixture removed; the host is back to its pre-run state");

  console.log("");
  console.log(`journeys: 3, steps: ${journal.length}, failures: 0`);
} catch (error) {
  console.error("");
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  await stop();
  // Safety net: a failed journey must not leave the fixture behind. `--keep-fixture`
  // exists for debugging a failure in place, and says so in the log.
  if (keepFixture) {
    console.log(`KEEP: fixture left at ${fixture} (exists=${existsSync(fixture)})`);
  } else {
    rmSync(fixture, { force: true });
  }
  if (createdScreenshotsDir && !keepFixture) {
    try {
      rmdirSync(screenshotsDir);
    } catch {
      // Directory not empty or already gone: both are acceptable.
    }
  }
}
