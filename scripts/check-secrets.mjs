#!/usr/bin/env node
/**
 * `check:secrets` - the release gate for credential leakage.
 *
 * Two scans, because they answer different questions:
 *
 *   * `gitleaks detect --no-git` reads the working tree, including files that
 *     are not committed yet - the state a build machine is actually in;
 *   * `gitleaks git` reads every blob in the history, because deleting a `.env`
 *     from the tree does not remove it from the commit that added it.
 *
 * A missing `gitleaks` is a failure, not a skip. The alternative - a small
 * home-grown regex pass - is exactly the shape of gate that looks like it is
 * watching while missing the entropy rules a real scanner ships.
 *
 * `.gitleaks.toml` extends the default rules; it never disables one. Its only
 * exemptions are build output and the published example credentials that the
 * redaction tests feed the redactor on purpose.
 *
 * Usage: `node scripts/check-secrets.mjs`
 */
import { spawnSync } from "node:child_process";

function binary() {
  const probe = spawnSync("gitleaks", ["version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return null;
  return probe.stdout.trim().split("\n")[0];
}

function scan(label, args) {
  const result = spawnSync("gitleaks", args, { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (output) {
    for (const line of output.split("\n")) {
      console.log(`${label}: ${line}`);
    }
  }
  if (result.error) {
    console.error(`${label}: gitleaks did not run: ${result.error.message}`);
    return false;
  }
  return result.status === 0;
}

const version = binary();
if (!version) {
  console.error(
    "gitleaks was not found on PATH. Install it (`winget install Gitleaks.Gitleaks`)\n" +
      "and re-run. This gate has no reduced mode: a regex pass is not a secrets scan.",
  );
  process.exit(2);
}

console.log(`gitleaks ${version}`);
const worktree = scan("worktree", [
  "detect",
  "--no-git",
  "--source",
  ".",
  "--config",
  ".gitleaks.toml",
  "--redact",
  "--verbose",
]);
const history = scan("history", ["git", ".", "--config", ".gitleaks.toml", "--redact", "--verbose"]);

if (!worktree || !history) {
  console.error("\nSecret scan failed: a finding above must be removed from the tree and the history.");
  process.exit(1);
}

console.log("\nNo secrets: the working tree and every commit are clean under the default rule set.");
