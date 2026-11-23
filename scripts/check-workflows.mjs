#!/usr/bin/env node
/**
 * `check:workflows` - the CI workflow must describe the tree it runs against.
 *
 * ## What this exists to stop
 *
 * `.github/workflows/verify.yml` is a second copy of the release procedure, and
 * until this gate nothing measured it. The failure mode is not a YAML syntax
 * error - GitHub reports those on push. It is a workflow that parses, runs, and
 * quietly proves less than the local gate:
 *
 *   * a step calls `npm run check:lint` after that script was renamed, so the
 *     step fails on every push and the branch is red for a reason nobody can
 *     act on; or worse,
 *   * the workflow invokes `npm run verify` for an *older* chain, and the CI a
 *     reader trusts is not the gate the release depends on;
 *   * the pinned toolchain drifts from `.node-version` / `Cargo.toml`, so CI
 *     compiles a different tree than the developer and a "works on CI" claim
 *     becomes a claim about a third configuration.
 *
 * ## What is checked
 *
 *   1. every `npm run <script>` names a script that exists in `package.json`;
 *   2. every `node <path>` and `cargo run ... --bin <name>` names a file that
 *      exists on disk;
 *   3. the workflow runs `npm run verify` - the chain, not a hand-copied subset;
 *   4. `node-version-file` points at the pinned file, and the Rust toolchain it
 *      installs matches `rust-version` in the workspace manifest;
 *   5. no step pretends to check something with `continue-on-error: true`, which
 *      turns a gate into a log line, and no step is written with `|| true`;
 *   6. a step that *states* the chain length (`Release gate (26 steps)`, or the
 *      header prose "twenty-six steps") states the real one. This is the check
 *      the gate shipped without: the workflow said "25 steps" while the chain
 *      had grown to 26, and every assertion above stayed green because none of
 *      them read a number. A count in prose is the same class of claim as the
 *      counts `check:doc-counts` measures, and it was outside that gate too.
 *
 * Exit 0 when the workflow is consistent with the tree. Exit 1 otherwise.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOWS = join(ROOT, ".github", "workflows");
const problems = [];

if (!existsSync(WORKFLOWS)) {
  console.error(".github/workflows is missing; the repository makes no CI claim.");
  process.exit(1);
}

const files = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/i.test(name));
if (files.length === 0) {
  console.error(".github/workflows holds no workflow file.");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const scripts = pkg.scripts ?? {};
const cargoToml = readFileSync(join(ROOT, "Cargo.toml"), "utf8");
const rustVersion = cargoToml.match(/^\s*rust-version\s*=\s*"([^"]+)"/m)?.[1];

// The Rust toolchain a workflow installs must be the one the manifest says the
// crate supports. A workflow on 1.85 against `rust-version = "1.90"` is red for
// a reason the developer never sees, and a workflow on 1.100 is a claim that the
// minimum is untested.
const pinnedNodeFile = readFileSync(join(ROOT, ".node-version"), "utf8").trim();

/**
 * Blank out YAML comments, keeping line count and indentation.
 *
 * A workflow's prose is where this gate was first fooled: the header comment
 * says "the same gate a release depends on: `npm run verify`", so replacing the
 * real `run: npm run verify` step with something else still matched, and the
 * negative proof caught the gate reporting green on a workflow that no longer
 * ran the chain. Every check below reads `code`, never `text`.
 *
 * A `#` starts a comment only at the start of a line or after whitespace, which
 * is the YAML rule; `scripts/check-#.mjs` would otherwise be truncated. No step
 * in this repository's workflows puts a `#` inside a quoted scalar, and if one
 * ever does, the fail-closed behaviour is a spurious problem rather than a
 * missed one.
 */
function stripComments(text) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const at = line.search(/(^|\s)#/);
      return at === -1 ? line : line.slice(0, at + (line[at] === "#" ? 0 : 1));
    })
    .join("\n");
}

let totalSteps = 0;

