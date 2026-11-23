//! Durable storage: schema, migrations, crash recovery and the snapshot ledger.
//!
//! Design decisions that this module makes concrete:
//!
//! * **Write-ahead commit.** A snapshot row is inserted `PENDING`, then promoted
//!   to `COMMITTED` *before* the destructive mutation. The commit point precedes
//!   the damage (`03-01` §7.1, ADR-003).
//! * **Recovery is meaningful.** Rows and files are reconciled in both
//!   directions, so a crash has a defined outcome instead of a guess.
//! * **Corruption is quarantined, never deleted.** A tool that silently wipes
//!   history when the disk hiccups cannot be trusted with rollback.
//! * **No secrets, no contents.** The schema has no column for file bytes,
//!   environment variables or raw command lines (`04-02` §3).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, params};

use crate::config::Paths;
use crate::engine::audit::{AuditEntry, AuditPhase, AuditStatus, compact_utc_stamp, now_utc};
use crate::engine::retention::{PrunePlan, RetentionCandidate};
use crate::engine::snapshot::{SnapshotKey, verify_archive};
use crate::error::{ErrorCode, ZenithError, ZenithResult};
use crate::models::{ActionId, ReversibilityTier, SnapshotRecord, SnapshotStatus};

/// Row shape used for recovery and integrity checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredSnapshot {
    pub snapshot_id: String,
    pub action_id: String,
    pub created_at_utc: String,
    pub snapshot_type: String,
    pub tx_status: TxStatus,
    pub payload_json: String,
    pub hmac_sha256: String,
    pub schema_version: i64,
    pub est_bytes: u64,
    pub is_restored: bool,
    pub restored_at_utc: Option<String>,
    pub correlation_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TxStatus {
    Pending,
    Committed,
    Aborted,
    Broken,
}

impl TxStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "PENDING",
            Self::Committed => "COMMITTED",
            Self::Aborted => "ABORTED",
            Self::Broken => "BROKEN",
        }
    }

    fn parse(value: &str) -> ZenithResult<Self> {
        match value {
            "PENDING" => Ok(Self::Pending),
            "COMMITTED" => Ok(Self::Committed),
            "ABORTED" => Ok(Self::Aborted),
            "BROKEN" => Ok(Self::Broken),
            other => Err(ZenithError::new(ErrorCode::IntegrityError)
                .with("reason", "unknown tx_status")
                .detail(other.to_string())),
        }
    }
}

/// What startup recovery changed. Surfaced in the log and, when non-empty, in
/// the UI as a startup notice.
#[derive(Debug, Clone, Default)]
pub struct RecoveryReport {
    pub pending_aborted: Vec<String>,
    pub missing_archives: Vec<String>,
    pub orphan_archives: Vec<String>,
    pub temp_files_removed: Vec<String>,
    pub quarantined_database: Option<PathBuf>,
    /// Directories the reconciliation pass could not read. A recovery pass that
    /// cannot see a directory has not reconciled it, and saying nothing is how
    /// "startup found no problems" becomes a claim about directories nobody
    /// looked inside (DEF-152).
    pub unreadable_directories: Vec<String>,
}

impl RecoveryReport {
    pub fn is_empty(&self) -> bool {
        self.pending_aborted.is_empty()
            && self.missing_archives.is_empty()
            && self.orphan_archives.is_empty()
            && self.temp_files_removed.is_empty()
            && self.quarantined_database.is_none()
            && self.unreadable_directories.is_empty()
    }

    /// One line per repair, for the log.
    pub fn summary(&self) -> Vec<String> {
        let mut lines = Vec::new();
        if let Some(path) = &self.quarantined_database {
            lines.push(format!("recovery.database_quarantined {}", path.display()));
        }
        for id in &self.pending_aborted {
            lines.push(format!("recovery.pending_aborted {id}"));
        }
        for id in &self.missing_archives {
            lines.push(format!("recovery.archive_missing {id}"));
        }
        for name in &self.orphan_archives {
            lines.push(format!("recovery.archive_orphan {name}"));
        }
        for name in &self.temp_files_removed {
            lines.push(format!("recovery.tmp_orphan_removed {name}"));
        }
        for dir in &self.unreadable_directories {
            lines.push(format!("recovery.directory_unreadable {dir}"));
        }
        lines
    }
}

/// The store handle. One connection behind a mutex: correctness over
/// concurrency, because the workload is small and the data matters.
pub struct Store {
    conn: Mutex<Connection>,
    key: SnapshotKey,
    paths: Paths,
}

