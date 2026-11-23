#!/usr/bin/env node
/**
 * Locale integrity gate.
 *
 * Run: `node scripts/check-locales.mjs`
 *
 * Three failures this catches, all of which have shipped in real products:
 *
 * 1. **A missing key.** The user sees `⟦some.key⟧` instead of a sentence.
 * 2. **A renamed placeholder.** `{count}` in English, `{counts}` in Turkish -
 *    the Turkish build renders the literal placeholder text.
 * 3. **An extra placeholder** the source does not pass, which usually means a
 *    translator copied a string from another key entirely.
 *
 * The English catalogue is the schema. Every other catalogue must match it exactly.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const i18nDir = join(here, "..", "src", "i18n");

/** Pull `"key": "value"` pairs out of a TS catalogue. */
function parseCatalogue(file) {
  const source = readFileSync(file, "utf8");
  const entries = new Map();
  // The value may start on the next line: the catalogues are formatted, and a
  // long sentence is wrapped after the colon. Without the `s` flag those keys
  // were invisible here while `check-doc-counts` counted them, so the two gates
  // disagreed about the size of the catalogue by exactly the number of wrapped
  // strings.
  //
  // The key class includes `-` because the notification keys are hyphenated
  // (`notify.profile.in-app-only`, `notify.kind.action-complete`). Without it
  // eight keys were never parity-checked: a missing Turkish translation of the
  // "In-app only" preset would have rendered as a raw key in Settings.
  const re = /^\s*"([a-zA-Z0-9._-]+)":\s*"((?:[^"\\]|\\.)*)"/gms;
  let match;
  while ((match = re.exec(source)) !== null) {
    entries.set(match[1], match[2]);
  }
  return entries;
}

/**
 * Placeholder names used by one pattern, following the same grammar `format.ts`
 * parses: `{name}` and `{name, plural, …}` / `{name, select, …}`.
 *
 * A naive `/\{(\w+)\}/` regex is wrong: it finds `{Yok}` inside the Turkish
 * plural branch `=0 {Yok} one {1 öğe}` and reports a placeholder that does not
 * exist. The scanner below walks balanced braces and only reads the header of
 * each argument, which is exactly what the formatter does.
 */
function placeholders(pattern) {
  const names = new Set();
  let index = 0;

  while (index < pattern.length) {
    const open = pattern.indexOf("{", index);
    if (open === -1) {
      break;
    }

    // Find the matching close brace for this argument.
    let depth = 0;
    let end = -1;
    for (let cursor = open; cursor < pattern.length; cursor += 1) {
      if (pattern[cursor] === "{") {
        depth += 1;
      } else if (pattern[cursor] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = cursor;
          break;
        }
      }
    }
    if (end === -1) {
      break;
    }

    const body = pattern.slice(open + 1, end);
    // The argument name is the text before the first top-level comma.
    const header = body.split(",")[0].trim();
    if (/^[a-zA-Z0-9_]+$/.test(header)) {
      names.add(header);
    }

    index = end + 1;
  }

  return names;
}

const files = readdirSync(i18nDir).filter(
  (name) =>
    name.endsWith(".ts") &&
    !name.endsWith(".test.ts") &&
    name !== "format.ts" &&
    name !== "index.tsx" &&
    // A catalogue is identified by its content, not by living in this folder:
    // `languages.ts` and the `chrome/` layer are registries, and parsing them as
    // catalogues would report every key as missing from a file that was never
    // meant to hold one. The marker is the product name every full catalogue
    // must carry.
    readFileSync(join(i18nDir, name), "utf8").includes('"app.name"'),
);
if (!files.includes("en.ts")) {
  console.error("src/i18n/en.ts is missing; it is the schema every locale is checked against.");
  process.exit(1);
}

const base = parseCatalogue(join(i18nDir, "en.ts"));
const problems = [];

if (base.size < 100) {
  console.error(`English catalogue parsed only ${base.size} keys; the parser is probably wrong.`);
  process.exit(1);
}

for (const file of files) {
  const locale = file.replace(/\.ts$/, "");
  const catalogue = parseCatalogue(join(i18nDir, file));

  for (const [key, english] of base) {
    const translated = catalogue.get(key);
    if (translated === undefined) {
      problems.push(`${locale}: missing key "${key}"`);
      continue;
    }
    if (translated.trim() === "") {
      problems.push(`${locale}: empty value for "${key}"`);
      continue;
    }

    const expected = placeholders(english);
    const actual = placeholders(translated);

    for (const name of expected) {
      if (!actual.has(name)) {
        problems.push(`${locale}: "${key}" lost placeholder {${name}}`);
      }
    }
    for (const name of actual) {
      if (!expected.has(name)) {
        problems.push(`${locale}: "${key}" has unknown placeholder {${name}}`);
      }
    }
  }

  for (const key of catalogue.keys()) {
    if (!base.has(key)) {
      problems.push(`${locale}: key "${key}" does not exist in English`);
    }
  }

  console.log(`${locale}: ${catalogue.size} keys checked`);
}

if (problems.length > 0) {
  console.error(`\n${problems.length} locale problem(s):`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

// A catalogue that is byte-identical to English is almost always a forgotten
// translation, not a coincidence. Turkish and English share no sentence.
for (const file of files) {
  if (file === "en.ts") {
    continue;
  }
  const catalogue = parseCatalogue(join(i18nDir, file));
  let identical = 0;
  for (const [key, english] of base) {
    if (catalogue.get(key) === english) {
      identical += 1;
    }
  }
  const ratio = identical / base.size;
  if (ratio > 0.25) {
    console.error(
      `\n${file}: ${identical}/${base.size} strings are identical to English (${(ratio * 100).toFixed(0)}%). Untranslated?`,
    );
    process.exit(1);
  }
  console.log(`${file}: ${identical} string(s) identical to English (${(ratio * 100).toFixed(1)}%)`);
}

console.log(`\nAll ${files.length} locales agree with English on ${base.size} keys.`);
