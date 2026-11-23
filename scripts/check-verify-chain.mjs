#!/usr/bin/env node
/**
 * `check:verify-chain` - the gate that reads the release gate (DEF-129).
 *
 * `npm run verify` is the one command a release depends on. On 2026-11-22 it was
 * seventeen steps and **none of them executed a test**: `check-doc-counts` ran
 * `cargo test --workspace -- --list`, which compiles the test binaries and prints
 * their names, and every other step was a static scan or `tsc`/`vite`.
 *
 * Proved by planting `assert!(false)` in an app-crate test: `cargo test` exited
 * 101 and `npm run verify` still exited 0. A release gate that stays green while
 * a test fails does not gate the release.
 *
 * A test step can go missing again in three ways, and each is checked here:
 *   * the script is deleted from `package.json`;
 *   * the script no longer runs the tests (back to `--list`, or `cargo check`);
 *   * the script is dropped from the `verify` chain.
 *
 * The step count the documents state is derived from the chain itself, so the
 * prose cannot drift away from the command it describes.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const scripts = pkg.scripts ?? {};

const problems = [];
const notes = [];

/** Split the `verify` script into its `&&`-separated steps. */
function chainSteps() {
  const verify = scripts.verify;
  if (typeof verify !== "string" || verify.trim() === "") {
    problems.push("package.json has no `verify` script");
    return [];
  }
  return verify
    .split("&&")
    .map((step) => step.trim())
    .filter(Boolean);
}

const steps = chainSteps();

// ---------------------------------------------------------------- step 1 ----
// Every step must name a script that exists. A typo silently skips a gate only
// if npm resolves it elsewhere, so this is checked by name, not by running.
const known = new Set(Object.keys(scripts));
const invoked = [];
for (const step of steps) {
  const match = /^npm run ([\w:-]+)$/.exec(step);
  if (!match) {
    // `npm run verify` is the only shape allowed: a bare shell command here
    // cannot be reviewed as a named gate.
    problems.push(`step is not a named npm script: ${step}`);
    continue;
  }
  const name = match[1];
  invoked.push(name);
  if (!known.has(name)) problems.push(`step names a missing script: ${name}`);
}

// ---------------------------------------------------------------- step 2 ----
// The Rust test gate must exist, and must actually execute tests.
const RUST_TESTS = "check:rust-tests";
const rustScript = scripts[RUST_TESTS];
if (typeof rustScript !== "string") {
  problems.push(`\`${RUST_TESTS}\` is missing: the chain has no Rust test step (DEF-129)`);
} else {
  if (!/\bcargo\s+test\b/.test(rustScript)) {
    problems.push(`\`${RUST_TESTS}\` does not run \`cargo test\`: ${rustScript}`);
  }
  // `--list` enumerates names and runs no test body. It is how the chain looked
  // green while a test asserted false.
  if (/(^|\s)--list(\s|$)/.test(rustScript)) {
    problems.push(
      `\`${RUST_TESTS}\` passes \`--list\`, which lists tests without running them (DEF-129)`,
    );
  }
  if (/\bcargo\s+(check|clippy|build)\b/.test(rustScript) && !/\bcargo\s+test\b/.test(rustScript)) {
    problems.push(`\`${RUST_TESTS}\` compiles but does not run tests: ${rustScript}`);
  }
  if (!/--workspace|\s-p\s/.test(rustScript)) {
    problems.push(
      `\`${RUST_TESTS}\` must name its scope (\`--workspace\` or \`-p\`), or it tests one crate and claims the workspace`,
    );
  }
}

// ---------------------------------------------------------------- step 3 ----
// It must be wired into the chain.
if (!invoked.includes(RUST_TESTS)) {
  problems.push(`\`${RUST_TESTS}\` is not part of \`verify\`: a gate outside the chain does not run`);
}

// ---------------------------------------------------------------- step 4 ----
// The renderer bundle must be built before anything compiles Rust.
//
// `src-tauri/src/lib.rs` calls `tauri::generate_context!()`, which embeds
// `frontendDist` **at compile time**. On a clean checkout `dist/` does not
// exist - it is generated, and `.gitignore` says so - so every Rust-compiling
// step fails with:
//
//     error: proc macro panicked
//     help: The `frontendDist` configuration is set to `"../dist"` but this
//           path doesn't exist
//
// That is what turned the third CI run red at `check:lint`, the first compiling
// step in the chain. The chain put `build` **after** the Rust steps, so it only
// worked on a machine that happened to have a stale `dist/`; a fresh clone could
// not pass the gate at all. Ordering is therefore an invariant, not a preference.
//
// A step counts as compiling Rust when its command says so (`cargo test`,
// `cargo run`, `cargo clippy`) **or** when the node script it names mentions
// clippy in its own source - `check:lint` is `node scripts/check-lint.mjs` and
// compiles everything through clippy. The second half is why this reads the
// file instead of matching only the command string. `check:msrv` mentions
// `cargo metadata` and `cargo tree`, which read the graph without compiling, so
// it is correctly outside the rule.
const COMPILES_RUST = /\bcargo\s+(test|build|run|clippy)\b|\bclippy\b/;

