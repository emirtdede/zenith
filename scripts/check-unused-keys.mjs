/**
 * Unused-key audit (Zero-Stub L3: no dead configuration).
 *
 * Two earlier versions of this script were wrong, and both failures are worth
 * recording because they are the failure mode this library keeps hitting: the
 * gate reported what its regex could see, not what the app asks for.
 *
 *  - v1 looked only for literal `"key"` strings and flagged `risk.${def.risk}`
 *    and `tier.${def.tier}` - runtime-built keys - as dead.
 *  - v2 added template prefixes but still flagged all 44 `actions.*.title|desc`
 *    keys, which `ActionGrid` builds as `` `${def.i18nPrefix}.title` `` from the
 *    **generated** catalog.
 *
 * The rule now is grounded in real sources, not in guessing prefixes:
 *
 *   1. literal `"key"` in src/ or the Rust core;
 *   2. `tKey(def.metricKey)` style - any key family the manifest produces;
 *   3. `actions.<prefix>.<suffix>` where `<prefix>` is one of the 22
 *      `i18nPrefix` values in `src/catalog.generated.ts` and `<suffix>` is a
 *      template suffix the code actually appends (`.title`, `.desc`);
 *   4. `<family>.<value>` where the code contains `` `family.${...}` ``.
 *
 * Everything else is reported. No allowlist of "probably fine" keys: a key that
 * reaches no code path is shipped text nobody can see.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function files(dir, exts, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "target") continue;
      files(full, exts, out);
    } else if (exts.some((e) => full.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

const en = readFileSync("src/i18n/en.ts", "utf8");
const keys = [...en.matchAll(/^\s*"([A-Za-z0-9_.]+)":/gm)].map((m) => m[1]);
if (keys.length === 0) {
  console.error("FAIL: no keys parsed from src/i18n/en.ts - the shape changed");
  process.exit(2);
}

const sources = [
  ...files("src", [".ts", ".tsx"]),
  ...files("crates", [".rs"]),
  ...files("src-tauri", [".rs"]),
].filter((f) => !f.endsWith("en.ts") && !f.endsWith("tr.ts"));

const byFile = new Map(sources.map((f) => [f, readFileSync(f, "utf8")]));
const haystack = [...byFile.values()].join("\n");

/* --- family 3: generated action prefixes ------------------------------- */
const catalog = readFileSync("src/catalog.generated.ts", "utf8");
const actionPrefixes = [...catalog.matchAll(/i18nPrefix: '([^']+)'/g)].map((m) => m[1]);
if (actionPrefixes.length === 0) {
  console.error("FAIL: no i18nPrefix values in src/catalog.generated.ts - the shape changed");
  process.exit(2);
}

/* --- family 4: `${...}` template families ------------------------------ */
const dynPrefixes = new Set();
// Note the `.` inside the character class: `trust.signature.${...}` is a
// two-segment prefix, and an earlier version of this regex (`[A-Za-z0-9_]*\.`)
// silently missed it - reporting four live signature keys and seven live purge
// keys as dead. Found by reading TrustScreen.tsx against the report.
for (const m of haystack.matchAll(/`([A-Za-z0-9_.]*\.)\$\{/g)) {
  if (m[1]) dynPrefixes.add(m[1]); // `risk.${...}` -> "risk."
}
// Suffixes appended after an interpolation: `${def.i18nPrefix}.title`.
const dynSuffixes = new Set();
for (const m of haystack.matchAll(/\$\{[^}]+\}\.([A-Za-z0-9_]+)/g)) {
  dynSuffixes.add(m[1]); // "title"
}

const usedLiteral = [];
const usedAction = [];
const usedDynamic = [];
const unused = [];

for (const key of keys) {
  if (
    haystack.includes(`"${key}"`) ||
    haystack.includes(`'${key}'`) ||
    haystack.includes(`\`${key}\``)
  ) {
    usedLiteral.push(key);
    continue;
  }

  // 3. actions.<generatedPrefix>.title|desc
  const actionHit = actionPrefixes.some(
    (prefix) =>
      key.startsWith(`${prefix}.`) &&
      dynSuffixes.has(key.slice(prefix.length + 1)),
  );
  if (actionHit) {
    usedAction.push(key);
    continue;
  }

  // 4. <family>.<value> for a family the code interpolates
  let dynamic = false;
  for (const pre of dynPrefixes) {
    if (key.startsWith(pre)) {
      dynamic = true;
      break;
    }
  }
  if (dynamic) {
    usedDynamic.push(key);
    continue;
  }

  unused.push(key);
}

console.log(`catalogue keys:        ${keys.length}`);
console.log(`literal references:    ${usedLiteral.length}`);
console.log(`generated action keys: ${usedAction.length}`);
console.log(`template families:     ${usedDynamic.length}`);
console.log(`unused:                ${unused.length}`);
console.log(`action prefixes:       ${actionPrefixes.length}`);
console.log(`template families:     ${[...dynPrefixes].sort().join(" ")}`);
console.log(`template suffixes:     ${[...dynSuffixes].sort().join(" ")}`);
for (const k of unused) console.log(`  UNUSED ${k}`);
process.exit(unused.length ? 1 : 0);
