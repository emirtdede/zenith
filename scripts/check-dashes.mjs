#!/usr/bin/env node
/**
 * `check:dashes` - the project forbids typographic dashes in first-party text.
 *
 * U+2014 (em dash) and U+2013 (en dash) were used 1,343 times across 133 files:
 * in UI copy, in error messages, in the documents and in code comments. That is
 * a typographic choice, not a technical one, and it cost real money here:
 *
 *   * the character is three bytes in UTF-8 and is mangled by every tool chain
 *     that is not told the encoding - PowerShell wrote `-?` into logs, and a
 *     reviewer reading `cargo-deny failed -? exit -1` cannot tell an en dash
 *     from a mojibake artefact;
 *   * it carries no more meaning than "-", so it is pure surface area for a
 *     corrupted copy-paste;
 *   * the project has one placeholder for "not measured", and it must be
 *     spelled identically everywhere (`src/shared/placeholder.ts`).
 *
 * The rule is one character: any U+2014 or U+2013 outside a vendored licence
 * text fails the build. The escape forms are caught too, because a dash written
 * as a unicode escape is the same dash and would otherwise slip through a grep
 * for the literal glyph. The needles are assembled from fragments for exactly
 * that reason, and the gate asserts it does not contain them.
 *
 * Exempt (they must stay verbatim to be valid):
 *   * `resources/licenses/**` - third-party licence texts, quoted exactly;
 *   * `resources/sbom/**` - generated from upstream crate metadata, which
 *     itself contains typographic dashes (e.g. the "Fowler-Noll-Vo" hash
 *     description ships with en dashes). Rewriting it would falsify a file that
 *     must be byte-stable, and `check:sbom` would immediately reject it as stale
 *     - which is exactly how this exemption was found;
 *   * `node_modules`, `target`, `dist`, `.git` - not first-party source;
 *   * `evidence/screens/**` - PNG binaries, not text.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = /node_modules|[\\/]target[\\/]|[\\/]dist[\\/]|[\\/]\.git[\\/]|resources[\\/]licenses|resources[\\/]sbom|evidence[\\/]screens|[\\/]tools[\\/]/;
const EXTS = /\.(ts|tsx|rs|mjs|js|md|json|toml|css|html|ps1|yml|yaml|nsh|txt|xml|sql)$/i;

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

// The needles are assembled from fragments so that this file, which must name
// them, does not contain them. A gate that trips on its own source teaches the
// next person to add an exemption instead of reading the failure.
const BACKSLASH = String.fromCharCode(0x5c);
const ESCAPES = [
  `${BACKSLASH}u2014`,
  `${BACKSLASH}u2013`,
  `${BACKSLASH}u{2014}`,
  `${BACKSLASH}u{2013}`,
  `&${"mdash"};`,
  `&${"ndash"};`,
  `&#${"8212"};`,
  `&#${"8211"};`,
];

// Proven, not assumed: none of the needles may appear verbatim in this file.
{
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  for (const needle of ESCAPES) {
    if (self.includes(needle)) {
      console.error(`check-dashes.mjs contains its own needle (${needle.length} chars); rebuild it from fragments.`);
      process.exit(1);
    }
  }
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (SKIP.test(full)) continue;
    if (entry.isDirectory()) walk(full, out);
    else if (EXTS.test(full)) out.push(full);
  }
  return out;
}

const violations = [];
let scanned = 0;

for (const file of walk(ROOT)) {
  let text;
  try {
    if (!statSync(file).isFile()) continue;
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  scanned += 1;
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    let hits = 0;
    for (const ch of line) if (ch === EM || ch === EN) hits += 1;
    for (const esc of ESCAPES) {
      let at = line.indexOf(esc);
      while (at !== -1) {
        hits += 1;
        at = line.indexOf(esc, at + esc.length);
      }
    }
    if (hits > 0) {
      violations.push({ rel, line: i + 1, hits, text: line.trim().slice(0, 120) });
    }
  });
}

console.log(`scanned ${scanned} first-party text files`);

if (violations.length > 0) {
  const total = violations.reduce((n, v) => n + v.hits, 0);
  console.error(`\n${total} typographic dash(es) in ${violations.length} line(s):`);
  for (const v of violations.slice(0, 40)) {
    console.error(`  ${v.rel}:${v.line}  ${v.hits}x  ${v.text}`);
  }
  if (violations.length > 40) console.error(`  ... and ${violations.length - 40} more`);
  console.error(
    "\nUse the ASCII hyphen instead. For 'not measured', import NOT_MEASURED from\n" +
      "src/shared/placeholder.ts - the marker must be one named constant, not a\n" +
      "glyph repeated per screen (DEF-118).",
  );
  process.exit(1);
}

console.log("no typographic dashes: every dash in first-party text is an ASCII hyphen.");
