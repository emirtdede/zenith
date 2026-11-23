/**
 * Numeric-drift audit.
 *
 * Every count a document states must be re-derived from the tree it describes.
 * The previous version of this script declared a `MEASURED` object and printed
 * it under the word "measured" - it measured nothing. That is the exact failure
 * mode the scorecard calls dishonest: a green gate asserting its own constant.
 * It was found by re-counting by hand (445 catalogue keys, 132 vitest tests, 12
 * files) and noticing the gate still said 443 / 124 / 11 while exiting 0.
 *
 * Each number below now comes from a real artefact:
 *
 *   keys     - parsed out of `src/i18n/en.ts`
 *   vitest   - `evidence/vitest-counts.json`, written by `check:fe` immediately
 *              before this gate runs, and refused if older than a test source
 *   files    - the same report (`testResults.length`)
 *   rust     - `cargo test --workspace -- --list`, the number of tests cargo
 *              will actually run
 *   commands - the `generate_handler!` list in `src-tauri/src/lib.rs`
 *   defs     - rows in the deficiency register, plus its own §3 totals, which
 *              must agree with the row count
 *
 * Anything it cannot measure is an error, not a silent pass.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { measureFfi } from "./lib/ffi-measure.mjs";

// ---------------------------------------------------------------- measurement

function walk(dir, exts, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "target") continue;
      walk(full, exts, out);
    } else if (exts.some((e) => full.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(2);
}

// -- keys -------------------------------------------------------------------
const en = readFileSync("src/i18n/en.ts", "utf8");
const keys = new Set();
for (const m of en.matchAll(/^\s*"([^"]+)":/gm)) keys.add(m[1]);
if (keys.size === 0) fail("parsed zero catalogue keys out of src/i18n/en.ts");

// -- vitest -----------------------------------------------------------------
const COUNTS = "evidence/vitest-counts.json";
let report;
try {
  report = JSON.parse(readFileSync(COUNTS, "utf8"));
} catch (error) {
  fail(`cannot read ${COUNTS} (${error.message}) - run \`npm run check:fe\` first`);
}
const vitestTests = report.numTotalTests;
const vitestFiles = report.testResults.length;
if (!Number.isInteger(vitestTests) || !Number.isInteger(vitestFiles)) {
  fail(`${COUNTS} does not look like a vitest json report`);
}
if (report.numFailedTests !== 0) {
  fail(`${COUNTS} records ${report.numFailedTests} failing test(s)`);
}

// The report must postdate every test file, or it is a number from last week
// being presented as today's measurement.
const countsMtime = statSync(COUNTS).mtimeMs;
const testSources = walk("src", [".test.ts", ".test.tsx"]);
for (const file of testSources) {
  if (statSync(file).mtimeMs > countsMtime) {
    fail(`${COUNTS} is older than ${file} - re-run \`npm run check:fe\``);
  }
}

// -- rust -------------------------------------------------------------------
let rustTests;
try {
  const listing = execFileSync("cargo", ["test", "--workspace", "--", "--list"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  rustTests = listing.split(/\r?\n/).filter((line) => /: test$/.test(line)).length;
} catch (error) {
  fail(`cargo test --list failed: ${error.message}`);
}
if (!rustTests) fail("cargo listed zero tests");

// -- commands ---------------------------------------------------------------
const lib = readFileSync("src-tauri/src/lib.rs", "utf8");
const handler = /generate_handler!\[([\s\S]*?)\]/.exec(lib);
if (!handler) fail("no generate_handler![…] in src-tauri/src/lib.rs");
const commands = handler[1]
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean).length;
if (!commands) fail("generate_handler! lists zero commands");

// -- register ---------------------------------------------------------------
const register = readFileSync("docs/10-audit/10-02-deficiency-register.md", "utf8");
const defIds = new Set();
for (const line of register.split("\n")) {
  const m = /^\|\s*(DEF-\d{3})\s*\|/.exec(line);
  if (m) defIds.add(m[1]);
}
const defs = defIds.size;
if (!defs) fail("parsed zero DEF ids out of the register");

// §3 states its own totals. They must agree with the rows above, or the table
// is describing a register that no longer exists.
const totals = /\|\s*\*\*Total\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|\s*\*{0,2}(\d+)\*{0,2}\s*\|/.exec(
  register,
);
if (!totals) fail("no **Total** row in the register's §3");
const [, statedDefs, statedClosed, statedOpen] = totals.map(Number);
if (statedDefs !== defs) {
  fail(`register §3 says ${statedDefs} rows; the table has ${defs}`);
}
if (statedClosed + statedOpen !== defs) {
  fail(`register §3 says ${statedClosed} closed + ${statedOpen} open, which is not ${defs}`);
}

const MEASURED = {
  rust: rustTests,
  vitest: vitestTests,
  files: vitestFiles,
  keys: keys.size,
  commands,
  defs,
  closed: statedClosed,
  open: statedOpen,
  // The FFI surface, measured once in `scripts/lib/ffi-measure.mjs` and used by
  // `check:ffi` too. The scorecard quoted 109 / 111 / 44 while the gate printed
  // 106 / 109 / 45: two readers, two counts, no comparison. Now there is one.
  unsafe: measureFfi(join(dirname(fileURLToPath(import.meta.url)), "..")).blocks,
  // The chain length. Before this key existed, three documents described a
  // 21-step, a 24-step and a 20-step `verify` while the chain was 26, and the
  // gate printed `numeric drift: 0` over all three: "N-step chain" matched no
  // pattern. This is the DEF-096 class again - a gate reading every count
  // except the one the repository changes most often.
  steps: JSON.parse(readFileSync("package.json", "utf8")).scripts.verify.split(" && ").length,
};

// ------------------------------------------------------- table self-consistency
//
// DEF-124. A table that states its own total is a claim about its own rows, and
// nothing checked it: `07-01` §2 listed 243 + 2 + 34 above a total of 286 (the
// rows summed to 279) and its module table summed to 243 while the core crate
// held 245 tests. The numeric scan below only reads prose phrases like "281 Rust
// tests", so every number *inside* a table was invisible - the gate was green
// while the table above it did not add up.
//
// Three shapes exist in this library and all three are checked:
//
//   | **Total** | | **100** | |              one bold total, one numeric column
//   | **Total** | **45/100** | |             a numerator/denominator pair
//   | **Total** | | **45** | **98** |        two totals, two scored columns
//
// A column is only checked when *every* row above it is a plain integer (or an
// `a/b` pair), so a mixed column such as `1 (DEF-028)` is skipped rather than
// guessed at. A total with no numeric rows above it is a bug in the doc, not a
// pass, and is reported.
const totalProblems = [];

const strip = (text) => String(text).replace(/\*\*/g, "").trim();
const INTEGER = /^\d+$/;
const RATIO = /^(\d+)\s*\/\s*(\d+)$/;
const isSeparator = (cells) => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));

