import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";

import { restore, snapshot } from "./lib/mutate-restore.mjs";

/**
 * Mutation test for the eight-band check added to `check-scorecard.mjs`.
 *
 * DEF-084 was the owner's bands printed as "51/100" when the weights sum to 110.
 * This reintroduces each way that can go wrong and asserts the gate rejects it,
 * restoring the file byte-identically afterwards.
 */
const TARGET = "docs/10-audit/10-01-scorecard.md";

const runGate = () => {
  try {
    execFileSync("node", ["scripts/check-scorecard.mjs"], { stdio: "pipe" });
    return { ok: true, out: "" };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
};

const scenarios = [
  {
    name: "owner bands quoted as 51/100 (the original DEF-084 denominator error)",
    mutate: (t) =>
      t.replace(
        "**51/110, which normalises to 46.4/100**",
        "**51/100**",
      ),
    expect: "normalise",
  },
  {
    name: "weights claimed as 100 when they sum to 110",
    mutate: (t) => t.replace("weights sum to **110**, not 100", "weights sum to **100**, not 100"),
    expect: "owner bands",
  },
  {
    name: "the derived gap overstated (six points instead of 1.4)",
    mutate: (t) => t.replace("within **1.4 points**", "within **6.0 points**"),
    expect: "agree within",
  },
  {
    name: "raw score no longer stated as raw points",
    mutate: (t) => t.replace("awarded **51 raw points**", "awarded **51**"),
    expect: "raw score",
  },
];

const snap = snapshot(TARGET);
const original = snap.bytes;
let failures = 0;

try {
  const clean = runGate();
  if (clean.ok) console.log("PASS  pristine tree -> gate accepts it");
  else {
    failures += 1;
    console.log("FAIL  pristine tree -> gate rejects the real file");
    console.log(clean.out.trim());
  }

  for (const { name, mutate, expect } of scenarios) {
    const mutated = mutate(original);
    if (mutated === original) {
      failures += 1;
      console.log(`FAIL  ${name} -> mutation did not apply`);
      continue;
    }
    writeFileSync(TARGET, mutated, "utf8");
    const result = runGate();
    const caught = !result.ok && result.out.includes(expect);
    if (caught) console.log(`PASS  ${name} -> rejected ("${expect}")`);
    else {
      failures += 1;
      console.log(`FAIL  ${name} -> gate did NOT catch it`);
      console.log(result.out.trim().split("\n").slice(-5).join("\n"));
    }
  }
} finally {
  restore(TARGET, snap);
}

const restored = readFileSync(TARGET, "utf8");
const statAfter = statSync(TARGET);
const contentIdentical = restored === original;
const mtimePreserved = statAfter.mtime.getTime() === snap.mtime.getTime();
// A gate that rewrites a file must leave it exactly as found - bytes *and*
// mtime. Restoring only content is what broke the build-chain timestamp check
// in the focus-trap gate (DEF-087), and the same rule applies here.
if (contentIdentical) {
  console.log("\nrestore: byte-identical");
} else {
  failures += 1;
  console.log("\nrestore: MISMATCH");
}
if (mtimePreserved) {
  console.log("mtime:   preserved");
} else {
  failures += 1;
  console.log("mtime:   MOVED - the gate perturbed the tree it audits");
}

process.exit(failures ? 1 : 0);
