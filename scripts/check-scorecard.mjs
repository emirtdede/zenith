#!/usr/bin/env node
/**
 * Scorecard arithmetic gate (`10-01` §2/§3, `10-02` §3).
 *
 * Why this exists: on 2026-11-21 the scorecard shipped a total of 51 that its
 * own rows could not produce. §2 scored C10 as `12/6` - double its weight - and
 * the prose beneath claimed the total was "the sum with C10 capped at its
 * weight". Capping gives 45, not 51. Every other gate was green, because no
 * gate read the scorecard as arithmetic; `check-docs` only verifies that DEF
 * and REQ ids resolve. A document whose central claim does not add up is the
 * one defect a documentation score cannot survive, so it is now a machine gate.
 *
 * What it asserts:
 *   1. The rubric weights in §1 sum to 100.
 *   2. §3 has exactly one row per criterion C1…C10.
 *   3. No score exceeds its criterion's weight (in either column).
 *   4. The `Total` row equals the sum of the rows, for v1 and v2.
 *   5. Every point withheld in §3.2 lands on a criterion that is actually below
 *      its weight, and the number of withheld points equals the total shortfall.
 *   6. `10-02` §3 totals match the register's own rows: count, closed + open,
 *      and the sequence of ids has no gap.
 *   7. Any "admitted-open" figure quoted in the scorecard agrees with `10-02`.
 *   8. The owner's eight-band assessment is reported against its *real*
 *      denominator (110, not 100) and every figure derived from it matches.
 *
 * Exit 0 when the documents are arithmetically consistent; 1 with a list of
 * disagreements otherwise. It reads files only - it never writes.
 */

import { readFileSync } from "node:fs";

const SCORECARD = "docs/10-audit/10-01-scorecard.md";
const REGISTER = "docs/10-audit/10-02-deficiency-register.md";

const problems = [];
const fail = (msg) => problems.push(msg);

const scorecard = readFileSync(SCORECARD, "utf8");
const register = readFileSync(REGISTER, "utf8");
const scoreLines = scorecard.split("\n");

// ---------------------------------------------------------------- 1. weights
// §1 table: | C1 | Requirements engineering | 12 | ... |
const weights = new Map();
for (const line of scoreLines) {
  const m = line.match(/^\| (C\d+) \| [^|]+ \| (\d+) \| [^|]*\|?\s*$/);
  if (m && !line.includes("**")) weights.set(m[1], Number(m[2]));
}
// §1 is the first table with exactly ten C-rows; §3 has two number columns and
// matches a different shape, so it cannot collide with this one.
if (weights.size !== 10) {
  fail(`§1 declares ${weights.size} weighted criteria, expected 10`);
}
const weightSum = [...weights.values()].reduce((a, b) => a + b, 0);
if (weightSum !== 100) fail(`§1 weights sum to ${weightSum}, expected 100`);

// ------------------------------------------------------------- 2. score rows
// §3 table: | C1 | Requirements | 5 | **12** | evidence |  (note: no leading #)
const rows = new Map();
for (const line of scoreLines) {
  const m = line.match(/^\| (C\d+) \| [^|]+ \| (\d+) \| \*\*(\d+)\*\* \|/);
  if (m) rows.set(m[1], { v1: Number(m[2]), v2: Number(m[3]) });
}
if (rows.size !== 10) fail(`§3 scores ${rows.size} criteria, expected 10`);
for (const c of weights.keys()) {
  if (!rows.has(c)) fail(`§3 has no score row for ${c}`);
}

// ------------------------------------------------- 3. no score over its weight
let v1Sum = 0;
let v2Sum = 0;
for (const [c, weight] of weights) {
  const row = rows.get(c);
  if (!row) continue;
  v1Sum += row.v1;
  v2Sum += row.v2;
  if (row.v2 > weight) fail(`${c} v2 score ${row.v2} exceeds its weight ${weight}`);
  if (row.v1 > weight) fail(`${c} v1 score ${row.v1} exceeds its weight ${weight}`);
}

