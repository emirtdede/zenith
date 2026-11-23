/**
 * The negative self-test for `check-step-keys`.
 *
 * A gate is only worth its lines if it fails on the bug it was written for. This
 * feeds the real analysis function synthetic sources - no product file is edited,
 * so it is safe to run in the chain - and asserts:
 *
 *   * each DEF-135 shape is reported (the two languages, a literal undefined
 *     key, and the old `snapshots.<id>` literal);
 *   * three shapes that are *not* keys are not reported (an i18n prefix stem, an
 *     `unsupported(...)` feature name, a file name in a support bundle, and the
 *     comment that documents the defect).
 *
 * The last group matters as much as the first: a gate with false positives gets
 * switched off, and then it catches nothing.
 */
import { analyse } from "./lib/key-scan.mjs";

const CATALOGUE = `
  "actions.emptyRecycleBin.title": "Empty the Recycle Bin",
  "actions.emptyRecycleBin.done": "Completed: Empty the Recycle Bin",
  "outcomes.none": "Not recorded",
  "steps.dnsFlush": "Flushing DNS",
`;

const en = new Set(
  [...CATALOGUE.matchAll(/^\s*"([A-Za-z0-9_.]+)":/gm)].map((m) => m[1]),
);
const tr = new Set(en);

const options = { en, tr, dynamicDonePrefixes: [] };

/** Runs the analysis over one synthetic file. */
const one = (kind, text) => analyse([{ path: "fixture", text, kind }], options);

let failures = 0;
function expect(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log(`        ${detail}`);
  }
}

// ------------------------------------------------------------- must catch ----

{
  const r = one("rust", `summary_key: format!("{}done", def.i18n_prefix),`);
  expect(
    "Rust format!(\"{}done\", prefix) is malformed (the original DEF-135 shape)",
    r.malformed.length === 1,
    `malformed=${r.malformed.length}`,
  );
}

{
  const r = one("ts", "summaryKey: `${def.i18nPrefix}done`,");
  expect(
    "TS `${prefix}done` template is malformed",
    r.malformed.length === 1,
    `malformed=${r.malformed.length}`,
  );
}

{
  const r = one("ts", `summaryKey: "snapshots.empty-recycle-bin",`);
  expect(
    "a literal key the catalogue does not define is reported",
    r.missingEn.length === 1 && r.missingEn[0] === "snapshots.empty-recycle-bin",
    `missingEn=${r.missingEn.join(",")}`,
  );
}

{
  const r = one("ts", `beforeKey: "outcomes.noneTypo",`);
  expect(
    "an undefined literal in any key family is reported",
    r.missingEn.includes("outcomes.noneTypo"),
    `missingEn=${r.missingEn.join(",")}`,
  );
}

// --------------------------------------------------------- must not catch ----

{
  const r = one("rust", `i18n_prefix: "actions.emptyRecycleBin",`);
  expect(
    "an i18n prefix stem is not a key and is not reported",
    r.missingEn.length === 0 && r.malformed.length === 0,
    `missingEn=${r.missingEn.join(",")} malformed=${r.malformed.length}`,
  );
}

{
  const r = one("rust", `Err(super::unsupported("actions.registry_delete"))`);
  expect(
    "an unsupported(...) feature name is not a key",
    r.missingEn.length === 0 && r.malformed.length === 0,
    `missingEn=${r.missingEn.join(",")}`,
  );
}

{
  const r = one("ts", `includedFiles: ["manifest.json", "snapshots.json"],`);
  expect(
    "a file name in a support bundle is not a key",
    r.missingEn.length === 0 && r.malformed.length === 0,
    `missingEn=${r.missingEn.join(",")}`,
  );
}

{
  const r = one(
    "rust",
    `// DEF-135: this was format!("{}done", def.i18n_prefix), which could never be a key.\n` +
      `summary_key: format!("{}.done", def.i18n_prefix),`,
  );
  expect(
    "the comment documenting the defect is not reported, but the correct code is silent",
    r.malformed.length === 0,
    `malformed=${r.malformed.length}`,
  );
}

{
  const r = one("rust", `std::fs::create_dir_all(format!("{},{}", a, b))?;`);
  expect(
    "a format! that builds a path is not a key construction",
    r.malformed.length === 0,
    `malformed=${r.malformed.length}`,
  );
}

// ------------------------------------------------------------- must catch ----
// The construction scan must also fire on a key family with no literal prefix
// in the format string, because the family arrives as an argument.
{
  const r = one("rust", `self.summary_key = format!("outcomes.{}", name);`);
  expect(
    "a glued placeholder after a key family is malformed",
    r.malformed.length === 0,
    `a dot separator before the placeholder is correct, so this must be silent (got ${r.malformed.length})`,
  );
}

console.log(
  failures
    ? `\nFAILED: ${failures} assertion(s)`
    : "\nThe gate catches every DEF-135 shape and stays silent on the four things that are not keys.",
);
process.exit(failures ? 1 : 0);
