/**
 * T-FE-22 - a log line is localized, not printed raw (DEF-088).
 *
 * The packaged console showed `steps.dnsFlush: Success`: the core's `text`
 * field (a support-facing technical string) was rendered verbatim, so the user
 * saw a catalogue key plus a Rust `Debug` word. The renderer now localizes
 * `stepKey`; these cases pin the fallbacks so a gap still shows something.
 */
import { describe, expect, it } from "vitest";

import { format } from "../i18n/format";
import type { LogLine } from "../bridge/types";
import { logText, logTextAll } from "./logText";

const line = (over: Partial<LogLine> = {}): LogLine => ({
  seq: 1,
  atUtc: "2026-11-21T00:00:00Z",
  level: "info",
  text: "steps.dnsFlush: success",
  ...over,
});

/** Mirrors `buildTranslator`'s lookup: known key -> copy, unknown -> key. */
const catalogue: Record<string, string> = {
  "steps.dnsFlush": "DNS önbelleği temizlendi",
};
const tKey = (key: string) => {
  const value = catalogue[key];
  return value ? format(value, {}, "tr") : key;
};

describe("logText (T-FE-22, DEF-088)", () => {
  it("renders the localized copy for a known stepKey, not the raw text", () => {
    expect(logText(tKey, line({ stepKey: "steps.dnsFlush" }))).toBe(
      "DNS önbelleği temizlendi",
    );
  });

  it("never leaks the raw key when the catalogue has the step", () => {
    const rendered = logText(tKey, line({ stepKey: "steps.dnsFlush" }));
    expect(rendered).not.toContain("steps.dnsFlush");
    expect(rendered).not.toContain("Success");
  });

  it("falls back to the technical text for an untagged line", () => {
    expect(logText(tKey, line({ text: "support bundle: C:\\x.zip" }))).toBe(
      "support bundle: C:\\x.zip",
    );
  });

  it("falls back to the technical text for a stepKey the catalogue lacks", () => {
    // A newer core emitting an unknown step must not show `⟦steps.newThing⟧`.
    expect(
      logText(tKey, line({ stepKey: "steps.fromTheFuture", text: "steps.fromTheFuture: success" })),
    ).toBe("steps.fromTheFuture: success");
  });

  it("prefers stepKey over text when both are present and the key resolves", () => {
    expect(
      logText(tKey, line({ stepKey: "steps.dnsFlush", text: "unrelated technical detail" })),
    ).toBe("DNS önbelleği temizlendi");
  });

  it("does not treat an empty stepKey as a key", () => {
    expect(logText(tKey, line({ stepKey: "", text: "plain line" }))).toBe("plain line");
  });
});

describe("logText params for shell-written lines (T-FE-24, DEF-094)", () => {
  // A realistic catalogue entry with a placeholder, plus the `tKey` contract:
  // known key -> formatted sentence, unknown -> the key itself.
  const withParams: Record<string, string> = {
    "console.bundleSaved": "Destek paketi kaydedildi: {path}",
    "console.auditExported": "Denetim dışa aktarımı kaydedildi: {path}",
  };
  const tKeyWithParams = (key: string, params?: Record<string, string | number>) => {
    const value = withParams[key];
    return value ? format(value, params ?? {}, "tr") : key;
  };

  it("interpolates the path into the localized sentence", () => {
    const rendered = logText(
      tKeyWithParams,
      line({
        stepKey: "console.bundleSaved",
        params: { path: "C:\\Users\\emir\\bundle.zip" },
        text: "support bundle: C:\\Users\\emir\\bundle.zip",
      }),
    );
    expect(rendered).toBe("Destek paketi kaydedildi: C:\\Users\\emir\\bundle.zip");
    // The English technical text must not be what the user reads.
    expect(rendered).not.toContain("support bundle:");
  });

  it("keeps the path literal while translating the words around it", () => {
    const rendered = logText(
      tKeyWithParams,
      line({ stepKey: "console.auditExported", params: { path: "D:\\audit.csv" } }),
    );
    expect(rendered).toContain("D:\\audit.csv");
    expect(rendered.startsWith("Denetim")).toBe(true);
  });

  it("would still print English if the shell sent no stepKey", () => {
    // This is the regression being pinned: a shell line with only `text` falls
    // through to the raw English string, which is exactly DEF-094.
    const rendered = logText(
      tKeyWithParams,
      line({ text: "support bundle: C:\\x.zip" }),
    );
    expect(rendered).toBe("support bundle: C:\\x.zip");
  });
});

describe("logTextAll - the clipboard matches the screen (T-FE-25, DEF-116)", () => {
  // Both Copy buttons wrote `line.text` (the support-facing English field)
  // while the two renderers printed `logText(line)`. A Turkish user copied a
  // block of `steps.dnsFlush: Success` that appeared nowhere in the window.
  const t = {
    tKey: (key: string, params?: Record<string, string | number>) => {
      const catalogue: Record<string, string> = {
        "steps.dnsFlush": "DNS önbelleği temizlendi",
        "console.bundleSaved": "Destek paketi: {path}",
      };
      const value = catalogue[key];
      return value ? format(value, params ?? {}, "tr") : key;
    },
    formatTime: () => "12:00",
  };

  it("copies the localized sentence, not the technical text", () => {
    const copied = logTextAll(t, [
      line({ stepKey: "steps.dnsFlush", text: "steps.dnsFlush: Success" }),
    ]);
    expect(copied).toContain("DNS önbelleği temizlendi");
    expect(copied).not.toContain("steps.dnsFlush");
    expect(copied).not.toContain("Success");
  });

  it("keeps the technical text only where the screen falls back to it", () => {
    const copied = logTextAll(t, [
      line({ text: "support bundle: C:\\x.zip" }),
    ]);
    expect(copied).toContain("support bundle: C:\\x.zip");
  });

  it("puts one line per entry with its timestamp, so a pasted log is correlatable", () => {
    const copied = logTextAll(t, [
      line({ seq: 1, text: "first" }),
      line({ seq: 2, text: "second" }),
    ]);
    const rows = copied.split("\n");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("12:00");
    expect(rows[1]).toContain("12:00");
    expect(rows[0]).toContain("first");
    expect(rows[1]).toContain("second");
  });

  it("returns an empty string for an empty log, not a stray newline", () => {
    expect(logTextAll(t, [])).toBe("");
  });
});
