#!/usr/bin/env node
/**
 * `boot:capture` - photograph the boot skeleton next to the loaded shell.
 *
 * The skeleton is the only loading state a user can observe: every screen's data
 * arrives during boot, so a per-screen spinner would never be seen. That makes
 * it exactly the state a screenshot pack forgets, because it exists for a few
 * hundred milliseconds and no driver session can attach that fast.
 *
 * This script attaches to WebView2's own DevTools endpoint instead, which exists
 * as soon as the page does, and polls the DOM for `.boot-skeleton`. The app runs
 * against a throwaway `LOCALAPPDATA`, so the profile is cold (the slowest boot a
 * user can get) and the real profile is never touched.
 *
 * It fails when the skeleton is never observed, or when the two captures are
 * byte-identical - a "before" picture of the loaded screen is not evidence.
 *
 * Usage: node scripts/capture-boot.mjs --app target/release/zenith.exe
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (token.startsWith("--")) args.set(token.slice(2), process.argv[i + 1]);
}
const app = resolve(args.get("app") ?? "target/release/zenith.exe");
const out = resolve(args.get("out") ?? join("evidence", "screens", "boot"));

function freePort() {
  return new Promise((ok, fail) => {
    const server = createServer();
    server.unref();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close(() => ok(port));
    });
  });
}

function pngSize(file) {
  const bytes = readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length };
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((ok, fail) => {
    socket.addEventListener("open", ok, { once: true });
    socket.addEventListener("error", fail, { once: true });
  });
  let next = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.fail(new Error(message.error.message));
    else entry.ok(message.result);
  });
  return {
    send(method, params = {}) {
      const id = next++;
      return new Promise((ok, fail) => {
        pending.set(id, { ok, fail });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

async function shot(page, file) {
  const result = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  writeFileSync(file, Buffer.from(result.data, "base64"));
  return pngSize(file);
}

const problems = [];
const profile = mkdtempSync(join(tmpdir(), "zenith-boot-profile-"));
const debugPort = await freePort();
mkdirSync(out, { recursive: true });

const child = spawn(app, [], {
  env: {
    ...process.env,
    LOCALAPPDATA: profile,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`,
  },
  stdio: "ignore",
});

let page = null;
try {
  const started = Date.now();
  let target = null;
  for (let attempt = 0; attempt < 400 && !target; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (response.ok) {
        const list = await response.json();
        target = list.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl) ?? null;
      }
    } catch {
      /* WebView2 is still coming up */
    }
    if (!target) await sleep(10);
  }
  if (!target) throw new Error("WebView2 never exposed a DevTools page target");
  page = await connect(target.webSocketDebuggerUrl);
  await page.send("Page.enable");

  const evaluate = async (expression) => {
    const result = await page.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      // A synthetic click without a user gesture can be ignored by code that
      // checks `event.isTrusted` or by a webview that gates input; the flag
      // makes the evaluation behave like a real interaction.
      userGesture: true,
    });
    if (result.exceptionDetails) {
      problems.push(`evaluate failed: ${result.exceptionDetails.text ?? "exception"}`);
    }
    return result.result?.value;
  };

  let skeletonSeen = false;
  for (let attempt = 0; attempt < 600 && !skeletonSeen; attempt += 1) {
    skeletonSeen = (await evaluate("Boolean(document.querySelector('.boot-skeleton'))")) === true;
    if (!skeletonSeen) await sleep(10);
  }
  const attachedAfter = Date.now() - started;
  if (!skeletonSeen) {
    problems.push(
      `the boot skeleton was never visible after attach (${attachedAfter} ms); the capture would describe the loaded screen`,
    );
  } else {
    const size = await shot(page, join(out, "01-skeleton.png"));
    console.log(`01-skeleton.png  ${size.width}x${size.height}  observed ${attachedAfter} ms after launch`);
  }

  // The loaded side of the pair: wait for real content, dismiss the first-run
  // guide, and photograph the same window.
  let loaded = false;
  for (let attempt = 0; attempt < 600 && !loaded; attempt += 1) {
    loaded = (await evaluate("Boolean(document.querySelector('[data-action-card]'))")) === true;
    if (!loaded) await sleep(50);
  }
  if (!loaded) {
    problems.push("the loaded action grid never appeared, so there is no after picture");
  } else {
    await sleep(400);
    // The guide mounts a beat after the grid behind it, so "not there yet" and
    // "already onboarded" look identical for a moment. Wait for it to appear,
    // then dismiss it and confirm it is gone.
    let guideAppeared = false;
    for (let attempt = 0; attempt < 100 && !guideAppeared; attempt += 1) {
      guideAppeared = (await evaluate("Boolean(document.querySelector('.onboarding'))")) === true;
      if (!guideAppeared) await sleep(100);
    }
    if (guideAppeared) {
      const clicked = await evaluate(`
        (() => {
          const skip = document.querySelector('.onboarding .btn-quiet');
          if (!skip) return 'missing';
          skip.click();
          return 'clicked:' + skip.textContent.trim();
        })()
      `);
      console.log(`first-run guide: ${clicked}`);
      await sleep(1500);
      if (await evaluate("Boolean(document.querySelector('.onboarding'))")) {
        problems.push("the first-run guide could not be dismissed, so the after picture shows a modal");
      }
    } else {
      console.log("no first-run guide in this profile");
    }
    await sleep(300);
    const size = await shot(page, join(out, "02-loaded.png"));
    console.log(`02-loaded.png    ${size.width}x${size.height}`);
    const first = readFileSync(join(out, "01-skeleton.png"));
    const second = readFileSync(join(out, "02-loaded.png"));
    if (first.equals(second)) problems.push("the skeleton and the loaded capture are byte-identical");
  }
} finally {
  page?.close();
  child.kill();
  await sleep(600);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* WebView2 may still hold a lock; the profile is under %TEMP% */
  }
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`\nBoot pair captured in ${out}`);
