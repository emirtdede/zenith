# 07-02 - Observability & Support

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-QUA-002 |
| Version | 2.0.0 |
| Owner | Engineering / Support |
| Implementation | `src-tauri/src/logging.rs`, `crates/zenith-core/src/engine/support.rs`, `crates/zenith-core/src/engine/audit.rs`, `crates/zenith-core/src/engine/redact.rs` |
| Closes | DEF-016 (no log strategy, no support bundle, no triage path) |

A diagnostic tool that cannot be diagnosed is a contradiction. This document specifies the four
artefacts that make a Zenith failure investigable - the operation log, the audit trail, the in-app
console, and the support bundle - and the redaction that every one of them passes through.

Every claim names the file that implements it. Where a capability is bounded, the bound is a
constant and is tested, not asserted.

---

## 1. The three streams

| Stream | Lifetime | Destination | Owner |
| :--- | :--- | :--- | :--- |
| **Operation log** | Persisted, rotated | `%ProgramData%\Vellium\Zenith\logs\zenith.log[.1..2]` | `src-tauri/src/logging.rs` |
| **Audit trail** | Persisted, capped | `state.db` → `execution_audit` | `crates/zenith-core/src/engine/audit.rs` |
| **Console** | Process lifetime | Renderer memory, 5,000 lines | `src/state/store.ts` |

They are deliberately separate. The console is what the user watches; the audit trail is what an
auditor reads; the log is what support receives. Collapsing them would either put PII in the audit
table or lose the audit trail when the window closes.

---

## 2. Operation log

### 2.1 What a line looks like

```text
2026-11-19T09:17:49.416Z INFO  action flush-dns-cache completed
2026-11-19T09:18:02.003Z WARN  store is in per-user fallback mode (machine directory not writable)
2026-11-19T09:18:44.870Z ERROR action reset-winsock-stack failed: ACCESS_DENIED
```

`<RFC 3339 UTC> <LEVEL padded to 5> <message>`, one line per event, always `\n`-terminated.
Timestamps are UTC with millisecond precision so two machines' logs interleave correctly in a
support case.

### 2.2 The writer

`logging::append(paths, level, message)` is the **only** function that writes a log line. That is
not a convention; there is no other caller of `OpenOptions::append` against `logs_dir`.

| Property | Implementation | Test |
| :--- | :--- | :--- |
| Every line redacted | `redact_text(&redact_command_line(message))` | `a_line_is_written_and_redacted` |
| Rotation before append | `rotate_if_needed(&active, line.len())` | `rotation_moves_the_active_file_and_bounds_the_ring` |
| Unwritable directory is not a crash | returns `None` | `an_unwritable_directory_is_reported_not_panicked` |
| Failure never blocks the caller | return value is ignored by callers | - (by design) |

**Two-pass redaction, and why.** `redact_command_line` masks `--flag value` and `--flag=value`
pairs; `redact_text` masks `Bearer <token>` markers and well-known token prefixes. Neither is a
superset of the other, so both run. The test that proves it writes
`run curl --password hunter2 https://api.example/x` and asserts `hunter2` is absent - a real bug
this test caught in development, where a single `redact_text` pass left the flag value intact.

### 2.3 Rotation

| Constant | Value | Meaning |
| :--- | :--- | :--- |
| `LOG_MAX_BYTES` | 5 MiB | maximum size of any one log file |
| `LOG_MAX_FILES` | 3 | active + 2 rotated (`zenith.log`, `.1`, `.2`) |

Rotation runs **before** the append and is decided from the incoming line's length, so a single
long line can never push a file past the cap. The oldest file is deleted first, then indices shift
upward, so no rename ever overwrites a live file. `LOG_MAX_FILES` counts the active file.

Both constants previously had no consumer - a live L3 violation. `logging.rs` is that consumer, and
`04-02` §5 now cites it truthfully.

### 2.4 Levels

| Level | Used for |
| :--- | :--- |
| `INFO` | startup maintenance, recovery summaries, completed actions |
| `WARN` | degraded store, quarantine events, retention awaiting consent |
| `ERROR` | an action that ended in an error code (never `CANCELLED`) |

A cancelled action is not an error and is not logged at `ERROR`; it is an intentional user
decision. Errors log the stable code (`ACCESS_DENIED`), not a sentence, so the log is
locale-independent.

---

## 3. Audit trail and correlation ids