const SCHEMA_V1: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  snapshot_id      TEXT PRIMARY KEY NOT NULL,
  action_id        TEXT NOT NULL,
  created_at_utc   TEXT NOT NULL,
  os_build         INTEGER NOT NULL DEFAULT 0,
  snapshot_type    TEXT NOT NULL,
  tx_status        TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_snapshots_action_time ON snapshots(action_id, created_at_utc DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_status      ON snapshots(tx_status);
CREATE INDEX IF NOT EXISTS idx_snapshots_unrestored  ON snapshots(is_restored, created_at_utc DESC);

CREATE TABLE IF NOT EXISTS execution_audit (
  log_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  correlation_id   TEXT NOT NULL,
  action_id        TEXT NOT NULL,
  phase            TEXT NOT NULL,
  started_at_utc   TEXT NOT NULL,
  completed_at_utc TEXT,
  duration_ms      INTEGER,
  status           TEXT NOT NULL,
  snapshot_id      TEXT,
  error_code       TEXT,
  message_key      TEXT NOT NULL,
  params_json      TEXT NOT NULL DEFAULT '{}',
  bytes_freed      INTEGER NOT NULL DEFAULT 0,
  items_affected   INTEGER NOT NULL DEFAULT 0,
  elevated         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_audit_time   ON execution_audit(started_at_utc DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON execution_audit(action_id, started_at_utc DESC);
CREATE INDEX IF NOT EXISTS idx_audit_corr   ON execution_audit(correlation_id);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS archive_ledger (
  snapshot_id    TEXT PRIMARY KEY NOT NULL,
  zip_path       TEXT NOT NULL,
  zip_sha256     TEXT NOT NULL,
  file_count     INTEGER NOT NULL,
  total_bytes    INTEGER NOT NULL,
  deleted_at_utc TEXT,
  FOREIGN KEY (snapshot_id) REFERENCES snapshots(snapshot_id) ON DELETE CASCADE
);
"#;

impl Store {
    /// Open (or create) the store. Returns the store and a recovery report.
    pub fn open(paths: &Paths, key: SnapshotKey) -> ZenithResult<(Self, RecoveryReport)> {
        paths.ensure_layout();
        let db_path = paths.database();
        let mut report = RecoveryReport::default();

        let conn = match Connection::open(&db_path) {
            Ok(conn) => conn,
            Err(err) => {
                return Err(map_sqlite("open state.db", err));
            }
        };

        // Integrity before anything else. A corrupt store must not be migrated.
        if quick_check(&conn).is_err() {
            drop(conn);
            report.quarantined_database = Some(quarantine(&db_path, paths)?);
            let conn =
                Connection::open(&db_path).map_err(|err| map_sqlite("recreate state.db", err))?;
            migrate(&conn)?;
            let store = Self {
                conn: Mutex::new(conn),
                key,
                paths: paths.clone(),
            };
            return Ok((store, report));
        }

        migrate(&conn)?;

        let store = Self {
            conn: Mutex::new(conn),
            key,
            paths: paths.clone(),
        };

        let reconciliation = store.reconcile()?;
        report.pending_aborted = reconciliation.pending_aborted;
        report.missing_archives = reconciliation.missing_archives;
        report.orphan_archives = reconciliation.orphan_archives;
        report.temp_files_removed = reconciliation.temp_files_removed;
        // Field-by-field assignment is what dropped this one on the first pass:
        // the report was built correctly and then discarded here. The compiler
        // cannot catch it, so the test below asserts the field survives the
        // `Store::open` boundary rather than only existing on `reconcile`.
        report.unreadable_directories = reconciliation.unreadable_directories;

        Ok((store, report))
    }

    pub fn paths(&self) -> &Paths {
        &self.paths
    }

    pub fn key(&self) -> &SnapshotKey {
        &self.key
    }

    // -----------------------------------------------------------------
    // Snapshots
    // -----------------------------------------------------------------

    /// Insert a snapshot as `PENDING`. Returns the generated id.
    pub fn begin_snapshot(
        &self,
        action: ActionId,
        snapshot_type: &str,
        payload_json: &str,
        correlation_id: &str,
        est_bytes: u64,
    ) -> ZenithResult<String> {
        let snapshot_id = crate::engine::audit::new_correlation_id();
        let created = now_utc();
        let tag = self.key.tag(
            &snapshot_id,
            action.as_str(),
            payload_json,
            crate::SCHEMA_VERSION,
        );

        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO snapshots
               (snapshot_id, action_id, created_at_utc, snapshot_type, tx_status,
                payload_json, hmac_sha256, schema_version, est_bytes, correlation_id)
             VALUES (?1, ?2, ?3, ?4, 'PENDING', ?5, ?6, ?7, ?8, ?9)",
            params![
                snapshot_id,
                action.as_str(),
                created,
                snapshot_type,
                payload_json,
                tag,
                crate::SCHEMA_VERSION,
                est_bytes as i64,
                correlation_id
            ],
        )
        .map_err(|err| map_sqlite("insert snapshot", err))?;

        Ok(snapshot_id)
    }

    /// Promote to `COMMITTED`. This is the commit point.
    pub fn commit_snapshot(&self, snapshot_id: &str) -> ZenithResult<()> {
        let conn = self.conn.lock();
        let changed = conn
            .execute(
                "UPDATE snapshots SET tx_status = 'COMMITTED' WHERE snapshot_id = ?1 AND tx_status = 'PENDING'",
                params![snapshot_id],
            )
            .map_err(|err| map_sqlite("commit snapshot", err))?;
        if changed == 0 {
            return Err(ZenithError::new(ErrorCode::SnapshotNotFound)
                .with("snapshotId", snapshot_id.to_string()));
        }
        Ok(())
    }

    /// Abandon a `PENDING` snapshot. Used when the archive failed before the
    /// commit point; the row is kept for forensics.
    pub fn abort_snapshot(&self, snapshot_id: &str) -> ZenithResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE snapshots SET tx_status = 'ABORTED' WHERE snapshot_id = ?1 AND tx_status = 'PENDING'",
            params![snapshot_id],
        )
        .map_err(|err| map_sqlite("abort snapshot", err))?;
        Ok(())
    }

    pub fn record_archive(
        &self,
        snapshot_id: &str,
        zip_path: &str,
        zip_sha256: &str,
        file_count: u64,
        total_bytes: u64,
    ) -> ZenithResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO archive_ledger
               (snapshot_id, zip_path, zip_sha256, file_count, total_bytes)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                snapshot_id,
                zip_path,
                zip_sha256,
                file_count as i64,
                total_bytes as i64
            ],
        )
        .map_err(|err| map_sqlite("record archive", err))?;
        Ok(())
    }

    pub fn archive_for(&self, snapshot_id: &str) -> ZenithResult<Option<(String, String)>> {
        let conn = self.conn.lock();
        let row = conn
            .query_row(
                "SELECT zip_path, zip_sha256 FROM archive_ledger
                 WHERE snapshot_id = ?1 AND deleted_at_utc IS NULL",
                params![snapshot_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|err| map_sqlite("read archive ledger", err))?;
        Ok(row)
    }

    pub fn get_snapshot(&self, snapshot_id: &str) -> ZenithResult<Option<StoredSnapshot>> {
        let conn = self.conn.lock();
        let row = conn
            .query_row(
                "SELECT snapshot_id, action_id, created_at_utc, snapshot_type, tx_status,
                        payload_json, hmac_sha256, schema_version, est_bytes,
                        is_restored, restored_at_utc, correlation_id
                 FROM snapshots WHERE snapshot_id = ?1",
                params![snapshot_id],
                map_stored_snapshot,
            )
            .optional()
            .map_err(|err| map_sqlite("read snapshot", err))?;
        Ok(row)
    }

    /// List snapshot history for the UI, newest first.
    pub fn list_snapshots(&self, limit: i64) -> ZenithResult<Vec<SnapshotRecord>> {
        let conn = self.conn.lock();
        let mut statement = conn
            .prepare(
                "SELECT snapshot_id, action_id, created_at_utc, snapshot_type,
                        is_restored, restored_at_utc, est_bytes, tx_status
                 FROM snapshots
                 WHERE tx_status IN ('COMMITTED','BROKEN')
                 -- created_at_utc has millisecond precision, so two actions
                 -- started in the same millisecond tie. rowid is monotonic and
                 -- breaks the tie in insertion order, which is the only
                 -- ordering the UI can honestly call newest-first.
                 ORDER BY created_at_utc DESC, rowid DESC
                 LIMIT ?1",
            )
            .map_err(|err| map_sqlite("prepare list", err))?;

        let rows = statement
            .query_map(params![limit], |row| {
                let action_text: String = row.get(1)?;
                Ok((
                    row.get::<_, String>(0)?,
                    action_text,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)? != 0,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, i64>(6)? as u64,
                    row.get::<_, String>(7)?,
                ))
            })
            .map_err(|err| map_sqlite("query list", err))?;

        let mut out = Vec::new();
        for row in rows {
            let (id, action_text, created, kind, is_restored, restored_at, est, status) =
                row.map_err(|err| map_sqlite("row", err))?;
            let Ok(action) = action_text.parse::<ActionId>() else {
                continue; // unknown action id: skip rather than panic
            };
            let tier = ReversibilityTier::from_action(action);
            out.push(SnapshotRecord {
                snapshot_id: id,
                action_id: action,
                created_at_utc: created,
                tier,
                snapshot_type: kind,
                is_restored,
                restored_at_utc: restored_at,
                est_bytes: est,
                status: if status == "BROKEN" {
                    SnapshotStatus::Broken
                } else {
                    SnapshotStatus::Committed
                },
                // DEF-135: was `format!("snapshots.{}", action.as_str())`, and
                // no `snapshots.<action-id>` key has ever existed in the
                // catalogue, so every audit export carried a raw key. The
                // snapshot records the completion of an action, so it names that
                // action's done key, which the catalogue defines.
                summary_key: format!("{}.done", crate::manifest::action_by_id(action).i18n_prefix),
                summary_params: BTreeMap::new(),
            });
        }
        Ok(out)
    }

    pub fn mark_restored(&self, snapshot_id: &str) -> ZenithResult<bool> {
        let conn = self.conn.lock();
        let changed = conn
            .execute(
                "UPDATE snapshots
                 SET is_restored = 1, restored_at_utc = ?2
                 WHERE snapshot_id = ?1 AND is_restored = 0 AND tx_status = 'COMMITTED'",
                params![snapshot_id, now_utc()],
            )
            .map_err(|err| map_sqlite("mark restored", err))?;
        Ok(changed > 0)
    }

    /// Verify the HMAC tag of a stored snapshot before any rollback work.
    pub fn verify_snapshot(&self, stored: &StoredSnapshot) -> ZenithResult<()> {
        if stored.tx_status != TxStatus::Committed {
            return Err(ZenithError::new(ErrorCode::IntegrityError)
                .with("reason", "snapshot is not committed")
                .with("snapshotId", stored.snapshot_id.clone()));
        }
        let ok = self.key.verify(
            &stored.snapshot_id,
            &stored.action_id,
            &stored.payload_json,
            stored.schema_version,
            &stored.hmac_sha256,
        );
        if ok {
            Ok(())
        } else {
            Err(ZenithError::new(ErrorCode::IntegrityError)
                .with("snapshotId", stored.snapshot_id.clone())
                .with("reason", "hmac mismatch"))
        }
    }

    pub fn snapshots_for_retention(&self) -> ZenithResult<Vec<RetentionCandidate>> {
        let conn = self.conn.lock();
        let mut statement = conn
            .prepare(
                "SELECT snapshot_id, created_at_utc, est_bytes, is_restored
                 FROM snapshots WHERE tx_status = 'COMMITTED'",
            )
            .map_err(|err| map_sqlite("prepare retention", err))?;
        let rows = statement
            .query_map([], |row| {
                Ok(RetentionCandidate {
                    snapshot_id: row.get(0)?,
                    created_at_utc: row.get(1)?,
                    est_bytes: row.get::<_, i64>(2)? as u64,
                    is_restored: row.get::<_, i64>(3)? != 0,
                })
            })
            .map_err(|err| map_sqlite("query retention", err))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|err| map_sqlite("retention row", err))?);
        }
        Ok(out)
    }

    pub fn audit_row_count(&self) -> ZenithResult<i64> {
        let conn = self.conn.lock();
        conn.query_row("SELECT COUNT(*) FROM execution_audit", [], |row| row.get(0))
            .map_err(|err| map_sqlite("count audit", err))
    }

    /// Apply a prune plan. Snapshots in `automatic` are deleted (restored ones,
    /// which the planner only ever selects). `needs_consent` is deliberately
    /// ignored here - the caller must obtain consent and pass those ids in
    /// `confirmed` (REQ-F-047).
    pub fn apply_prune(&self, plan: &PrunePlan, confirmed: &[String]) -> ZenithResult<u64> {
        let mut deleted = 0u64;
        let mut conn = self.conn.lock();
        let tx = conn
            .transaction()
            .map_err(|err| map_sqlite("begin prune", err))?;

        let mut all: Vec<&String> = plan.automatic.iter().collect();
        for id in confirmed {
            if plan.needs_consent.contains(id) {
                all.push(id);
            }
        }

        for id in all {
            let zip_path: Option<String> = tx
                .query_row(
                    "SELECT zip_path FROM archive_ledger WHERE snapshot_id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|err| map_sqlite("read ledger for prune", err))?;

            tx.execute("DELETE FROM snapshots WHERE snapshot_id = ?1", params![id])
                .map_err(|err| map_sqlite("delete snapshot", err))?;

            if let Some(path) = zip_path {
                let full = self.paths.data.join(&path);
                let _ = std::fs::remove_file(&full);
                let _ = std::fs::remove_file(full.with_extension("zip.sha256"));
            }
            deleted += 1;
        }

        if plan.audit_rows_to_delete > 0 {
            tx.execute(
                "DELETE FROM execution_audit WHERE log_id IN (
                   SELECT log_id FROM execution_audit ORDER BY started_at_utc ASC LIMIT ?1
                 )",
                params![plan.audit_rows_to_delete],
            )
            .map_err(|err| map_sqlite("prune audit", err))?;
        }

        tx.commit().map_err(|err| map_sqlite("commit prune", err))?;
        Ok(deleted)
    }

    // -----------------------------------------------------------------
    // Audit
    // -----------------------------------------------------------------

    pub fn insert_audit(&self, entry: &AuditEntry) -> ZenithResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO execution_audit
               (correlation_id, action_id, phase, started_at_utc, completed_at_utc,
                duration_ms, status, snapshot_id, error_code, message_key, params_json,
                bytes_freed, items_affected, elevated)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![
                entry.correlation_id,
                entry.action_id.as_str(),
                entry.phase.as_str(),
                entry.started_at_utc,
                entry.completed_at_utc,
                entry.duration_ms.map(|value| value as i64),
                entry.status.as_str(),
                entry.snapshot_id,
                entry.error_code.map(|code| code.as_str()),
                entry.message_key,
                entry.params_json,
                entry.bytes_freed as i64,
                entry.items_affected as i64,
                i64::from(entry.elevated),
            ],
        )
        .map_err(|err| map_sqlite("insert audit", err))?;
        Ok(())
    }

    pub fn list_audit(&self, limit: i64) -> ZenithResult<Vec<AuditEntry>> {
        let conn = self.conn.lock();
        let mut statement = conn
            .prepare(
                "SELECT correlation_id, action_id, phase, started_at_utc, completed_at_utc,
                        duration_ms, status, snapshot_id, error_code, message_key,
                        params_json, bytes_freed, items_affected, elevated
                 FROM execution_audit ORDER BY started_at_utc DESC LIMIT ?1",
            )
            .map_err(|err| map_sqlite("prepare audit list", err))?;

        // Read raw columns first, then decode. Doing this outside the row
        // closure means one malformed row is skipped instead of aborting the
        // whole list, and no column is ever filled with a placeholder value.
        let rows = statement
            .query_map(params![limit], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, i64>(12)?,
                    row.get::<_, i64>(13)?,
                ))
            })
            .map_err(|err| map_sqlite("query audit", err))?;

        let mut out = Vec::new();
        for row in rows {
            let (
                correlation_id,
                action_text,
                phase_text,
                started_at_utc,
                completed_at_utc,
                duration_ms,
                status_text,
                snapshot_id,
                error_code,
                message_key,
                params_json,
                bytes_freed,
                items_affected,
                elevated,
            ) = row.map_err(|err| map_sqlite("audit row", err))?;

            let (Some(phase), Some(status)) = (
                AuditPhase::parse(&phase_text),
                AuditStatus::parse(&status_text),
            ) else {
                continue; // unknown enum text: skip the row, never invent one
            };
            let Ok(action_id) = action_text.parse::<ActionId>() else {
                continue;
            };

            out.push(AuditEntry {
                correlation_id,
                action_id,
                phase,
                started_at_utc,
                completed_at_utc,
                duration_ms: duration_ms.map(|value| value as u64),
                status,
                snapshot_id,
                error_code: error_code.as_deref().and_then(ErrorCode::parse),
                message_key,
                params_json,
                bytes_freed: bytes_freed as u64,
                items_affected: items_affected as u64,
                elevated: elevated != 0,
            });
        }
        Ok(out)
    }

    // -----------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------

    pub fn get_setting(&self, key: &str) -> ZenithResult<Option<String>> {
        let conn = self.conn.lock();
        let value = conn
            .query_row(
                "SELECT value_json FROM settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| map_sqlite("read setting", err))?;
        Ok(value)
    }

    pub fn set_setting(&self, key: &str, value_json: &str) -> ZenithResult<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                            updated_at = excluded.updated_at",
            params![key, value_json, now_utc()],
        )
        .map_err(|err| map_sqlite("write setting", err))?;
        Ok(())
    }

    /// Delete snapshot rows and their files, keeping the audit trail.
    ///
    /// Used by `app_data_purge { scope: "snapshots" }`. Quarantined forensics
    /// survive unless `include_quarantine` is set: a broken archive may be the
    /// only evidence of what went wrong, and deleting it silently would destroy
    /// the thing a support case needs.
    ///
    /// Returns the row count and any directory that could not be cleared. The
    /// second half matters: the rows are committed away *before* the files are
    /// touched, so a directory that refuses to disappear leaves archives with no
    /// ledger entry. Reporting a clean purge there would break the one promise
    /// this module makes (DEF-150).
    pub fn purge_snapshots(&self, include_quarantine: bool) -> ZenithResult<(u64, Vec<String>)> {
        let snapshots: i64 = {
            let conn = self.conn.lock();
            let count = conn
                .query_row("SELECT COUNT(*) FROM snapshots", [], |row| row.get(0))
                .map_err(|err| map_sqlite("count snapshots", err))?;
            conn.execute_batch("DELETE FROM archive_ledger; DELETE FROM snapshots;")
                .map_err(|err| map_sqlite("purge snapshots", err))?;
            count
        };

        let mut failures = Vec::new();
        for dir in [self.paths.backups_dir(), self.paths.hives_dir()] {
            reset_owned_dir(&dir, &mut failures);
        }
        if include_quarantine {
            drop_owned_dir(&self.paths.quarantine_dir(), &mut failures);
        }
        Ok((snapshots.max(0) as u64, failures))
    }

    /// Wipe all user data. Used by "delete everything" (REQ-F-097).
    ///
    /// Like [`Store::purge_snapshots`], the row deletion commits first and the
    /// directories are cleared afterwards, so anything that survives is named in
    /// the returned warnings rather than quietly left behind.
    pub fn purge(&self, include_quarantine: bool) -> ZenithResult<(u64, u64, Vec<String>)> {
        let mut conn = self.conn.lock();
        let tx = conn
            .transaction()
            .map_err(|err| map_sqlite("begin purge", err))?;
        let snapshots: i64 = tx
            .query_row("SELECT COUNT(*) FROM snapshots", [], |row| row.get(0))
            .map_err(|err| map_sqlite("count snapshots", err))?;
        let audit: i64 = tx
            .query_row("SELECT COUNT(*) FROM execution_audit", [], |row| row.get(0))
            .map_err(|err| map_sqlite("count audit", err))?;
        tx.execute_batch("DELETE FROM archive_ledger; DELETE FROM snapshots; DELETE FROM execution_audit; DELETE FROM settings;")
            .map_err(|err| map_sqlite("purge rows", err))?;
        tx.commit().map_err(|err| map_sqlite("commit purge", err))?;

        let mut failures = Vec::new();
        for dir in [
            self.paths.backups_dir(),
            self.paths.hives_dir(),
            self.paths.logs_dir(),
            self.paths.support_dir(),
        ] {
            reset_owned_dir(&dir, &mut failures);
        }
        if include_quarantine {
            drop_owned_dir(&self.paths.quarantine_dir(), &mut failures);
        }

        Ok((snapshots.max(0) as u64, audit.max(0) as u64, failures))
    }

    // -----------------------------------------------------------------
    // Recovery
    // -----------------------------------------------------------------

    /// Reconcile database rows against files on disk, in both directions.
    pub fn reconcile(&self) -> ZenithResult<RecoveryReport> {
        let mut report = RecoveryReport::default();

        // 1. PENDING rows never reached the commit point.
        {
            let conn = self.conn.lock();
            let mut statement = conn
                .prepare("SELECT snapshot_id FROM snapshots WHERE tx_status = 'PENDING'")
                .map_err(|err| map_sqlite("prepare pending", err))?;
            let ids: Vec<String> = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|err| map_sqlite("query pending", err))?
                .filter_map(Result::ok)
                .collect();
            drop(statement);

            for id in ids {
                conn.execute(
                    "UPDATE snapshots SET tx_status = 'ABORTED' WHERE snapshot_id = ?1",
                    params![id],
                )
                .map_err(|err| map_sqlite("abort pending", err))?;
                report.pending_aborted.push(id);
            }
        }

        // 2. COMMITTED rows whose archive vanished are BROKEN, not silently
        //    un-rollbackable.
        let committed_with_archives = {
            let conn = self.conn.lock();
            let mut statement = conn
                .prepare(
                    "SELECT s.snapshot_id, l.zip_path
                     FROM snapshots s JOIN archive_ledger l ON l.snapshot_id = s.snapshot_id
                     WHERE s.tx_status = 'COMMITTED' AND l.deleted_at_utc IS NULL",
                )
                .map_err(|err| map_sqlite("prepare committed", err))?;
            let rows: Vec<(String, String)> = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(|err| map_sqlite("query committed", err))?
                .filter_map(Result::ok)
                .collect();
            rows
        };

        for (id, relative) in &committed_with_archives {
            let full = self.paths.data.join(relative);
            let missing = !full.is_file();
            // A present file that fails verification is just as unusable as a
            // missing one, and saying so now is better than failing at rollback.
            let corrupt = !missing && verify_archive(&full).is_err();
            if missing || corrupt {
                let conn = self.conn.lock();
                conn.execute(
                    "UPDATE snapshots SET tx_status = 'BROKEN' WHERE snapshot_id = ?1",
                    params![id],
                )
                .map_err(|err| map_sqlite("mark broken", err))?;
                report.missing_archives.push(id.clone());
            }
        }

        // 3. Temp files with no owner: the writer crashed before committing.
        let backups = self.paths.backups_dir();
        match std::fs::read_dir(&backups) {
            Ok(entries) => {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name.ends_with(".zip.tmp") && std::fs::remove_file(entry.path()).is_ok() {
                        report.temp_files_removed.push(name);
                    }
                }
            }
            // A missing directory is normal on a fresh install; anything else
            // means the pass could not inspect it, and that must be visible.
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => report
                .unreadable_directories
                .push(backups.display().to_string()),
        }

        // 4. Verified archives with no row are quarantined, not deleted: they
        //    may be the only copy left of something.
        let known: std::collections::HashSet<String> = {
            let conn = self.conn.lock();
            let mut statement = conn
                .prepare("SELECT zip_path FROM archive_ledger WHERE deleted_at_utc IS NULL")
                .map_err(|err| map_sqlite("prepare ledger", err))?;
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|err| map_sqlite("query ledger", err))?
                .filter_map(Result::ok)
                .collect()
        };

        match std::fs::read_dir(&backups) {
            Ok(entries) => {
                let quarantine = self.paths.quarantine_dir();
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if !name.ends_with(".zip") || known.contains(&format!("backups/{name}")) {
                        continue;
                    }
                    if let Err(_err) = std::fs::create_dir_all(&quarantine) {
                        report
                            .unreadable_directories
                            .push(quarantine.display().to_string());
                        break;
                    }
                    let target = quarantine.join(&name);
                    if std::fs::rename(entry.path(), &target).is_ok() {
                        report.orphan_archives.push(name);
                    }
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => {
                let already = report
                    .unreadable_directories
                    .iter()
                    .any(|seen| seen == &backups.display().to_string());
                if !already {
                    report
                        .unreadable_directories
                        .push(backups.display().to_string());
                }
            }
        }

        Ok(report)
    }
}

