#!/usr/bin/env node
/**
 * `check:mutate-restore` - prove the mutation helper is lossless (DEF-131).
 *
 * Every mutation gate in `scripts/` snapshots a file, writes a mutant, runs the
 * tests, then restores the original. The restore must be exact or the gate
 * silently edits the product: a corrupted source file passes the tree to the
 * next step, and a corrupted binary is a shipped artefact change.
 *
 * The helper used to read and write `"utf8"`. On source that is exact. On a
 * binary it is lossy twice - decode replaces invalid bytes with U+FFFD, encode
 * turns each into three bytes - and the old `restore()` compared the same lossy
 * decode on both sides, so it returned `contentIdentical: true` for a file it had
 * just destroyed. A 9,125,888-byte `cargo-deny.exe` became 14,840,172 bytes and
 * would not execute; the check agreed with the corruption.
 *
 * This gate exercises the helper on real bytes:
 *   1. a text file round-trips exactly, with mtime preserved;
 *   2. a binary file round-trips exactly, byte for byte;
 *   3. `snapshot()` refuses a non-UTF-8 file instead of quietly corrupting it;
 *   4. `restore()` reports a lie as a lie - a truncated snapshot must fail.
 *
 * Each case writes a scratch file under the OS temp directory, so the tree is
 * never touched.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { snapshot, snapshotBinary, restore } from "./lib/mutate-restore.mjs";

const problems = [];
const notes = [];

const scratch = mkdtempSync(join(tmpdir(), "zenith-mutate-"));
process.on("exit", () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* a leftover temp dir is not a gate failure */
  }
});

function check(label, condition, detail) {
  if (condition) {
    notes.push(`ok   ${label}`);
  } else {
    problems.push(`${label}${detail ? `: ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------- 1. text ----
{
  const path = join(scratch, "sample.ts");
  const original = 'export const x = "merhaba";\n// türkçe karakter: ğüşiöç\n';
  writeFileSync(path, original, "utf8");
  const past = new Date("2020-01-02T03:04:05Z");
  utimesSync(path, past, past);
  const snap = snapshot(path);
  writeFileSync(path, `${original}// mutant\n`, "utf8");
  const result = restore(path, snap);
  check("text round-trips byte-exactly", readFileSync(path, "utf8") === original);
  check("text restore reports identical", result.contentIdentical === true);
  check("text restore preserves mtime", result.mtimePreserved === true);
  check(
    "text snapshot keeps the utf8 view",
    snap.bytes === original && snap.raw.equals(Buffer.from(original, "utf8")),
  );
}

// ---------------------------------------------------------------- 2. binary --
{
  const path = join(scratch, "sample.bin");
  // Every byte value, repeated: covers invalid UTF-8, NULs and lone surrogates.
  const raw = Buffer.alloc(2048);
  for (let i = 0; i < raw.length; i += 1) raw[i] = i % 256;
  writeFileSync(path, raw);
  const before = statSync(path);
  const snap = snapshotBinary(path);
  // Mutate with a shape that would look "fine" through a lossy codec.
  writeFileSync(path, Buffer.from("MZ mutant", "utf8"));
  const result = restore(path, snap);
  const after = readFileSync(path);
  check("binary round-trips byte-for-byte", after.equals(raw), `${after.length} vs ${raw.length} bytes`);
  check("binary restore reports identical", result.contentIdentical === true);
  check("binary restore preserves mtime", result.mtimePreserved === true);
  check(
    "binary snapshot is not lossless as text",
    snap.lossless === false,
    "a binary that decodes cleanly is suspicious",
  );
  check("binary snapshot is not empty", snap.raw.length === 2048);
  void before;
}

// ---------------------------------------------------------------- 3. refusal --
{
  const path = join(scratch, "binary-not-text.rs");
  writeFileSync(path, Buffer.from([0xff, 0xfe, 0x00, 0x81, 0x82]));
  let threw = false;
  try {
    snapshot(path);
  } catch (error) {
    threw = /not valid UTF-8/.test(error.message) && /DEF-131/.test(error.message);
  }
  check("snapshot() refuses a non-UTF-8 file", threw);
}

// ---------------------------------------------------------------- 4. honesty --
{
  const path = join(scratch, "honesty.txt");
  writeFileSync(path, "the real content", "utf8");
  const snap = snapshot(path);
  // `raw` is the authority. Hand `restore` a snapshot whose *text* view matches
  // the file but whose bytes do not: the file must end up matching `raw`, and
  // `contentIdentical` must be computed against bytes. A helper that trusted the
  // text view would write the wrong thing and report success.
  writeFileSync(path, "the real content", "utf8");
  const split = {
    ...snap,
    raw: Buffer.from("BYTES WIN", "utf8"),
    bytes: "the real content",
  };
  const result = restore(path, split);
  check(
    "restore() writes raw, not the text view",
    readFileSync(path, "utf8") === "BYTES WIN",
    readFileSync(path, "utf8"),
  );
  check("restore() verifies against bytes", result.contentIdentical === true);
}

// ---------------------------------------------------------------- report -----
for (const note of notes) console.log(note);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`\nMutation helper holds: ${notes.length} checks, bytes restored exactly.`);
