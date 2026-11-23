# 03-03 - Data Model, Storage, Migrations & Retention

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-DATA-001 |
| Version | 2.0.0 |
| Store | SQLite 3 (bundled), WAL |
| Owner | Architecture |
| Closes | DEF-014, DEF-015, DEF-019, DEF-020 |

---

## 1. Storage layout

```text
%ProgramData%\Vellium\Zenith\            (primary; Administrators+SYSTEM write)
├── state.db                             SQLite, WAL
├── state.db-wal  state.db-shm           journal (crash safety)
├── hmac.key.dpapi                       DPAPI-protected 32-byte key (machine scope)
├── schema.version                       integer, mirrors user_version
├── backups\
│   ├── <snapshot_id>.zip                verified archives
│   ├── <snapshot_id>.zip.sha256         sidecar hash (fast integrity check)
│   └── *.zip.tmp                        transient; deleted on recovery
├── hives\                               reg.exe exports for compensating recovery
├── logs\
│   ├── zenith.log                       current
│   └── zenith.log.1 … .3                rotated, 5 MB each
└── quarantine\                          corrupt DB moved aside, never deleted

%LOCALAPPDATA%\Vellium\Zenith\           (per-user, always writable)
├── support\                             support bundles
└── prefs.json                           theme, locale, reduce-motion (mirrored in DB)
```

Fallback: if `%ProgramData%\Vellium\Zenith` cannot be created, use
`%LOCALAPPDATA%\Vellium\Zenith\data` and raise a `DegradedStorage` notice in the UI
(REQ-F-093, ADR-005).

---

## 2. Why machine-wide

| Scenario | `%LOCALAPPDATA%` (v1.0.0) | `%ProgramData%` (v2.0.0) |
| :--- | :--- | :--- |
| Standard user runs app | writes `C:\Users\ayse\...` | reads machine store |
| Same user elevates with **their own** admin account | same profile → OK | same store → OK |
| Standard user elevates with **another** admin's credentials (over-the-shoulder) | **different profile → different DB → history lost** | same store → OK |
| Attacker tries to forge a snapshot | can write user DB | needs admin |

---

## 3. Schema (v1)

Applied transactionally on open; `PRAGMA user_version` is the migration cursor.

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE snapshots (
  snapshot_id      TEXT PRIMARY KEY NOT NULL,
  action_id        TEXT NOT NULL,
  created_at_utc   TEXT NOT NULL,
  os_build         INTEGER NOT NULL,
  snapshot_type    TEXT NOT NULL,          -- registry|service|filesystem|explorer|hive
  tx_status        TEXT NOT NULL,          -- PENDING|COMMITTED|ABORTED|BROKEN
  payload_json     TEXT NOT NULL,
  hmac_sha256      TEXT NOT NULL,
  schema_version   INTEGER NOT NULL DEFAULT 1,
  est_bytes        INTEGER NOT NULL DEFAULT 0,
  is_restored      INTEGER NOT NULL DEFAULT 0,
  restored_at_utc  TEXT,
  correlation_id   TEXT NOT NULL,
  CHECK (tx_status IN ('PENDING','COMMITTED','ABORTED','BROKEN')),
  CHECK (is_restored IN (0,1))
);

CREATE INDEX idx_snapshots_action_time ON snapshots(action_id, created_at_utc DESC);
CREATE INDEX idx_snapshots_status      ON snapshots(tx_status);
CREATE INDEX idx_snapshots_unrestored  ON snapshots(is_restored, created_at_utc DESC);