fn quick_check(conn: &Connection) -> ZenithResult<()> {
    let result: String = conn
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|err| map_sqlite("quick_check", err))?;
    if result.eq_ignore_ascii_case("ok") {
        Ok(())
    } else {
        Err(ZenithError::new(ErrorCode::IntegrityError)
            .with("reason", "quick_check failed")
            .detail(result))
    }
}

/// Clear an owned directory and recreate it empty.
///
/// A directory that cannot be removed is recorded, not ignored: the caller's
/// rows are already committed away by this point, so silence would leave
/// archives nobody has a ledger entry for (DEF-150).
fn reset_owned_dir(dir: &Path, failures: &mut Vec<String>) {
    if !dir.exists() {
        // Nothing was there to clear. Recreating is still worth doing so the
        // next launch finds the layout it expects.
        if let Err(err) = std::fs::create_dir_all(dir) {
            failures.push(format!("could not create {}: {err}", dir.display()));
        }
        return;
    }
    if !dir.is_dir() {
        // A file sitting where a directory belongs. `remove_dir_all` would fail
        // with a confusing errno, and treating it as "nothing to do" is how the
        // DEF-150 silence started.
        failures.push(format!(
            "could not clear {}: path exists and is not a directory",
            dir.display()
        ));
        return;
    }
    if let Err(err) = std::fs::remove_dir_all(dir) {
        failures.push(format!("could not clear {}: {err}", dir.display()));
        return;
    }
    if let Err(err) = std::fs::create_dir_all(dir) {
        failures.push(format!("could not recreate {}: {err}", dir.display()));
    }
}

