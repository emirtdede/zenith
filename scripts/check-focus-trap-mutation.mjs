#!/usr/bin/env node
/**
 * Focus-trap mutation gate (DEF-086).
 *
 * The lesson of `10-01` §3.1.1 is that a green test proves only what it was
 * written to check. `useFocusTrap.test.tsx` has nine passing cases, and the
 * important question is whether the one that guards the *real* bug - `autoFocus`
 * moving focus on commit, before the effect could capture the trigger - actually
 * fails when the fix is removed.
 *
 * This removes exactly the render-time capture and asserts the suite goes red.
 * If it stays green, the regression test is decorative and this script fails.
 *
 * Usage: node scripts/check-focus-trap-mutation.mjs
 */

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

import { restore, snapshot } from "./lib/mutate-restore.mjs";

const file = "src/ui/useFocusTrap.ts";
const snap = snapshot(file);
const original = snap.bytes;

const captureBlock =
  /  const restoreTo = useRef<HTMLElement \| null>\(null\);\n  const captured = useRef\(false\);\n  if \(!captured\.current\) \{[\s\S]*?\n  \}\n/;

if (!captureBlock.test(original)) {
  console.error("FAIL: could not find the render-time capture block; the gate is out of date with the source");
  process.exit(2);
}

const mutated = original.replace(
  captureBlock,
  "  const restoreTo = useRef<HTMLElement | null>(null);\n",
);

let caught = false;
let summary = "";
let namedTest = false;

let result = { contentIdentical: false, mtimePreserved: false };

try {
  writeFileSync(file, mutated, "utf8");
  try {
    execSync("npx vitest run src/ui/useFocusTrap.test.tsx", { stdio: "pipe" });
  } catch (error) {
    const out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    const plain = out.replace(/\x1b\[[0-9;]*m/g, "");
    const m = plain.match(/Tests\s+(\d+) failed \| (\d+) passed/);
    summary = m ? `${m[2]} passed, ${m[1]} failed` : "(no vitest summary parsed)";
    namedTest = plain.includes("autoFocus field");
    caught = Boolean(m) && Number(m[1]) > 0 && namedTest;
  }
} finally {
  // Restore bytes *and* timestamps: the build-chain check compares the newest
  // source mtime against the binary, so a gate that leaves the mtime moved
  // breaks a check it is not even testing.
  result = restore(file, snap);
}

console.log(`mutation: removed the render-time capture in ${file}`);
console.log(`vitest:   ${summary}`);
console.log(`the autoFocus regression test failed: ${namedTest}`);
console.log(`restore:  ${result.contentIdentical ? "byte-identical" : "DIFFERS"}`);
console.log(`mtime:    ${result.mtimePreserved ? "preserved" : "MOVED"}`);

if (!result.contentIdentical) {
  console.error("FAIL: file was not restored byte-identically");
  process.exit(1);
}
if (!result.mtimePreserved) {
  console.error("FAIL: restore moved the file's mtime, corrupting the build-chain timestamp check");
  process.exit(1);
}
if (!caught) {
  console.error("FAIL: the regression test survived the mutation - it does not guard the bug it claims to");
  process.exit(1);
}
console.log("gate holds: the autoFocus regression test bites");
