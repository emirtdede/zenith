import { describe, expect, it } from "vitest";

import { AUDIT_COLUMNS, auditRows, toCsv, toJson } from "./export";
import type { SnapshotRecord } from "./bridge/types";

function snapshot(overrides: Partial<SnapshotRecord> = {}): SnapshotRecord {
  return {
    snapshotId: "r0/registry",
    actionId: "empty-recycle-bin",
    createdAtUtc: "2026-11-20T10:00:00Z",
    tier: "Reversible",
    snapshotType: "registry",
    isRestored: false,
    restoredAtUtc: null,
    estBytes: 1536,
    status: "committed",
    summaryKey: "snapshots.summary.registry",
    ...overrides,
  } as SnapshotRecord;
}

describe("auditRows", () => {
  it("maps a snapshot to a row with a stable column set", () => {
    const rows = auditRows([snapshot()]);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(Object.keys(row).sort()).toEqual([...AUDIT_COLUMNS].sort());
    expect(row.snapshot_id).toBe("r0/registry");
    expect(row.action_id).toBe("empty-recycle-bin");
    expect(row.est_bytes).toBe(1536);
    expect(row.restored_at_utc).toBe("");
  });

  it("keeps an unknown action id rather than dropping the row", () => {
    const rows = auditRows([snapshot({ actionId: "future-action" as never })]);
    expect(rows[0]!.action).toBe("future-action");
    expect(rows[0]!.action_id).toBe("future-action");
  });

  it("returns an empty array for an empty ledger", () => {
    expect(auditRows([])).toEqual([]);
  });

  it("writes the translated title in `action` and the stable id in `action_id`", () => {
    // DEF-135: both columns used to be the id, so the file a helpdesk receives
    // said `empty-recycle-bin` twice and never named the action.
    const [row] = auditRows([snapshot()], (key) =>
      key === "actions.emptyRecycleBin.title" ? "Empty the Recycle Bin" : key,
    );
    expect(row!.action).toBe("Empty the Recycle Bin");
    expect(row!.action_id).toBe("empty-recycle-bin");
  });

  it("translates the summary key instead of exporting it raw", () => {
    const [row] = auditRows([snapshot()], (key) =>
      key === "snapshots.summary.registry" ? "Registry keys backed up" : key,
    );
    expect(row!.summary).toBe("Registry keys backed up");
  });

  it("falls back to the raw key when the catalogue does not define it", () => {
    // A snapshot from a newer core must not become an empty cell.
    const [row] = auditRows([snapshot({ summaryKey: "outcomes.fromTheFuture" })], (key) => key);
    expect(row!.summary).toBe("outcomes.fromTheFuture");
  });
});

describe("toCsv", () => {
  it("writes the header first and one line per row", () => {
    const csv = toCsv(auditRows([snapshot(), snapshot({ snapshotId: "r1/x" })]));
    const lines = csv.trimEnd().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(AUDIT_COLUMNS.join(","));
  });

  it("quotes values containing a comma, quote or newline (RFC 4180)", () => {
    const csv = toCsv(
      auditRows([snapshot({ summaryKey: 'a,b "c"\nd' })]),
    );
    expect(csv).toContain('"a,b ""c""\nd"');
  });

  it("leaves numbers unquoted so a spreadsheet reads them as numbers", () => {
    const csv = toCsv(auditRows([snapshot({ estBytes: 2048 })]));
    const row = csv.split("\r\n")[1];
    expect(row).toContain(",2048,");
    expect(row).not.toContain('"2048"');
  });

  it("ends every row with CRLF, including the last", () => {
    const csv = toCsv(auditRows([snapshot()]));
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("defuses formula injection from a value that began with = + - @ (CWE-1236)", () => {
    // The audit ledger is the file people forward to a helpdesk, so a cell that
    // a spreadsheet would execute is a code-execution path through the export.
    for (const payload of ['=HYPERLINK("http://x")', "+1+1", "-2+3", "@SUM(A1)"]) {
      const csv = toCsv(auditRows([snapshot({ actionId: payload as never })]));
      const row = csv.split("\r\n")[1]!;

      // The cell is guarded by an apostrophe; a value that also contains a
      // delimiter is quoted per RFC 4180, and quoting wraps the guarded text.
      const guarded = `'${payload}`;
      const expected = /[",\r\n]/.test(guarded)
        ? `"${guarded.replaceAll('"', '""')}"`
        : guarded;
      expect(row).toContain(expected);

      // The real assertion: no cell in the row starts with a live formula
      // character. The apostrophe guard is the only thing allowed in front.
      for (const cell of row.split(",")) {
        const text = cell.replace(/^"|"$/g, "").replace(/""/g, '"');
        expect(text.startsWith("'") || !/^[=+\-@\t\r]/.test(text)).toBe(true);
      }
    }
  });

  it("leaves a negative number unquoted and unguarded, because it is a number", () => {
    // `-5` as est_bytes must stay numeric: guarding a number would turn the
    // measurement into text and break the spreadsheet's own arithmetic.
    const csv = toCsv(auditRows([snapshot({ estBytes: -5 })]));
    const row = csv.split("\r\n")[1]!;
    expect(row).toContain(",-5,");
    expect(row).not.toContain("'-5");
  });
});

describe("toJson", () => {
  it("emits a versioned envelope, not a bare array", () => {
    const json = JSON.parse(toJson(auditRows([snapshot()]), "2026-11-20T10:05:00Z"));
    expect(json.v).toBe(1);
    expect(json.kind).toBe("zenith.audit");
    expect(json.exportedAtUtc).toBe("2026-11-20T10:05:00Z");
    expect(json.columns).toEqual([...AUDIT_COLUMNS]);
    expect(json.rows).toHaveLength(1);
  });

  it("round-trips through JSON.parse without loss", () => {
    const rows = auditRows([snapshot()]);
    const json = JSON.parse(toJson(rows, "2026-11-20T10:05:00Z"));
    expect(json.rows[0]).toEqual(rows[0]);
  });
});