/// Remove an owned directory without recreating it.
fn drop_owned_dir(dir: &Path, failures: &mut Vec<String>) {
    if !dir.exists() {
        return;
    }
    if let Err(err) = std::fs::remove_dir_all(dir) {
        failures.push(format!("could not remove {}: {err}", dir.display()));
    }
}

fn migrate(conn: &Connection) -> ZenithResult<()> {
    let current: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|err| map_sqlite("read user_version", err))?;

    if current == 0 {
        conn.execute_batch(SCHEMA_V1)
            .map_err(|err| map_sqlite("apply schema v1", err))?;
    } else if current > crate::SCHEMA_VERSION {
        return Err(ZenithError::new(ErrorCode::SchemaMigrationFailed)
            .with("current", current.to_string())
            .with("supported", crate::SCHEMA_VERSION.to_string())
            .detail("database was written by a newer Zenith build"));
    }

    if current < 1 {
        conn.execute(
            "INSERT OR REPLACE INTO schema_migrations (version, applied_at, description)
             VALUES (1, ?1, 'initial schema')",
            params![now_utc()],
        )
        .map_err(|err| map_sqlite("record migration", err))?;
        conn.pragma_update(None, "user_version", 1i64)
            .map_err(|err| map_sqlite("set user_version", err))?;
    }

    Ok(())
}

