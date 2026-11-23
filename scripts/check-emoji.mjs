#!/usr/bin/env node
/**
 * `check:emoji` - the project ships no pictographic emoji.
 *
 * Emoji are the one category of text that has no stable rendering: the same
 * code point is a colour glyph on Windows 11, a monochrome outline in WebView2
 * on a stripped Windows 10 image, and a tofu box inside the NSIS wizard, whose
 * font is chosen by Windows rather than by us. A screenshot taken on the
 * developer machine therefore lies about what a reviewer will see, and the
 * emoji that renders in the README does not render in the installer.
 *
 * The rule is the Unicode property, not a hand-maintained list:
 *
 *   * any character with `Emoji_Presentation=Yes` (U+2705, U+1F7E5, ...);
 *   * any `Emoji=Yes` character followed by U+FE0F, the presentation selector
 *     (U+26A0 U+FE0F, U+2764 U+FE0F, ...);
 *   * the zero-width joiner U+200D, which only appears inside emoji sequences
 *     in first-party text.
 *
 * This deliberately does not ban text-default symbols such as U+2605 (star),
 * U+2713 (check) or U+00A9 (copyright): they are typography, not pictographs,
 * and the project uses words for every status marker instead.
 *
 * Exempt (byte-stable third-party or binary material):
 *   * `resources/licenses/**` and `resources/sbom/**`;
 *   * `node_modules`, `target`, `dist`, `.git`, `tools`;
 *   * `evidence/screens/**` (PNG);
 *   * the `[EK-*]` attachment files.
 *
 * Usage: `node scripts/check-emoji.mjs`
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP =
  /node_modules|[\\/]target[\\/]|[\\/]dist[\\/]|[\\/]\.git[\\/]|resources[\\/]licenses|resources[\\/]sbom|evidence[\\/]screens|[\\/]tools[\\/]|\[EK-[^\]]+\]/;
const EXTS = /\.(ts|tsx|rs|mjs|js|md|json|toml|css|html|ps1|yml|yaml|nsh|txt|xml|sql)$/i;

const PRESENTATION = /\p{Emoji_Presentation}/u;
const EMOJI = /\p{Emoji}/u;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (SKIP.test(full)) continue;
    if (entry.isDirectory()) walk(full, out);
    else if (EXTS.test(full)) out.push(full);
  }
  return out;
}

function isEmojiSequence(char, next) {
  if (PRESENTATION.test(char)) return true;
  if (char === "\u200D") return true;
  return next === "\uFE0F" && EMOJI.test(char);
}

const violations = [];
let scanned = 0;

for (const file of walk(ROOT)) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  scanned += 1;
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const chars = [...line];
    const hits = [];
    for (let index = 0; index < chars.length; index += 1) {
      if (isEmojiSequence(chars[index], chars[index + 1])) {
        const code = chars[index].codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
        hits.push(`U+${code}`);
      }
    }
    if (hits.length > 0) {
      violations.push({
        rel,
        line: i + 1,
        hits: hits.length,
        codes: [...new Set(hits)].join(" "),
        text: line.trim().slice(0, 120),
      });
    }
  });
}

console.log(`scanned ${scanned} first-party text files`);

if (violations.length > 0) {
  const total = violations.reduce((n, v) => n + v.hits, 0);
  console.error(`\n${total} emoji sequence(s) in ${violations.length} line(s):`);
  for (const v of violations.slice(0, 60)) {
    console.error(`  ${v.rel}:${v.line}  ${v.hits}x ${v.codes}  ${v.text}`);
  }
  if (violations.length > 60) console.error(`  ... and ${violations.length - 60} more`);
  console.error(
    "\nUse words or the project's own SVG icons instead. Status markers are\n" +
      "spelled PASS, FAIL, WARN and TODO; there is no emoji exception.",
  );
  process.exit(1);
}

console.log("no emoji: every first-party text file is free of pictographic emoji.");
