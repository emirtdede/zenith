#!/usr/bin/env node
/**
 * WCAG contrast gate for the three themes.
 *
 * Run: `node scripts/check-contrast.mjs`
 *
 * Why a script and not a claim in a document: the palette is the one part of
 * the UI that can regress silently. A designer nudging `--muted` by two percent
 * breaks AA for every secondary label, and nobody notices in review. This file
 * computes the real ratios from the real token values and fails CI.
 *
 * Thresholds (WCAG 2.2):
 *   4.5:1 - normal text (1.4.3 AA)
 *   3.0:1 - large text, UI component boundaries and focus indicators (1.4.11)
 *
 * The line colour is held to 3:1 not because it is "text" but because it is the
 * only visible boundary of an input, a card edge or a divider - a 1.3:1 border
 * is decoration, not an affordance.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const TEXT_MIN = 4.5;
const UI_MIN = 3.0;

function channelToLinear(value) {
  const srgb = value / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex) {
  const cleaned = hex.replace("#", "").trim();
  if (!/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    throw new Error(`not a six-digit hex colour: ${hex}`);
  }
  const [r, g, b] = [0, 2, 4].map((offset) =>
    channelToLinear(parseInt(cleaned.slice(offset, offset + 2), 16)),
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Parse the tokens out of `src/styles/tokens.css` so the gate cannot drift from
 * the stylesheet. Reading the file is the whole point: a hard-coded copy here
 * would test itself.
 */
function loadThemes(css) {
  const themes = {};
  const blocks = css.split(/\[data-theme="([a-z-]+)"\]/g);
  // blocks = [preamble, name, body, name, body, ...]
  for (let index = 1; index < blocks.length; index += 2) {
    const name = blocks[index];
    const body = blocks[index + 1] ?? "";
    const tokens = {};
    for (const match of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
      tokens[match[1]] = match[2];
    }
    // The shared block above the themes defines geometry and typography only.
    if (Object.keys(tokens).length > 0) {
      themes[name] = tokens;
    }
  }
  return themes;
}

const cssPath = join(here, "..", "src", "styles", "tokens.css");
const themes = loadThemes(readFileSync(cssPath, "utf8"));

if (Object.keys(themes).length !== 3) {
  console.error(
    `expected 3 themes in tokens.css, found ${Object.keys(themes).length}: ${Object.keys(themes).join(", ")}`,
  );
  process.exit(1);
}

const failures = [];
const rows = [];

for (const [theme, tokens] of Object.entries(themes)) {
  const surfaces = ["bg", "surface", "sunken"].filter((key) => tokens[key]);

  for (const key of ["text", "muted", "accent", "ok", "warn", "bad"]) {
    if (!tokens[key]) {
      failures.push(`${theme}: missing --${key}`);
      continue;
    }
    for (const surface of surfaces) {
      const ratio = contrast(tokens[key], tokens[surface]);
      rows.push([theme, key, surface, ratio, TEXT_MIN]);
      if (ratio < TEXT_MIN) {
        failures.push(
          `${theme}: --${key} on --${surface} is ${ratio.toFixed(2)}:1, needs ${TEXT_MIN}:1`,
        );
      }
    }
  }

  for (const key of ["line", "focus"]) {
    if (!tokens[key]) {
      failures.push(`${theme}: missing --${key}`);
      continue;
    }
    for (const surface of surfaces) {
      const ratio = contrast(tokens[key], tokens[surface]);
      rows.push([theme, key, surface, ratio, UI_MIN]);
      if (ratio < UI_MIN) {
        failures.push(
          `${theme}: --${key} on --${surface} is ${ratio.toFixed(2)}:1, needs ${UI_MIN}:1`,
        );
      }
    }
  }

  // Selection and focus must stay distinguishable from an ordinary surface.
  if (tokens["accent-soft"]) {
    const ratio = contrast(tokens["accent-soft"], tokens["surface"]);
    rows.push([theme, "accent-soft", "surface", ratio, 1.0]);
    if (ratio < 1.05) {
      failures.push(`${theme}: --accent-soft is indistinguishable from --surface`);
    }
  }
}

const width = Math.max(...rows.map((row) => row[0].length)) + 2;
for (const [theme, token, surface, ratio, min] of rows) {
  const verdict = ratio >= min ? "PASS" : "FAIL";
  console.log(
    `${theme.padEnd(width)}${token.padEnd(12)}on ${surface.padEnd(8)}${ratio.toFixed(2).padStart(6)}:1  (min ${min.toFixed(1)})  ${verdict}`,
  );
}

if (failures.length > 0) {
  console.error(`\n${failures.length} contrast failure(s):`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(`\nAll ${rows.length} checks pass in 3 themes.`);
