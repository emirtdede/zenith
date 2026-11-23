/**
 * Non-Windows guard audit (`03-06` Rule 0).
 *
 * Every `#[cfg(not(windows))]` item must either return a `Result` carrying
 * `NotImplemented`, or be absent. This scanner does not try to be a compiler:
 * it lists every guarded `fn` and whether its signature is fallible, so a
 * human review sees the full set and a regression shows up as a diff.
 *
 * Exit code 1 when a guarded function returns a bare non-Result value that is
 * not one of the deliberately-pessimistic cases recorded in `03-06` §1.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "crates/zenith-core/src/adapters";

// Documented in `03-06` §1: not fabricated values.
//   * `Option::None` means "unknown", which L1 explicitly requires; and
//   * `is_elevated -> false` is the pessimistic answer that can only refuse work.
const ALLOWED_BARE = new Set([
  "privilege.rs::is_elevated",
  "process.rs::terminate_if_identity_matches",
  // `Option`-returning helpers: `None` is the documented "unknown", never a
  // plausible-looking answer.
  "privilege.rs::sid_for_pid",
  "privilege.rs::current_sid",
  "process.rs::image_name",
  "process.rs::command_line",
  // `console::output` is not platform-specific behaviour: writing to stdout is
  // the same operation everywhere. It is a working implementation, not a stub.
  "console.rs::output",
]);

let failures = 0;
let guarded = 0;

for (const file of readdirSync(DIR).filter((name) => name.endsWith(".rs"))) {
  const lines = readFileSync(join(DIR, file), "utf8").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== "#[cfg(not(windows))]") continue;
    let j = i + 1;
    while (j < lines.length && !/\bfn\s+\w+/.test(lines[j])) j += 1;
    if (j >= lines.length) continue;

    // A signature can wrap across lines; read until the body opens or `;`.
    let signature = lines[j];
    let end = j;
    while (
      end + 1 < lines.length &&
      !signature.includes("{") &&
      !signature.trimEnd().endsWith(";")
    ) {
      end += 1;
      signature += " " + lines[end];
    }
    const name = (signature.match(/\bfn\s+(\w+)/) ?? [])[1];
    if (!name) continue;

    // Trait method declarations and `impl` bodies are covered by their trait.
    if (signature.includes(";")) continue;
    guarded += 1;

    const fallible = /->\s*(ZenithResult<|Result<)/.test(signature);
    const ident = `${file}::${name}`;
    if (!fallible && !ALLOWED_BARE.has(ident)) {
      failures += 1;
      console.log(`FAIL  ${file}:${j + 1}  ${name}  ${signature.trim()}`);
    }
  }
}

console.log(`guarded fns: ${guarded}`);
console.log(
  failures === 0
    ? "Rule 0 holds: every guarded fn is fallible or documented-pessimistic."
    : `${failures} guarded fn(s) return a bare value.`,
);
process.exit(failures === 0 ? 0 : 1);
