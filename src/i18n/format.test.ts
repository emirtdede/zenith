/**
 * `format()` unit tests (T-FE-14, `03-05` i18n contract).
 *
 * The render suite found that `#` inside a plural branch was emitted literally,
 * so the UI showed "# items" instead of "3 items". A formatter bug is invisible
 * to `tsc` and to a key-parity check, so it gets its own test here rather than
 * only a regression in the component suite.
 */

import { describe, expect, it } from "vitest";

import { format, formatBytes } from "./format";
import { NOT_MEASURED } from "../shared/placeholder";

const ITEMS = "{count, plural, =0 {None} one {1 item} other {# items}}";

describe("ICU subset", () => {
  it("renders plain arguments", () => {
    expect(format("Hello {name}", { name: "Emir" })).toBe("Hello Emir");
  });

  it("substitutes # with the count in a plural branch", () => {
    expect(format(ITEMS, { count: 3 })).toBe("3 items");
    expect(format(ITEMS, { count: 1 })).toBe("1 item");
    expect(format(ITEMS, { count: 0 })).toBe("None");
  });

  it("formats the count with locale grouping", () => {
    expect(format(ITEMS, { count: 1200 }, "en")).toBe("1,200 items");
  });

  it("falls back to `other` for a branch with no rule", () => {
    expect(format("{n, plural, one {one} other {many}}", { n: 5 })).toBe("many");
  });

  it("supports select", () => {
    const pattern = "{g, select, admin {Administrator} other {Standard}}";
    expect(format(pattern, { g: "admin" })).toBe("Administrator");
    expect(format(pattern, { g: "user" })).toBe("Standard");
  });

  it("formats numbers and bytes", () => {
    expect(format("{n, number}", { n: 1234.5 }, "en")).toBe("1,234.5");
    // Whole bytes and kilobytes carry no decimal (format.ts); MB and above do.
    expect(format("{b, bytes}", { b: 1536 }, "en")).toBe("2\u00a0KB");
    expect(format("{b, bytes}", { b: 1572864 }, "en")).toBe("1.5\u00a0MB");
  });

  it("names a missing parameter instead of rendering nothing", () => {
    // A blank space is a bug nobody can act on; the placeholder names the key.
    expect(format("Hi {name}")).toBe("Hi \u27e6name\u27e7");
  });

  it("leaves an unbalanced brace verbatim instead of throwing", () => {
    expect(format("broken {oops")).toBe("broken {oops");
  });

  it("refuses to invent a size for a negative or non-finite byte count", () => {
    // The marker is a named constant, not a glyph: asserting the literal would
    // make a change of placeholder a test rewrite, and lumping "-" into a text
    // match elsewhere is how a real measurement gets mistaken for a hyphen.
    expect(formatBytes(-1, "en")).toBe(NOT_MEASURED);
    expect(formatBytes(Number.NaN, "en")).toBe(NOT_MEASURED);
  });
});
