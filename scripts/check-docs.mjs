// Documentation integrity sweep.
//
// Four families of check, all of which have failed in real document sets:
//
//   1. structure  - every document has its header keys, every relative link
//                   resolves, no U+FFFD from a bad encoding round-trip;
//   2. closure    - every DEFINED requirement (REQ-F, REQ-N) appears in the
//                   traceability matrix, and every row cites a requirement the
//                   SRS defines (a matrix that drifts is worse than none);
//   3. tests      - every `T-*` id cited in the matrix exists in the test plan,
//                   either literally or inside a declared range (`T-WIN-01..12`);
//   4. register   - every cited DEF id is defined in the deficiency register.
//
// Run: `node scripts/check-docs.mjs`
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const files = walk("docs").filter((f) => f.endsWith(".md"));
const problems = [];
let lines = 0;
let words = 0;
let links = 0;

for (const file of files) {
  const text = readFileSync(file, "utf8");
  lines += text.split("\n").length;
  words += text.split(/\s+/).filter(Boolean).length;

  if (text.includes("\uFFFD")) problems.push(`FFFD ${basename(file)}`);

  if (!file.endsWith("README.md")) {
    const head = text.slice(0, 1800);
    for (const key of ["Document ID", "Version", "Owner", "Closes"]) {
      if (!head.includes(key)) problems.push(`HEADER ${basename(file)} missing ${key}`);
    }
  }

  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^(https?:|#|mailto:)/.test(target)) continue;
    links += 1;
    const resolved = resolve(dirname(file), target.split("#")[0]);
    if (!existsSync(resolved)) problems.push(`LINK ${basename(file)} -> ${target}`);
  }
}

// ---------------------------------------------------------------- requirements
const srsFunctional = readFileSync("docs/02-requirements/02-01-srs-functional.md", "utf8");
const srsNonfunctional = readFileSync("docs/02-requirements/02-02-srs-nonfunctional.md", "utf8");
const matrixPath = "docs/02-requirements/02-03-traceability-matrix.md";
const matrix = readFileSync(matrixPath, "utf8");
const plan = readFileSync("docs/07-quality/07-01-test-plan.md", "utf8");

/** Ids that appear at the start of a table row, i.e. are being defined. */
function definedRequirements(source, prefix) {
  const ids = new Set();
  const re = new RegExp(`^\\|\\s*(${prefix}-\\d+)\\s*\\|`, "gm");
  for (const match of source.matchAll(re)) ids.add(match[1]);
  return ids;
}

const functional = definedRequirements(srsFunctional, "REQ-F");
const nonfunctional = definedRequirements(srsNonfunctional, "REQ-N");
const matrixFunctional = definedRequirements(matrix, "REQ-F");
const matrixNonfunctional = definedRequirements(matrix, "REQ-N");

for (const id of functional) {
  if (!matrixFunctional.has(id)) problems.push(`TRACE ${id} defined but not in 02-03`);
}
for (const id of nonfunctional) {
  if (!matrixNonfunctional.has(id)) problems.push(`TRACE ${id} defined but not in 02-03`);
}
for (const id of matrixFunctional) {
  if (!functional.has(id)) problems.push(`TRACE ${id} in 02-03 but not defined in 02-01`);
}
for (const id of matrixNonfunctional) {
  if (!nonfunctional.has(id)) problems.push(`TRACE ${id} in 02-03 but not defined in 02-02`);
}

// A functional row must name a test; a non-functional row must name evidence.
const matrixSection2 = matrix.slice(
  matrix.indexOf("## 2. Functional"),
  matrix.indexOf("## 3. Non-functional"),
);
for (const match of matrixSection2.matchAll(/^\|\s*(REQ-F-\d+)\s*\|([^|]*)\|([^|]*)\|/gm)) {
  if (!/T-[A-Z][A-Z0-9]*-\d+/.test(match[3])) {
    problems.push(`TRACE ${match[1]} has no test id in 02-03`);
  }
}

// ---------------------------------------------------------------- test ids
const testIds = new Set([...plan.matchAll(/T-[A-Z][A-Z0-9]*-\d+/g)].map((m) => m[0]));
const ranges = [...plan.matchAll(/T-([A-Z][A-Z0-9]*)-(\d+)\.\.(\d+)/g)].map((m) => ({
  family: m[1],
  from: Number(m[2]),
  to: Number(m[3]),
}));

function isDefinedTest(id) {
  if (testIds.has(id)) return true;
  const match = /^T-([A-Z][A-Z0-9]*)-(\d+)$/.exec(id);
  if (!match) return false;
  const n = Number(match[2]);
  return ranges.some((r) => r.family === match[1] && n >= r.from && n <= r.to);
}

const citedTests = new Set([...matrix.matchAll(/T-[A-Z][A-Z0-9]*-\d+/g)].map((m) => m[0]));
for (const id of citedTests) {
  if (!isDefinedTest(id)) problems.push(`TEST ${id} cited in 02-03 but absent from 07-01`);
}

// ---------------------------------------------------------------- DEF register
const register = readFileSync("docs/10-audit/10-02-deficiency-register.md", "utf8");
const defined = new Set([...register.matchAll(/DEF-\d{3}/g)].map((m) => m[0]));
const cited = new Set();
for (const file of files) {
  for (const match of readFileSync(file, "utf8").matchAll(/DEF-\d{3}/g)) cited.add(match[0]);
}
const undefinedIds = [...cited].filter((id) => !defined.has(id));
for (const id of undefinedIds) problems.push(`DEF ${id} cited but not defined`);

console.log(
  `docs ${files.length} | lines ${lines} | words ${words} | links ${links} | DEF ${defined.size}/${cited.size} | REQ-F ${matrixFunctional.size}/${functional.size} | REQ-N ${matrixNonfunctional.size}/${nonfunctional.size} | tests ${citedTests.size}`,
);
console.log(`problems: ${problems.length ? "" : "none"}`);
for (const problem of problems) console.log(`  - ${problem}`);
process.exit(problems.length ? 1 : 0);
