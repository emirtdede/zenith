/**
 * Boot instrumentation (REQ-N-001, DEF-049).
 *
 * REQ-N-001 asks for cold start to interactive paint, measured with
 * `performance.mark`. This module owns the two marks and the one measurement so
 * the timing is taken once, at the real boundary, rather than being sprinkled
 * through components.
 *
 * Everything degrades to `null` when the User Timing API is unavailable (older
 * WebView2, a test host that stubs it out). `null` is rendered as "unknown" and
 * never as `0`, because a missing measurement and an instantaneous boot are not
 * the same claim.
 */

const BOOT_START = "zenith:boot-start";
const INTERACTIVE = "zenith:interactive";
const MEASURE = "zenith:boot";

function timingAvailable(): boolean {
  return (
    typeof performance !== "undefined" &&
    typeof performance.mark === "function" &&
    typeof performance.measure === "function"
  );
}

/** Mark the instant the renderer script starts, before React is imported. */
export function markBootStart(): void {
  if (!timingAvailable()) return;
  performance.clearMarks(BOOT_START);
  performance.clearMarks(INTERACTIVE);
  performance.clearMeasures(MEASURE);
  performance.mark(BOOT_START);
}

/**
 * Mark "interactive" - after the first commit - and return the elapsed
 * milliseconds, or `null` if either mark is missing.
 */
export function markInteractive(): number | null {
  if (!timingAvailable()) return null;
  try {
    performance.mark(INTERACTIVE);
    const measure = performance.measure(MEASURE, BOOT_START, INTERACTIVE);
    return Math.round(measure.duration);
  } catch {
    // `performance.measure` throws when a mark does not exist, which happens if
    // the app was mounted without `markBootStart` (tests do this deliberately).
    return null;
  }
}
