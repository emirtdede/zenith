import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * Negative test for check:checklists. Each case reproduces a defect that
 * actually landed in this tree, applies it to a copy of the real file, and
 * requires the gate to fail with a reason naming the row.
 */

const path = "docs/11-release/11-02-github-checklist.md";
const original = readFileSync(path, "utf8");

function runGate() {
  try {
    const stdout = execFileSync(process.execPath, ["scripts/check-checklists.mjs"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return { failed: false, output: stdout };
  } catch (error) {
    return { failed: true, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

const cases = [];

// Case 1: two rows joined onto one line, the shape that hid G-56.
cases.push({
  name: "two rows joined onto one line",
  apply: (text) => text.replace(" |\n| G-56 |", " || G-56 |"),
  expect: /G-56 is missing/,
});

// Case 2: a row without its closing pipe, the shape that hid G-55's verdict cell.
cases.push({
  name: "row without a closing pipe",
  apply: (text) =>
    text.replace(/(^\| G-55 \|.*?)\s*\|$/m, "$1"),
  expect: /G-55 has no closing pipe|G-55 has 4 cells/,
});

// Case 3: a verdict that is neither PASS nor FAIL.
cases.push({
  name: "undecided verdict",
  apply: (text) => text.replace(/(^\| G-01 \|.*\| )PASS( \|$)/m, "$1LIKELY$2"),
  expect: /G-01 verdict does not start with PASS or FAIL/,
});

// Case 4: the summary drifts from the rows.
cases.push({
  name: "summary count drift",
  apply: (text) => text.replace(/^\| Requirement rows \| 66 \|$/m, "| Requirement rows | 65 |"),
  expect: /summary says rows=65, measured 66/,
});

// Case 5: a FAIL row dropped from the register.
cases.push({
  name: "FAIL row missing from the register",
  apply: (text) => text.replace(/^\| G-61 \| No real-host Windows matrix.*\n/m, ""),
  expect: /G-61 is FAIL but absent from the register/,
});

let failures = 0;
for (const testCase of cases) {
  const mutated = testCase.apply(original);
  if (mutated === original) {
    console.log(`  SKIP  ${testCase.name} (anchor did not apply)`);
    failures += 1;
    continue;
  }
  writeFileSync(path, mutated);
  const result = runGate();
  writeFileSync(path, original);

  const caught = result.failed && testCase.expect.test(result.output);
  console.log(`  ${caught ? "PASS" : "FAIL"}  ${testCase.name}`);
  if (!caught) {
    failures += 1;
    console.log(result.output.trim().split("\n").slice(0, 6).join("\n"));
  }
}

writeFileSync(path, original);
const clean = runGate();
console.log(`  ${clean.failed ? "FAIL" : "PASS"}  unmutated tree passes the gate`);
if (clean.failed) failures += 1;

if (failures > 0) {
  console.error(`\n${failures} self-test case(s) failed`);
  process.exit(1);
}
console.log(`\ncheck:checklists self-test holds: ${cases.length} mutation cases, all caught.`);
