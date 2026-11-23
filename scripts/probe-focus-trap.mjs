#!/usr/bin/env node
/**
 * Focus containment probe (DEF-086).
 *
 * `useFocusTrap.test.tsx` proves the hook against jsdom. That is not the same
 * claim as "the shipped window contains focus": jsdom has no real focus model,
 * no `offsetParent` layout, and no `<dialog>`-style stacking. This probe drives
 * the packaged binary and asks the real WebView2 engine three questions:
 *
 *   1. When a confirm dialog opens, is focus *inside* it?
 *   2. Does Tab at the last control wrap to the first, and Shift+Tab at the
 *      first wrap to the last, instead of escaping into the page behind?
 *   3. When the dialog closes, does focus return to the control that opened it,
 *      rather than falling to `<body>`?
 *
 * Synthetic `KeyboardEvent`s do not trigger the browser's native Tab focus
 * move, which is exactly what makes this a test of *our* handler: the only
 * thing that can move focus here is `useFocusTrap`'s own `preventDefault` +
 * `focus()`. If the hook were absent, `activeElement` would not move at all and
 * every assertion below would fail.
 *
 * Usage: node scripts/probe-focus-trap.mjs --app target/release/zenith.exe \
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
 * Dispatch one Tab from the page. `shift` reverses it. Returns what held focus
 * before and after, plus whether the handler called `preventDefault` (which is
 * how the trap stops the browser's own move).
 */
const pressTab = (shift) => `
  const before = document.activeElement;
  const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: ${shift ? "true" : "false"}, bubbles: true, cancelable: true });
  document.activeElement.dispatchEvent(ev);
  const after = document.activeElement;
  return {
    before: before ? (before.className || before.tagName) + '|' + (before.textContent || '').trim().slice(0, 24) : null,
    after: after ? (after.className || after.tagName) + '|' + (after.textContent || '').trim().slice(0, 24) : null,
    prevented: ev.defaultPrevented,
    beforeIsDialog: !!(before && before.closest && before.closest('[role=dialog]')),
    afterIsDialog: !!(after && after.closest && after.closest('[role=dialog]')),
    afterIsBody: after === document.body,
  };
`;

