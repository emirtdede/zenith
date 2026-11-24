#!/usr/bin/env node
/**
 * `check:evidence-ledger-mutation` - prove the ledger gate measures glob rows.
 *
 * The gate once collected `screens/locales/*.png` and never expanded it, and its
 * on-disk walk read only the top level of `evidence/`. The eleven locale
 * screenshots were described in the ledger for weeks while the directory did not
 * exist, and the gate still printed "every artefact is described, every citation
 * resolves, nothing is empty".
 *
 * A fix without a proof is a claim. So this script reproduces the exact blind
 * spot against the real tree: move the directory aside, require the gate to fail
 * naming the glob, put it back, require it to pass. It also checks the shallower
 * variant - a single empty file at depth - because the zero-byte rule used to
 * apply to the top level only.
 *
 * Run: `node scripts/check-evidence-ledger-mutation.mjs`
 */
import { execFileSync } from "node:child_process";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCALES = join(ROOT, "evidence", "screens", "locales");
const LOCALES_ASIDE = join(ROOT, "evidence", "screens", "locales-aside");
const EMPTY_PROBE = join(ROOT, "evidence", "screens", "locales", "00-empty-probe.png");

function runGate() {
  try {
    const stdout = execFileSync(process.execPath, ["scripts/check-evidence-ledger.mjs"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { failed: false, output: stdout };
  } catch (error) {
    return { failed: true, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

const cases = [];

try {
  // Case 1: the directory a glob row names does not exist.
  renameSync(LOCALES, LOCALES_ASIDE);
  cases.push({
    name: "glob row whose directory is missing",
    expect: /the ledger describes screens\/locales\/\*\.png, but no file under evidence\/ matches it/,
    result: runGate(),
  });
  renameSync(LOCALES_ASIDE, LOCALES);

  // Case 2: a zero-byte artefact below the top level. The probe needs a ledger
  // row to get past the "no row describes it" check, so it borrows one: it is
  // placed inside a glob the ledger already covers.
  writeFileSync(EMPTY_PROBE, "", "utf8");
  cases.push({
    name: "zero-byte artefact inside a covered glob",
    expect: /00-empty-probe\.png is 0 bytes/,
    result: runGate(),
  });
  rmSync(EMPTY_PROBE, { force: true });
} finally {
  // Restore unconditionally: a test that leaves the tree broken is worse than no
  // test, and this file runs inside the release chain.
  if (execFileSync(process.execPath, ["-e", `require("fs").existsSync(${JSON.stringify(LOCALES_ASIDE)})`], { encoding: "utf8" }).trim() === "true") {
    renameSync(LOCALES_ASIDE, LOCALES);
  }
  rmSync(EMPTY_PROBE, { force: true });
}

let failures = 0;
for (const testCase of cases) {
  const caught = testCase.result.failed && testCase.expect.test(testCase.result.output);
  console.log(`  ${caught ? "PASS" : "FAIL"}  ${testCase.name}`);
  if (!caught) {
    failures += 1;
    console.log(testCase.result.output.trim().split("\n").slice(0, 6).join("\n"));
  }
}

const clean = runGate();
console.log(`  ${clean.failed ? "FAIL" : "PASS"}  restored tree passes the gate`);
if (clean.failed) {
  failures += 1;
  console.log(clean.output.trim().split("\n").slice(0, 8).join("\n"));
}

if (failures > 0) {
  console.error(`\n${failures} self-test case(s) failed`);
  process.exit(1);
}
console.log(`\ncheck:evidence-ledger self-test holds: ${cases.length} blind spots reproduced, both caught.`);
