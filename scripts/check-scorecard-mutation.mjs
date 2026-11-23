#!/usr/bin/env node
/**
 * Mutation test for `scripts/check-scorecard.mjs` (evidence for DEF-080).
 *
 * A gate that cannot catch the defect it was written for is decoration. This
 * script reintroduces, one at a time, the three ways the scorecard was wrong on
 * 2026-11-21 and asserts the gate rejects each:
 *
 *   1. C10 scored 12 against a criterion worth 6 (the original error).
 *   2. A total that does not equal the sum of its rows (51 where the rows give 45).
 *   3. A withheld point attributed to a criterion that is at full weight.
 *
 * Each mutation is applied to the real file and then undone from the in-memory
 * copy, so the working tree ends byte-identical to how it started. It is not part
 * of `npm run verify` - it rewrites a documentation file mid-run - but it is
 * cheap enough to run by hand before a release, and DEF-080 cites its output.
 *
 * Exit 0 only if the pristine tree passes *and* every mutation is caught.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";

import { restore, snapshot } from "./lib/mutate-restore.mjs";

const TARGET = "docs/10-audit/10-01-scorecard.md";

const runGate = () => {
  try {
    const out = execFileSync("node", ["scripts/check-scorecard.mjs"], { stdio: "pipe" });
    return { ok: true, out: String(out) };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
};

const scenarios = [
  {
    name: "C10 scored 12 against a weight of 6",
    mutate: (text) =>
      text.replace(/^\| C10 \| Delivery & truth \| 6 \| \*\*6\*\* \|/m, "| C10 | Delivery & truth | 6 | **12** |"),
    expect: "exceeds its weight",
  },
  {
    name: "total overstated by six (51 where the rows sum to 45)",
    mutate: (text) =>
      text.replace(/^\| \*\*Total\*\* \| \| \*\*45\*\* \| \*\*98\*\* \|/m, "| **Total** | | **51** | **98** |"),
    expect: "rows sum to 45",
  },
  {
    name: "a withheld point moved onto a criterion at full weight",
    mutate: (text) => text.replace(/^\| [−-]1 \| C5 \|/mu, "| −1 | C9 |"),
    expect: "at full weight",
  },
];

const snap = snapshot(TARGET);
const original = snap.bytes;
let failures = 0;

try {
  // The pristine tree must pass, otherwise the mutations prove nothing.
  const clean = runGate();
  if (clean.ok) {
    console.log("PASS  pristine tree -> gate accepts it");
  } else {
    failures += 1;
    console.log("FAIL  pristine tree -> gate rejects the real file");
    console.log(clean.out.trim());
  }

  for (const { name, mutate, expect } of scenarios) {
    const mutated = mutate(original);
    if (mutated === original) {
      failures += 1;
      console.log(`FAIL  ${name} -> mutation did not apply (the row shape changed)`);
      continue;
    }
    writeFileSync(TARGET, mutated, "utf8");
    const result = runGate();
    const caught = !result.ok && result.out.includes(expect);
    if (caught) {
      console.log(`PASS  ${name} -> gate rejected it ("${expect}")`);
    } else {
      failures += 1;
      console.log(`FAIL  ${name} -> gate did NOT catch it`);
      console.log(result.out.trim().split("\n").slice(-6).join("\n"));
    }
  }
} finally {
  restore(TARGET, snap);
}

// The restore must be byte-exact AND must not move the mtime: this script
// rewrites a file every run, and a gate that perturbs the tree it audits is the
// DEF-087 lesson.
const restored = readFileSync(TARGET, "utf8");
const statAfter = statSync(TARGET);
const contentIdentical = restored === original;
const mtimePreserved = statAfter.mtime.getTime() === snap.mtime.getTime();
if (contentIdentical) {
  console.log("\nrestore: byte-identical");
} else {
  failures += 1;
  console.log("\nrestore: MISMATCH - restore the file from your editor history");
}
if (mtimePreserved) {
  console.log("mtime:   preserved");
} else {
  failures += 1;
  console.log("mtime:   MOVED - the gate perturbed the tree it audits");
}

process.exit(failures ? 1 : 0);
