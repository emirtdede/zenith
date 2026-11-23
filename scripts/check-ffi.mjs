#!/usr/bin/env node
/**
 * FFI documentation gate (`03-06` §2, `07-01` T-RS-04).
 *
 * The crate-wide `#![deny(clippy::undocumented_unsafe_blocks)]` only sees the
 * code that clippy actually compiles. On a non-Windows machine every
 * `#[cfg(windows)]` adapter is stripped before the lint runs, so the Windows FFI
 * surface - the part that can corrupt memory - is never checked locally.
 *
 * This gate reads the source instead of the build. The counting lives in
 * `scripts/lib/ffi-measure.mjs` so that `check:doc-counts` quotes exactly the
 * numbers this gate enforces. They used to count separately: the scorecard read
 * 109 blocks / 111 comments / 44 files while this gate printed 106 / 109 / 45,
 * and nothing compared the two.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { measureFfi } from "./lib/ffi-measure.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { files, blocks, impls, documented, safetyComments, problems } = measureFfi(root);

if (files === 0) {
  console.error("No Rust sources found; the gate is pointed at the wrong directory.");
  process.exit(1);
}
if (blocks === 0) {
  console.error("Parsed zero unsafe blocks, which cannot be right for this crate.");
  process.exit(1);
}
// DEF-158: an `unsafe impl` is an unsafe construct whose correctness is the
// programmer's promise, and until the counter above existed the gate could not
// see one. Zero impls would mean the parser regressed, not that the crate has
// none: `child.rs` alone declares two.
if (impls === 0) {
  console.error("Parsed zero unsafe impls; the crate declares them in adapters/child.rs.");
  process.exit(1);
}

console.log(`files: ${files}`);
console.log(`unsafe blocks: ${blocks}`);
console.log(`unsafe impls: ${impls}`);
console.log(`documented: ${documented}`);
console.log(`// SAFETY: comments: ${safetyComments}`);

if (problems.length > 0) {
  console.error(`\n${problems.length} undocumented unsafe construct(s):`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

if (documented !== blocks + impls) {
  console.error(
    `documented ${documented} does not equal blocks+impls ${blocks + impls}; the count is inconsistent.`,
  );
  process.exit(1);
}

console.log("\nEvery unsafe block and unsafe impl carries a SAFETY comment.");
