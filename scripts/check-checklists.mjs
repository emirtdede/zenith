/**
 * `check:checklists` - the two release checklists must be well-formed tables.
 *
 * Why this exists: while assembling the 1.0.0 checklists, the same defect landed
 * twice in different shapes. Once two rows were joined onto one line (G-55 and
 * G-56), and once a row lost its trailing pipe. Both rendered as a table, both
 * were readable by eye, and both silently removed a requirement from the count:
 * the first made 66 rows look like 65, the second made 66 look like 65 again
 * while the summary table still said 66.
 *
 * A checklist whose row count is a lie is worse than one with a missing row,
 * because the summary keeps asserting completeness. So the table shape is
 * measured here rather than trusted:
 *
 *   1. every requirement line has exactly five cells and is closed by a pipe;
 *   2. ids run 1..N with no gap and no duplicate;
 *   3. every row's verdict starts with PASS or FAIL, so no row is undecided;
 *   4. the summary's Requirement rows / PASS / FAIL equal the measured counts;
 *   5. every FAIL row in section 7.1's register also appears in the body.
 *
 * Run: `node scripts/check-checklists.mjs`
 */
import { readFileSync } from "node:fs";

const problems = [];

const CHECKLISTS = [
  { path: "docs/11-release/11-02-github-checklist.md", prefix: "G", label: "GitHub" },
  { path: "docs/11-release/11-03-store-checklist.md", prefix: "M", label: "Store" },
];

for (const checklist of CHECKLISTS) {
  const text = readFileSync(checklist.path, "utf8");
  const summaryAt = text.indexOf("## 7. Summary");
  if (summaryAt === -1) {
    problems.push(`${checklist.path}: no "## 7. Summary" section`);
    continue;
  }
  const body = text.slice(0, summaryAt);
  const summary = text.slice(summaryAt);

  const rows = [];
  for (const line of body.split("\n")) {
    if (!new RegExp(`^\\| ${checklist.prefix}-\\d+ \\|`).test(line)) continue;

    const id = line.slice(2, line.indexOf(" |")).trim();

    if (!line.trimEnd().endsWith("|")) {
      problems.push(`${checklist.path}: ${id} has no closing pipe, so the table loses a cell`);
      continue;
    }

    const cells = line.trimEnd().slice(1, -1).split(" | ");
    if (cells.length !== 5) {
      problems.push(`${checklist.path}: ${id} has ${cells.length} cells, expected 5`);
      continue;
    }

    const result = cells[4];
    if (!/^(PASS|FAIL)\b/.test(result)) {
      problems.push(`${checklist.path}: ${id} verdict does not start with PASS or FAIL: "${result.slice(0, 40)}"`);
      continue;
    }

    // A cell that itself contains an unescaped pipe also fractures the row, and
    // the count check above cannot see it because the split already re-paired.
    if (cells.some((cell) => /(^|[^\\])\|/.test(cell))) {
      problems.push(`${checklist.path}: ${id} has a pipe inside a cell; escape it as \\|`);
    }

    rows.push({ id, verdict: result.startsWith("PASS") ? "PASS" : "FAIL" });
  }

  if (rows.length === 0) {
    problems.push(`${checklist.path}: no requirement rows found`);
    continue;
  }

  // ids contiguous from 1
  const numbers = rows.map((row) => Number(row.id.slice(checklist.prefix.length + 1)));
  const sorted = [...numbers].sort((a, b) => a - b);
  for (let expected = 1; expected <= sorted[sorted.length - 1]; expected += 1) {
    if (!sorted.includes(expected)) {
      problems.push(`${checklist.path}: ${checklist.prefix}-${String(expected).padStart(2, "0")} is missing`);
    }
  }
  const duplicates = sorted.filter((value, index) => index > 0 && sorted[index - 1] === value);
  for (const duplicate of duplicates) {
    problems.push(`${checklist.path}: ${checklist.prefix}-${String(duplicate).padStart(2, "0")} appears more than once`);
  }

  // summary agreement
  const measured = {
    rows: rows.length,
    pass: rows.filter((row) => row.verdict === "PASS").length,
    fail: rows.filter((row) => row.verdict === "FAIL").length,
  };
  const stated = {
    rows: Number((summary.match(/^\| Requirement rows \| (\d+) \|$/m) ?? [])[1]),
    pass: Number((summary.match(/^\| `PASS` \| (\d+) \|$/m) ?? [])[1]),
    fail: Number((summary.match(/^\| `FAIL` \| (\d+) \|$/m) ?? [])[1]),
  };
  for (const key of ["rows", "pass", "fail"]) {
    if (!Number.isFinite(stated[key])) {
      problems.push(`${checklist.path}: summary has no usable "${key}" figure`);
    } else if (stated[key] !== measured[key]) {
      problems.push(
        `${checklist.path}: summary says ${key}=${stated[key]}, measured ${measured[key]}`,
      );
    }
  }

  // The FAIL register must not list a row the body decided PASS, or omit one it
  // decided FAIL: the register is what a reader acts on.
  const registerAt = summary.indexOf("### 7.1 FAIL register");
  if (registerAt === -1) {
    problems.push(`${checklist.path}: no FAIL register section`);
  } else {
    const register = summary
      .slice(registerAt)
      .split("\n")
      .filter((line) => new RegExp(`^\\| ${checklist.prefix}-\\d+ \\|`).test(line))
      .map((line) => line.slice(2, line.indexOf(" |")).trim());

    const failing = rows.filter((row) => row.verdict === "FAIL").map((row) => row.id);
    for (const id of failing) {
      if (!register.includes(id)) problems.push(`${checklist.path}: ${id} is FAIL but absent from the register`);
    }
    for (const id of register) {
      if (!failing.includes(id)) problems.push(`${checklist.path}: ${id} is in the register but not FAIL in the body`);
    }
  }

  console.log(
    `${checklist.label}: ${measured.rows} rows, ${measured.pass} PASS, ${measured.fail} FAIL, ids contiguous, summary agrees`,
  );
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log("\nBoth checklists are well-formed and their summaries match their rows.");
