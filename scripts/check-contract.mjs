#!/usr/bin/env node
/**
 * T-CONTRACT-08/09: the document, the Rust registry, and the frontend bridge
 * must name exactly the same commands, events and error keys.
 *
 * Run: `node scripts/check-contract.mjs`
 *
 * This is a text gate, not a Rust test, because the contract lives in Markdown
 * and the renderer lives in TypeScript. Parsing the three real artifacts is the
 * only way to catch "documented but not implemented" and "implemented but not
 * documented" with one check.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const doc = read("docs/03-architecture/03-04-ipc-contract.md");
const commandsRs = read("src-tauri/src/commands.rs");
const libRs = read("src-tauri/src/lib.rs");
const nativeTs = read("src/bridge/native.ts");
const adapterTs = read("src/bridge/adapter.ts");
const en = read("src/i18n/en.ts");
const tr = read("src/i18n/tr.ts");

const failures = [];

/** Commands documented in §3. */
const documented = [...doc.matchAll(/^\|\s*\d+\s*\|\s*`([a-z0-9_]+)`\s*\|/gm)].map(
  (match) => match[1],
);

/** Commands declared with the Tauri attribute. */
const declared = [
  ...commandsRs.matchAll(/#\[tauri::command\]\s*\n\s*pub\s+(?:async\s+)?fn\s+([a-z0-9_]+)/g),
].map((match) => match[1]);

/** Commands registered in the invoke handler. */
const handlerBlock = libRs.split("generate_handler![")[1]?.split("]")[0] ?? "";
const registered = [...handlerBlock.matchAll(/commands::([a-z0-9_]+)/g)].map(
  (match) => match[1],
);

/** Commands the renderer can actually call. */
const called = new Set(
  [...nativeTs.matchAll(/\bcall\("([a-z0-9_]+)"/g)].map((match) => match[1]),
);

function compare(label, left, right) {
  const a = [...left].sort();
  const b = [...right].sort();
  const missing = a.filter((item) => !b.includes(item));
  const extra = b.filter((item) => !a.includes(item));
  if (missing.length > 0 || extra.length > 0) {
    failures.push(
      `${label}: missing [${missing.join(", ")}] · extra [${extra.join(", ")}]`,
    );
  }
}

compare("doc ↔ #[tauri::command]", documented, declared);
compare("doc ↔ generate_handler!", documented, registered);
compare("doc ↔ native.ts call sites", documented, called);

if (documented.length !== 15) {
  failures.push(`expected 15 commands in the contract table, found ${documented.length}`);
}

/** Events documented in §6. */
const documentedEvents = [
  ...doc.matchAll(/^\|\s*`([a-z_]+)`\s*\|\s*`\{ v,? ?/gm),
].map((match) => match[1]);

const eventBlock = adapterTs.split("export interface EventMap {")[1]?.split("\n}")[0] ?? "";
const declaredEvents = [...eventBlock.matchAll(/^\s{2}([a-z_]+):\s*\{/gm)].map(
  (match) => match[1],
);
compare("doc events ↔ EventMap", documentedEvents, declaredEvents);

/**
 * Error codes documented in §7 must resolve in both shipped catalogues.
 *
 * The document names the exact `messageKey` and `remedyKey`; deriving them from
 * the code would let a doc/code mismatch through, which is the bug this gate
 * exists to catch.
 */
const errorRows = [
  ...doc.matchAll(
    /^\|\s*`([A-Z][A-Z0-9_]+)`\s*\|\s*[a-z]+\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/gm,
  ),
].map((match) => ({ code: match[1], messageKey: match[2], remedyKey: match[3] }));

if (errorRows.length < 20) {
  failures.push(`expected the full error catalogue, found ${errorRows.length} rows`);
}

for (const row of errorRows) {
  for (const [locale, source] of [
    ["en", en],
    ["tr", tr],
  ]) {
    for (const key of [row.messageKey, row.remedyKey]) {
      if (!source.includes(`"${key}"`)) {
        failures.push(`${locale}.ts is missing "${key}" (${row.code})`);
      }
    }
  }
}

console.log(`commands: ${documented.length} documented, ${declared.length} declared, ${registered.length} registered, ${called.size} called`);
console.log(`events:   ${documentedEvents.length} documented, ${declaredEvents.length} in EventMap`);
console.log(`errors:   ${errorRows.length} codes checked in en + tr`);

if (failures.length > 0) {
  console.error(`\n${failures.length} contract failure(s):`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log("\nContract holds: document = Rust registry = frontend bridge.");