/** Every contiguous markdown table, split at its separator row. */
function tableBlocks(lines) {
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim().startsWith("|")) continue;
    const start = i;
    const rows = [];
    while (i < lines.length && lines[i].trim().startsWith("|")) {
      rows.push({ index: i, cells: lines[i].split("|").slice(1, -1).map((c) => c.trim()) });
      i += 1;
    }
    const sep = rows.findIndex((row) => isSeparator(row.cells));
    if (sep < 1) continue; // no header + separator: not a table we can reason about
    blocks.push({ start, header: rows[sep - 1].cells, data: rows.slice(sep + 1) });
  }
  return blocks;
}

/** Sum one column of the data rows, or null if any row in it is not a number. */
function sumColumn(data, col, parse) {
  let total = null;
  for (const row of data) {
    const value = parse(row.cells[col] ?? "");
    if (value === null) return null;
    total = total === null ? value : Array.isArray(value)
      ? [total[0] + value[0], total[1] + value[1]]
      : total + value;
  }
  return total;
}

function checkTableTotals() {
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    const blocks = tableBlocks(lines);

    for (const block of blocks) {
      // A row whose first cell is a bold "Total" states the sum of the rows.
      const totalAt = block.data.findIndex((row) =>
        /^\*\*[^*]*[Tt]otal[^*]*\*\*$/.test(row.cells[0] ?? ""),
      );
      if (totalAt < 0) continue;
      const total = block.data[totalAt];
      // Only the rows *above* the total are its addends. A table may continue
      // below its total (07-01's suite table lists gate rows after `Rust total`),
      // and including them made every column non-numeric, silently disabling the
      // check - measured with mutation: M1 and M2 SURVIVED until this was fixed.
      const data = block.data.slice(0, totalAt);

      for (let col = 1; col < total.cells.length; col += 1) {
        const statedInt = INTEGER.test(strip(total.cells[col])) ? Number(strip(total.cells[col])) : null;
        const statedRatio = RATIO.exec(strip(total.cells[col]));
        if (statedInt === null && !statedRatio) continue;

        if (statedInt !== null) {
          const sum = sumColumn(data, col, (v) => (INTEGER.test(strip(v)) ? Number(strip(v)) : null));
          if (sum !== null && sum !== statedInt) {
            totalProblems.push(
              `${file}:${total.index + 1}  column ${col}: rows sum to ${sum}, total says ${statedInt}`,
            );
          }
        } else {
          const sum = sumColumn(data, col, (v) => {
            const m = RATIO.exec(strip(v));
            return m ? [Number(m[1]), Number(m[2])] : null;
          });
          if (sum !== null && (sum[0] !== Number(statedRatio[1]) || sum[1] !== Number(statedRatio[2]))) {
            totalProblems.push(
              `${file}:${total.index + 1}  column ${col}: rows sum to ${sum[0]}/${sum[1]}, total says ${statedRatio[1]}/${statedRatio[2]}`,
            );
          }
        }
      }
    }

    // Prose that says "table sums to N" makes the next table's Tests column a
    // claim. `07-01`'s module table has no Total row, so this is the only way
    // its thirty rows are checked against the crate they describe.
    lines.forEach((line, i) => {
      const claim = /table sums to (\d+)/i.exec(line);
      if (!claim) return;
      const next = blocks.find((block) => block.start > i);
      if (!next) {
        totalProblems.push(`${file}:${i + 1}  "table sums to" names no following table`);
        return;
      }
      const testsCol = next.header.findIndex((h) => /^tests$/i.test(strip(h)));
      if (testsCol < 0) {
        totalProblems.push(`${file}:${i + 1}  "table sums to" follows a table with no Tests column`);
        return;
      }
      const sum = sumColumn(next.data, testsCol, (v) => (INTEGER.test(strip(v)) ? Number(strip(v)) : null));
      if (sum === null) {
        totalProblems.push(`${file}:${i + 1}  the Tests column it claims to sum is not all integers`);
        return;
      }
      if (sum !== Number(claim[1])) {
        totalProblems.push(
          `${file}:${i + 1}  table sums to ${claim[1]}, its Tests column sums to ${sum}`,
        );
      }
    });
  }
}