CREATE TABLE execution_audit (
  log_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  correlation_id  TEXT NOT NULL,
  action_id       TEXT NOT NULL,
  phase           TEXT NOT NULL,           -- execute|rollback|diagnose
  started_at_utc  TEXT NOT NULL,
  completed_at_utc TEXT,
  duration_ms     INTEGER,
  status          TEXT NOT NULL,           -- success|error|cancelled|skipped|timeout
  snapshot_id     TEXT,
  error_code      TEXT,
  message_key     TEXT NOT NULL,
  params_json     TEXT NOT NULL DEFAULT '{}',
  bytes_freed     INTEGER NOT NULL DEFAULT 0,
  items_affected  INTEGER NOT NULL DEFAULT 0,
  elevated        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_audit_time   ON execution_audit(started_at_utc DESC);
CREATE INDEX idx_audit_action ON execution_audit(action_id, started_at_utc DESC);
CREATE INDEX idx_audit_corr   ON execution_audit(correlation_id);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY NOT NULL,
  value_json  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE archive_ledger (
  snapshot_id    TEXT PRIMARY KEY NOT NULL,
  zip_path       TEXT NOT NULL,
  zip_sha256     TEXT NOT NULL,
  file_count     INTEGER NOT NULL,
  total_bytes    INTEGER NOT NULL,
  deleted_at_utc TEXT,
  FOREIGN KEY (snapshot_id) REFERENCES snapshots(snapshot_id) ON DELETE CASCADE
);
```

**Deliberately absent columns** (privacy, `04-02` §3): file contents, environment variables, raw
command lines, user documents, usernames, email addresses.

---

## 4. Connection policy

| Concern | Policy |
| :--- | :--- |
| Pool | Single `Connection` behind `Mutex`; WAL allows one writer, many readers. Concurrency need is low and correctness matters more. |
| Long transactions | Forbidden outside migrations; a blocked writer must not stall the UI (all calls in `spawn_blocking`). |
| Integrity | `PRAGMA quick_check` on open; on failure → §4.4. |
| Timeouts | `busy_timeout = 5000`; on lock exhaustion return `DatabaseBusy` with remedy. |
| Prepared statements | Reused where hot (`snapshot list`, `audit insert`). |

### 4.1 Write-ahead flow for a mutable action

```text
BEGIN IMMEDIATE
  INSERT snapshots (tx_status='PENDING')     ← intent recorded
COMMIT
... phase 1/2 archive work ...
BEGIN IMMEDIATE
  UPDATE snapshots SET tx_status='COMMITTED', hmac=...
  INSERT archive_ledger
COMMIT                                        ← commit point
... destructive mutation ...
INSERT execution_audit(...)
```

### 4.2 Recovery on start (`recover_incomplete_transactions`)

| Found | Action | Log |
| :--- | :--- | :--- |
| `tx_status='PENDING'` row | Set `ABORTED`; delete matching `.tmp`; keep row for forensics | `recovery.pending_aborted` |
| `COMMITTED` row, archive missing | Set `BROKEN`; block rollback with explanation | `recovery.archive_missing` |
| `*.zip.tmp` with no row | Delete file | `recovery.tmp_orphan_removed` |
| `.zip` with no ledger row | Move to `quarantine`, delete after 7 days | `recovery.archive_orphan` |
| `archive_ledger` row, file missing | Mark snapshot `BROKEN` | `recovery.ledger_mismatch` |

Recovery **never deletes a committed snapshot row** (ADR-021).

### 4.3 Audit write

Every terminal state writes exactly one row. `correlation_id` is generated per user intent and
propagated to logs, events, and the support bundle (REQ-F-144).

### 4.4 Corruption handling

```text
quick_check fails
  → close handle
  → move state.db{,-wal,-shm} to quarantine/state-<utc>.db
  → create fresh DB, migrations applied
  → emit startup_notice { code: 'StoreQuarantined', path }
  → app runs (no history, rollback unavailable until user decides)
```

Never silent-delete user history; never silently continue with a corrupt store.

---

## 5. Snapshot payload contracts

Payload is JSON, versioned by `schema_version`, and tagged. Discriminated by `type`.

### 5.1 `registry_backup`

```json
{
  "type": "registry_backup",
  "schema": 1,
  "entries": [
    { "hive": "HKCU", "subkey": "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      "value_name": "ProxyEnable", "data": { "kind": "dword", "value": 1 } },
    { "hive": "HKCU", "subkey": "...Internet Settings",
      "value_name": "AutoConfigURL", "data": { "kind": "absent" } }
  ]
}
```

`data.kind ∈ {dword, sz, expand_sz, qword, binary, multi_sz, absent}`. `absent` is meaningful: it
records that the value did not exist, so rollback deletes rather than writes a default.

### 5.2 `service_state_backup`

```json
{ "type": "service_state_backup", "schema": 1, "service_name": "Spooler",
  "was_running": true, "start_type": 2, "delayed_autostart": false }
```

`start_type` is the raw SCM value (`0` boot, `1` system, `2` auto, `3` manual, `4` disabled).

### 5.3 `filesystem_archive`

```json
{ "type": "filesystem_archive", "schema": 1,
  "scope_id": "screenshots",
  "archive_zip_path": "backups/snap_archive-screenshots_1763510400000.zip",
  "zip_sha256": "…64 hex…", "file_count": 412, "total_bytes": 183442211 }
```

`scope_id` (not a free path) is the rollback anchor - see ADR-007 and `03-05` §5.

### 5.4 `explorer_session_backup`

```json
{ "type": "explorer_session_backup", "schema": 1,
  "open_folder_paths": ["C:\\Users\\ayse\\Documents", "D:\\Projects"] }
```

### 5.5 `compensating_hive_export`

```json
{ "type": "compensating_hive_export", "schema": 1,
  "hive_export_path": "hives/WinSock2_1763510400.hiv",
  "export_sha256": "…", "restore_point_created": true,
  "restore_point_name": "Zenith_Winsock_Reset" }
```

---

## 6. Retention

| Data | Default cap | Behaviour at cap |
| :--- | :--- | :--- |
| `execution_audit` | 5,000 rows | Delete oldest; never delete today's rows |
| `snapshots` | 200 rows **or** 2 GB, whichever first | Prune oldest **restored** first; unrestored requires confirmation |
| `backups/*.zip` | follows ledger | Orphan GC on start; 7-day quarantine for unknown files |
| `logs` | 5 MB × 3 | Rotate, then drop oldest |
| `support/*` | 10 bundles | Delete oldest |
| `quarantine/*` | 30 days | Delete with log entry |
| `hives/*` | 20 files | Delete oldest (compensating recovery only) |

Pruning is a single transaction per batch and is audited (`retention.pruned` with counts and
bytes). The Settings screen shows current usage and a "free space now" button that explains what
will be removed first.

---

## 7. Migrations

Rules:

1. Forward-only. No down migrations in shipped code.
2. Each migration is one transaction; failure rolls back and the app refuses to start with
   `SchemaMigrationFailed` rather than running on a half-schema.
3. `schema.version` file and `PRAGMA user_version` must agree, else `SchemaDrift`.
4. A migration may not read action semantics; it works on stored data only.
5. Migration tests use fixtures generated from the previous release's schema.

| Version | Change | Notes |
| :--- | :--- | :--- |
| 1 | Initial schema above | Ships with 1.0.0 |
| 2 (planned) | `snapshots.abortable`, `audit.ui_locale` | Additive; no rewrite |

```rust
const MIGRATIONS: &[(i64, &str)] = &[(1, include_str!("../../migrations/001_init.sql"))];

fn migrate(conn: &mut Connection) -> Result<(), ZenithError> {
    let current: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    for (version, sql) in MIGRATIONS.iter().filter(|(v, _)| *v > current) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", version)?;
        tx.execute("INSERT INTO schema_migrations (version, applied_at, description) VALUES (?1, ?2, ?3)",
                   rusqlite::params![version, now_utc(), format!("schema v{version}")])?;
        tx.commit()?;
    }
    Ok(())
}
```

---

## 8. Integrity model

```text
tag = HMAC-SHA256(key_dpapi, snapshot_id ‖ 0x00 ‖ action_id ‖ 0x00 ‖ payload_json ‖ 0x00 ‖ schema_version)
```

Verified on every read used for rollback. Failure → `SnapshotIntegrityError`, rollback refused,
support bundle offered. The key never leaves the machine and is unprotectable without
SYSTEM/Administrator (ADR-006).

**What this does and does not protect:**

| Threat | Protected |
| :--- | :--- |
| Standard user edits `payload_json` | PASS tag invalid |
| Standard user copies a snapshot to another machine | PASS key differs |
| Malware running as the same standard user | PASS |
| Malware running elevated | FAIL (it can read the key - accepted; elevated malware already owns the machine) |
| Disk corruption | PASS detected |

---

## 9. Backup and export

Users can export a snapshot set as a portable bundle:

```text
zenith-snapshots-20261118.zip
├── manifest.json        snapshot rows (no HMAC secrets), versions
├── snapshots/*.json     payloads
└── README.txt           what this is, and that archives are not included by default
```

Import is deliberately **not** supported in v1: replayed snapshots from another machine would
weaken the scope model. Export exists for audit and forensics.

---

## 10. Open/close lifecycle

```text
init()
  resolve dir → create → set ACL (installer does this on first install)
  read/unprotect key
  open DB (WAL) → quick_check → migrate → recover → retention check
close()
  checkpoint WAL → close
```

A second process opening the same DB is expected (one window only, but CLI may run). WAL + busy
timeout handles it; the execution registry prevents concurrent mutation, and the single-instance
plugin keeps a second GUI process from starting at all.

---

## 11. Test obligations (mapped in `02-03`)

| Test | Asserts |
| :--- | :--- |
| T-RUST-05 | One snapshot row per mutation; audit row per terminal state |
| T-RUST-07 | Tampered payload rejected |
| T-RUST-16 | Retention caps honoured; unrestored preserved |
| T-RUST-17 | Fallback path used when ProgramData is unwritable |
| T-RUST-18 | Corrupt DB quarantined, app starts |
| T-RUST-19 | Migration from v1 fixture succeeds transactionally |
| T-RUST-20 | Low-disk pre-check refuses destructive action |
| T-FAULT-01 | Every crash point leaves a recoverable state |
| T-FAULT-02 | Orphan archive GC works |