Every user intent gets one correlation id (`audit::new_correlation_id()`, a 32-char lowercase hex
UUIDv4) at the IPC boundary. It appears in:

1. the `IpcError` returned to the renderer (`correlationId`),
2. the error toast the user sees (`misc.error.correlation`),
3. the audit row,
4. the operation log line.

That is what makes §6's triage procedure possible: a user quotes eight words from the toast and
support finds the exact row and line.

| Property | Rule | Test |
| :--- | :--- | :--- |
| Unique | two calls never collide | `correlation_ids_are_unique_and_url_safe` |
| URL-safe | `[0-9a-f]{32}`, no dashes | same |
| Present on *every* error | `IpcError::new` always generates one | `error_serialises_to_the_ipc_shape` |
| Never a fake id | boot failure before the core is up uses the literal `unavailable`, not a random UUID | `05-02` §9 |

The audit schema has no column for command lines, environment variables or file contents
(`03-03` §1). Fields that do not exist cannot leak.

---

## 4. Audit export

`file_save_text` (IPC §5.10) writes user-initiated text to a path the user picks in the native
dialog. Formats are closed: `ps1`, `bat`, `csv`, `json`.

| Property | Implementation |
| :--- | :--- |
| Format allowlist | `match request.format` - anything else is `INVALID_ARGUMENT` |
| Size cap | 2 MiB (`MAX_SAVE_BYTES`) |
| Path is a hint, never a directory | separators stripped from `suggested_name` |
| Cancel is not an error | returns `{ path: null, bytes: 0 }` |
| No silent write | the OS dialog is the only writer; the core does not pick a path |

### 4.1 The audit-table export (REQ-F-090)

The snapshot ledger is the audit trail, so the export reads it directly rather than
re-deriving a table from the console log:

| Piece | Where |
| :--- | :--- |
| Row projection | `src/export.ts` → `auditRows(snapshots)`; action name resolved from the generated catalogue |
| CSV | `toCsv(rows)` - RFC 4180 quoting, CRLF row endings, numbers left unquoted |
| JSON | `toJson(rows, exportedAtUtc)` - `{ v: 1, kind: "zenith.audit", exportedAtUtc, columns, rows }` |
| Buttons | Snapshots screen: **Export CSV** / **Export JSON** |
| Transport | the same `file_save_text` command; no new IPC surface |
| Schema stability | the `v` field is written first and the column list is exported alongside the rows |
| Tests | `src/export.test.ts` - 9 cases (quoting, quoting of embedded quotes/newlines, unquoted numbers, CRLF, envelope, round-trip, unknown action id) |

A cancelled dialog returns `{ path: null }`; the export then logs nothing instead of
announcing a file that was never written. REQ-F-090 is met: the schema version is
present and machine-checked by the test file.---

## 5. Support bundle

`support_bundle_create` → `support::create(store, paths, elevated, note)`. Written to
`%LOCALAPPDATA%\Vellium\Zenith\support\Zenith-Support-<stamp>.zip` so a standard user can always
produce one (ADR-024).

### 5.1 Contents - allowlisted, never a glob

| Entry | Contents | Identity risk |
| :--- | :--- | :--- |
| `manifest.json` | schema/app version, OS build, elevated flag, store mode, file list | C0 |
| `audit.json` | last 200 audit rows (keys + counters) | C1, redacted |
| `snapshots.json` | ledger metadata; **no payloads, no archive paths** | C1 |
| `environment.json` | OS build/UBR/arch, schema version | C1, no host/user |
| `logs/*.log` | last 256 KiB per file, trimmed on a line boundary | C1, redacted |
| `user-note.txt` | the reporter's own words (optional) | redacted |

### 5.2 Bounds

| Constant | Value |
| :--- | ---: |
| `SUPPORT_BUNDLE_MAX_BYTES` | 5 MiB uncompressed |
| `SUPPORT_BUNDLE_MAX_FILES` | 10 |
| per-log cap | 256 KiB |

The total is measured **before** writing; `trim_to_budget` drops whole entries from the end until
the bundle fits, then `entries.truncate(MAX_FILES − 1)` reserves the slot the manifest needs. The
archive is written `.zip.tmp` and renamed, so a crash never leaves a half-shareable zip.

### 5.3 Redaction order

