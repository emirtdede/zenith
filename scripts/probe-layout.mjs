#!/usr/bin/env node
/**
 * Layout probe: measures the rendered action grid in the real binary.
 *
 * A screenshot shows what the compositor last painted, which for WebView2 can be
 * a stale frame mid-scroll. Geometry questions ("do cards in a row share a
 * baseline?") must be answered from `getBoundingClientRect`, not from pixels.
 *
 * Usage: node scripts/probe-layout.mjs --app target/release/zenith.exe \
 *          --driver %TEMP%\zenith-e2e\msedgedriver.exe
 *
 * Exit 0 when every row of cards shares one bottom edge and no element overflows
 * its card horizontally; exit 1 when a measurement disagrees.
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

async function wd(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 300)}`);
  }
  return json;
}

async function stop() {
  try {
    await wd("DELETE", `/session/${sessionId}`);
  } catch {
    /* the session may already be gone */
  }
  intermediary.kill();
}

let sessionId = null;
try {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const status = await fetch(`${base}/status`);
      if (status.ok) break;
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }

  const created = await wd("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        "tauri:options": { application: app },
        browserName: "wry",
      },
    },
  });
  sessionId = created.value?.sessionId ?? created.sessionId;

  // Wait for the grid, then let the first-launch diagnosis settle so card text
  // is final (a metric that arrives mid-measure changes the card height).
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const count = await wd("POST", `/session/${sessionId}/execute/sync`, {
      script: "return document.querySelectorAll('[data-action-card]').length;",
      args: [],
    });
    if (count.value === 22) break;
    await sleep(500);
  }
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const running = await wd("POST", `/session/${sessionId}/execute/sync`, {
      script: "return document.querySelectorAll('.health-actions button.btn-quiet').length;",
      args: [],
    });
    if (running.value === 0) break;
    await sleep(500);
  }
  await sleep(500);

  const report = await wd("POST", `/session/${sessionId}/execute/sync`, {
    script: `
      const cards = [...document.querySelectorAll('[data-action-card]')].map((card) => {
        const box = card.getBoundingClientRect();
        const title = card.querySelector('h3, .card-title');
        return {
          title: title ? title.textContent.trim().slice(0, 40) : '(untitled)',
          top: Math.round(box.top + window.scrollY),
          bottom: Math.round(box.bottom + window.scrollY),
          left: Math.round(box.left),
          right: Math.round(box.right),
          width: Math.round(box.width),
        };
      });

      // Group cards into rows by their top edge (1 px tolerance).
      const rows = [];
      for (const card of cards) {
        const row = rows.find((candidate) => Math.abs(candidate.top - card.top) <= 1);
        if (row) row.cards.push(card);
        else rows.push({ top: card.top, cards: [card] });
      }

      const uneven = rows
        .filter((row) => row.cards.length > 1)
        .map((row) => {
          const bottoms = row.cards.map((card) => card.bottom);
          return {
            top: row.top,
            spread: Math.max(...bottoms) - Math.min(...bottoms),
            cards: row.cards.map((card) => ({ title: card.title, bottom: card.bottom })),
          };
        })
        .filter((row) => row.spread > 1);

      // Any child whose right edge escapes its card is clipped text.
      const overflowing = [];
      for (const card of document.querySelectorAll('[data-action-card]')) {
        const limit = card.getBoundingClientRect().right;
        for (const child of card.querySelectorAll('*')) {
          const box = child.getBoundingClientRect();
          if (box.width > 0 && box.right > limit + 1) {
            overflowing.push({
              card: card.querySelector('h3, .card-title')?.textContent.trim().slice(0, 30),
              tag: child.tagName,
              cls: child.className,
              over: Math.round(box.right - limit),
            });
          }
        }
      }

      return { cards: cards.length, rows: rows.length, uneven, overflowing };
    `,
    args: [],
  });

  const { cards, rows, uneven, overflowing } = report.value;
  console.log(`cards: ${cards}, rows: ${rows}`);
  console.log(`rows with uneven bottoms: ${uneven.length}`);
  for (const row of uneven) {
    console.log(`  row@${row.top} spread ${row.spread}px: ${row.cards.map((c) => `${c.title}=${c.bottom}`).join(', ')}`);
  }
  console.log(`elements overflowing their card: ${overflowing.length}`);
  for (const item of overflowing.slice(0, 10)) {
    console.log(`  ${item.card} > ${item.tag}.${item.cls} by ${item.over}px`);
  }

  await stop();
  process.exit(uneven.length === 0 && overflowing.length === 0 ? 0 : 1);
} catch (error) {
  console.error(`probe failed: ${error.message}`);
  await stop();
  process.exit(2);
}
