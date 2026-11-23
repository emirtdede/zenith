#!/usr/bin/env node
/**
 * `check:msrv` - the lockfile must be buildable by the toolchain this project
 * says it needs (DEF-164).
 *
 * ## What this exists to stop
 *
 * `Cargo.toml` declares `rust-version = "1.90"` and the CI job installs exactly
 * 1.90.0. Nothing compared those two facts against the crates actually in
 * `Cargo.lock`. On 2026-11-23 that gap shipped a red `main`:
 *
 *     error: rustc 1.90.0 is not supported by the following packages:
 *       parking_lot@0.13.0 requires rustc 1.95
 *
 * `parking_lot` was a **direct** workspace dependency, and the local machine's
 * default toolchain was 1.100, so `cargo test`, `cargo clippy` and the whole
 * 26-step gate passed locally while the same tree could not compile on the
 * pinned toolchain. A `rust-version` field is a promise; a lockfile can break it
 * one `cargo add` at a time.
 *
 * ## Why the target matters
 *
 * `cargo metadata` describes every crate the resolver knows about, including
 * Linux-only GTK crates (`atk`, `cairo-rs`, `gdk`) that a Windows build never
 * compiles and that legitimately need a newer compiler than this app does.
 * Failing on those would make the gate wrong for a Windows-only product, so the
 * candidate set is taken from `cargo tree --target <host>`, which is exactly the
 * set this build compiles. The gate measures what is built, not what exists.
 *
 * ## What is checked
 *
 *   1. the workspace declares a `rust-version` at all - an unstated MSRV cannot
 *      be honoured or checked;
 *   2. every crate compiled for the host target whose manifest declares
 *      `rust.version` declares one less than or equal to it;
 *   3. the comparison is numeric, so `1.90.0` and `1.90` are the same claim and
 *      a crate saying `1.5` is older than `1.90` rather than "string-smaller".
 *
 * Exit 0 when the lockfile fits the declared toolchain. Exit 1 otherwise, naming
 * each offending crate and the version it demands.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePinnedToolchain, runCargo, rustcHost } from "./lib/rust-toolchain.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const problems = [];
const notes = [];

/**
 * Choose the cargo that reads the dependency graph.
 *
 * The comparison this gate performs is over **data** - each crate's declared
 * `rust.version` in `cargo metadata` - so the toolchain that reads it does not
 * have to be the declared one; any cargo that understands the manifest and the
 * lockfile gives the same answer. What must *not* happen is the gate refusing to
 * answer because the declared toolchain is absent: then "declare 1.85 while the
 * lock needs 1.90" would report "1.85 is not installed" and never mention the
 * lockfile, which is the fact the gate exists to surface.
 *
 * Preference order:
 *   1. the declared toolchain, when installed - the most faithful reader;
 *   2. whatever `cargo` is on PATH - it can still read the graph, and the gate
 *      says so in its output so the measurement is not mistaken for a
 *      pinned-toolchain run.
 */
let pinned = null;
let readerBinDir = null;
try {
  pinned = resolvePinnedToolchain(ROOT);
  readerBinDir = pinned.binDir;
  notes.push(`pinned toolchain: ${pinned.binDir}`);
  notes.push(`pinned rustc: ${pinned.release}`);
} catch (error) {
  // Not fatal here: the graph comparison is data. `check:lint` is the gate that
  // must run the compiler and therefore fails when it is missing.
  const firstLine = String(error?.message ?? error).split("\n")[0];
  notes.push(`declared toolchain not installed: ${firstLine}`);
  notes.push("reading the graph with the cargo on PATH instead (the comparison is data)");
}

/** "1.90" -> [1, 90, 0]; unknown shapes are rejected rather than guessed. */
function parseVersion(text) {
  if (typeof text !== "string") return null;
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Read the dependency graph. Uses the declared toolchain when it is installed,
 * otherwise the cargo on PATH; either way the answer is the graph in
 * `Cargo.lock` and the `rust.version` fields in `cargo metadata`, which do not
 * depend on which compiler reads them.
 */
function cargo(args, label) {
  if (readerBinDir) {
    const result = runCargo(readerBinDir, args, { cwd: ROOT });
    if (result.code !== 0) {
      const detail = result.output.trim().split(/\r?\n/)[0];
      problems.push(`could not read ${label}: ${detail || "cargo exited non-zero"}`);
      return null;
    }
    return result.output;
  }
  try {
    return execFileSync("cargo", args, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = `${error.stderr ?? ""}${error.stdout ?? ""}`.trim().split(/\r?\n/)[0];
    problems.push(`could not read ${label}: ${detail || String(error).slice(0, 200)}`);
    return null;
  }
}

// ------------------------------------------------------- 1. the declaration ---
let manifestText = "";
try {
  manifestText = readFileSync(join(ROOT, "Cargo.toml"), "utf8");
} catch {
  problems.push("Cargo.toml is missing");
}

const declaredText = /^rust-version\s*=\s*"([^"]+)"/m.exec(manifestText)?.[1];
const declared = parseVersion(declaredText);
if (!declaredText) {
  problems.push("the workspace manifest declares no `rust-version`; an unstated MSRV cannot be checked");
} else if (!declared) {
  problems.push(`the workspace \`rust-version\` is not a plain version: "${declaredText}"`);
}

