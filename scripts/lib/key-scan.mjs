/**
 * The key-coverage analysis, as a pure function over text.
 *
 * Split out of `check-step-keys.mjs` so the negative self-test can feed it
 * synthetic sources instead of mutating the real tree. A gate that can only be
 * tested by editing product files is a gate nobody re-tests.
 *
 * Two scans, because DEF-135 had two shapes:
 *
 *  * **literal** - a key written as a string, which must exist in the catalogue;
 *  * **construction** - a key *built* with `format!` or a template literal, where
 *    the check is that no placeholder touches a word character. `{}done` cannot
 *    be defined in any locale; `{}.done` can. This is the scan that would have
 *    caught the defect on the day it was written.
 */

/** Families whose values are catalogue keys, not prose. */
export const FAMILIES = [
  "steps",
  "error",
  "remedy",
  "outcomes",
  "actions",
  "snapshots",
  "console",
  "confirm",
  "notices",
  "diag",
  "trust",
  // DEF-146: the measured state on each side of a change. These were emitted by
  // `adapters/actions.rs` and defined nowhere, because this list had never been
  // taught them - the gate reported what it could see, not what the app asks
  // for, which is the exact failure the header of this file warns about.
  "before",
  "after",
];

const FAMILY_RE = new RegExp(`"((?:${FAMILIES.join("|")})\\.[A-Za-z0-9_.-]+)"`, "g");

/**
 * A line whose value *is* a catalogue key. Only these lines have the invariant
 * the construction scan checks. Without the context test the rule fires on
 * `format!("WinSock2_{}.hiv", n)` (a file name) and on the comment documenting
 * the very defect it hunts - both of which are how a gate gets ignored.
 */
const KEY_ASSIGNMENT =
  /(?:^|[\s{,])(?:summary_key|step_key|before_key|after_key|message_key|summaryKey|stepKey|beforeKey|afterKey|messageKey)\s*[:=]/;

/** Comments describe keys; they cannot emit one. */
const isComment = (line) => /^\s*(\/\/|\/\*|\*|#)/.test(line);

/**
 * Removes `#[cfg(test)] mod tests { … }` blocks. Brace counting is enough: the
 * attribute always precedes a module, and raw PowerShell strings in this tree
 * live in the manifest, not in a test module.
 */
export function withoutTestModules(text) {
  const marker = "#[cfg(test)]";
  let out = "";
  let index = 0;
  for (;;) {
    const at = text.indexOf(marker, index);
    if (at === -1) break;
    out += text.slice(index, at);
    let i = text.indexOf("{", at);
    if (i === -1) break;
    let depth = 0;
    for (; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    index = i;
  }
  out += text.slice(index);
  return out;
}

/**
 * A real key for this family, as opposed to a stem, feature name or file name.
 *
 * `actions.<Name>` is an i18n *prefix* (the catalogue owns `actions.<Name>.title`),
 * so only `actions.<Name>.<suffix>` can be a key. A `.json`/`.ps1` suffix is a
 * file name; `unsupported("actions.x")` is a platform capability.
 */
export function isKey(family, key) {
  if (/\.(json|ps1|bat|zip|txt|log|csv)$/.test(key)) return false;
  if (family === "actions") return key.split(".").length >= 3;
  return key.split(".").length >= 2;
}

/**
 * @param {Array<{path: string, text: string, kind: "rust"|"ts"}>} sources
 * @param {{en: Set<string>, tr: Set<string>, dynamicDonePrefixes?: string[]}} options
 */
export function analyse(sources, options) {
  const { en, tr, dynamicDonePrefixes = [] } = options;

  /** key -> Set of sources, so a failure names where to fix it. */
  const emitted = new Map();
  const record = (key, source) => {
    if (!emitted.has(key)) emitted.set(key, new Set());
    emitted.get(key).add(source);
  };

  const malformed = [];

  for (const { path, kind } of sources) {
    let text = sources.find((s) => s.path === path)?.text ?? "";

    if (kind === "rust") {
      text = withoutTestModules(text);
      // A platform capability name, not a translation key.
      text = text.replace(/unsupported\("[^"]*"\)/g, 'unsupported("")');
    }

    for (const m of text.matchAll(FAMILY_RE)) {
      if (isKey(m[1].split(".")[0], m[1])) record(m[1], path);
    }

    // Construction scan: only key assignments, never comments.
    text.split("\n").forEach((line, i) => {
      if (isComment(line) || !KEY_ASSIGNMENT.test(line)) return;
      const literals =
        kind === "rust"
          ? [...line.matchAll(/format!\(\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1])
          : [...line.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
      for (const literal of literals) {
        const placeholder = kind === "rust" ? /\{\}/g : /\$\{[^}]*\}/g;
        for (const p of literal.matchAll(placeholder)) {
          const before = literal[p.index - 1];
          const after = literal[p.index + p[0].length];
          if (
            (after !== undefined && /[A-Za-z0-9_]/.test(after)) ||
            (before !== undefined && /[A-Za-z0-9_]/.test(before))
          ) {
            malformed.push({ path, line: i + 1, literal, kind });
          }
        }
      }
    });
  }

  // Keys built at runtime, reconstructed from the one list of actions.
  for (const prefix of dynamicDonePrefixes) {
    record(`${prefix}.done`, "DYNAMIC format!/template key construction");
  }

  const missingEn = [...emitted.keys()].filter((k) => !en.has(k)).sort();
  const missingTr = [...emitted.keys()].filter((k) => !tr.has(k)).sort();

  /*
   * Catalogue keys that no emitter produces. Only families the core owns are
   * checked: a `ui.*` key may be composed at runtime.
   */
  const CORE_OWNED = ["steps.", "outcomes.", "notices.", "diag."];
  const unused = [...en]
    .filter((k) => CORE_OWNED.some((p) => k.startsWith(p)) && !emitted.has(k))
    .sort();

  return { emitted, malformed, missingEn, missingTr, unused };
}

/** Parses `"key":` lines out of a TypeScript catalogue. */
export function catalogueKeys(text) {
  return new Set([...text.matchAll(/^\s*"([A-Za-z0-9_.]+)":/gm)].map((m) => m[1]));
}
