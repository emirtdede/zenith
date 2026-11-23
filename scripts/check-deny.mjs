/**
 * Gate for DEF-061: `deny.toml` exists and cargo-deny passes it.
 *
 * The binary is vendored under `tools/cargo-deny/` so the gate does not depend
 * on whatever is on PATH, and so an air-gapped rebuild can still run the policy
 * check (08-01 §2). If it is missing, this fails with the download command
 * instead of skipping - a skipped security check is not a passed one.
 *
 * ## Why the offline retry exists (DEF-074)
 *
 * cargo-deny refreshes the RustSec advisory database on every run. On a host
 * with no DNS - an air-gapped build box, a locked-down CI runner, or this
 * machine when the network drops - it exits 1 with `failed to fetch advisory
 * database` and no advisories checked. That is a *transport* failure reported
 * with the same exit code as a *policy violation*, and treating it as a policy
 * failure teaches people to skip the gate.
 *
 * The retry is `--offline`, which checks the locally cached database. The result
 * is printed with the database's commit date, so the reader can tell a
 * same-day advisory check from a two-month-old cache. An offline pass is a pass
 * against the cached data - it is never reported as "up to date".
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CONFIG = join(ROOT, "deny.toml");

if (!existsSync(CONFIG)) {
  console.error("deny.toml is missing; 04-01 §9 is not enforced.");
  process.exit(1);
}

function findBinary() {
  const vendor = join(ROOT, "tools", "cargo-deny");
  if (existsSync(vendor)) {
    for (const entry of readdirSync(vendor, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(vendor, entry.name, "cargo-deny.exe");
      if (existsSync(candidate)) return candidate;
    }
  }
  const probe = spawnSync("cargo-deny", ["--version"], { encoding: "utf8" });
  if (probe.status === 0) return "cargo-deny";
  console.error(
    "cargo-deny 0.22.0 is not vendored and not on PATH.\n" +
      "Download cargo-deny-0.22.0-x86_64-pc-windows-msvc.tar.gz from\n" +
      "https://github.com/EmbarkStudios/cargo-deny/releases and extract it under\n" +
      "tools/cargo-deny/ (see 08-01 §2).",
  );
  process.exit(1);
}

/**
 * The vendored binary must be intact before its verdict is trusted (DEF-131).
 *
 * A lossy `"utf8"` round-trip in the mutation helper rewrote
 * `cargo-deny.exe` from 9,125,888 bytes to 14,840,172 and reported the result as
 * `contentIdentical: true`. The next `check:deny` then said
 * "failed with exit 4294967295" with no output - a corrupt tool dressed as a
 * policy failure, which is the one confusion this file exists to prevent.
 *
 * The documented size is the cheap invariant: `tools/cargo-deny/README.md`
 * records the extracted binary at 9,125,888 B, and `--version` proves it can
 * execute. Either failing means the tree needs `tar -xzf cargo-deny.tar.gz`
 * again, not a policy investigation.
 */
function assertBinaryIntact(binaryPath) {
  if (binaryPath === "cargo-deny") return; // PATH copy: cannot verify a size we did not record
  const DOCUMENTED_BYTES = 9_125_888;
  const size = statSync(binaryPath).size;
  if (size !== DOCUMENTED_BYTES) {
    console.error(
      `The vendored cargo-deny binary is ${size.toLocaleString("en-US")} bytes; ` +
        `the release is ${DOCUMENTED_BYTES.toLocaleString("en-US")}.\n` +
        "It has been rewritten by something that was not the release tarball.\n" +
        "Re-extract it (the archive is beside it, hash in `cargo-deny.tar.gz.sha256`):\n" +
        `  cd ${dirname(binaryPath)} && tar -xzf ../../cargo-deny.tar.gz`,
    );
    process.exit(3);
  }
  const probe = spawnSync(binaryPath, ["--version"], { encoding: "utf8" });
  if (probe.status !== 0 || !/cargo-deny 0\.22\.0/.test(`${probe.stdout ?? ""}`)) {
    console.error(
      "The vendored cargo-deny binary is the right size but will not run: " +
        `${probe.error ? probe.error.message : `exit ${probe.status}`}.\n` +
        "Re-extract it from `tools/cargo-deny/cargo-deny.tar.gz`.",
    );
    process.exit(3);
  }
}

/** Newest `advisory-db` checkout under CARGO_HOME, or null when none exists. */
function cachedDatabaseAge() {
  const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
  const root = join(cargoHome, "advisory-dbs");
  if (!existsSync(root)) return null;
  let newest = null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("advisory-db-")) continue;
    const head = join(root, entry.name, ".git", "FETCH_HEAD");
    const stampOn = existsSync(head) ? head : join(root, entry.name, ".git");
    if (!existsSync(stampOn)) continue;
    const at = statSync(stampOn).mtimeMs;
    if (newest === null || at > newest) newest = at;
  }
  return newest === null ? null : new Date(newest);
}

function run(args) {
  return spawnSync(binary, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, CARGO_TERM_COLOR: "never" },
  });
}

const binary = findBinary();
assertBinaryIntact(binary);
const first = run(["check"]);

