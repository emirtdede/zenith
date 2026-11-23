#!/usr/bin/env node
/**
 * `setup:capture` - render the six installer states to PNG evidence.
 *
 * The wizard is a 640x420 card, so the capture is a 664x444 viewport at
 * `deviceScaleFactor: 2`: 12px of breathing room around the card on every side,
 * and 2x pixels so a reviewer can read the 11.5px hint lines without squinting.
 *
 * It drives Edge over the DevTools protocol directly. Adding a Playwright or
 * Puppeteer dependency for six screenshots would put a browser download in the
 * release path; `msedge.exe` is already on every Windows machine the product
 * targets, and Node has a global `WebSocket`.
 *
 * Usage: `node scripts/capture-setup.mjs [--out <dir>]`
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const OUT = (() => {
  const index = process.argv.indexOf("--out");
  return index !== -1 ? resolve(process.argv[index + 1]) : join(ROOT, "evidence", "screens", "setup");
})();

const SCREENS = [
  { file: "01-welcome.png", query: "?setup=1&state=welcome" },
  { file: "02-options.png", query: "?setup=1&state=options" },
  { file: "03-progress.png", query: "?setup=1&state=progress&progress=64" },
  { file: "04-done.png", query: "?setup=1&state=done" },
  { file: "05-uninstall.png", query: "?uninstall=1&state=uninstall" },
  { file: "06-uninstalled.png", query: "?uninstall=1&state=uninstalled" },
  { file: "07-uninstalled-data-deleted.png", query: "?uninstall=1&state=uninstalled&delete=1" },
  { file: "08-failed.png", query: "?setup=1&state=failed&error=INSTALL_WRITE_DENIED:+0x80070005" },
  { file: "09-rtl-arabic.png", query: "?setup=1&state=welcome&lang=ar" },
  { file: "10-turkish.png", query: "?setup=1&state=welcome&lang=tr" },
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

function chromiumPath() {
  const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = process.env["LOCALAPPDATA"] ?? "";
  const candidates = [
    process.env.CHROMIUM_PATH,
    process.env.MSEDGE_PATH,
    join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function serve() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = join(DIST, decodeURIComponent(path));
    if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    response.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.next = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      const queue = this.listeners.get(message.method) ?? [];
      for (const listener of queue) listener(message.params);
    });
  }

  send(method, params = {}) {
    const id = this.next++;
    return new Promise((ok, fail) => {
      this.pending.set(id, { resolve: ok, reject: fail });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method) {
    return new Promise((ok) => {
      const queue = this.listeners.get(method) ?? [];
      const listener = (params) => {
        this.listeners.set(
          method,
          (this.listeners.get(method) ?? []).filter((item) => item !== listener),
        );
        ok(params);
      };
      this.listeners.set(method, [...queue, listener]);
    });
  }

  close() {
    this.socket.close();
  }
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((ok, fail) => {
    socket.addEventListener("open", ok, { once: true });
    socket.addEventListener("error", fail, { once: true });
  });
  return new Cdp(socket);
}

function pngSize(file) {
  const bytes = readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length };
}

async function main() {
  if (!existsSync(join(DIST, "setup.html"))) {
    console.error("dist/setup.html is missing; run `npm run build` first.");
    process.exit(1);
  }
  const edge = chromiumPath();
  if (!edge) {
    console.error("Neither msedge.exe nor chrome.exe was found; set CHROMIUM_PATH to a Chromium executable.");
    process.exit(1);
  }

  const server = await serve();
  const port = server.address().port;
  const profile = mkdtempSync(join(tmpdir(), "zenith-setup-capture-"));
  const debug = 9500 + Math.floor(Math.random() * 400);
  const browser = spawn(
    edge,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debug}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  const problems = [];
  try {
    let version = null;
    for (let attempt = 0; attempt < 100 && !version; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${debug}/json/version`);
        if (response.ok) version = await response.json();
      } catch {
        // Edge is still starting.
      }
      if (!version) await new Promise((ok) => setTimeout(ok, 100));
    }
    if (!version) throw new Error("Edge did not open a DevTools endpoint");

    mkdirSync(OUT, { recursive: true });
    const browserCdp = await connect(version.webSocketDebuggerUrl);
    const { targetId } = await browserCdp.send("Target.createTarget", { url: "about:blank" });
    const list = await (await fetch(`http://127.0.0.1:${debug}/json/list`)).json();
    const target = list.find((entry) => entry.id === targetId);
    if (!target) throw new Error("the new target is not listed");
    const page = await connect(target.webSocketDebuggerUrl);

    await page.send("Page.enable");
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 664,
      height: 444,
      deviceScaleFactor: 2,
      mobile: false,
    });

    for (const screen of SCREENS) {
      const url = `http://127.0.0.1:${port}/setup.html${screen.query}`;
      const loaded = page.once("Page.loadEventFired");
      await page.send("Page.navigate", { url });
      await loaded;
      // The card fades in over 220ms; the backdrop's first frame is immediate.
      await new Promise((ok) => setTimeout(ok, 450));
      const shot = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      const file = join(OUT, screen.file);
      writeFileSync(file, Buffer.from(shot.data, "base64"));
      const size = pngSize(file);
      if (size.width !== 1328 || size.height !== 888) {
        problems.push(`${screen.file} is ${size.width}x${size.height}, expected 1328x888 (664x444 at 2x)`);
      }
      console.log(`${screen.file}  ${size.width}x${size.height}  ${(size.bytes / 1024).toFixed(0)} KB`);
    }

    page.close();
    browserCdp.close();
  } finally {
    browser.kill();
    server.close();
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // The browser may still hold a lock; the profile is under %TEMP%.
    }
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`\n${SCREENS.length} screenshots at 664x444 (deviceScaleFactor 2) in ${OUT}`);
}

await main();
