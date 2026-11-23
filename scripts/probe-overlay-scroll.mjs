#!/usr/bin/env node
/**
 * Overlay scroll probe: is any overlay a nested scroll container?
 *
 * `05-02` §1 bounds `.main` as the page's only content scroller and lists the
 * overlay scrollers. DEF-082 showed that a scroll rule on a shared class can
 * silently produce a scroller-in-a-scroller. The screen sweep only walks
 * `#main *`, so overlays (siblings of `.main`) are unmeasured - and `.script`
 * and `.palette-list` both scroll *inside* `.dialog`, which itself scrolls at
 * 86vh. This measures whether that actually nests, at the default window size
 * and at the 640 px minimum height where it is most likely to.
 *
 * Usage: node scripts/probe-overlay-scroll.mjs --app target/release/zenith.exe \
 *          --driver %TEMP%\zenith-e2e\msedgedriver.exe
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (token.startsWith("--")) args.set(token.slice(2), process.argv[i + 1]);
}
const app = args.get("app") ?? "target/release/zenith.exe";
const driverPath = args.get("driver") ?? process.env.ZENITH_MSEDGEDRIVER ?? "";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      server.close(() => resolve(a && typeof a === "object" ? a.port : 0));
    });
  });
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
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 240)}`);
  return json;
}

const js = async (script) =>
  (await wd("POST", `/session/${sessionId}/execute/sync`, { script, args: [] })).value;

/**
 * Every scrollable box in the overlay layer, with its hidden height.
 *
 * Elements are tagged with a temporary attribute so the ancestor walk tests
 * *this* element rather than the first class-name match - two `.btn` rows would
 * otherwise be confused for each other and the nesting verdict would be fiction.
 */
const OVERLAY_SCROLLERS = `
  const scrolls = (el) => {
    const s = getComputedStyle(el);
    return /(auto|scroll)/.test(s.overflowY) || /(auto|scroll)/.test(s.overflowX);
  };
  const hides = (el) => el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2;

  const targets = [];
  for (const root of document.querySelectorAll('[role=dialog]')) {
    for (const el of [root, ...root.querySelectorAll('*')]) {
      if (!scrolls(el) || !hides(el)) continue;
      el.setAttribute('data-probe', String(targets.length));
      targets.push(el);
    }
  }

  const found = targets.map((el) => {
    let p = el.parentElement;
    let nestedIn = null;
    while (p) {
      if (p.hasAttribute('data-probe')) nestedIn = String(p.className).slice(0, 40) || p.tagName;
      else if (scrolls(p) && hides(p)) nestedIn = String(p.className).slice(0, 40) || p.tagName;
      if (nestedIn) break;
      p = p.parentElement;
    }
    return {
      cls: String(el.className).slice(0, 40) || el.tagName,
      hidden: el.scrollHeight - el.clientHeight,
      hiddenX: el.scrollWidth - el.clientWidth,
      clientH: el.clientHeight,
      scrollH: el.scrollHeight,
      nestedIn,
    };
  });

  for (const el of targets) el.removeAttribute('data-probe');

  return {
    found,
    nestedCount: found.filter((f) => f.nestedIn).length,
    viewportH: window.innerHeight,
  };
`;

const problems = [];
const journal = [];

try {
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(`${base}/status`)).ok) break;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }

  const created = await wd("POST", "/session", {
    capabilities: { alwaysMatch: { "tauri:options": { application: app }, browserName: "wry" } },
  });
  sessionId = created.value?.sessionId ?? created.sessionId;

  for (let i = 0; i < 120; i += 1) {
    if ((await js("return document.querySelectorAll('[data-action-card]').length;")) === 22) break;
    await sleep(500);
  }
  for (let i = 0; i < 180; i += 1) {
    if ((await js("return document.querySelectorAll('.health-actions button.btn-quiet').length;")) === 0) break;
    await sleep(500);
  }

  // Open the script overlay: it holds `.script` (300px) inside `.dialog` (86vh).
  // Click and measure in separate round-trips: React re-renders after the event
  // handler returns, so reading `[role=dialog]` in the same execute call sees the
  // pre-click DOM and reports 0 - which is what the first run of this probe did.
  await js(`
    const card = document.querySelector('[data-action-card]');
    const report = [...card.querySelectorAll('button')].find((b) => /Ayrıntılar|Details/i.test(b.textContent));
    report?.click();
    return null;
  `);
  await sleep(500);
  const opened = await js("return document.querySelectorAll('[role=dialog]').length;");
  journal.push(`script overlay dialogs: ${opened}`);
  if (opened === 0) problems.push("script overlay did not open (the .script scroller went unmeasured)");

  const scriptLayer = await js(OVERLAY_SCROLLERS);
  journal.push(
    `script overlay @${scriptLayer.viewportH}px: ${scriptLayer.found.length} scroller(s), nested=${scriptLayer.nestedCount}` +
      scriptLayer.found.map((f) => `\n    ${f.cls} hides ${f.hidden}px (client ${f.clientH}, scroll ${f.scrollH})`).join(""),
  );
  if (scriptLayer.nestedCount > 0) {
    problems.push(`script overlay: ${scriptLayer.nestedCount} nested scroll container(s) inside .dialog`);
  }

  // Close, then open the palette: `.palette-list` (48vh) inside `.dialog`.
  await js(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return null;
  `);
  await sleep(300);
  await js(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    return null;
  `);
  await sleep(400);

  const paletteLayer = await js(OVERLAY_SCROLLERS);
  journal.push(
    `palette @${paletteLayer.viewportH}px: ${paletteLayer.found.length} scroller(s), nested=${paletteLayer.nestedCount}` +
      paletteLayer.found.map((f) => `\n    ${f.cls} hides ${f.hidden}px (client ${f.clientH}, scroll ${f.scrollH})`).join(""),
  );
  if (paletteLayer.nestedCount > 0) {
    problems.push(`palette: ${paletteLayer.nestedCount} nested scroll container(s) inside .dialog`);
  }

  // The 780 px default is the comfortable case. `.dialog` is bounded at 86vh and
  // `.palette-list` at 48vh, so nesting is most likely at the 960×640 minimum
  // window (`05-02` §1). Shrink to the floor and re-measure the palette, which
  // is the overlay that actually scrolls today.
  await wd("POST", `/session/${sessionId}/window/rect`, { width: 960, height: 640 });
  await sleep(600);

  const tiny = await js(OVERLAY_SCROLLERS);
  journal.push(
    `palette @${tiny.viewportH}px (minimum window): ${tiny.found.length} scroller(s), nested=${tiny.nestedCount}` +
      tiny.found.map((f) => `\n    ${f.cls} hides ${f.hidden}px (client ${f.clientH}, scroll ${f.scrollH})`).join(""),
  );
  if (tiny.nestedCount > 0) {
    problems.push(
      `palette at the 640 px minimum: ${tiny.nestedCount} nested scroll container(s) inside .dialog - ` +
        `05-02 §1 permits .dialog and .palette-list to scroll, but not one inside the other`,
    );
  }
} catch (error) {
  problems.push(`harness: ${error.message}`);
} finally {
  if (sessionId) {
    try {
      await wd("DELETE", `/session/${sessionId}`);
    } catch {
      /* gone */
    }
  }
  intermediary.kill();
}

for (const line of journal) console.log(line);
for (const p of problems) console.error(`FAIL ${p}`);
console.log(`problems: ${problems.length}`);
process.exit(problems.length ? 1 : 0);
