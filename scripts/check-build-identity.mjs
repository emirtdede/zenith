#!/usr/bin/env node
/**
 * Build-identity gate (DEF-092).
 *
 * The defect this exists to catch: on 2026-11-21 the release binary was rebuilt
 * at 10:55 and still reported `release-20261120` in the Trust Center, because
 * `build.rs` emitted only `rerun-if-env-changed`, which switches off cargo's
 * default "rerun when a package file changes" behaviour. The bytes were new; the
 * provenance claim was a day old. Nothing failed, because nothing treated the
 * embedded date as an output with a truth value.
 *
 * This script treats it as one. Three independent facts must agree:
 *
 *   1. `target/release/zenith.exe` contains a `release-YYYYMMDD` marker;
 *   2. that date equals the binary's own modification date;
 *   3. no shipped source file is newer than the binary (a newer source means the
 *      binary is stale, and any identity it reports is about older code).
 *
 * Set `ZENITH_BUILD_COMMIT` at build time and check 1 is replaced by "the marker
 * equals the variable" - the CI path in `08-02` §2.3.
 *
 * Exit codes: 0 pass, 1 fail, 2 nothing to check (no binary yet, so the gate is
 * skipped rather than passing on absence). `npm run verify` treats 2 as a skip
 * because it runs before `tauri build`; the release checklist runs it after.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const BINARY = process.env.ZENITH_BINARY ?? "target/release/zenith.exe";
const MARKER = /release-(\d{4})(\d{2})(\d{2})/g;

/** Source roots whose files get compiled into the binary. */
const SOURCE_ROOTS = ["src", "src-tauri/src"];
/** Individual files that are inputs to the build. */
const SOURCE_FILES = ["src-tauri/build.rs", "src-tauri/tauri.conf.json"];

/**
 * Files that live under a source root but are **not** compiled into the binary.
 * A test file is not part of the shipped bytes, so editing one cannot make the
 * binary stale; counting it would fail this gate for a change that did not
 * affect the artefact at all, and a gate that cries wolf gets disabled.
 */
const NOT_SHIPPED = [/\.test\.[cm]?[jt]sx?$/, /\.spec\.[cm]?[jt]sx?$/, /[/\\]__tests__[/\\]/];

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

function dateKey(date) {
  // UTC on purpose. `build.rs` derives `release-YYYYMMDD` from the epoch with
  // Howard Hinnant's `civil_from_days`, which is a **UTC** calendar; comparing
  // it to a locally-rendered date makes a correct build fail for part of every
  // day. Measured on this machine (UTC+03:00): a binary built at 00:47 local
  // embeds 20261121 while its local mtime renders 20261122, so the gate rejected
  // a clean `npm run tauri build` - the gate itself was the defect (DEF-109).
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

let binaryStat;
try {
  binaryStat = statSync(BINARY);
} catch {
  // Exit 2 = "nothing to check". This is a **release** gate: it runs after
  // `npm run tauri build`, on purpose, because a gate that needs an artefact
  // cannot honestly run before the artefact exists. It is deliberately not part
  // of `npm run verify` - pretending to check a binary that has not been built
  // is exactly the kind of green that means nothing. `08-02` §2.4 lists it in
  // the release checklist next to `probe-focus-trap`.
  console.log(`skip no binary at ${BINARY} (run \`npm run tauri build\` first)`);
  process.exit(2);
}

const bytes = readFileSync(BINARY);
const text = bytes.toString("latin1");
const markers = [...new Set([...text.matchAll(MARKER)].map((m) => m[1] + m[2] + m[3]))];

if (markers.length === 0) {
  fail(`no release-YYYYMMDD marker in ${BINARY}; the Trust Center has nothing truthful to show`);
  process.exit(1);
}
if (markers.length > 1) {
  fail(`binary carries ${markers.length} distinct build dates (${markers.join(", ")}); provenance is ambiguous`);
  process.exit(1);
}

const embedded = markers[0];
const binaryDate = dateKey(binaryStat.mtime);

const expected = process.env.ZENITH_BUILD_COMMIT?.trim();
if (expected && /^release-\d{8}$/.test(expected)) {
  const wanted = expected.slice("release-".length);
  if (embedded !== wanted) {
    fail(`binary was built with ZENITH_BUILD_COMMIT=${expected} but embeds release-${embedded}`);
  } else {
    console.log(`ok   embedded release-${embedded} matches ZENITH_BUILD_COMMIT`);
  }
} else if (embedded !== binaryDate) {
  fail(
    `embedded build date release-${embedded} does not match the binary's modification date ${binaryDate} ` +
      `(${BINARY} mtime ${binaryStat.mtime.toISOString()}). The binary reports a day it was not built on ` +
      `- DEF-092.`,
  );
} else {
  console.log(`ok   embedded release-${embedded} matches binary mtime ${binaryDate}`);
}

// Staleness: a source file newer than the binary means the identity describes
// code that is no longer in the tree.
function newestFile(dir) {
  let newest = null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = newestFile(path);
      if (nested && (!newest || nested.mtime > newest.mtime)) {
        newest = nested;
      }
      continue;
    }
    if (NOT_SHIPPED.some((pattern) => pattern.test(path))) {
      continue;
    }
    const stat = statSync(path);
    if (!newest || stat.mtime > newest.mtime) {
      newest = { path, mtime: stat.mtime };
    }
  }
  return newest;
}

const candidates = [];
for (const root of SOURCE_ROOTS) {
  try {
    const found = newestFile(root);
    if (found) candidates.push(found);
  } catch {
    // A missing root is not a failure; the other checks still apply.
  }
}
for (const file of SOURCE_FILES) {
  try {
    candidates.push({ path: file, mtime: statSync(file).mtime });
  } catch {
    // Ditto.
  }
}

const newer = candidates.filter((entry) => entry.mtime > binaryStat.mtime);
if (newer.length > 0) {
  newer
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 5)
    .forEach((entry) => fail(`source newer than binary: ${entry.path} (${entry.mtime.toISOString()})`));
  fail(`${newer.length} shipped file(s) changed after the binary was built; rebuild before claiming this hash`);
} else {
  console.log(`ok   all ${candidates.length} shipped source roots/files are older than the binary`);
}

if (process.exitCode === undefined) {
  console.log(`\nBuild identity holds: release-${embedded}, no source newer than the binary.`);
}

// DEF-113: a stamp is only truthful if the script that writes it actually runs.
// Cargo re-runs `build.rs` only when a watched input changes, so a rebuild that
// touched only the renderer relinked the binary without re-stamping it and the
// Trust Center reported the previous day. The fix names a path that never exists,
// which makes cargo treat the script as always out of date. This check fails if
// that line is removed - the date would then be stale again on the next
// renderer-only rebuild, and no other check would say so.
try {
  const buildRs = readFileSync("src-tauri/build.rs", "utf8");
  const restamp = buildRs
    .split("\n")
    .some((line) => /rerun-if-changed=FORCE_RESTAMP_EVERY_BUILD/.test(line) && !line.trim().startsWith("//"));
  if (restamp) {
    console.log("ok   build.rs re-stamps on every build (DEF-113)");
  } else {
    fail(
      "build.rs does not force a re-stamp; a renderer-only rebuild would relink the binary " +
        "while keeping yesterday's embedded date (DEF-113)",
    );
  }
} catch {
  fail("cannot read src-tauri/build.rs to verify the re-stamp line (DEF-113)");
}
