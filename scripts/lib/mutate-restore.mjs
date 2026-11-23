import { readFileSync, writeFileSync, statSync, utimesSync } from "node:fs";

/**
 * Snapshot and restore a file **byte-exactly**, timestamps included.
 *
 * DEF-087's mutation gate rewrites `useFocusTrap.ts`, re-runs vitest, then puts
 * the original text back. The bytes were identical, but the mtime moved - and
 * that broke the build-chain check, which compares "newest source" against the
 * binary to prove every log postdates the shipped code. A gate that audits the
 * tree must not perturb the tree; restoring only content leaves a lie in the
 * filesystem metadata.
 *
 * ## Why this file reads bytes, not text (DEF-131)
 *
 * This helper used to be `readFileSync(path, "utf8")` in and out. On a text file
 * that is exact. On a binary it is lossy twice over: the decode replaces every
 * invalid sequence with U+FFFD, and the re-encode turns each of those into three
 * bytes. A 9,125,888-byte `cargo-deny.exe` was written back as 14,840,172
 * bytes and could no longer be executed - and `restore()` reported
 * `contentIdentical: true`, because it compared the same lossy decode on both
 * sides. The check agreed with the corruption.
 *
 * So: `raw` holds the real bytes, `restore` writes `raw`, and equality is
 * `Buffer.equals`. `bytes` (text) stays for the mutation scripts that edit source
 * with `.replace()`, and `snapshot()` refuses a file that cannot survive that
 * round-trip - a text mutation gate pointed at a binary is a bug in the caller,
 * and it should be caught before the file is written, not after.
 */

function readRaw(path) {
  const stat = statSync(path);
  const raw = readFileSync(path);
  const text = raw.toString("utf8");
  return {
    raw,
    bytes: text,
    lossless: Buffer.from(text, "utf8").equals(raw),
    atime: stat.atime,
    mtime: stat.mtime,
  };
}

/** Snapshot a **text** file. Throws if the bytes would not survive UTF-8. */
export function snapshot(path) {
  const snap = readRaw(path);
  if (!snap.lossless) {
    throw new Error(
      `${path} is not valid UTF-8 (${snap.raw.length} bytes). ` +
        "A text mutation gate cannot rewrite it without corrupting it - use " +
        "`snapshotBinary` and restore it rather than editing it (DEF-131).",
    );
  }
  return snap;
}

/** Snapshot any file, text or binary. */
export function snapshotBinary(path) {
  return readRaw(path);
}

/** Write the snapshot's exact bytes and timestamps back. */
export function restore(path, snap) {
  const raw = snap.raw ?? Buffer.from(snap.bytes, "utf8");
  writeFileSync(path, raw);
  utimesSync(path, snap.atime, snap.mtime);
  const stat = statSync(path);
  return {
    contentIdentical: readFileSync(path).equals(raw),
    mtimePreserved: stat.mtime.getTime() === snap.mtime.getTime(),
  };
}