/** Put focus on the first or last focusable control inside the open dialog. */
const focusEdge = (edge) => `
  const d = document.querySelector('[role=dialog]');
  if (!d) return { ok: false, reason: 'no dialog' };
  const sel = "a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])";
  const items = [...d.querySelectorAll(sel)].filter((el) => el.offsetParent !== null);
  if (items.length === 0) return { ok: false, reason: 'no focusable control' };
  const el = ${edge === "last" ? "items[items.length - 1]" : "items[0]"};
  el.focus();
  return { ok: document.activeElement === el, count: items.length, cls: el.className, text: (el.textContent || '').trim().slice(0, 30) };
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

  // Open a confirmation from a real card's Run button, with focus on that button
  // - this is the element the trap must restore focus to when the dialog closes.
  await js(`
    const input = document.querySelector('#action-search');
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const card = [...document.querySelectorAll('[data-action-card]')].find((el) => el.textContent.includes('Geri Dönüşüm'));
    const run = card ? card.querySelector('[data-card-run]') : null;
    if (run) { run.focus(); run.click(); }
    return run ? (run.textContent || '').trim() : null;
  `);
  await sleep(600);

  const dialogs = await js("return document.querySelectorAll('[role=dialog]').length;");
  journal.push(`confirm dialog opened: ${dialogs}`);
  if (dialogs !== 1) {
    problems.push(`expected 1 open dialog, found ${dialogs} - the trap went unmeasured`);
  } else {
    // Q1: on open, focus is inside the dialog rather than left on the trigger.
    const inside = await js(`
      const d = document.querySelector('[role=dialog]');
      return { inside: !!(d && d.contains(document.activeElement)), tag: document.activeElement && document.activeElement.tagName,
               cls: document.activeElement && document.activeElement.className };
    `);
    journal.push(`focus on open: inside=${inside.inside} (${inside.tag}.${inside.cls})`);
    if (!inside.inside) problems.push("focus was NOT inside the dialog after it opened");

    // Q2a: Tab from the last control must wrap to the first.
    const last = await js(focusEdge("last"));
    journal.push(`placed on last: ${last.ok} (${last.text}) of ${last.count}`);
    if (!last.ok) problems.push("could not place focus on the last control");
    const forward = await js(pressTab(false));
    journal.push(
      `Tab at last: before="${forward.before}" -> after="${forward.after}" prevented=${forward.prevented} inDialog=${forward.afterIsDialog}`,
    );
    if (!forward.prevented) problems.push("Tab at the last control was not intercepted - focus could leave the dialog");
    if (!forward.afterIsDialog) problems.push("Tab at the last control left the dialog");
    if (forward.afterIsBody) problems.push("Tab at the last control dropped focus to <body>");

    // Q2b: Shift+Tab from the first control must wrap to the last.
    const first = await js(focusEdge("first"));
    journal.push(`placed on first: ${first.ok} (${first.text})`);
    const backward = await js(pressTab(true));
    journal.push(
      `Shift+Tab at first: before="${backward.before}" -> after="${backward.after}" prevented=${backward.prevented} inDialog=${backward.afterIsDialog}`,
    );
    if (!backward.afterIsDialog) problems.push("Shift+Tab at the first control left the dialog");

    // Q2c: Tab pressed while focus sits outside the dialog is pulled back in.
    const pulled = await js(`
      const outside = document.querySelector('[data-action-card]');
      if (outside) outside.focus();
      const beforeOutside = document.activeElement === outside;
      const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      document.activeElement.dispatchEvent(ev);
      const d = document.querySelector('[role=dialog]');
      return { beforeOutside, backInside: !!(d && d.contains(document.activeElement)), prevented: ev.defaultPrevented };
    `);
    journal.push(
      `Tab from background: started outside=${pulled.beforeOutside} -> backInside=${pulled.backInside} prevented=${pulled.prevented}`,
    );
    if (!pulled.backInside) problems.push("Tab pressed with focus outside the dialog did not pull focus back in");

    // Q3: closing restores focus to the Run button that opened the dialog.
    const restored = await js(`
      const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      document.dispatchEvent(ev);
      return true;
    `);
    await sleep(500);
    const afterClose = await js(`
      const d = document.querySelectorAll('[role=dialog]').length;
      const a = document.activeElement;
      return {
        dialogs: d,
        isBody: a === document.body,
        tag: a && a.tagName,
        hasRun: !!(a && a.hasAttribute && a.hasAttribute('data-card-run')),
      };
    `);
    journal.push(
      `after Escape: dialogs=${afterClose.dialogs} activeElement=${afterClose.tag} onTrigger=${afterClose.hasRun} onBody=${afterClose.isBody}`,
    );
    if (afterClose.dialogs !== 0) problems.push("Escape did not close the dialog");
    if (!afterClose.hasRun) problems.push("focus was not restored to the control that opened the dialog");
  }

  // The palette is the second overlay and must get the same guarantee.
  await js(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    return null;
  `);
  await sleep(500);
  const pal = await js(`
    const d = document.querySelector('.dialog.palette');
    if (!d) return { open: false };
    const before = !!(d && d.contains(document.activeElement));
    const sel = "a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])";
    const items = [...d.querySelectorAll(sel)].filter((el) => el.offsetParent !== null);
    const lastEl = items[items.length - 1];
    if (lastEl) lastEl.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.activeElement.dispatchEvent(ev);
    return {
      open: true,
      focusInsideOnOpen: before,
      count: items.length,
      stillInside: !!(d && d.contains(document.activeElement)),
      wrapped: document.activeElement === items[0],
      prevented: ev.defaultPrevented,
    };
  `);
  journal.push(
    `palette: open=${pal.open} focusInsideOnOpen=${pal.focusInsideOnOpen} controls=${pal.count} Tab-wrap=${pal.wrapped} stillInside=${pal.stillInside}`,
  );
  if (!pal.open) problems.push("Ctrl+K did not open the palette");
  else if (!pal.stillInside) problems.push("Tab escaped the palette");
  else if (!pal.wrapped) problems.push("Tab at the palette's last control did not wrap to the first");

  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return null;`);
  await sleep(400);
  const palClosed = await js("return document.querySelectorAll('.dialog.palette').length;");
  journal.push(`palette after Escape: ${palClosed}`);
  if (palClosed !== 0) problems.push("Escape did not close the palette");
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