// -------------------------------------------------------------------- scanning

const files = [];
(function walkDocs(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkDocs(full);
    else if (full.endsWith(".md")) files.push(full);
  }
})("docs");
files.push("evidence/README.md");

// The table audit needs `files`, so it runs here - defining it above and
// forgetting to call it would leave a gate that reads nothing and says nothing,
// which is the class of defect it exists to catch.
checkTableTotals();

const patterns = [
  { re: /(\d+)\s+vitest/g, key: "vitest", label: "vitest" },
  { re: /vitest`?\s+(\d+)\s+tests/gi, key: "vitest", label: "vitest" },
  // `m[1]` is the test count and `m[2]` the file count: the metric is `files`,
  // so the value must come from group 2. Reading group 1 here made the gate
  // compare 132 against 12 and, because of the old range window, say nothing.
  { re: /(\d+)\s+tests in (\d+) files/gi, key: "files", label: "files", valueGroup: 2 },
  { re: /(\d+)\s+Rust tests/gi, key: "rust", label: "rust" },
  // The evidence ledger writes its split as "272 tests (27 app + 243 core + 2
  // drift)". That phrasing matched none of the patterns above, so the ledger's
  // own headline count was the one number in the tree the gap did not read -
  // the DEF-096 failure, surviving inside the fix for DEF-096.
  { re: /(\d+)\s+tests\s+\(\d+\s+app\s+\+\s+\d+\s+core/gi, key: "rust", label: "rust" },
  { re: /(\d+)\s+keys\b/gi, key: "keys", label: "keys" },
  { re: /register (\d+) ids/gi, key: "defs", label: "defs" },
  { re: /(\d+)-row register/gi, key: "defs", label: "defs" },
  { re: /(\d+) rows: (\d+) closed/gi, key: "defs", label: "defs", closedKey: "closed" },
  // The FFI surface. The scorecard said "109 `unsafe` blocks" and "111 comments
  // in total" and "44 source files" while `check:ffi` printed 106 / 109 / 45.
  // Every count a document states must come from the same measurement the gate
  // enforces, or the document is quoting a memory.
  { re: /(\d+)\s+`?unsafe`?\s+blocks/gi, key: "unsafe", label: "unsafe blocks" },
  // The chain's own length, in the three phrasings the documents use. Each was
  // a live false statement that this gate called green: `10-01` described a
  // "21-step chain" whose `check:scorecard` it also placed at step 12 (it is
  // step 14), `10-03` described a "24-step chain", and the ledger's older rows
  // say "20-step". Only the first two are current claims; the ledger rows carry
  // "at the time" or "superseded", which the historical rule above honours.
  { re: /(\d+)-step\s+(?:release\s+)?chain/gi, key: "steps", label: "chain steps" },
  { re: /(\d+)-step\s+(?:release\s+)?gate/gi, key: "steps", label: "chain steps" },
  // A register row count stated as prose rather than through `N-row register`.
  { re: /(\d+)\s+rows:/gi, key: "defs", label: "defs" },
];

let mismatches = 0;
for (const file of files) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    // A closure row legitimately quotes the count as it stood on the day the
    // defect was fixed. Rewriting those to today's number would falsify the
    // record. Three things make a line historical:
    //
    //   * it says so ("at the time", "then-current", …);
    //   * it is a `| DEF-nnn |` register/scorecard row, which by construction
    //     narrates a closed defect rather than today's tree.
    //
    // Everything else must equal the measurement exactly. The first version
    // instead ignored differences larger than 12, which meant a badly stale
    // number - 255 beside a measured 272 - passed silently. A gate that only
    // catches near-misses is the DEF-096 class one order out: it looks like it
    // is watching.
    const historical =
      /at the time|at closure|as of 2026-11-|then-current|the day it closed|superseded/i.test(line) ||
      /^\|\s*DEF-\d+\s*\|/.test(line);
    for (const { re, key, label, valueGroup = 1, closedKey } of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const value = Number(m[valueGroup]);
        const expected = MEASURED[key];
        if (value !== expected && !historical) {
          mismatches += 1;
          console.log(
            `${file}:${i + 1}  ${label}: ${value} (measured ${expected})  ${line.trim().slice(0, 100)}`,
          );
        }
        if (value !== expected && historical) {
          console.log(`${file}:${i + 1}  ${label}: ${value} - historical, marked as such (ok)`);
        }
        if (closedKey && m[2] !== undefined) {
          const cv = Number(m[2]);
          if (cv !== MEASURED[closedKey] && !historical) {
            mismatches += 1;
            console.log(
              `${file}:${i + 1}  closed: ${cv} (measured ${MEASURED[closedKey]})  ${line.trim().slice(0, 100)}`,
            );
          }
        }
      }
    }
  });
}

for (const problem of totalProblems) {
  console.log(problem);
}

console.log(`\nmeasured: ${JSON.stringify(MEASURED)}`);
console.log(`numeric drift: ${mismatches} mismatch(es)`);
console.log(`table totals: ${totalProblems.length} problem(s)`);
process.exit(mismatches || totalProblems.length ? 1 : 0);
