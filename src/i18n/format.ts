/**
 * A deliberate subset of ICU MessageFormat: `{name}`, `{n, plural, ...}`,
 * `{g, select, ...}`, and `{n, number}`, `{b, bytes}`.
 *
 * Why not `intl-messageformat`? Because the app must work with zero network
 * access and a 40 KB dependency for one formatter is a poor trade against a
 * ~120-line module that has tests. What is deliberately *not* supported:
 * nested plural inside select, apostrophe escaping, `{n, number, percent}`.
 * If a locale needs those, this module grows with a test, not silently.
 *
 * `bytes` is a Zenith extension: file sizes are the single most common number in
 * this product, and localising "2.4 GB" per locale by hand is how units drift.
 */

import { NOT_MEASURED } from "../shared/placeholder";

export type MessageParams = Record<string, string | number | undefined | null>;

/** Locale-aware number formatting, cached: `Intl.NumberFormat` is expensive. */
const numberFormats = new Map<string, Intl.NumberFormat>();

/**
 * `Intl.PluralRules` is as expensive to construct as `NumberFormat` and was
 * rebuilt on every plural substitution - once per list row in a snapshot table
 * (DEF-142). One map, same pattern as the formats above.
 */
const pluralRules = new Map<string, Intl.PluralRules>();

function numberFormat(locale: string, maximumFractionDigits: number): Intl.NumberFormat {
  const key = `${locale}:${maximumFractionDigits}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, {
      maximumFractionDigits,
      minimumFractionDigits: 0,
    });
    numberFormats.set(key, format);
  }
  return format;
}

/** Binary units, which is what Windows uses for file sizes. */
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(value: number, locale: string): string {
  if (!Number.isFinite(value) || value < 0) {
    return NOT_MEASURED;
  }
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < BYTE_UNITS.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  // Whole bytes and kilobytes read badly with a decimal; everything above them
  // gets one decimal, which is the precision the underlying measurement has.
  const digits = unit <= 1 ? 0 : 1;
  const rendered = numberFormat(locale, digits).format(scaled);
  return `${rendered}\u00a0${BYTE_UNITS[unit]}`;
}

function pluralCategory(locale: string, count: number): "zero" | "one" | "two" | "few" | "many" | "other" {
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules.select(count) as "zero" | "one" | "two" | "few" | "many" | "other";
}

/**
 * Split `{...}` arguments out of a pattern without being fooled by braces inside
 * a plural branch.
 */
function parseArgument(source: string, start: number): { body: string; end: number } | null {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return { body: source.slice(start + 1, index), end: index };
      }
    }
  }
  return null;
}

/** Parse `one {…} other {…}` into an ordered branch map. */
function parseBranches(body: string): { selector: string; branches: Map<string, string> } {
  const comma = body.indexOf(",");
  const selector = body.slice(0, comma).trim();
  const rest = body.slice(comma + 1);
  const branches = new Map<string, string>();
  let index = 0;
  while (index < rest.length) {
    // Skip whitespace between branches.
    while (index < rest.length && /\s/.test(rest[index] ?? "")) {
      index += 1;
    }
    const keyStart = index;
    while (index < rest.length && !/[\s{]/.test(rest[index] ?? "")) {
      index += 1;
    }
    const branchKey = rest.slice(keyStart, index);
    while (index < rest.length && /\s/.test(rest[index] ?? "")) {
      index += 1;
    }
    if (rest[index] !== "{") {
      break;
    }
    const parsed = parseArgument(rest, index);
    if (!parsed) {
      break;
    }
    branches.set(branchKey, parsed.body);
    index = parsed.end + 1;
  }
  return { selector, branches };
}

function substitute(
  body: string,
  params: MessageParams,
  locale: string,
): string | null {
  // Argument types are split by the first top-level comma only: a branch body
  // may itself contain commas.
  const comma = body.indexOf(",");
  if (comma === -1) {
    const name = body.trim();
    const value = params[name];
    return value === undefined || value === null ? null : String(value);
  }

  const name = body.slice(0, comma).trim();
  const remainder = body.slice(comma + 1);
  const raw = params[name];
  if (raw === undefined || raw === null) {
    return null;
  }

  const typeEnd = remainder.indexOf(",");
  const type = (typeEnd === -1 ? remainder : remainder.slice(0, typeEnd)).trim();
  const options = typeEnd === -1 ? "" : remainder.slice(typeEnd + 1);

  switch (type) {
    case "number":
      return numberFormat(locale, 2).format(Number(raw));
    case "bytes":
      return formatBytes(Number(raw), locale);
    case "plural": {
      const { branches } = parseBranches(`${name},${options}`);
      const count = Number(raw);
      const exact = branches.get(`=${count}`);
      const chosen =
        exact ??
        branches.get(pluralCategory(locale, count)) ??
        branches.get("other") ??
        "";
      // ICU: `#` inside a plural branch stands for the formatted count. Omitting
      // this renders the literal "# items", which the render tests caught.
      const numbered = chosen.replace(/#/g, numberFormat(locale, 0).format(count));
      return format(numbered, params, locale);
    }
    case "select": {
      const { branches } = parseBranches(`${name},${options}`);
      const chosen = branches.get(String(raw)) ?? branches.get("other") ?? "";
      return format(chosen, params, locale);
    }
    default:
      return String(raw);
  }
}

/**
 * Render a pattern.
 *
 * A missing parameter renders as `⟦name⟧` rather than an empty string. A blank
 * space in the UI is a bug report nobody can act on; a bracketed placeholder
 * names the missing key.
 */
export function format(pattern: string, params: MessageParams = {}, locale = "en"): string {
  let output = "";
  let index = 0;
  while (index < pattern.length) {
    const open = pattern.indexOf("{", index);
    if (open === -1) {
      output += pattern.slice(index);
      break;
    }
    output += pattern.slice(index, open);
    const parsed = parseArgument(pattern, open);
    if (!parsed) {
      // Unbalanced brace: emit the rest verbatim instead of throwing. A
      // malformed string is a translation bug, not a runtime failure.
      output += pattern.slice(open);
      break;
    }
    const rendered = substitute(parsed.body, params, locale);
    output += rendered ?? `\u27e6${parsed.body.trim()}\u27e7`;
    index = parsed.end + 1;
  }
  return output;
}