fn quarantine(db_path: &Path, paths: &Paths) -> ZenithResult<PathBuf> {
    let dir = paths.quarantine_dir();
    std::fs::create_dir_all(&dir).map_err(|err| ZenithError::io("create quarantine", &err))?;
    let stamp = compact_utc_stamp(time::OffsetDateTime::now_utc());
    let target = dir.join(format!("state-{stamp}.db"));

    let mut moved = false;
    for suffix in ["", "-wal", "-shm"] {
        let from = PathBuf::from(format!("{}{suffix}", db_path.display()));
        if from.exists() {
            let to = PathBuf::from(format!("{}{suffix}", target.display()));
            std::fs::rename(&from, &to)
                .map_err(|err| ZenithError::io("quarantine database", &err))?;
            moved = true;
        }
    }
    if !moved {
        // Nothing to move: create an empty quarantine marker so the report is
        // not misleading.
        std::fs::write(&target, b"no database file present")
            .map_err(|err| ZenithError::io("write quarantine marker", &err))?;
    }
    Ok(target)
}

fn map_stored_snapshot(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredSnapshot> {
    let status: String = row.get(4)?;
    Ok(StoredSnapshot {
        snapshot_id: row.get(0)?,
        action_id: row.get(1)?,
        created_at_utc: row.get(2)?,
        snapshot_type: row.get(3)?,
        tx_status: TxStatus::parse(&status).unwrap_or(TxStatus::Broken),
        payload_json: row.get(5)?,
        hmac_sha256: row.get(6)?,
        schema_version: row.get(7)?,
        est_bytes: row.get::<_, i64>(8)? as u64,
        is_restored: row.get::<_, i64>(9)? != 0,
        restored_at_utc: row.get(10)?,
        correlation_id: row.get(11)?,
    })
}

fn map_sqlite(context: &str, err: rusqlite::Error) -> ZenithError {
    use rusqlite::ErrorCode as SqliteCode;
    let busy = matches!(
        &err,
        rusqlite::Error::SqliteFailure(failure, _)
            if failure.code == SqliteCode::DatabaseBusy || failure.code == SqliteCode::DatabaseLocked
    );
    let code = if busy {
        ErrorCode::DatabaseBusy
    } else {
        ErrorCode::Internal
    };
    ZenithError::new(code)
        .with("context", context.to_string())
        .detail(err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::audit::new_correlation_id;

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::for_root(dir.path());
        let key = SnapshotKey::from_bytes([3u8; 32]);
        let (store, _report) = Store::open(&paths, key).expect("open store");
        (dir, store)
    }

    #[test]
    fn a_fresh_store_has_schema_version_one() {
        let (_dir, store) = store();
        let conn = store.conn.lock();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("version");
        assert_eq!(version, crate::SCHEMA_VERSION);
    }

    #[test]
    fn snapshot_lifecycle_pending_then_committed() {
        let (_dir, store) = store();
        let id = store
            .begin_snapshot(
                ActionId::ArchiveScreenshots,
                "filesystem_archive",
                r#"{"a":1}"#,
                &new_correlation_id(),
                1234,
            )
            .expect("begin");
        let stored = store.get_snapshot(&id).expect("read").expect("exists");
        assert_eq!(stored.tx_status, TxStatus::Pending);

        store.commit_snapshot(&id).expect("commit");
        let stored = store.get_snapshot(&id).expect("read").expect("exists");
        assert_eq!(stored.tx_status, TxStatus::Committed);
        store.verify_snapshot(&stored).expect("hmac valid");
    }

    #[test]
    fn a_tampered_payload_is_rejected_at_verify() {
        let (_dir, store) = store();
        let id = store
            .begin_snapshot(
                ActionId::ClearStuckProxyVpn,
                "registry_backup",
                r#"{"proxy":"auto"}"#,
                &new_correlation_id(),
                10,
            )
            .expect("begin");
        store.commit_snapshot(&id).expect("commit");

        {
            let conn = store.conn.lock();
            conn.execute(
                "UPDATE snapshots SET payload_json = ?2 WHERE snapshot_id = ?1",
                params![id, r#"{"proxy":"C:\\Windows\\System32"}"#],
            )
            .expect("tamper");
        }

        let stored = store.get_snapshot(&id).expect("read").expect("exists");
        let err = store.verify_snapshot(&stored).unwrap_err();
        assert!(err.is(ErrorCode::IntegrityError));
    }

    #[test]
    fn committing_an_unknown_snapshot_fails() {
        let (_dir, store) = store();
        let err = store.commit_snapshot("does-not-exist").unwrap_err();
        assert!(err.is(ErrorCode::SnapshotNotFound));
    }

    #[test]
    fn aborted_snapshots_never_appear_in_history() {
        let (_dir, store) = store();
        let id = store
            .begin_snapshot(
                ActionId::CleanTempCache,
                "filesystem_archive",
                "{}",
                &new_correlation_id(),
                1,
            )
            .expect("begin");
        store.abort_snapshot(&id).expect("abort");
        assert!(
            store
                .list_snapshots(10)
                .expect("list")
                .iter()
                .all(|row| row.snapshot_id != id)
        );
    }

    #[test]
    fn history_is_newest_first_and_marks_restored() {
        let (_dir, store) = store();
        let first = store
            .begin_snapshot(
                ActionId::ArchiveScreenshots,
                "filesystem_archive",
                "{}",
                &new_correlation_id(),
                5,
            )
            .expect("begin");
        store.commit_snapshot(&first).expect("commit");

        let second = store
            .begin_snapshot(
                ActionId::RestartBluetooth,
                "service_state_backup",
                "{}",
                &new_correlation_id(),
                5,
            )
            .expect("begin");
        store.commit_snapshot(&second).expect("commit");

        let rows = store.list_snapshots(10).expect("list");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].snapshot_id, second);

        assert!(store.mark_restored(&second).expect("restore"));
        // Idempotent: a second rollback is not a second success.
        assert!(!store.mark_restored(&second).expect("restore again"));
    }

    #[test]
    fn recovery_aborts_pending_rows() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::for_root(dir.path());
        let key = SnapshotKey::from_bytes([4u8; 32]);
        let id = {
            let (store, _) = Store::open(&paths, key).expect("open");
            // Simulate a crash: leave it PENDING and drop the store. The tail
            // expression is the id, so the block needs no `let` binding of its
            // own (clippy::let_and_return, found only on the pinned toolchain).
            store
                .begin_snapshot(
                    ActionId::CleanTempCache,
                    "filesystem_archive",
                    "{}",
                    &new_correlation_id(),
                    1,
                )
                .expect("begin")
        };

        let (store, report) =
            Store::open(&paths, SnapshotKey::from_bytes([4u8; 32])).expect("reopen");
        assert!(report.pending_aborted.contains(&id));
        let stored = store.get_snapshot(&id).expect("read").expect("exists");
        assert_eq!(stored.tx_status, TxStatus::Aborted);
    }

    #[test]
    fn recovery_marks_missing_archives_broken() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::for_root(dir.path());
        let key_bytes = [5u8; 32];
        let id = {
            let (store, _) = Store::open(&paths, SnapshotKey::from_bytes(key_bytes)).expect("open");
            let id = store
                .begin_snapshot(
                    ActionId::ArchiveScreenshots,
                    "filesystem_archive",
                    "{}",
                    &new_correlation_id(),
                    1,
                )
                .expect("begin");
            store
                .record_archive(&id, "backups/missing.zip", &"a".repeat(64), 1, 1)
                .expect("ledger");
            store.commit_snapshot(&id).expect("commit");
            id
        };

        let (store, report) =
            Store::open(&paths, SnapshotKey::from_bytes(key_bytes)).expect("reopen");
        assert!(report.missing_archives.contains(&id));
        let stored = store.get_snapshot(&id).expect("read").expect("exists");
        assert_eq!(stored.tx_status, TxStatus::Broken);
        assert!(store.verify_snapshot(&stored).is_err());
    }

    #[test]
    fn recovery_removes_temp_files_and_quarantines_orphans() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::for_root(dir.path());
        paths.ensure_layout();
        std::fs::write(paths.backups_dir().join("crash.zip.tmp"), b"partial").expect("write");

        let (_store, report) =
            Store::open(&paths, SnapshotKey::from_bytes([6u8; 32])).expect("open");
        assert!(
            report
                .temp_files_removed
                .iter()
                .any(|name| name == "crash.zip.tmp")
        );
        assert!(!paths.backups_dir().join("crash.zip.tmp").exists());
    }

    #[test]
    fn an_unreadable_backups_directory_crosses_the_open_boundary() {
        // DEF-152: `Store::open` copies the reconciliation field by field, and
        // the first cut of this fix built the report correctly and then dropped
        // the new field on assignment. The compiler cannot see that, so the
        // assertion is made at the `Store::open` boundary, not on `reconcile`.
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::for_root(dir.path());
        paths.ensure_layout();
        let backups = paths.backups_dir();
        std::fs::remove_dir_all(&backups).expect("remove backups dir");
        std::fs::write(&backups, b"a file where a directory belongs").expect("blocker");

        let (_store, report) =
            Store::open(&paths, SnapshotKey::from_bytes([11u8; 32])).expect("open");
        assert!(
            report
                .unreadable_directories
                .iter()
                .any(|path| path.ends_with("backups")),
            "an uninspectable directory must survive to the caller: {report:?}"
        );
        assert!(
            !report.is_empty(),
            "an unreadable directory is not a clean run"
        );
        assert!(
            report
                .summary()
                .iter()
                .any(|line| line.starts_with("recovery.directory_unreadable")),
            "the log line must name the problem"
        );
    }

    #[test]
    fn a_healthy_layout_reports_no_unreadable_directories() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::for_root(dir.path());
        let (_store, report) =
            Store::open(&paths, SnapshotKey::from_bytes([12u8; 32])).expect("open");
        assert!(report.unreadable_directories.is_empty());
        assert!(report.is_empty(), "a fresh store is a clean run");
    }

    #[test]
    fn audit_rows_are_written_and_listed() {
        let (_dir, store) = store();
        let entry = AuditEntry::started(
            ActionId::FlushDnsCache,
            AuditPhase::Execute,
            new_correlation_id(),
            false,
        )
        .with_counts(0, 0)
        .finish(AuditStatus::Success, "outcomes.dnsFlushed");
        store.insert_audit(&entry).expect("insert");
        let rows = store.list_audit(10).expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].message_key, "outcomes.dnsFlushed");
    }

    #[test]
    fn settings_round_trip_and_overwrite() {
        let (_dir, store) = store();
        assert!(store.get_setting("theme").expect("get").is_none());
        store.set_setting("theme", "\"true-black\"").expect("set");
        assert_eq!(
            store.get_setting("theme").expect("get").as_deref(),
            Some("\"true-black\"")
        );
        store.set_setting("theme", "\"off-white\"").expect("set");
        assert_eq!(
            store.get_setting("theme").expect("get").as_deref(),
            Some("\"off-white\"")
        );
    }

    #[test]
    fn purge_empties_the_store() {
        let (_dir, store) = store();
        let id = store
            .begin_snapshot(
                ActionId::ArchiveScreenshots,
                "filesystem_archive",
                "{}",
                &new_correlation_id(),
                1,
            )
            .expect("begin");
        store.commit_snapshot(&id).expect("commit");
        store
            .insert_audit(
                &AuditEntry::started(
                    ActionId::ArchiveScreenshots,
                    AuditPhase::Execute,
                    new_correlation_id(),
                    false,
                )
                .finish(AuditStatus::Success, "ok"),
            )
            .expect("audit");

        let (snapshots, audit, failures) = store.purge(false).expect("purge");
        assert_eq!(snapshots, 1);
        assert_eq!(audit, 1);
        assert!(
            failures.is_empty(),
            "clean temp dirs must clear: {failures:?}"
        );
        assert!(store.list_snapshots(10).expect("list").is_empty());
        assert_eq!(store.audit_row_count().expect("count"), 0);
    }

    #[test]
    fn a_purge_reports_a_directory_it_could_not_clear() {
        // DEF-150: rows are committed away before the files are touched, so a
        // directory that survives must be named. Simulated by pointing the
        // backups dir at a *file*, which `remove_dir_all` refuses.
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::for_root(dir.path());
        paths.ensure_layout();
        let (store, _report) =
            Store::open(&paths, SnapshotKey::from_bytes([9u8; 32])).expect("open");

        let backups = paths.backups_dir();
        std::fs::remove_dir_all(&backups).expect("remove backups dir");
        std::fs::write(&backups, b"not a directory").expect("write blocker");

        let (_snapshots, _audit, failures) = store.purge(false).expect("purge");
        assert!(
            failures.iter().any(|line| line.contains("could not clear")),
            "a surviving directory must be reported: {failures:?}"
        );
    }

    #[test]
    fn a_corrupt_database_is_quarantined_not_deleted() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::for_root(dir.path());
        paths.ensure_layout();
        std::fs::write(paths.database(), b"this is not a sqlite database at all").expect("write");

        let (store, report) =
            Store::open(&paths, SnapshotKey::from_bytes([7u8; 32])).expect("open");
        assert!(report.quarantined_database.is_some());
        // The quarantined bytes still exist.
        let quarantined = report.quarantined_database.expect("path");
        assert!(quarantined.is_file());
        // And the app works on a fresh schema.
        assert!(store.list_snapshots(1).expect("list").is_empty());
    }

    #[test]
    fn opening_a_newer_schema_refuses_to_run() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::for_root(dir.path());
        paths.ensure_layout();
        {
            let conn = Connection::open(paths.database()).expect("open");
            conn.pragma_update(None, "user_version", 99i64)
                .expect("set");
        }
        let result = Store::open(&paths, SnapshotKey::from_bytes([8u8; 32]));
        let err = match result {
            Ok(_) => panic!("a newer schema must not be opened"),
            Err(err) => err,
        };
        assert!(err.is(ErrorCode::SchemaMigrationFailed));
    }
}
