#!/usr/bin/env node
/**
 * `check:lint` - formatting and lints, on the toolchain this project declares.
 *
 * ## What this exists to stop (DEF-165, DEF-166)
 *
 * The release gate ran `cargo test`, and CI additionally ran `cargo fmt --check`
 * and `cargo clippy -D warnings`. So the local 27-step chain was **weaker than
 * the CI it claims to replicate**, and the gap shipped a red `main`:
 *
 *     error: unsafe impl missing a safety comment   child.rs:301, :309
 *     error: casting to the same type is unnecessary process.rs:135
 *
 * Those are not subtle. They were invisible locally for two compounding reasons:
 *
 *   1. no `npm run` step ran fmt or clippy at all, so the local gate could not
 *      see them however the machine was configured;
 *   2. this machine has two Rust installations and the newer one wins on `PATH`
 *      (`C:\Program Files\Rust stable MSVC 1.100\bin` before `~/.cargo/bin`), so
 *      even a hand-run `rustup run 1.90.0 cargo clippy` executed **1.100's**
 *      clippy - and 1.100 accepts code 1.90 rejects.
 *
 * ## What is checked
 *
 *   1. the declared `rust-version` has an installed toolchain, or the gate says
 *      which `rustup` command installs it - it never falls back to another;
 *   2. the clippy that answers is the declared minor version. This is the check
 *      that would have caught the PATH problem: 1.90 was claimed, 0.1.100
 *      answered, and nothing compared the two;
 *   3. `cargo fmt --all -- --check` passes;
 *   4. `cargo clippy --workspace --all-targets --locked -- -D warnings` passes.
 *
 * CI runs this same script, so a green local run and a green runner are the same
 * measurement rather than two procedures that happen to agree.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clippyIdentity,
  declaredRustVersion,
  resolvePinnedToolchain,
  runCargo,
  rustcCommit,
  rustfmtVersion,
} from "./lib/rust-toolchain.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const problems = [];
const notes = [];

const declared = declaredRustVersion(ROOT);
let pinned = null;
try {
  pinned = resolvePinnedToolchain(ROOT);
} catch (error) {
  problems.push(String(error.message ?? error));
}

if (pinned) {
  notes.push(`declared rust-version: ${declared}`);
  notes.push(`pinned toolchain:      ${pinned.binDir}`);
  notes.push(`pinned rustc:          ${pinned.release}`);

  // What a bare `cargo` would have done here. Printed because the difference is
  // the whole defect: on this machine it is 1.100, and that is why the local
  // gate stayed green while CI failed.
  let bareRustc = "unknown";
  try {
    bareRustc =
      /release: (\S+)/.exec(
        execFileSync("rustc", ["-vV"], { encoding: "utf8", stdio: "pipe" }),
      )?.[1] ?? "unknown";
  } catch {
    /* rustc absent from PATH: the pinned one below is what runs */
  }
  notes.push(`bare rustc on PATH:    ${bareRustc} (not used)`);

  // ---- the lints must answer from the pinned toolchain ----------------------
  // The identity check is the build commit, not a version string: clippy calls
  // itself 0.1.90 while the compiler is 1.90.0, so comparing numbers was wrong.
  // A clippy built from the same commit as the pinned rustc is the pinned clippy.
  const clippy = clippyIdentity(pinned.binDir, ROOT);
  const pinnedCommit = rustcCommit(pinned.binDir, ROOT);
  const fmt = rustfmtVersion(pinned.binDir, ROOT);

  if (!clippy) {
    problems.push("`cargo clippy -V` printed no version; the lint step cannot be trusted");
  } else if (!pinnedCommit) {
    problems.push("could not read the pinned rustc commit hash; the clippy identity is unverifiable");
  } else if (!pinnedCommit.startsWith(clippy.commit)) {
    // Clippy prints an abbreviated hash (`1159e78c47`) and `rustc -vV` prints
    // the full forty (`1159e78c4747b02…`), so equality is the wrong comparison:
    // the short form is a prefix of the long one. Comparing them directly made
    // the gate blame PATH for a toolchain that was correct.
    problems.push(
      `clippy ${clippy.version} was built from ${clippy.commit} but the pinned rustc is ` +
        `${pinnedCommit}: the subcommand resolved outside the pinned toolchain ` +
        `(this is the DEF-165 PATH defect)`,
    );
  } else {
    notes.push(`clippy:                ${clippy.version} (commit ${clippy.commit}, matches rustc)`);
  }
  if (!fmt) problems.push("`cargo fmt --version` printed no version");

  if (!problems.length) {
    // ---- 3. formatting ----------------------------------------------------
    const fmtRun = runCargo(pinned.binDir, ["fmt", "--all", "--", "--check"], {
      cwd: ROOT,
      timeoutMs: 15 * 60 * 1000,
    });
    if (fmtRun.code !== 0) {
      problems.push(
        "cargo fmt --all -- --check failed; run `cargo fmt --all` and review the diff\n" +
          fmtRun.output.split(/\r?\n/).slice(0, 40).join("\n"),
      );
    } else {
      notes.push("formatting:            clean");
    }

    // ---- 4. lints ---------------------------------------------------------
    if (!problems.length) {
      const clippyRun = runCargo(
        pinned.binDir,
        ["clippy", "--workspace", "--all-targets", "--locked", "--", "-D", "warnings"],
        { cwd: ROOT, timeoutMs: 60 * 60 * 1000 },
      );
      if (clippyRun.code !== 0) {
        const lines = clippyRun.output.split(/\r?\n/);
        const errors = lines.filter((l) => /^error(\[|:)/.test(l.trim()));
        problems.push(
          `cargo clippy --workspace --all-targets --locked -- -D warnings failed ` +
            `(${errors.length} error line(s)):\n` +
            (errors.slice(0, 20).join("\n") || lines.slice(-20).join("\n")),
        );
      } else {
        notes.push("clippy:                clean, -D warnings");
      }
    }
  }
}

for (const note of notes) console.log(note);

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `\nLint holds: formatting and lints are clean on the declared ${declared} toolchain.`,
);