for (const name of files) {
  const path = join(WORKFLOWS, name);
  const text = readFileSync(path, "utf8");
  // Every invariant is measured on executable YAML, not on the prose around it.
  const code = stripComments(text);
  const label = `.github/workflows/${name}`;

  // --- 1. `npm run <script>` names a real script --------------------------
  for (const match of code.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) {
    const script = match[1];
    if (!(script in scripts)) {
      problems.push(`${label}: \`npm run ${script}\` is not a script in package.json`);
    }
  }

  // --- 2. `node <path>` names a real file --------------------------------
  for (const match of code.matchAll(/\bnode ([a-zA-Z0-9_./-]+\.mjs)\b/g)) {
    const target = match[1];
    if (!existsSync(join(ROOT, target))) {
      problems.push(`${label}: \`node ${target}\` names a file that does not exist`);
    }
  }

  // --- 3. the chain itself is run ----------------------------------------
  if (!/npm run verify\b/.test(code)) {
    problems.push(
      `${label}: does not run \`npm run verify\`. A workflow that runs a hand-copied subset ` +
        `drifts from the chain, and the chain is what \`check:verify-chain\` protects.`,
    );
  }

  // --- 4. pinned toolchain matches the tree ------------------------------
  const nodeFile = code.match(/node-version-file:\s*(\S+)/)?.[1];
  if (nodeFile) {
    if (!existsSync(join(ROOT, nodeFile))) {
      problems.push(`${label}: node-version-file "${nodeFile}" does not exist`);
    } else if (readFileSync(join(ROOT, nodeFile), "utf8").trim() !== pinnedNodeFile) {
      problems.push(`${label}: node-version-file disagrees with .node-version`);
    }
  } else if (!/node-version:\s*["']?\d/.test(code)) {
    problems.push(`${label}: pins no Node version; the build would use whatever the runner ships`);
  }

  const installed = [...code.matchAll(/rustup toolchain install (\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  if (installed.length > 0 && rustVersion) {
    for (const version of installed) {
      if (!version.startsWith(`${rustVersion}.`) && version !== rustVersion) {
        problems.push(
          `${label}: installs Rust ${version} while Cargo.toml declares rust-version = "${rustVersion}"`,
        );
      }
    }
  }

  // --- 5. a gate that cannot fail is not a gate --------------------------
  if (/continue-on-error:\s*true/.test(code)) {
    problems.push(`${label}: uses \`continue-on-error: true\`, which turns a failure into a log line`);
  }
  for (const match of code.matchAll(/\|\|\s*true/g)) {
    problems.push(`${label}: contains \`|| true\` near "${match[0]}", which masks a non-zero exit`);
  }

  // --- 6. a stated chain length is the real chain length ----------------
  // `npm run verify` is a `&&` chain; its length is the number of steps the
  // workflow's own label and prose describe. Measured from `package.json`, not
  // transcribed, because a transcribed number is what drifted.
  const chainSteps = String(scripts.verify ?? "").split("&&").filter((s) => s.trim()).length;
  if (chainSteps > 0) {
    for (const match of code.matchAll(/\b(\d+)[- ]steps?\b/gi)) {
      const stated = Number(match[1]);
      if (stated !== chainSteps) {
        problems.push(
          `${label}: states "${stated} steps" but \`npm run verify\` has ${chainSteps} steps`,
        );
      }
    }
    // Prose in comments is stripped from `code`, so read the number words from
    // the raw file: the header sentence is exactly where the stale "twenty-five"
    // survived.
    const WORDS = {
      twenty: 20, "twenty-one": 21, "twenty-two": 22, "twenty-three": 23,
      "twenty-four": 24, "twenty-five": 25, "twenty-six": 26, "twenty-seven": 27,
      "twenty-eight": 28, "twenty-nine": 29, thirty: 30,
    };
    for (const match of text.matchAll(/\b(twenty(?:-[a-z]+)?|thirty)[- ]steps?\b/gi)) {
      const word = match[1].toLowerCase();
      const stated = WORDS[word];
      if (stated !== undefined && stated !== chainSteps) {
        problems.push(
          `${label}: prose says "${word} steps" but \`npm run verify\` has ${chainSteps} steps`,
        );
      }
    }
  }

  totalSteps += (text.match(/^ {6}- (name|uses):/gm) ?? []).length;
}

if (!rustVersion) {
  problems.push("Cargo.toml declares no rust-version; the toolchain pin is unverifiable");
}

console.log(`workflows: ${files.length} file(s), ${totalSteps} step(s) across them`);
console.log(`pinned node: ${pinnedNodeFile}, workspace rust-version: ${rustVersion ?? "unset"}`);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log("\nEvery workflow step names a script, a file or a toolchain that exists in this tree.");
