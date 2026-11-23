#!/usr/bin/env node
/**
 * WCAG 2.2 contrast gate for all fourteen palettes.
 *
 * Run: `node scripts/check-contrast.mjs`
 *
 * Why a script and not a claim in a document: the palette is the one part of the
 * UI that can regress silently. A designer nudging `textMuted` by two percent
 * breaks AA for every secondary label, and nobody notices in review.
 *
 * The values are read from `src/settings/palettes.json`, which is the same file
 * the renderer paints from. A gate that re-declared the colours would only test
 * its own copy; this one cannot disagree with the product.
 *
 * Thresholds:
 *   4.5:1 - normal text (1.4.3 AA): text-primary, text-secondary, text-muted, accent
 *   3.0:1 - large text, control boundaries and focus indicators (1.4.11):
 *           border-strong (the visible edge of an input, card or button)
 *   4.5:1 - a label on an accent-filled button (accent-fg on accent)
 *
 * `border` is a hairline divider, not an affordance, in every palette; it is
 * held to "distinguishable from the surface" (1.2:1) rather than to 3:1. The
 * distinction matters: forcing a 3:1 hairline turns every table into a grid.
 *
 * The semantic status colours live in `tokens.css` (mode-derived, not
 * palette-derived) and are checked from that file so a status badge keeps its
 * meaning in all fourteen palettes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

const TEXT_MIN = 4.5;
const UI_MIN = 3.0;
const DIVIDER_MIN = 1.2;

function channelToLinear(value) {
  const srgb = value / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex) {
  const cleaned = String(hex).replace("#", "").trim();
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

const palettes = JSON.parse(readFileSync(join(ROOT, "src", "settings", "palettes.json"), "utf8"));

const REQUIRED = [
  "canvas",
  "surface",
  "surfaceSubtle",
  "surfaceHover",
  "border",
  "borderStrong",
  "textPrimary",
  "textSecondary",
  "textMuted",
  "accent",
  "accentHover",
  "accentSoft",
  "accentRing",
  "accentFg",
  "accentText",
];

const failures = [];
const rows = [];

if (!Array.isArray(palettes) || palettes.length !== 14) {
  console.error(`expected 14 palettes in palettes.json, found ${Array.isArray(palettes) ? palettes.length : "none"}`);
  process.exit(1);
}

for (const palette of palettes) {
  for (const mode of ["light", "dark"]) {
    const tokens = palette[mode];
    if (!tokens) {
      failures.push(`${palette.id}: missing ${mode} token block`);
      continue;
    }
    for (const key of REQUIRED) {
      if (typeof tokens[key] !== "string" || tokens[key].length === 0) {
        failures.push(`${palette.id}/${mode}: missing ${key}`);
      }
    }
    if (failures.length > 0 && failures[failures.length - 1].startsWith(`${palette.id}/${mode}`)) {
      continue;
    }

    const surfaces = ["canvas", "surface", "surfaceSubtle"];
    const id = `${palette.id}/${mode}`;

    for (const key of ["textPrimary", "textSecondary", "textMuted", "accentText"]) {
      for (const surface of surfaces) {
        const ratio = contrast(tokens[key], tokens[surface]);
        rows.push([id, key, surface, ratio, TEXT_MIN]);
        if (ratio < TEXT_MIN) {
          failures.push(`${id}: ${key} on ${surface} is ${ratio.toFixed(2)}:1, needs ${TEXT_MIN}:1`);
        }
      }
    }

    for (const surface of ["canvas", "surface"]) {
      const ratio = contrast(tokens.borderStrong, tokens[surface]);
      rows.push([id, "borderStrong", surface, ratio, UI_MIN]);
      if (ratio < UI_MIN) {
        failures.push(
          `${id}: borderStrong on ${surface} is ${ratio.toFixed(2)}:1, needs ${UI_MIN}:1`,
        );
      }
      const divider = contrast(tokens.border, tokens[surface]);
      rows.push([id, "border", surface, divider, DIVIDER_MIN]);
      if (divider < DIVIDER_MIN) {
        failures.push(
          `${id}: border on ${surface} is ${divider.toFixed(2)}:1, needs ${DIVIDER_MIN}:1 (a divider must be visible)`,
        );
      }
    }

    const label = contrast(tokens.accentFg, tokens.accent);
    rows.push([id, "accentFg", "accent", label, TEXT_MIN]);
    if (label < TEXT_MIN) {
      failures.push(`${id}: accentFg on accent is ${label.toFixed(2)}:1, needs ${TEXT_MIN}:1`);
    }

    const ring = contrast(tokens.accentText, tokens.surface);
    rows.push([id, "accentText(ring)", "surface", ring, UI_MIN]);
    if (ring < UI_MIN) {
      failures.push(
        `${id}: accentText on surface is ${ring.toFixed(2)}:1, a focus ring needs ${UI_MIN}:1`,
      );
    }
  }
}

// ---------------------------------------------------- semantic status colours
const tokensCss = readFileSync(join(ROOT, "src", "styles", "tokens.css"), "utf8");

function readBlock(selector) {
  const index = tokensCss.indexOf(selector);
  if (index === -1) return {};
  const open = tokensCss.indexOf("{", index);
  const close = tokensCss.indexOf("}", open);
  const body = tokensCss.slice(open + 1, close);
  const found = {};
  for (const match of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    found[match[1]] = match[2];
  }
  return found;
}

const semanticLight = readBlock(":root {");
const semanticDark = readBlock('html[data-mode="dark"] {');

for (const [mode, block, canvases] of [
  ["light", semanticLight, ["#fafafa", "#ffffff"]],
  ["dark", semanticDark, ["#09090b", "#111114"]],
]) {
  for (const key of ["danger", "ok", "warn", "info"]) {
    if (!block[key]) {
      failures.push(`tokens.css (${mode}): missing --${key}`);
      continue;
    }
    for (const canvas of canvases) {
      const ratio = contrast(block[key], canvas);
      rows.push([`semantic/${mode}`, key, canvas, ratio, TEXT_MIN]);
      if (ratio < TEXT_MIN) {
        failures.push(
          `semantic/${mode}: ${key} on ${canvas} is ${ratio.toFixed(2)}:1, needs ${TEXT_MIN}:1`,
        );
      }
    }
  }
}

const width = Math.max(...rows.map((row) => row[0].length)) + 2;
for (const [id, token, surface, ratio, min] of rows) {
  const verdict = ratio >= min ? "PASS" : "FAIL";
  console.log(
    `${id.padEnd(width)}${token.padEnd(14)}on ${surface.padEnd(8)}${ratio.toFixed(2).padStart(6)}:1  (min ${min.toFixed(1)})  ${verdict}`,
  );
}

if (failures.length > 0) {
  console.error(`\n${failures.length} contrast failure(s):`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(
  `\nAll ${rows.length} checks pass across ${palettes.length} palettes (28 palettes with modes) and the semantic layer.`,
);
