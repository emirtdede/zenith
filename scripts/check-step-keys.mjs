/**
 * Emitted-key coverage audit.
 *
 * The core and the simulator emit catalogue keys as strings and the renderer
 * turns them into human text. Three things can silently break that:
 *
 *   1. a key that is emitted but not in the catalogue - the user sees the raw
 *      key (or `⟦key⟧`);
 *   2. a key *built* in a shape no catalogue can ever define, which is how
 *      DEF-135 shipped: `format!("{}done", prefix)` produced
 *      `actions.emptyRecycleBindone`, and it leaked into the audit export, the
 *      status line and the snapshot ledger;
 *   3. a catalogue key that no code path can emit - dead configuration.
 *
 * The analysis lives in `scripts/lib/key-scan.mjs` so
 * `scripts/check-step-keys-negative.mjs` can prove it fails on the defect it was
 * written for, using synthetic sources instead of editing product files.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { analyse, catalogueKeys } from "./lib/key-scan.mjs";

const ROOT = "C:/Users/emir/Desktop/Zenith";

function files(dir, exts, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "target" || entry === "dist") continue;
      files(full, exts, out);
    } else if (exts.some((e) => full.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

const rel = (p) => p.replace(`${ROOT}/`, "").replaceAll("\\", "/");

// Tests may deliberately reference keys that do not exist (a fixture naming a
// future key is a fixture, not a product string), so `.test.ts(x)` is excluded.
const sources = [
  ...[...files(`${ROOT}/crates`, [".rs"]), ...files(`${ROOT}/src-tauri`, [".rs"])].map((p) => ({
    path: rel(p),
    text: readFileSync(p, "utf8"),
    kind: "rust",
  })),
  ...files(`${ROOT}/src`, [".ts", ".tsx"])
    .filter((f) => !/\.test\.tsx?$/.test(f))
    .map((p) => ({ path: rel(p), text: readFileSync(p, "utf8"), kind: "ts" })),
];

const en = catalogueKeys(readFileSync(`${ROOT}/src/i18n/en.ts`, "utf8"));
const tr = catalogueKeys(readFileSync(`${ROOT}/src/i18n/tr.ts`, "utf8"));

// The one list of actions, so a new action cannot add an unchecked key.
const catalog = readFileSync(`${ROOT}/src/catalog.generated.ts`, "utf8");
const dynamicDonePrefixes = [...catalog.matchAll(/i18nPrefix: '([^']+)'/g)].map((m) => m[1]);

const result = analyse(sources, { en, tr, dynamicDonePrefixes });

console.log(`emitted keys:                ${result.emitted.size}`);
console.log(`catalogue keys:              ${en.size}`);
console.log(`missing from en:             ${result.missingEn.length}`);
for (const k of result.missingEn) {
  console.log(`  MISSING en ${k}  <- ${[...result.emitted.get(k)].join("; ")}`);
}
console.log(`missing from tr:             ${result.missingTr.length}`);
for (const k of result.missingTr) {
  console.log(`  MISSING tr ${k}  <- ${[...result.emitted.get(k)].join("; ")}`);
}
console.log(`core-owned with no emitter:  ${result.unused.length}`);
for (const k of result.unused) console.log(`  UNUSED ${k}`);
console.log(`malformed key constructions: ${result.malformed.length}`);
for (const m of result.malformed) {
  console.log(
    `  MALFORMED ${m.path}:${m.line}  ${m.literal}  (${m.kind}: a placeholder is glued to a word character, so the built key has no separator)`,
  );
}

const failed =
  result.missingEn.length + result.missingTr.length + result.unused.length + result.malformed.length;
process.exit(failed ? 1 : 0);
