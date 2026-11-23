import type { LogLine } from "../bridge/types";

/**
 * A log line's user-facing text.
 *
 * The core emits a keys, never English (ADR-010): `stepKey` is `steps.dnsFlush`
 * and `text` is the redacted technical string kept for support. Before this
 * helper both console renderers printed `line.text` verbatim, so a Turkish user
 * read `steps.dnsFlush: Success` - a raw catalogue key plus a Rust `Debug` enum
 * (DEF-088). The localized key wins; `text` is the fallback for lines the core
 * did not tag, and for a key the catalogue does not have (a newer core), so an
 * unknown step still shows something rather than `⟦key⟧`.
 *
 * `tKey` returns the key itself when it is missing, which is how the fallback
 * tells "translated" from "absent" without a try/catch.
 *
 * `params` exists for the lines the *shell* writes (a saved bundle path, an
 * exported audit file). Those were plain English strings, so a Turkish window
 * showed `support bundle: C:\…` while every neighbouring line was translated -
 * the same defect as DEF-088, one direction over (DEF-094). Passing the values
 * through the catalogue keeps the sentence translatable and the path literal.
 */
export function logText(
  tKey: (key: string, params?: Record<string, string | number>) => string,
  line: LogLine,
): string {
  if (!line.stepKey) {
    return line.text;
  }
  const localized = tKey(line.stepKey, line.params);
  return localized === line.stepKey ? line.text : localized;
}

/**
 * The whole log, as the user reads it, one line per entry.
 *
 * Both Copy buttons wrote `state.logs.map((line) => line.text)` - the raw
 * technical field - while the two renderers directly above them printed
 * `logText(...)`. So a Turkish user selected-copied a block of English
 * `steps.dnsFlush: Success` lines that appeared nowhere on screen, and pasted
 * it into a ticket (DEF-116). The clipboard is the surface a helpdesk reads,
 * so it must be the surface the user saw; `text` stays in the DOM only as the
 * fallback `logText` already implements.
 *
 * Time is prepended because a pasted log with no timestamps is much harder to
 * correlate with the audit rows the correlation id points at; it uses the same
 * `formatTime` the rows use, so the paste matches the screen column for column.
 */
export function logTextAll(
  t: {
    tKey: (key: string, params?: Record<string, string | number>) => string;
    formatTime: (iso: string) => string;
  },
  lines: readonly LogLine[],
): string {
  return lines.map((line) => `${t.formatTime(line.atUtc)}\t${logText(t.tKey, line)}`).join("\n");
}