// ------------------------------------------------------- 4. totals must add up
// §1's Total row carries a single number (the weight total). §3's carries two
// (v1 and v2), so the two are distinguishable by shape rather than by position.
const totalLine = scoreLines.find((l) => {
  if (!/^\| \*\*Total\*\* \| \|/.test(l)) return false;
  return [...l.matchAll(/\*\*(\d+)\*\*/g)].length === 2;
});
if (!totalLine) {
  fail("§3 has no Total row with two numbers (v1 and v2)");
} else {
  const m = totalLine.match(/\*\*(\d+)\*\* \| \*\*(\d+)\*\*/);
  if (!m) {
    fail(`§3 Total row is unreadable: ${totalLine.slice(0, 90)}`);
  } else {
    const [, statedV1, statedV2] = m.map(Number);
    if (statedV1 !== v1Sum) {
      fail(`§3 Total says v1 = ${statedV1}, but the rows sum to ${v1Sum}`);
    }
    if (statedV2 !== v2Sum) {
      fail(`§3 Total says v2 = ${statedV2}, but the rows sum to ${v2Sum}`);
    }
  }
}

// ------------------------------------------------------- 5. withheld == shortfall
const shortfall = new Map();
for (const [c, weight] of weights) {
  const row = rows.get(c);
  if (!row) continue;
  const loss = weight - row.v2;
  if (loss > 0) shortfall.set(c, loss);
}
const shortfallTotal = [...shortfall.values()].reduce((a, b) => a + b, 0);

// §3.2 table: | −1 | C7 | reason | DEF-… |
const withheld = [];
for (const line of scoreLines) {
  const m = line.match(/^\| [−-](\d+) \| (C\d+)[^|]*\|/u);
  if (m) withheld.push({ points: Number(m[1]), criterion: m[2] });
}
const withheldTotal = withheld.reduce((a, w) => a + w.points, 0);
if (withheldTotal !== shortfallTotal) {
  fail(
    `§3.2 withholds ${withheldTotal} point(s) but the §3 table is ${shortfallTotal} point(s) short`,
  );
}
for (const w of withheld) {
  if (!shortfall.has(w.criterion)) {
    fail(
      `§3.2 withholds a point on ${w.criterion}, but that criterion is at full weight in §3`,
    );
  }
}

