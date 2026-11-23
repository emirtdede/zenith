#!/usr/bin/env node
/**
 * Resolve the Rust toolchain this project declares, and run `cargo` through it.
 *
 * ## Why this module exists (DEF-165)
 *
 * `Cargo.toml` says `rust-version = "1.90"` and CI installs exactly 1.90.0. The
 * authoring machine has **two** Rust installations and the wrong one wins on
 * `PATH`:
 *
 *     C:\Program Files\Rust stable MSVC 1.100\bin   (standalone, first)
 *     C:\Users\…\.cargo\bin                         (rustup shims, second)
 *
 * So bare `cargo` is 1.100, and `rustup run 1.90.0 cargo clippy` does not help:
 * `cargo` resolves the `clippy` subcommand from `PATH` and finds 1.100's, so the
 * command printed `clippy 0.1.100` under a 1.90 label. Measured:
 *
 *     rustup run 1.90.0 cargo clippy -V   -> clippy 0.1.100   (wrong compiler)
 *     <toolchain>/bin/cargo clippy -V     -> clippy 0.1.90    (right compiler)
 *
 * Saying "verified on 1.90" while a newer compiler did the work is how three
 * clippy errors reached a red `main` (DEF-166). This module makes the toolchain
 * explicit: it locates the installed toolchain whose `rustc` reports the
 * declared version, and every child process runs with that toolchain's `bin`
 * first on `PATH`, so the subcommands resolve inside it too.
 *
 * If the declared toolchain is not installed the module throws with the exact
 * `rustup` command that fixes it. Guessing is not an option: a gate that
 * silently measures another compiler is worse than no gate.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** The `rust-version` the workspace promises to support. */
export function declaredRustVersion(root) {
  const manifest = readFileSync(join(root, "Cargo.toml"), "utf8");
  const declared = /^\s*rust-version\s*=\s*"([^"]+)"/m.exec(manifest)?.[1];
  if (!declared) {
    throw new Error("Cargo.toml declares no `rust-version`; there is no toolchain to pin");
  }
  return declared;
}

function rustupToolchainDirs() {
  const home = process.env.RUSTUP_HOME ?? join(homedir(), ".rustup");
  const dir = join(home, "toolchains");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => existsSync(join(path, "bin")));
}

function binary(binDir, name) {
  const candidates = process.platform === "win32" ? [`${name}.exe`] : [name];
  for (const candidate of candidates) {
    const path = join(binDir, candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

function rustcRelease(toolchainDir) {
  // `toolchainDir` is the root; the executables live in its `bin/`. Passing the
  // root straight to `binary()` looked for `<root>/rustc.exe`, found nothing, and
  // made every installed toolchain look absent - a gate reporting "not installed"
  // about a directory it had just listed (caught by running it, not by reading it).
  const binDir = join(toolchainDir, "bin");
  const rustc = binary(binDir, "rustc");
  if (!rustc) return null;
  try {
    const report = execFileSync(rustc, ["-vV"], { encoding: "utf8", stdio: "pipe" });
    return { release: /^release: (\S+)$/m.exec(report)?.[1] ?? null, verbose: report.trim() };
  } catch {
    return null;
  }
}

/**
 * Find the installed toolchain whose `rustc` is the declared version.
 *
 * A declared `1.90` matches an installed `1.90.0`, and a declared `1.90.0`
 * matches itself; it does not match `1.100`, which a naive string compare would
 * happily accept and a semver compare would reject for the right reason.
 */
export function resolvePinnedToolchain(root) {
  const declared = declaredRustVersion(root);
  const wanted = declared.split(".").slice(0, 2).join(".");

  const matches = [];
  for (const toolchainDir of rustupToolchainDirs()) {
    const info = rustcRelease(toolchainDir);
    if (!info?.release) continue;
    const series = info.release.split(".").slice(0, 2).join(".");
    if (series === wanted) matches.push({ binDir: join(toolchainDir, "bin"), ...info });
  }

  if (matches.length === 0) {
    throw new Error(
      `no installed Rust toolchain reports ${declared} (looked in ${join(
        process.env.RUSTUP_HOME ?? join(homedir(), ".rustup"),
        "toolchains",
      )}).\n` +
        `Install it with:  rustup toolchain install ${declared} --profile minimal --component rustfmt,clippy`,
    );
  }

  // More than one patch release of the same minor: prefer the highest, because
  // that is the most recent compiler that still satisfies the declaration.
  matches.sort((a, b) => compare(a.release, b.release));
  return matches[matches.length - 1];
}

function compare(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/**
 * The environment a child needs so `cargo test`, `cargo clippy` and `cargo fmt`
 * all resolve inside the pinned toolchain. Prepending `bin` is what fixes the
 * subcommand lookup; clearing `RUSTUP_TOOLCHAIN` stops an inherited rustup
 * selection from overriding the explicit choice.
 */
export function pinnedEnv(binDir) {
  const env = { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` };
  delete env.RUSTUP_TOOLCHAIN;
  return env;
}

/** Run `<binDir>/cargo` with `args`, capturing output. */
export function runCargo(binDir, args, { cwd, timeoutMs = 60 * 60 * 1000 } = {}) {
  const cargo = binary(binDir, "cargo");
  if (!cargo) throw new Error(`no cargo in ${binDir}`);
  try {
    const stdout = execFileSync(cargo, args, {
      cwd,
      env: pinnedEnv(binDir),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 128 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return { code: 0, output: stdout };
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    return { code: typeof error.status === "number" ? error.status : 1, output };
  }
}

/**
 * `clippy 0.1.90 (1159e78c47 2025-09-14)` -> `{ version: "0.1.90", commit: "1159e78c47" }`.
 *
 * Clippy's own version number is not the compiler's: `0.1.90` ships with rustc
 * `1.90.0`. Comparing those two numbers was wrong and made the gate claim the
 * subcommand had resolved elsewhere. The build commit is the honest identity:
 * a clippy built from the same commit as the pinned `rustc` is the pinned
 * clippy, whatever its version string says.
 */
export function clippyIdentity(binDir, cwd) {
  const result = runCargo(binDir, ["clippy", "-V"], { cwd, timeoutMs: 120_000 });
  const match = /clippy (\d+\.\d+\.\d+) \(([0-9a-f]+)/.exec(result.output);
  return match ? { version: match[1], commit: match[2] } : null;
}

/** The commit the given toolchain's `rustc` was built from.
 *
 * `cargo --version --verbose` reports **cargo's** commit (`840b83a10`), not the
 * compiler's, and comparing that to clippy's hash failed with a message blaming
 * PATH while the toolchain was correct. `rustc -vV` is the only source that
 * answers the question actually being asked.
 */
export function rustcCommit(binDir, cwd) {
  const rustc = binary(binDir, "rustc");
  if (!rustc) return null;
  try {
    const report = execFileSync(rustc, ["-vV"], { cwd, encoding: "utf8", stdio: "pipe" });
    return /^commit-hash: ([0-9a-f]+)$/m.exec(report)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The host target triple the given toolchain compiles for. */
export function rustcHost(binDir, cwd) {
  const rustc = binary(binDir, "rustc");
  if (!rustc) return null;
  try {
    const report = execFileSync(rustc, ["-vV"], { cwd, encoding: "utf8", stdio: "pipe" });
    return /^host: (\S+)$/m.exec(report)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function rustfmtVersion(binDir, cwd) {
  const result = runCargo(binDir, ["fmt", "--version"], { cwd, timeoutMs: 120_000 });
  return /rustfmt (\S+)/.exec(result.output)?.[1] ?? null;
}
