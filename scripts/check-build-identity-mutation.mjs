#!/usr/bin/env node
/**
 * Mutation gate for `check-build-identity.mjs` (DEF-092).
 *
 * The rule this repository holds itself to: a green gate is not evidence that
 * the gate works. `check-scorecard-mutation.mjs`, `check-bands-mutation.mjs` and
 * `check-focus-trap-mutation.mjs` already exist for that reason; this is the
 * fourth. It proves the build-identity gate fails on the *original* defect and
 * on both of its other two claims.
 *
 * Three mutations, each isolated, each restored byte-for-byte **and**
 * mtime-for-mtime (`scripts/lib/mutate-restore.mjs`): a gate that audits the
 * tree must not perturb the tree.
 *
 *   M1  stale date      - give a copy of the binary an mtime a day later than
 *                         the date it embeds. This is DEF-092 exactly: a binary
 *                         rebuilt after its identity was stamped.
 *   M2  stale source    - touch a shipped source file so it is newer than the
 *                         binary. The hash in `08-02` would then describe code
 *                         that is no longer in the tree.
 *   M3  no marker       - strip every `release-YYYYMMDD` marker from a copy.
 *                         The Trust Center then has nothing truthful to show.
 *
 * M1 and M3 use a scratch copy via `ZENITH_BINARY`, so the real artefact is
 * never touched. M2 must touch a real source file to be meaningful.
 */
import { copyFileSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { restore, snapshot } from "./lib/mutate-restore.mjs";

const GATE = "scripts/check-build-identity.mjs";
const BINARY = "target/release/zenith.exe";
const SCRATCH = join(tmpdir(), "zenith-build-identity-mutation");

/** Run the gate, returning { code, out }. */
function runGate(env = {}) {
  try {
    const out = execFileSync(process.execPath, [GATE], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { code: 0, out };
  } catch (error) {
    return {
      code: typeof error.status === "number" ? error.status : 1,
      out: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

let failures = 0;

function expectBaseline() {
  const result = runGate();
  if (result.code !== 0) {
    console.error(`FAIL baseline is not green (exit ${result.code}):\n${result.out}`);
    failures += 1;
    return false;
  }
  console.log("ok   baseline: gate passes on the shipped artefact");
  return true;
}

function expectFail(label, result, needle) {
  if (result.code !== 1) {
    console.error(`FAIL ${label}: expected exit 1, got ${result.code}\n${result.out}`);
    failures += 1;
    return;
  }
  if (!result.out.includes(needle)) {
    console.error(`FAIL ${label}: exit 1 but message did not name the cause (wanted "${needle}")\n${result.out}`);
    failures += 1;
    return;
  }
  console.log(`ok   ${label}: fails loudly and names the cause`);
}

if (!expectBaseline()) {
  console.error("\nCannot mutate a gate that is not green to begin with.");
  process.exit(1);
}

mkdirSync(SCRATCH, { recursive: true });

// ---------------------------------------------------------------- M1: stale date
{
  const copy = join(SCRATCH, "stale-date.exe");
  copyFileSync(BINARY, copy);
  const stat = statSync(copy);
  // One day later than the embedded marker's date.
  const later = new Date(stat.mtime.getTime() + 24 * 60 * 60 * 1000);
  utimesSync(copy, later, later);

  const result = runGate({ ZENITH_BINARY: copy });
  expectFail("M1 stale build date", result, "does not match the binary's modification date");

  const restored = restoreMtime(copy);
  if (!restored) {
    failures += 1;
  }
}

// --------------------------------------------------------------- M2: stale source
{
  const target = "src/main.tsx";
  const snap = snapshot(target);
  const binaryMtime = statSync(BINARY).mtime;
  const future = new Date(binaryMtime.getTime() + 60 * 60 * 1000);
  utimesSync(target, future, future);

  const result = runGate();
  expectFail("M2 source newer than binary", result, "changed after the binary was built");

  const { contentIdentical, mtimePreserved } = restore(target, snap);
  if (!contentIdentical || !mtimePreserved) {
    console.error(
      `FAIL M2 restore: content=${contentIdentical} mtime=${mtimePreserved} - the gate perturbed the tree`,
    );
    failures += 1;
  } else {
    console.log("ok   M2 restore: bytes and mtime identical");
  }
}

// ---------------------------------------------------------------- M3: no marker
{
  const copy = join(SCRATCH, "no-marker.exe");
  const bytes = readFileSync(BINARY);
  const text = bytes.toString("latin1");
  // Overwrite each digit of every marker with 'x' so the pattern cannot match.
  let mutated = text;
  for (const match of text.matchAll(/release-\d{8}/g)) {
    const at = match.index ?? 0;
    mutated = mutated.slice(0, at) + "release-xxxxxxxx" + mutated.slice(at + match[0].length);
  }
  writeFileSync(copy, Buffer.from(mutated, "latin1"));
  const stat = statSync(BINARY);
  utimesSync(copy, stat.atime, stat.mtime);

  const result = runGate({ ZENITH_BINARY: copy });
  expectFail("M3 no build marker", result, "no release-YYYYMMDD marker");

  restoreMtime(copy);
}

function restoreMtime(path) {
  try {
    const stat = statSync(BINARY);
    utimesSync(path, stat.atime, stat.mtime);
    return true;
  } catch {
    return false;
  }
}

// The baseline must be green again: a mutation gate that leaves the tree in a
// failing state is worse than no gate.
const after = runGate();
if (after.code !== 0) {
  console.error(`FAIL tree not restored: gate now exits ${after.code}\n${after.out}`);
  failures += 1;
} else {
  console.log("ok   tree restored: gate green again");
}

if (failures > 0) {
  console.error(`\n${failures} mutation expectation(s) failed.`);
  process.exit(1);
}
console.log("\nBuild-identity gate bites on all three claims, and restores the tree.");
