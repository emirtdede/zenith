/**
 * The audit table, as data (DEF-055, REQ-F-090).
 *
 * The Snapshots screen already *is* the audit ledger: one row per mutation, with
 * the action, its tier, when it happened, whether it can still be rolled back
 * and how large the snapshot is. What was missing was a way to hand that table
 * to someone else - an IT ticket asking "what did you change on this machine?".
 *
 * Kept as pure functions with no React and no bridge import so it can be unit
 * tested directly, and so the exported bytes are exactly what a test asserts.
 */

import type { SnapshotRecord } from "./bridge/types";
import { ACTIONS } from "./catalog.generated";

export interface AuditRow {
  snapshot_id: string;
  action_id: string;
  action: string;
  created_at_utc: string;
  tier: string;
  est_bytes: number;
  status: string;
  restored_at_utc: string;
  summary: string;
}

/** Column order is part of the export contract; keep it stable. */
export const AUDIT_COLUMNS = [
  "snapshot_id",
  "action_id",
  "action",
  "created_at_utc",
  "tier",
  "est_bytes",
  "status",
  "restored_at_utc",
  "summary",
] as const;

/**
 * Resolves a catalogue key to the text a reader should see.
 *
 * Identity by default so the function stays pure and unit-testable: a caller
 * that has a translator passes `t.tKey`, and the tests pass nothing and assert
 * the raw keys. This is the inversion that keeps `export.ts` free of React.
 */
export type LabelLookup = (key: string, params?: Record<string, string>) => string;

const identity: LabelLookup = (key) => key;

/**
 * Flattens the snapshot ledger into exportable rows.
 *
 * `action` is the translated title from the generated catalogue, `action_id` the
 * stable machine id, and `summary` the translated outcome. Before DEF-135 both
 * text columns were raw keys, so a helpdesk received `empty-recycle-bin` and
 * `snapshots.empty-recycle-bin` - the exact file people forward to a stranger
 * carried identifiers instead of a sentence.
 *
 * An id that is not in the catalogue (a snapshot from a newer build) keeps the
 * raw id in both columns instead of being dropped, and a key the catalogue does
 * not define falls back to the key rather than to an empty cell.
 */
export function auditRows(snapshots: SnapshotRecord[], translate: LabelLookup = identity): AuditRow[] {
  return snapshots.map((row) => {
    const def = ACTIONS.find((entry) => entry.id === row.actionId);
    const titleKey = def ? `${def.i18nPrefix}.title` : null;
    const title = titleKey ? translate(titleKey) : row.actionId;
    return {
      snapshot_id: row.snapshotId,
      action_id: row.actionId,
      action: title === titleKey ? row.actionId : title,
      created_at_utc: row.createdAtUtc,
      tier: row.tier,
      est_bytes: row.estBytes,
      status: row.status,
      restored_at_utc: row.restoredAtUtc ?? "",
      summary: translate(row.summaryKey, row.summaryParams),
    };
  });
}

/**
 * RFC 4180 quoting: wrap in quotes when the value contains a comma, quote or
 * line break, and double any inner quote. Numbers stay unquoted so a
 * spreadsheet opens them as numbers, not text.
 *
 * Formula injection (CWE-1236) is handled first. A spreadsheet treats a cell
 * beginning with `=`, `+`, `-`, `@`, tab or carriage return as a formula, so a
 * value that reached this row from outside the program - an action id from a
 * newer core, or any future free-text column - could execute
 * `=HYPERLINK(...)` or `=cmd|'...'` when a helpdesk opens the export. The
 * audit ledger is precisely the file people forward to a stranger. Prefixing
 * one apostrophe makes the cell literal text; the apostrophe is the standard
 * spreadsheet quoting marker and is not shown in the cell.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function csvCell(value: string | number): string {
  if (typeof value === "number") return String(value);
  const safe = FORMULA_LEAD.test(value) ? `'${value}` : value;
  if (!/[",\r\n]/.test(safe)) return safe;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** Renders rows as CSV with a header line and CRLF row endings (RFC 4180). */
export function toCsv(rows: AuditRow[]): string {
  const lines = [AUDIT_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(AUDIT_COLUMNS.map((column) => csvCell(row[column])).join(","));
  }
  // Trailing newline: a file without it is a common cause of "last row ignored"
  // in naive readers.
  return `${lines.join("\r\n")}\r\n`;
}

/** Renders rows as a JSON object with an explicit schema version. */
export function toJson(rows: AuditRow[], exportedAtUtc: string): string {
  return `${JSON.stringify(
    {
      v: 1,
      kind: "zenith.audit",
      exportedAtUtc,
      columns: [...AUDIT_COLUMNS],
      rows,
    },
    null,
    2,
  )}\n`;
}
