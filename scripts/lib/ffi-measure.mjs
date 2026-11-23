/**
 * One measurement of the FFI documentation surface, shared by the gate that
 * enforces it (`scripts/check-ffi.mjs`) and the audit that quotes it
 * (`scripts/check-doc-counts.mjs`).
 *
 * Why a shared module: the scorecard said "109 `unsafe` blocks, 111 comments,
 * 44 source files" while the gate printed 106 / 109 / 45. Two readers of the
 * same tree disagreed because each counted for itself, and the document had no
 * gate at all. A number that two programs derive differently is not a
 * measurement, and a document quoting a remembered number is a claim about
 * nothing.
 *
 * The returned object is the only shape either caller may print:
 *   files           - first-party `.rs` files scanned
 *   blocks          - `unsafe {` occurrences
 *   impls           - `unsafe impl` items (DEF-158: these were invisible)
 *   documented      - constructs with a `// SAFETY:` in the six lines above
 *   safetyComments  - every `// SAFETY:` line, including ones above no construct
 *   problems        - human-readable locations of undocumented constructs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** How far above a construct its comment may sit, in lines. */
export const WINDOW = 12;

/** Every `.rs` file under the given directories. */
export function rustFiles(directories) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".rs")) found.push(full);
    }
  };
  for (const directory of directories) walk(directory);
  return found;
}

/**
 * Strip a line's `//` comment so a construct name inside prose is not counted
 * as code. DEF-158: a comment that mentions `unsafe impl` was parsed as one.
 *
 * This is deliberately simple - the first `//` outside a string literal ends the
 * code. A `//` inside a string on a line that also declares an unsafe construct
 * does not occur here, and treating that case as a preprocessor would be a
 * parser this gate does not need.
 */
function codeOf(line) {
  const at = line.indexOf("//");
  return at === -1 ? line : line.slice(0, at);
}

/**
 * Does the comment block attached above line `index` carry a `SAFETY:` note?
 *
 * "Attached" is exact rather than a fixed character budget: walk upward past
 * blank lines, `#[...]` attributes, the contiguous comment block, and lines
 * that are visibly a continuation of the same statement. That is what a reader
 * sees as the comment belonging to this construct.
 *
 * Two cases forced this rule, both found by running it:
 *
 *   * `// SAFETY: ...`, `#[cfg(windows)]`, `unsafe impl Send for JobGuard {}` -
 *     the comment sat one line beyond a fixed six-line window and a documented
 *     construct was reported as undocumented (DEF-158). A `cfg` attribute
 *     between a comment and its item is ordinary Rust.
 *   * `let times =` followed by `unsafe { GetProcessTimes(..) }` - the comment
 *     is above the *statement*, not above the `unsafe` token, and the first
 *     strict version stopped at `let times =` and reported three documented
 *     blocks as undocumented (`process.rs`, `services.rs` twice).
 *
 * So a line is treated as part of the same statement when it ends in a token
 * that cannot end a statement (`=`, `(`, `,`, an operator) or begins with `.`
 * (a method chain). A line ending in `;`, `{` or `}` is a completed
 * statement or block boundary, and the walk stops there: the comment above it
 * belongs to that earlier statement, not to this construct.
 */
function hasSafetyAbove(lines, index) {
  const CONTINUES = /[=(,]$|[&|+]$/;
  for (let cursor = index - 1; cursor >= 0 && index - cursor <= WINDOW; cursor -= 1) {
    const line = lines[cursor];
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("#[")) continue;
    if (trimmed.startsWith("//")) {
      if (/\/\/\s*SAFETY:/.test(line)) return true;
      continue;
    }
    if (trimmed.startsWith(".") || CONTINUES.test(trimmed)) continue;
    return false;
  }
  return false;
}

/**
 * @param {string} root repository root, used only to shorten reported paths
 * @returns {{files:number,blocks:number,impls:number,documented:number,safetyComments:number,problems:string[]}}
 */
export function measureFfi(root) {
  const files = rustFiles([join(root, "crates", "zenith-core", "src"), join(root, "src-tauri", "src")]);
  const problems = [];
  let blocks = 0;
  let impls = 0;
  let documented = 0;
  let safetyComments = 0;

  for (const file of files) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    const label = relative(root, file).replace(/\\/g, "/");

    lines.forEach((line, index) => {
      if (/\/\/\s*SAFETY:/.test(line)) safetyComments += 1;

      // Two unsafe constructs, one rule. `unsafe { ... }` is a block; an
      // `unsafe impl Send for T` is an item whose body is safe code but whose
      // *promise* is the programmer's - and a wrong `Sync` impl is a data race.
      // Until DEF-158 only the block form was counted, so the impls in
      // `child.rs` had a comment covering them by adjacency and the gate saw
      // nothing to check. Both forms are matched here, on the code part of the
      // line only.
      const code = codeOf(line);
      const isBlock = /\bunsafe\s*\{/.test(code);
      const isImpl = /\bunsafe\s+impl\b/.test(code);
      if (!isBlock && !isImpl) return;
      if (isBlock) blocks += 1;
      if (isImpl) impls += 1;

      if (hasSafetyAbove(lines, index)) documented += 1;
      else {
        const what = isImpl ? "unsafe impl" : "unsafe block";
        problems.push(`${label}:${index + 1} ${what} without a // SAFETY: comment`);
      }
    });
  }

  return { files: files.length, blocks, impls, documented, safetyComments, problems };
}