// --------------------------------------------------- 2. the compiled set -----
// Which crates this build actually compiles. `--target <host>` is the whole
// point: it drops the platform crates that a Windows build never sees.
//
// The host comes from the pinned toolchain when it is installed, and from the
// toolchain on PATH otherwise. It must never be `null` merely because the
// declared toolchain is missing: when a mutation declares 1.85 and no 1.85 is
// installed, skipping the comparison made the gate exit 0 on exactly the drift
// it exists to catch (the negative proof SURVIVED until this was fixed).
const host = pinned
  ? rustcHost(pinned.binDir, ROOT)
  : (() => {
      try {
        const report = execFileSync("rustc", ["-vV"], {
          cwd: ROOT,
          encoding: "utf8",
          stdio: "pipe",
        });
        return /^host: (\S+)$/m.exec(report)?.[1] ?? null;
      } catch {
        return null;
      }
    })();
if (!host) problems.push("could not read the host target triple; the comparison cannot be scoped");

let packages = [];
if (host) {
  const metadataText = cargo(["metadata", "--locked", "--format-version", "1"], "cargo metadata");
  const treeText = cargo(
    ["tree", "--workspace", "--locked", "--target", host, "--prefix", "none", "--format", "{p}"],
    `cargo tree for ${host}`,
  );

  if (metadataText && treeText) {
    let metadata = null;
    try {
      metadata = JSON.parse(metadataText);
    } catch (error) {
      problems.push(`cargo metadata did not return JSON: ${String(error).slice(0, 200)}`);
    }

    if (metadata) {
      // `cargo tree --format {p}` prints `name vX.Y.Z`, one entry per edge, so
      // the same crate can appear many times. The comparison is per package, so
      // the set is what matters.
      const compiled = new Set();
      for (const line of treeText.split(/\r?\n/)) {
        const match = /^(\S+) v(\S+)$/.exec(line.trim());
        if (match) compiled.add(`${match[1]}@${match[2]}`);
      }

      if (compiled.size === 0) {
        problems.push("`cargo tree` listed nothing for the host target; the comparison would be vacuous");
      }

      for (const candidate of metadata.packages) {
        if (!compiled.has(`${candidate.name}@${candidate.version}`)) continue;
        if (typeof candidate.rust_version !== "string") continue;
        const needed = parseVersion(candidate.rust_version);
        if (!needed) {
          problems.push(
            `${candidate.name} ${candidate.version} declares an unreadable \`rust-version\`: "${candidate.rust_version}"`,
          );
          continue;
        }
        packages.push({
          name: candidate.name,
          version: candidate.version,
          needed,
          neededText: candidate.rust_version,
        });
      }

      if (packages.length === 0) {
        problems.push("no compiled crate declares `rust-version`; the comparison would be vacuous");
      }
    }
  }
}

notes.push(`host target: ${host ?? "unknown"}`);
notes.push(`declared workspace rust-version: ${declaredText ?? "MISSING"}`);
notes.push(`host-compiled crates with a declared MSRV: ${packages.length}`);

if (declared && packages.length) {
  packages.sort((a, b) => compareVersions(b.needed, a.needed));
  const highest = packages[0];
  notes.push(`highest requirement: ${highest.neededText} (${highest.name} ${highest.version})`);

  for (const candidate of packages) {
    const delta = compareVersions(candidate.needed, declared);
    if (delta > 0) {
      problems.push(
        `${candidate.name} ${candidate.version} requires rustc ${candidate.neededText}, but the workspace declares ${declaredText}`,
      );
    }
  }
  notes.push(
    `crates above the declaration: ${packages.filter((c) => compareVersions(c.needed, declared) > 0).length}`,
  );
}

// ------------------------------------------------------------------ report ---
for (const note of notes) console.log(note);

if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "\nFix: `cargo update -p <crate> --precise <older version>` for each offender, or raise\n" +
      "`rust-version` in Cargo.toml and the toolchain pin in .github/workflows/verify.yml together.",
  );
  process.exit(1);
}

console.log("\nMSRV holds: every crate this build compiles fits the declared toolchain.");
