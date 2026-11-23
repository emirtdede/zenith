#!/usr/bin/env node
/**
 * ADR-012 gate: the simulator must not be able to touch the OS.
 *
 * Run: `node scripts/check-simulator.mjs`
 *
 * A comment saying "this file imports nothing native" is worth nothing. This
 * script parses the simulator's actual import graph and fails if any reachable
 * module imports `@tauri-apps/*`, `node:*`, `fs`, `child_process`, or `path`.
 *
 * The rule is deliberately about *reachability*, not the entry file: a helper
 * three hops away that imports `invoke` would defeat a single-file check.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "..", "src");
const entry = join(srcRoot, "bridge", "simulator.ts");

const FORBIDDEN = [
  /^@tauri-apps\//,
  /^node:/,
  /^(fs|path|child_process|os|net|http|https|dns|crypto)$/,
];

/** Resolve `./x` and `../x` to a file on disk, trying TS/TSX/index. */
function resolveRelative(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  return candidates.find((candidate) => existsSync(candidate) && !candidate.endsWith("/")) ?? null;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g;
const SIDE_EFFECT_RE = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
const DYNAMIC_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

function importsOf(file) {
  const source = readFileSync(file, "utf8");
  const found = new Set();
  for (const re of [IMPORT_RE, SIDE_EFFECT_RE, DYNAMIC_RE]) {
    // Reset lastIndex: these are module-level regexes reused across files.
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source)) !== null) {
      found.add(match[1]);
    }
  }
  return [...found];
}

const visited = new Set();
const queue = [entry];
const violations = [];
const graph = [];

while (queue.length > 0) {
  const file = queue.shift();
  if (visited.has(file)) {
    continue;
  }
  visited.add(file);
  graph.push(file);

  for (const specifier of importsOf(file)) {
    const forbidden = FORBIDDEN.find((pattern) => pattern.test(specifier));
    if (forbidden) {
      violations.push({
        file: file.replace(srcRoot, "src"),
        specifier,
      });
      continue;
    }
    // Only relative imports are followed; a bare package specifier that is not
    // forbidden (e.g. `react`) is a pure library and is allowed.
    if (specifier.startsWith(".")) {
      const resolved = resolveRelative(file, specifier);
      if (!resolved) {
        violations.push({
          file: file.replace(srcRoot, "src"),
          specifier,
          reason: "relative import does not resolve",
        });
        continue;
      }
      queue.push(resolved);
    }
  }
}

console.log(`Simulator import graph: ${graph.length} module(s)`);
for (const file of graph) {
  console.log(`  ${file.replace(srcRoot, "src")}`);
}

if (violations.length > 0) {
  console.error(`\n${violations.length} violation(s) of ADR-012:`);
  for (const violation of violations) {
    console.error(
      `  - ${violation.file} imports "${violation.specifier}"${violation.reason ? ` (${violation.reason})` : ""}`,
    );
  }
  console.error(
    "\nThe simulator must stay pure. Move the native call behind src/bridge/native.ts.",
  );
  process.exit(1);
}

// A graph of one module means the walk never followed an import, which would
// make the check vacuous. Fail loudly instead of passing on a broken parser.
if (graph.length < 4) {
  console.error(
    `\nOnly ${graph.length} module(s) reached; expected the simulator to pull in the catalog and the shared types.`,
  );
  process.exit(1);
}

console.log("\nNo native import is reachable from the simulator. ADR-012 holds.");