function compilesRust(name) {
  const command = scripts[name] ?? "";
  if (COMPILES_RUST.test(command)) return true;
  const nodeTarget = /^node\s+(\S+\.mjs)\s*$/.exec(command.trim());
  if (!nodeTarget) return false;
  try {
    return COMPILES_RUST.test(readFileSync(join(ROOT, nodeTarget[1]), "utf8"));
  } catch {
    return false;
  }
}

const buildAt = invoked.indexOf("build");
if (buildAt === -1) {
  problems.push(
    "`build` is not part of `verify`: nothing produces the renderer bundle the Rust build embeds",
  );
} else {
  for (const [index, name] of invoked.entries()) {
    if (index >= buildAt || !compilesRust(name)) continue;
    problems.push(
      `\`${name}\` compiles Rust at step ${index + 1}, before \`build\` at step ${buildAt + 1}: ` +
        "`tauri::generate_context!` needs the renderer bundle, which a clean checkout does not have (DEF-167)",
    );
  }
}

// `check:bundle` inspects the `dist/` that `build` produced, so it can only be
// last: anywhere else it would verify a bundle that later steps replace.
const BUNDLE = "check:bundle";
if (invoked.length && invoked[invoked.length - 1] !== BUNDLE) {
  problems.push(`\`${BUNDLE}\` must be the last step: it inspects the bundle \`build\` produced`);
}

// ---------------------------------------------------------------- step 5 ----
// This gate must be in the chain too, or it protects nothing.
const SELF = "check:verify-chain";
if (!invoked.includes(SELF)) {
  problems.push(`\`${SELF}\` is not part of \`verify\``);
}

// ---------------------------------------------------------------- step 5 ----
// The documents state a step count. Bind it to the chain.
const stepCount = steps.length;
const docPath = "docs/07-quality/07-01-test-plan.md";
let docText = "";
try {
  docText = readFileSync(join(ROOT, docPath), "utf8");
} catch {
  problems.push(`${docPath} is missing`);
}

if (docText) {
  const words = {
    17: "seventeen",
    18: "eighteen",
    19: "nineteen",
    20: "twenty",
    21: "twenty-one",
    22: "twenty-two",
    23: "twenty-three",
    24: "twenty-four",
    25: "twenty-five",
    26: "twenty-six",
    27: "twenty-seven",
    28: "twenty-eight",
  };
  const word = words[stepCount];
  if (!word) {
    problems.push(
      `no spelled-out form registered for ${stepCount} steps; add it here and in ${docPath}`,
    );
  } else if (!docText.includes(`${word} steps`)) {
    // The prose must state the measured count. It is checked as a phrase, not as
    // a punctuation pattern: what matters is that the number is written down and
    // is the real one, not that it sits behind a particular dash.
    problems.push(`${docPath} does not state "${word} steps" beside the chain (measured ${stepCount})`);
  }
  // The literal chain in the prose must match the real one, step for step.
  const listed = /`npm run verify` is `([^`]+)`/.exec(docText);
  if (!listed) {
    problems.push(`${docPath} no longer lists the chain in backticks`);
  } else {
    const docSteps = listed[1]
      .split("&&")
      .map((step) => step.trim().replace(/^npm run /, ""))
      .filter(Boolean);
    const ownSteps = steps.map((step) => step.replace(/^npm run /, ""));
    if (docSteps.length !== ownSteps.length) {
      problems.push(
        `${docPath} lists ${docSteps.length} steps; \`package.json\` has ${ownSteps.length}`,
      );
    } else {
      for (let i = 0; i < ownSteps.length; i += 1) {
        if (docSteps[i] !== ownSteps[i]) {
          problems.push(`${docPath} step ${i + 1} is "${docSteps[i]}"; package.json has "${ownSteps[i]}"`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------- report ----
notes.push(`steps: ${stepCount}`);
notes.push(`rust test step: ${invoked.includes(RUST_TESTS) ? "in chain" : "MISSING"}`);
notes.push(`tests executed, not listed: ${rustScript && !/--list/.test(rustScript) ? "yes" : "NO"}`);

for (const note of notes) console.log(note);

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log("\nVerify chain holds: every step is a named gate, and the tests run.");