`scrub(bytes)` runs `redact_text` **first**, then `scrub_identifiers`. The order matters:
`redact_text` understands token shapes, `scrub_identifiers` understands *this machine's* `USERPROFILE`,
`USERNAME` and `COMPUTERNAME`. Reversing them would let a token survive if it happened to contain a
path. The returned `RedactionReport` counts masked values and scrubbed paths so the UI can show the
user exactly what was removed.

Tests: `redaction_happens_before_identifier_scrubbing`,
`identifier_scrubbing_replaces_identity_but_not_short_names`,
`trimming_drops_whole_entries_until_the_budget_is_met`, and the end-to-end
`seeded_secrets_do_not_survive_into_the_written_bundle`.

> **Closed 2026-11-20 (DEF-053).** The end-to-end test now exists: it writes a real log
> containing a `ghp_` token, a JWT and a `--db-password=` assignment, calls `create()`, opens the
> produced zip and re-reads every entry. It failed on its first run and exposed two real holes -
> a token as URL userinfo (`https://ghp_…@host`) was only masked when a password was present, and
> `redact_text` did not honour `flag=value`, so log lines leaked what command lines did not. Both
> are fixed in `redact.rs` (`redact_embedded_known`, `redact_secret_assignments`).

---

## 6. Triage procedure (how support uses these artefacts)

```text
1. User reports "it failed" and quotes the correlation id from the toast.
2. Support asks for Help → "Create support bundle" (no elevation needed).
3. Open manifest.json: version, OS build, elevation, store mode.
4. Search audit.json for the correlation id → action, phase, status, error code, counts.
5. Search logs/*.log for the same id or code → surrounding lines, redacted.
6. If the snapshot is involved, snapshots.json shows committed/restored state and size.
7. Reproduce with the script from the action's "Report" dialog if a script was involved.
```

No step requires the user to run a command or read a log. That is the requirement - a support
bundle a non-technical user cannot produce is not a support bundle.

### 6.1 What support cannot see

- File contents (never collected).
- Raw command lines (redacted before storage).
- Other users' preferences (per-user `%LOCALAPPDATA%`).
- Snapshot payloads (archive contents are not included).

Stated plainly because a support promise that overstates visibility is a privacy defect.

---

## 7. Boot-time observability

Startup is the most failure-prone moment and the hardest to report, so it produces explicit
artefacts:

| Condition | Notice | Log | Audit |
| :--- | :--- | :--- | :--- |
| Machine store unwritable | `notices.userFallbackStore` (Warning) | `WARN` line | - |
| Database quarantined | `notices.storeQuarantined` (Critical) | `INFO` recovery summary | - |
| Crash recovery repairs | `notices.storeRecovered` (Info) | one line per repair | - |
| Retention awaiting consent | `notices.retentionConsent` | `INFO` | - |
| Retention pruned | `notices.retentionPruned` | `INFO` | - |
| Retention store unreadable | - (no notice: preferences and telemetry still load) | `INFO` line `maintenance.retention_unreadable <reason>` | - |
| Elevation handover resumed | `notices.resumeQueue` (Info) | - | - |
| Handover items rejected | `notices.resumeDropped` (Warning) | - | - |

A notice is always a key plus params, never a sentence (`03-04` §2). A missed event loses nothing
because `state_get` returns the same list.

---

## 8. Verification

```powershell
# Log writer: redaction, rotation, graceful failure (7 tests)
cargo test -p zenith --lib logging::

# Housekeeping that produces the log lines (11 tests, 5 of them DEF-126)
cargo test -p zenith --lib maintenance::

# Support bundle: redaction order, identity scrub, budget trim, seeded-secret e2e (4 tests)
cargo test -p zenith-core support::

# Audit: correlation ids, timestamp round trip (7 tests)
cargo test -p zenith-core audit::

# Redaction shapes and idempotence (18 tests)
cargo test -p zenith-core redact::

# No console output bypasses the writer
node -e "const fs=require('fs');const s=fs.readFileSync('src-tauri/src/lib.rs','utf8');console.log(/println!/.test(s)?'FAIL':'ok')"
```

The last check exists because `println!` in a GUI-subsystem Windows build writes nowhere, which is the
v1.0.0 failure this log writer replaces. The binary is now console-subsystem (`03-04` §8.3) so the
headless CLI's redirected output is not lost; the rule still holds - diagnostics go through the log
writer, not `println!`, because the GUI detaches its console before the window opens.
