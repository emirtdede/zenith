/**
 * Boot instrumentation tests (DEF-049, REQ-N-001).
 *
 * The module's contract is narrow on purpose: it either returns a number it
 * actually measured, or `null`. A test that accepted `0` for "not measured"
 * would let the UI claim an instantaneous boot.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { markBootStart, markInteractive } from "./perf";

describe("boot timing", () => {
  beforeEach(() => {
    markBootStart();
  });

  it("measures a real interval between the two marks", () => {
    const ms = markInteractive();
    expect(ms).not.toBeNull();
    expect(typeof ms).toBe("number");
    expect(ms!).toBeGreaterThanOrEqual(0);
    // The measurement is rounded to whole milliseconds.
    expect(Number.isInteger(ms!)).toBe(true);
  });

  it("records exactly one measure per boot", () => {
    // The UI reads the value from the returned number; the measure entry exists
    // so a DevTools trace shows the same interval. Two boots must not stack.
    markInteractive();
    expect(performance.getEntriesByName("zenith:boot")).toHaveLength(1);
  });

  it("returns null when the start mark is missing, never zero", () => {
    // Simulate a host that mounts the app without the entry point running.
    performance.clearMarks("zenith:boot-start");
    expect(markInteractive()).toBeNull();
  });

  it("re-marking the start resets the measurement instead of stacking", () => {
    markInteractive();
    markBootStart();
    const entries = performance.getEntriesByName("zenith:boot");
    // markBootStart clears measures, so a second boot cannot report the first's
    // duration by accident.
    expect(entries).toHaveLength(0);
  });
});
