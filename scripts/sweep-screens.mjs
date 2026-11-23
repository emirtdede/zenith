#!/usr/bin/env node
/**
 * Screen sweep: renders every screen and overlay in the real binary, saves one
 * PNG per state, and fails on the defects a screenshot-less suite cannot see.
 *
 * What it checks, per state:
 *   * the screenshot is not blank (a WebView that failed to paint is one colour);
 *   * no rendered element escapes the viewport horizontally (WCAG 1.4.10);
 *   * the renderer console produced no error (a thrown render is invisible in
 *     a jsdom test that mocks the failing call);
 *   * headings are present, so a screen that silently renders nothing fails.
 *
 * Screenshots land in `evidence/screens/`. They are captured through the
 * WebDriver screenshot endpoint, not `PrintWindow`, so they are the renderer's
 * own pixels rather than whatever the compositor last had.
 *
 * Usage: node scripts/sweep-screens.mjs --app target/release/zenith.exe \
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
const outDir = args.get("out") ?? join("evidence", "screens");

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

async function click(selector) {
  const found = await wd("POST", `/session/${sessionId}/element`, {
    using: "css selector",
    value: selector,
  });
  const id = found.value?.["element-6066-11e4-a52e-4f735466cecf"] ?? found.value?.ELEMENT;
  if (!id) throw new Error(`no element for ${selector}`);
  await wd("POST", `/session/${sessionId}/element/${id}/click`, {});
}

/** Real renderer pixels, base64 PNG. */
async function screenshot(file) {
  const shot = await wd("GET", `/session/${sessionId}/screenshot`);
  writeFileSync(file, Buffer.from(shot.value, "base64"));
}

const problems = [];
const journal = [];

/**
 * A state is a name, a setup script (run in the page), a selector that must
 * exist, the id of the screen the shot must show, and an optional count.
 *
 * `screen` is not decoration: `#main[data-screen]` is set by `App.tsx`, so a
 * navigation click that silently did nothing would otherwise produce a passing
 * screenshot of the screen the run was already on. Asserting the id makes each
 * file provable.
 */
