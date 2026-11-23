#!/usr/bin/env node
/**
 * `check:evidence-ledger` - the ledger must describe the tree it points at (DEF-132).
 *
 * `evidence/README.md` is the map from a claim in `10-01-scorecard.md` to the
 * captured output that supports it. It was maintained by hand, and on
 * 2026-11-22 it had drifted in both directions at once, measured:
 *
 *   * 24 artefacts sat on disk that no row described - including
 *     `def121-mutation.log` and `def122-mutation.log`, which two documents cite
 *     as the proof of a closed defect, and `vitest-counts.json`, which
 *     `check:doc-counts` reads for its numbers;
 *   * six of those 24 could not support any claim at all: one was **0 bytes**,
 *     one said only "JSON report written to …", three were two lines of
 *     "Finished `dev` profile", and one was a successful `cargo check` wrapped in
 *     PowerShell's `NativeCommandError` noise.
 *
 * The dangerous direction is the first: a document citing a proof the ledger does
 * not explain. The second is worse in kind - a file under a heading called
 * Evidence that asserts nothing, which is the "it looks like it is watching"
 * defect this project keeps finding, aimed at its own proof.
 *
 * Four invariants, each one a way the ledger can lie:
 *   1. every artefact on disk has a row;
 *   2. every row names a file that exists;
 *   3. no artefact is empty - a zero-byte log cannot distinguish "passed
 *      silently" from "the redirect truncated";
 *   4. every `evidence/…` path cited by a document exists, so a doc cannot point
 *      at a proof that was deleted.
 *
 * A file may be *removed* deliberately; that is recorded in the "Removed
 * artefacts" table, and this gate asserts those files stay absent rather than
 * quietly reappearing.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = join(ROOT, "evidence");
const LEDGER = join(EVIDENCE, "README.md");

const problems = [];
const notes = [];

if (!existsSync(LEDGER)) {
  console.error("evidence/README.md is missing: there is no ledger.");
  process.exit(1);
}

/** Split a markdown document into table blocks with their header cells. */
function tableBlocks(lines) {
  const blocks = [];
  let current = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^\s*\|/.test(line)) {
      if (current) {
        blocks.push(current);
        current = null;
      }
      continue;
    }
    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
    if (!current) {
      current = { start: i, header: cells, rows: [] };
      continue;
    }
    // The `| :--- | :--- |` separator.
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    current.rows.push({ index: i, cells });
  }
  if (current) blocks.push(current);
  return blocks;
}

const ledgerLines = readFileSync(LEDGER, "utf8").split("\n");
const blocks = tableBlocks(ledgerLines);

/** First cell holds a backticked path. */
function firstCellPath(cells) {
  const m = /^`([^`]+)`$/.exec(cells[0] ?? "");
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- parse ------
const described = new Set(); // ledger rows that claim an artefact exists
const removed = new Set(); // rows that claim an artefact is deliberately gone
const globRows = new Set(); // `screens/*.png` style coverage

for (const block of blocks) {
  const isFileTable = /^file$/i.test((block.header[0] ?? "").trim());
  if (!isFileTable) continue;
  const removalTable = block.header.length === 2;
  for (const row of block.rows) {
    const path = firstCellPath(row.cells);
    if (!path) continue;
    if (path.includes("*")) {
      globRows.add(path);
      continue;
    }
    if (removalTable) removed.add(path);
    else described.add(path);
  }
}

notes.push(`ledger rows: ${described.size} described, ${removed.size} recorded as removed`);

// ---------------------------------------------------------------- 1 + 3 ------
// Every artefact on disk must be described, and must not be empty.
const onDisk = readdirSync(EVIDENCE, { withFileTypes: true })
  .filter((e) => e.isFile() && /\.(log|json|png)$/i.test(e.name))
  .map((e) => e.name)
  .sort();

for (const file of onDisk) {
  if (removed.has(file)) {
    problems.push(
      `${file} is recorded as removed but is on disk: either describe it or delete it (DEF-132)`,
    );
    continue;
  }
  if (!described.has(file)) {
    problems.push(`${file} is on disk but no ledger row describes it (DEF-132)`);
  }
  const size = statSync(join(EVIDENCE, file)).size;
  if (size === 0) {
    problems.push(
      `${file} is 0 bytes: an empty artefact cannot distinguish a silent pass from a truncated redirect (DEF-132)`,
    );
  }
}

// ---------------------------------------------------------------- 2 ----------
// Every described row must name a file that exists.
for (const file of described) {
  if (!existsSync(join(EVIDENCE, file))) {
    problems.push(`the ledger describes ${file}, which does not exist (DEF-132)`);
  }
}

// ---------------------------------------------------------------- 4 ----------
// Every `evidence/…` path a document cites must exist.
function walkDocs(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkDocs(full, out);
    else if (full.endsWith(".md")) out.push(full);
  }
  return out;
}

const cited = new Map();
for (const doc of walkDocs(join(ROOT, "docs"))) {
  const text = readFileSync(doc, "utf8");
  for (const m of text.matchAll(/evidence[\\/]([A-Za-z0-9_.*-]+\.(?:log|json|png))/g)) {
    const name = m[1];
    if (name.includes("*")) continue;
    if (!cited.has(name)) cited.set(name, new Set());
    cited.get(name).add(relative(ROOT, doc).replace(/\\/g, "/"));
  }
}

let dangling = 0;
for (const [name, docs] of cited) {
  if (!existsSync(join(EVIDENCE, name))) {
    dangling += 1;
    problems.push(
      `${[...docs].join(", ")} cite evidence/${name}, which does not exist (DEF-132)`,
    );
    continue;
  }
  if (!described.has(name)) {
    problems.push(
      `${[...docs].join(", ")} cite evidence/${name}, but the ledger does not describe it (DEF-132)`,
    );
  }
}

notes.push(`artefacts on disk: ${onDisk.length}`);
notes.push(`evidence paths cited by docs: ${cited.size}${dangling ? `, ${dangling} dangling` : ""}`);

// ---------------------------------------------------------------- report -----
for (const note of notes) console.log(note);

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  "\nEvidence ledger holds: every artefact is described, every citation resolves, nothing is empty.",
);