// ------------------------------------------------------------- 6. register maths
let section = "";
const regRows = [];
const regLines = register.split("\n");
regLines.forEach((line, i) => {
  const heading = line.match(/^##\s+(.*)$/);
  if (heading) section = heading[1].trim();
  const m = line.match(/^\| (DEF-\d{3}) \|/);
  // §4 restates the open blockers for the reader's convenience; those rows are
  // commentary on rows that already exist in §1/§2, not additional defects.
  if (m && !/^4\./.test(section)) regRows.push({ id: m[1], line: i + 1 });
});

const ids = regRows.map((r) => r.id);
const distinct = [...new Set(ids)];
if (distinct.length !== ids.length) {
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  fail(`register repeats ${[...new Set(dupes)].join(", ")} as a defect row in §1/§2`);
}

const nums = distinct.map((d) => Number(d.slice(4))).sort((a, b) => a - b);
for (let n = nums[0]; n <= nums[nums.length - 1]; n += 1) {
  if (!nums.includes(n)) fail(`register skips DEF-${String(n).padStart(3, "0")}`);
}

const totalsRow = regLines.find((l) => /^\| \*\*Total\*\* \|/.test(l));
if (!totalsRow) {
  fail("`10-02` §3 has no Total row");
} else {
  // | **Total** | **79** | **70** | **9** | splits to
  // ["", "**Total**", "**79**", "**70**", "**9**", ""] - skip the label cell too.
  const [, , stated, closed, open] = totalsRow.split("|").map((s) => s.trim());
  const t = Number(stated.replace(/\*/g, ""));
  const c = Number(closed.replace(/\*/g, ""));
  const o = Number(open.replace(/\*/g, ""));
  if (t !== distinct.length) {
    fail(`register Total says ${t}, but ${distinct.length} distinct ids exist`);
  }
  if (c + o !== t) fail(`register closed ${c} + open ${o} != total ${t}`);
  if (o !== 9) fail(`register reports ${o} open; the ledger admits 9`);

  // 7. Any "N admitted-open" claim in the scorecard must agree.
  const quoted = scorecard.match(/(\d+)\s+admitted-open/);
  if (quoted && Number(quoted[1]) !== o) {
    fail(`scorecard says ${quoted[1]} admitted-open, register says ${o}`);
  }
}

// ------------------------------------------------- 8. the owner's eight bands
// DEF-084: the owner's eight-band assessment was printed as "51/100" while its
// weights sum to 110, and a derived comparison subtracted it from a /100 figure.
// Parse the bands from the prose and assert the denominator and normalisation
// are the ones actually written - so the same category error cannot recur.
//
// Prose wraps at 100 columns, so match against whitespace-collapsed text: the
// paragraph is one logical sentence, and a gate that breaks when a line is
// re-wrapped is a gate that will be "fixed" by loosening it later.
const flat = scorecard.replace(/\s+/g, " ");
const bandsMatch = flat.match(
  /eight bands whose weights sum to \*\*(\d+)\*\*, not 100 \(vision (\d+)\/(\d+), architecture (\d+)\/(\d+), Rust\/Win32 (\d+)\/(\d+), security (\d+)\/(\d+), completeness (\d+)\/(\d+), i18n (\d+)\/(\d+), UI (\d+)\/(\d+), docs\/tests\/ops (\d+)\/(\d+)\)/,
);

if (!bandsMatch) {
  fail("§2's owner-band paragraph is not in the shape this gate reads (bands and weights)");
} else {
  const n = bandsMatch.slice(1).map(Number);
  const statedWeightSum = n[0];
  const scores = [n[1], n[3], n[5], n[7], n[9], n[11], n[13], n[15]];
  const weights = [n[2], n[4], n[6], n[8], n[10], n[12], n[14], n[16]];

  const realWeightSum = weights.reduce((a, b) => a + b, 0);
  const rawScore = scores.reduce((a, b) => a + b, 0);

  if (realWeightSum !== statedWeightSum) {
    fail(`owner bands: prose says weights sum to ${statedWeightSum}, they sum to ${realWeightSum}`);
  }
  if (realWeightSum === 100) {
    fail("owner bands now sum to 100 - the 51/110 correction and its prose need revisiting");
  }

  const normalised = (rawScore / realWeightSum) * 100;
  // The document must quote 51 raw and 46.4 normalised; both are checkable.
  if (!new RegExp(`\\b${rawScore} raw points\\b`).test(scorecard)) {
    fail(`§2 does not state the owner's raw score (${rawScore}) as "raw points"`);
  }

  // Bind the denominator to *this* sentence. An earlier version of this check
  // scanned the whole file for the first `x.x/100`, which the header row
  // satisfies - so a mutated "51/100" in the paragraph itself went uncaught
  // (proved by mutation). The claim has a fixed shape; require that shape.
  const normClaim = flat.slice(bandsMatch.index).match(
    /but it is \*\*(\d+)\/(\d+), which normalises to (\d+\.\d+)\/100\*\*/,
  );
  if (!normClaim) {
    fail(
      `§2 does not state the owner's total as "**${rawScore}/${realWeightSum}, which normalises to ` +
        `${normalised.toFixed(1)}/100**" - the denominator must name the real weight sum`,
    );
  } else {
    const [, num, den, norm] = normClaim;
    if (Number(num) !== rawScore) {
      fail(`§2 says the owner scored ${num}, the bands sum to ${rawScore}`);
    }
    if (Number(den) !== realWeightSum) {
      fail(`§2 divides the owner's score by ${den}, the weights sum to ${realWeightSum}`);
    }
    if (Math.abs(Number(norm) - normalised) > 0.05) {
      fail(`§2 says the bands normalise to ${norm}, they give ${normalised.toFixed(1)}`);
    }
  }

  // The derived claim must describe the honest gap, not a cross-denominator
  // subtraction. v1Sum is this library's own /100 score for the same artefact.
  const gap = Math.abs(normalised - v1Sum);
  if (!new RegExp(`within \\*\\*${gap.toFixed(1)} points\\*\\*`).test(scorecard)) {
    fail(
      `§2 should state the two assessments agree within ${gap.toFixed(1)} points ` +
        `(|${normalised.toFixed(1)} - ${v1Sum}|); it does not`,
    );
  }
}

// ------------------------------------------------------------------- report
const rubric = [...weights.entries()].map(([c, w]) => `${c}/${w}`).join(" ");
console.log(`rubric:   ${rubric}`);
console.log(`weights:  ${weightSum}`);
console.log(`v1 total: ${v1Sum}  v2 total: ${v2Sum}`);
console.log(
  `shortfall: ${shortfallTotal} (${
    [...shortfall].map(([c, l]) => `${c}-${l}`).join(", ") || "none"
  }) | withheld: ${withheldTotal} (${
    withheld.map((w) => `${w.criterion}-${w.points}`).join(", ") || "none"
  })`,
);
console.log(`register: ${distinct.length} ids, ${nums[0]}..${nums[nums.length - 1]}`);

if (problems.length) {
  console.error("\nproblems:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\nScorecard arithmetic holds: rows sum to the stated totals, every withheld point maps");
console.log("to a real shortfall, and the register totals match its own rows.");