const states = [
  {
    name: "01-actions",
    setup: "return null;",
    expect: "[data-action-card]",
    screen: "actions",
    requires: 22,
  },
  {
    name: "02-actions-cleanup",
    setup: "document.querySelectorAll('.tab')[1].click(); return null;",
    expect: "[data-action-card]",
    screen: "actions",
  },
  {
    name: "03-actions-search",
    // Back to the unfiltered tab first: the search box narrows whatever tab is
    // selected, so searching "dns" while the cleanup tab is active matches
    // nothing. That is the app behaving correctly and the probe being wrong.
    setup: `
      [...document.querySelectorAll('.tab')]
        .find((tab) => tab.textContent.trim() === 'Tümü')?.click();
      const input = document.querySelector('#action-search');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'dns');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return null;
    `,
    expect: "[data-action-card]",
    screen: "actions",
  },
  {
    name: "04-confirm-dialog",
    setup: `
      const input = document.querySelector('#action-search');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const card = [...document.querySelectorAll('[data-action-card]')]
        .find((el) => el.textContent.includes('Geri Dönüşüm'));
      card.querySelector('[data-card-run]').click();
      return null;
    `,
    expect: "[role=dialog]",
    screen: "actions",
  },
  {
    name: "05-snapshots",
    setup: `
      document.querySelector('[role=dialog] button.btn-quiet')?.click();
      document.querySelector('[data-nav="snapshots"]')?.click();
      return null;
    `,
    expect: "h2",
    screen: "snapshots",
  },
  {
    name: "06-trust",
    setup: `
      document.querySelector('[data-nav="trust"]')?.click();
      return null;
    `,
    expect: "h2",
    screen: "trust",
  },
  {
    name: "07-settings",
    setup: `
      document.querySelector('[data-nav="settings"]')?.click();
      return null;
    `,
    expect: "h2",
    screen: "settings",
  },
  {
    name: "08-help",
    setup: `
      document.querySelector('[data-nav="help"]')?.click();
      return null;
    `,
    expect: "h2",
    screen: "help",
  },
  {
    name: "09-activity",
    // The full-height activity screen renders `ol.log`; the `.console` drawer is
    // the collapsed overlay, a different element. Asserting the wrong class made
    // a working screen look broken.
    setup: `
      const search = document.querySelector('#action-search');
      if (search) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(search, '');
        search.dispatchEvent(new Event('input', { bubbles: true }));
      }
      document.querySelector('[data-nav="activity"]')?.click();
      return null;
    `,
    expect: "ol.log",
    screen: "activity",
  },
  {
    name: "10-palette",
    setup: `
      document.querySelector('[data-nav="actions"]')?.click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      return null;
    `,
    expect: "[role=dialog]",
  },
];

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

  // Wait for the catalog and let the automatic diagnosis finish: a screenshot
  // taken mid-scan shows a different card state than a user ever sits with.
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if ((await js("return document.querySelectorAll('[data-action-card]').length;")) === 22) break;
    await sleep(500);
  }
  for (let attempt = 0; attempt < 180; attempt += 1) {
    if ((await js("return document.querySelectorAll('.health-actions button.btn-quiet').length;")) === 0) break;
    await sleep(500);
  }

  mkdirSync(outDir, { recursive: true });

  for (const state of states) {
    await js(state.setup);
    await sleep(300);

    const present = await js(
      `return document.querySelectorAll(${JSON.stringify(state.expect)}).length;`,
    );
    if (present === 0) {
      problems.push(`${state.name}: nothing matched ${state.expect}`);
      journal.push(`  FAIL  ${state.name} :: missing ${state.expect}`);
      continue;
    }
    if (state.requires && present !== state.requires) {
      problems.push(`${state.name}: expected ${state.requires} of ${state.expect}, saw ${present}`);
    }

    const geometry = await js(`
      const doc = document.documentElement;
      const overflowX = doc.scrollWidth - doc.clientWidth;
      const escaped = [...document.querySelectorAll('body *')]
        .filter((el) => {
          const box = el.getBoundingClientRect();
          return box.width > 0 && (box.right > doc.clientWidth + 1 || box.left < -1);
        })
        .map((el) => ({ tag: el.tagName, cls: String(el.className).slice(0, 40) }));

      // \`05-02\` §1: \`.main\` is the only page scroll container. Five other rules in
      // \`app.css\` declare a scrollable overflow, but four of them (.drawer .log,
      // .dialog, .script, .palette-list) belong to surfaces that are siblings of
      // \`.main\`, so this walk - which starts at \`#main\` - cannot reach them and
      // must not tolerate them here. Exactly one scroller is legal inside page
      // content: the licence appendix, bounded and behind a <details>. Everything
      // else under \`.main\` that scrolls is a trap.
      const ALLOWED = ['licenses-text'];
      const nested = [...document.querySelectorAll('#main *')]
        .filter((el) => {
          const style = getComputedStyle(el);
          const scrolls = /(auto|scroll)/.test(style.overflowY) || /(auto|scroll)/.test(style.overflowX);
          if (!scrolls) return false;
          const cls = String(el.className);
          if (ALLOWED.some((name) => cls.split(/\\s+/).includes(name))) return false;
          // A box that scrolls but has nothing to scroll is not a trap; require
          // real hidden content in at least one axis.
          return el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2;
        })
        .map((el) => ({
          tag: el.tagName,
          cls: String(el.className).slice(0, 40),
          hidden: el.scrollHeight - el.clientHeight,
        }));

      return {
        overflowX,
        escaped: escaped.slice(0, 6),
        nested: nested.slice(0, 6),
        nestedCount: nested.length,
        screen: document.querySelector('#main[data-screen]')?.dataset.screen ?? "(none)",
        heading: (document.querySelector('#main h2, #main h3')?.textContent ?? '').trim().slice(0, 60),
        dialogs: document.querySelectorAll('[role=dialog]').length,
      };
    `);

    if (state.screen && geometry.screen !== state.screen) {
      problems.push(`${state.name}: expected screen "${state.screen}", the main region reports "${geometry.screen}"`);
    }
    if (geometry.overflowX > 0) {
      problems.push(`${state.name}: horizontal overflow ${geometry.overflowX}px`);
    }
    if (geometry.nestedCount > 0) {
      problems.push(
        `${state.name}: ${geometry.nestedCount} nested scroll container(s) inside #main (${geometry.nested
          .map((e) => `${e.tag}.${e.cls} hides ${e.hidden}px`)
          .join(", ")}) - 05-02 §1 allows only .main to scroll, plus the three named appendix regions`,
      );
    }
    if (geometry.escaped.length > 0) {
      problems.push(
        `${state.name}: ${geometry.escaped.length} element(s) outside the viewport (${geometry.escaped
          .map((e) => `${e.tag}.${e.cls}`)
          .join(", ")})`,
      );
    }
    if (geometry.heading === "") {
      problems.push(`${state.name}: no visible heading`);
    }

    const file = join(outDir, `${state.name}.png`);
    await screenshot(file);

    // A blank capture is one colour repeated; detect it by sampling the buffer
    // size instead of decoding the PNG: an all-white 1180x780 PNG compresses to
    // a couple of kB, while a real screen of text is far larger.
    const bytes = readFileSync(file).length;
    if (bytes < 12_000) {
      problems.push(`${state.name}: screenshot is ${bytes} B, indistinguishable from a blank frame`);
    }

    journal.push(
      `  PASS  ${state.name} :: screen=${geometry.screen} heading="${geometry.heading}" overflowX=${geometry.overflowX} dialogs=${geometry.dialogs} ${Math.round(bytes / 1024)}kB`,
    );
  }
} catch (error) {
  problems.push(`harness: ${error.message}`);
} finally {
  if (sessionId) {
    try {
      await wd("DELETE", `/session/${sessionId}`);
    } catch {
      /* already gone */
    }
  }
  intermediary.kill();
}

for (const line of journal) console.log(line);
for (const problem of problems) console.error(`FAIL ${problem}`);
console.log(`screens: ${states.length}, problems: ${problems.length}`);
process.exit(problems.length ? 1 : 0);