if (first.error) {
  console.error(`cargo-deny could not run: ${first.error.message}`);
  process.exit(1);
}

if (first.status === 0) {
  process.stdout.write(first.stdout ?? "");
  process.stderr.write(first.stderr ?? "");
  console.log("Dependency policy holds: advisories, bans, licences and sources.");
  process.exit(0);
}

// Distinguish "the network is down" from "the policy failed". Only the former
// is retried, and only when a cached database actually exists - otherwise the
// retry would pass with zero advisories, which is worse than failing.
const combined = `${first.stdout ?? ""}${first.stderr ?? ""}`;
const transportFailure = /failed to fetch|could not resolve host|unable to access/i.test(combined);
const cachedAt = cachedDatabaseAge();

/**
 * A run that produced no verdict at all (DEF-130).
 *
 * `cargo-deny check` either prints a verdict or explains why it could not reach
 * one. A run with *no output and no zero exit* is neither: on 2026-11-22 the full
 * `npm run verify` chain died here with
 *   `cargo-deny check failed with exit 4294967295`
 * and an empty log, while thirteen standalone runs in a row passed. `4294967295`
 * is `-1` as an unsigned int - the child was terminated before it decided
 * anything (probe: `cmd /c exit -1` produces exactly that status with empty
 * stdout and `signal: null`).
 *
 * Reporting that as a policy failure is the mistake this file's own header warns
 * about: it teaches people that a red `check:deny` means "a banned crate", when
 * sometimes it means "the tool was killed". The two need different responses, so
 * they get different messages and different exit codes.
 */
const producedNothing = combined.trim() === "";
const wasKilled = first.status === null || first.signal !== null;
const noVerdict = producedNothing && (wasKilled || first.status === -1 || first.status === 4294967295);

if (noVerdict) {
  // One immediate retry: a killed child is usually transient (AV scan, memory
  // pressure, a supervisor). A second empty run is a real problem, not noise.
  const retry = run(["check"]);
  const retryText = `${retry.stdout ?? ""}${retry.stderr ?? ""}`;
  if (retry.status === 0) {
    process.stdout.write(retry.stdout ?? "");
    process.stderr.write(retry.stderr ?? "");
    console.log(
      "Dependency policy holds: advisories, bans, licences and sources " +
        "(first attempt produced no verdict; it was killed before deciding).",
    );
    process.exit(0);
  }
  if (retryText.trim() !== "") {
    // The retry reached a decision - defer to the normal paths below by
    // re-reading it as the outcome of record.
    process.stderr.write(
      `cargo-deny produced no verdict on the first attempt ` +
        `(status ${first.status}, signal ${first.signal ?? "none"}); the retry spoke:\n`,
    );
    process.stdout.write(retry.stdout ?? "");
    process.stderr.write(retry.stderr ?? "");
    console.error(
      `cargo-deny check failed with exit ${retry.status} - this is a policy result, not a transport one.`,
    );
    process.exit(retry.status ?? 1);
  }
  console.error(
    "cargo-deny check produced no verdict twice: the process was killed before it " +
      "decided anything (no stdout, no stderr, non-zero status).\n" +
      "This is NOT a policy violation and NOT a pass - the security gate did not run.\n" +
      "Causes seen on this host: an antivirus scan holding the binary, memory pressure,\n" +
      "or a supervisor terminating the child. Re-run `node scripts/check-deny.mjs`;\n" +
      "if it persists, verify the vendored binary with " +
      "`tools/cargo-deny/*/cargo-deny.exe --version`.",
  );
  process.exit(2);
}

if (!transportFailure || cachedAt === null) {
  process.stdout.write(first.stdout ?? "");
  process.stderr.write(first.stderr ?? "");
  // The tool spoke, so this is a decision - but say which kind of decision, in
  // the same words the killed-process branch uses, so a reader never has to
  // guess whether red means "banned crate" or "tool died" (DEF-130).
  console.error(
    `cargo-deny check failed with exit ${first.status} - this is a policy result, not a transport one.`,
  );
  process.exit(first.status ?? 1);
}

console.warn(
  "cargo-deny could not refresh the RustSec advisory database (network unavailable).\n" +
    `Retrying against the cached database last updated ${cachedAt.toISOString()}.\n` +
    "This is an offline pass: re-run with network access before a release.",
);

// `--offline` is a top-level flag, not a `check` option: `check --offline`
// exits 2 with "unexpected argument", which is how this was caught.
const offline = run(["--offline", "check"]);
process.stdout.write(offline.stdout ?? "");
process.stderr.write(offline.stderr ?? "");

if (offline.status !== 0) {
  console.error(`cargo-deny check --offline failed with exit ${offline.status}`);
  process.exit(offline.status ?? 1);
}

const ageDays = Math.floor((Date.now() - cachedAt.getTime()) / 86_400_000);
if (ageDays > 30) {
  console.error(
    `Advisory database is ${ageDays} days old; an offline pass that stale is not a security result.`,
  );
  process.exit(1);
}

console.log(
  `Dependency policy holds against the cached advisory database (${ageDays} day(s) old).`,
);
