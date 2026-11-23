#!/usr/bin/env node
/**
 * Mutation test for `scripts/check-doc-counts.mjs` (evidence for DEF-096).
 *
 * DEF-096 was the gate whose entire job was catching stale numbers, and which
 * printed a hard-coded `MEASURED` object under the word "measured". The rewrite
 * derives every number from a real artefact. But a gate that *claims* to measure
 * is only worth what it catches, so this script reintroduces, one at a time, the
 * three ways numeric drift actually happens and asserts the gate rejects each:
 *
 *   1. a document states a count the tree no longer produces;
 *   2. the vitest report predates a test source (a number from last week);
 *   3. the register's own §3 total disagrees with its rows.
 *
 * Each mutation is applied to the real file and undone from an in-memory copy,
 * restoring bytes **and** mtime - a gate that audits the tree must not perturb
 * it (DEF-087).
 *
 * Not part of `npm run verify` (it rewrites documentation mid-run and invokes
 * `cargo test --list`); run it by hand before a release. DEF-096 cites its output.
 *
 * Exit 0 only if the pristine tree passes *and* every mutation is caught.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";

import { restore, snapshot } from "./lib/mutate-restore.mjs";

const runGate = () => {
  try {
    const out = execFileSync("node", ["scripts/check-doc-counts.mjs"], {
      stdio: "pipe",
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, out: `${out}` };
  } catch (err) {
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
};

let failures = 0;
const snapshots = [];

function track(file) {
  const snap = snapshot(file);
  snapshots.push({ file, snap });
  return snap;
}

try {
  // 1. The pristine tree must pass, otherwise the mutations prove nothing.
  const clean = runGate();
  if (clean.ok) {
    console.log("PASS  pristine tree -> gate accepts it");
  } else {
    failures += 1;
    console.log("FAIL  pristine tree -> gate rejects the real tree");
    console.log(clean.out.trim().split("\n").slice(-8).join("\n"));
  }

  // Every expected value below is derived from this run's own measurement, never
  // typed. The first version of this script hard-coded "measured 272", so when
  // the suite grew the mutations stopped applying and the file reported "did not
  // catch it" about a mutant that was never written - the DEF-096 mistake inside
  // the test for DEF-096.
  const measuredMatch = clean.out.match(/measured: (\{.*\})/);
  if (!measuredMatch) {
    console.error("cannot read the gate's measured object; aborting");
    process.exit(2);
  }
  const MEASURED = JSON.parse(measuredMatch[1]);

  // 2. A stale count in a document: a badly wrong number, 19 short of the real
  //    one. The first version of the gate ignored differences larger than 12,
  //    and this mutation proved the hole by passing silently. Current counts must
  //    now match exactly, whatever the tree happens to hold today.
  const docFile = "docs/10-audit/10-01-scorecard.md";
  const docSnap = track(docFile);
  const doc = docSnap.bytes;
  const wrongRust = MEASURED.rust - 19;
  const doctored = doc.replace(
    /^(\| )(\d+)( Rust tests pass \| `cargo test --workspace` \| ).*$/mu,
    (_, head, _n, mid) => `${head}${wrongRust}${mid}(deliberately wrong for this mutation) |`,
  );
  if (doctored === doc) {
    failures += 1;
    console.log("FAIL  stale Rust count -> mutation did not apply (the row shape changed)");
  } else {
    writeFileSync(docFile, doctored, "utf8");
    const result = runGate();
    const expected = `rust: ${wrongRust} (measured ${MEASURED.rust})`;
    const caught = !result.ok && result.out.includes(expected);
    if (caught) {
      console.log(`PASS  stale Rust count -> gate rejected it ("${expected}")`);
    } else {
      failures += 1;
      console.log("FAIL  stale Rust count -> gate did NOT catch it");
      console.log(result.out.trim().split("\n").slice(-6).join("\n"));
    }
    restore(docFile, docSnap);
  }

  // 3. A report that predates its test source. Dating the report into the past
  //    is the cleanest way to reproduce "a number from last week presented as
  //    today's measurement" without rewriting the JSON.
  const countsFile = "evidence/vitest-counts.json";
  const countsSnap = track(countsFile);
  const old = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  utimesSync(countsFile, old, old);
  {
    const result = runGate();
    const caught = !result.ok && /older than/.test(result.out);
    if (caught) {
      console.log('PASS  stale vitest report -> gate rejected it ("older than")');
    } else {
      failures += 1;
      console.log("FAIL  stale vitest report -> gate did NOT catch it");
      console.log(result.out.trim().split("\n").slice(-6).join("\n"));
    }
    // Tracked last, so its real mtime is restored at the end.
    const after = statSync(countsFile);
    snapshots[snapshots.length - 1] = {
      file: countsFile,
      snap: { ...countsSnap, atime: after.atime, mtime: countsSnap.mtime },
    };
    utimesSync(countsFile, countsSnap.atime, countsSnap.mtime);
  }

  // 4. The register's §3 total disagreeing with its own rows.
  const regFile = "docs/10-audit/10-02-deficiency-register.md";
  const regSnap = track(regFile);
  const reg = regSnap.bytes;
  const broken = reg.replace(
    /^\| \*\*Total\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \|$/mu,
    (_, t, c, o) => `| **Total** | **${t}** | **${Number(c) - 1}** | **${o}** |`,
  );
  if (broken === reg) {
    failures += 1;
    console.log("FAIL  register total -> mutation did not apply (the Total row shape changed)");
  } else {
    writeFileSync(regFile, broken, "utf8");
    const result = runGate();
    const caught = !result.ok && /which is not/.test(result.out);
    if (caught) {
      console.log('PASS  register total -> gate rejected it ("which is not")');
    } else {
      failures += 1;
      console.log("FAIL  register total -> gate did NOT catch it");
      console.log(result.out.trim().split("\n").slice(-6).join("\n"));
    }
    restore(regFile, regSnap);
  }

  // 5. The evidence ledger's own split-form count. This phrasing matched no
  //    pattern in the first rewrite, so the ledger's headline number was the one
  //    count the gate did not read - DEF-096 surviving inside the fix for
  //    DEF-096. The pattern is new, so it is mutated here to keep it honest.
  //    It targets whichever row the ledger marks "current": naming a log file
  //    here would rot on the next run, which is how mutation 5 silently stopped
  //    applying once already.
  const ledgerFile = "evidence/README.md";
  const ledgerSnap = track(ledgerFile);
  const ledger = ledgerSnap.bytes;
  // Change only the leading number: rewriting the shape too would delete the
  // very phrasing the gate matches, so the mutant would be invisible for the
  // wrong reason and the mutation would "fail" while proving nothing.
  const ledgerBroken = ledger.replace(
    /^(\| `[^`]+` \| `cargo test --workspace` \| )(\d+)( tests \(\d+ app \+ \d+ core[^\n]*- current.*)$/mu,
    (_, head, n, tail) => `${head}${Number(n) - 11}${tail}`,
  );
  if (ledgerBroken === ledger) {
    failures += 1;
    console.log("FAIL  ledger split count -> mutation did not apply (the row shape changed)");
  } else {
    writeFileSync(ledgerFile, ledgerBroken, "utf8");
    const result = runGate();
    const caught = !result.ok && /rust: \d+ \(measured/.test(result.out);
    if (caught) {
      console.log("PASS  ledger split count -> gate rejected it (rust measured mismatch)");
    } else {
      failures += 1;
      console.log("FAIL  ledger split count -> gate did NOT catch it");
      console.log(result.out.trim().split("\n").slice(-6).join("\n"));
    }
    restore(ledgerFile, ledgerSnap);
  }

  // 6. The historical exemption itself. It must accept a `| DEF-nnn |` closure
  //    row (that table narrates the past by construction) and must still reject
  //    a *non*-row line with no history marker. Proving only the catch half
  //    would leave a gate that flags the record it is supposed to preserve.
  const stratFile = "docs/06-i18n/06-01-i18n-strategy.md";
  const stratSnap = track(stratFile);
  const strat = stratSnap.bytes;

  const markedBroken = strat.replace("green at 471 keys at the time", "green at 471 keys");
  if (markedBroken === strat) {
    failures += 1;
    console.log("FAIL  historical exemption -> mutation did not apply (the marker phrase changed)");
  } else {
    writeFileSync(stratFile, markedBroken, "utf8");
    const result = runGate();
    // `445` here was typed, and the catalogue has since grown to 447 - so the
    // mutant was written, the gate rejected it, and this script still reported
    // "did NOT catch it": the expected string was stale, not the gate. That is
    // DEF-096 recurring inside the file that proves DEF-096 was fixed. The
    // measured key count is read from this run's own `measured:` object.
    const expected = `keys: 471 (measured ${MEASURED.keys})`;
    const caught = !result.ok && result.out.includes(expected);
    if (caught) {
      console.log(`PASS  unmarked stale prose -> gate rejected it ("${expected}")`);
    } else {
      failures += 1;
      console.log("FAIL  unmarked stale prose -> gate did NOT catch it");
      console.log(result.out.trim().split("\n").slice(-6).join("\n"));
    }
    restore(stratFile, stratSnap);
  }

  // And the exemption must not be a free pass for the register: a closure row
  // may quote a stale count, but the §3 Total row is not a `| DEF-` row and is
  // still checked (that is mutation 4).
} finally {
  // Restore everything, newest first, and verify bytes and mtime for each.
  for (const { file, snap } of snapshots.reverse()) {
    const outcome = restore(file, snap);
    if (outcome.contentIdentical && outcome.mtimePreserved) {
      console.log(`restore: ${file} byte-identical, mtime preserved`);
    } else {
      failures += 1;
      console.log(
        `restore: ${file} MISMATCH (content ${outcome.contentIdentical}, mtime ${outcome.mtimePreserved})`,
      );
    }
  }
}

console.log(failures ? `\n${failures} failure(s)` : "\nAll mutations caught; tree restored.");
process.exit(failures ? 1 : 0);
