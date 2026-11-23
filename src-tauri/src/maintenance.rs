//! Startup housekeeping that the published limits depend on.
//!
//! Every constant in `config` must have a caller, or it is dead configuration
//! (`04-02` §5). Two of them were not wired: the retention planner
//! (`SNAPSHOT_MAX_ROWS`, `SNAPSHOT_MAX_BYTES`, `AUDIT_MAX_ROWS`) and the
//! quarantine lifetime (`QUARANTINE_DAYS`). This module is that caller.
//!
//! The rules it preserves:
//!
//! * **Consent first.** Only `plan.automatic` (restored snapshots) is applied.
//!   `plan.needs_consent` is reported, never deleted; the UI asks the user.
//! * **Plan, then act.** The same `retention::plan` the tests exercise is the
//!   one used here, so a test failure and a production difference cannot diverge.
//! * **No surprise on failure.** Housekeeping is best-effort: a locked database
//!   or a permission denial must not stop the app from starting.

use std::time::{Duration, SystemTime};

use zenith_core::config::{AUDIT_MAX_ROWS, Paths, SNAPSHOT_MAX_BYTES, SNAPSHOT_MAX_ROWS};
use zenith_core::engine::db::Store;
use zenith_core::engine::retention::{
    self, OrphanDecision, PrunePlan, QUARANTINE_DAYS, RetentionCandidate,
};
use zenith_core::error::ZenithResult;

/// What one startup pass changed, for the log and the startup notice.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MaintenanceReport {
    /// Restored snapshots removed without asking.
    pub pruned_snapshots: u64,
    /// Audit rows removed past `AUDIT_MAX_ROWS`.
    pub pruned_audit_rows: i64,
    /// Unrestored snapshots that exceed the cap. Left for the user to approve.
    pub awaiting_consent: usize,
    /// Quarantined files deleted after `QUARANTINE_DAYS`.
    pub quarantine_expired: u64,
    /// Crash-leftover `.tmp` files deleted immediately.
    pub quarantine_temp_removed: u64,
    /// Which store read failed, if any, so the pass can say why it did less.
    ///
    /// Not a user-facing figure and not a startup notice: it exists so the
    /// failure reaches the log (DEF-126). Before this field, `unwrap_or(0)` and
    /// `else { return report }` made an unreadable store indistinguishable from
    /// an empty one, and a pass that silently pruned nothing looked exactly like
    /// a pass with nothing to do.
    pub retention_read_failed: Option<&'static str>,
}

impl MaintenanceReport {
    pub fn is_empty(&self) -> bool {
        self.pruned_snapshots == 0
            && self.pruned_audit_rows == 0
            && self.awaiting_consent == 0
            && self.quarantine_expired == 0
            && self.quarantine_temp_removed == 0
            // A failed read is not "nothing happened": it is a thing that must
            // be logged, so the pass is not empty (DEF-126).
            && self.retention_read_failed.is_none()
    }

    /// One line per change. Keys, not prose, so the renderer can localise.
    pub fn summary(&self) -> Vec<String> {
        let mut lines = Vec::new();
        if self.pruned_snapshots > 0 {
            lines.push(format!(
                "maintenance.pruned_snapshots {}",
                self.pruned_snapshots
            ));
        }
        if self.pruned_audit_rows > 0 {
            lines.push(format!(
                "maintenance.pruned_audit_rows {}",
                self.pruned_audit_rows
            ));
        }
        if self.awaiting_consent > 0 {
            lines.push(format!(
                "maintenance.awaiting_consent {}",
                self.awaiting_consent
            ));
        }
        if self.quarantine_expired > 0 {
            lines.push(format!(
                "maintenance.quarantine_expired {}",
                self.quarantine_expired
            ));
        }
        if self.quarantine_temp_removed > 0 {
            lines.push(format!(
                "maintenance.quarantine_temp_removed {}",
                self.quarantine_temp_removed
            ));
        }
        if let Some(reason) = self.retention_read_failed {
            lines.push(format!("maintenance.retention_unreadable {reason}"));
        }
        lines
    }
}

/// The three store operations `apply_retention` performs, behind a trait.
///
/// The defect being fixed (DEF-126) is only observable when a read fails, and a
/// `Store` that opens successfully will answer all three, so a test could never
/// reach the failure path without this seam. Private to the module: it exists for
/// the tests below, not as an extensibility point.
trait RetentionStore {
    fn candidates(&self) -> ZenithResult<Vec<RetentionCandidate>>;
    fn audit_rows(&self) -> ZenithResult<i64>;
    fn apply(&self, plan: &PrunePlan, confirmed: &[String]) -> ZenithResult<u64>;
}

impl RetentionStore for Store {
    fn candidates(&self) -> ZenithResult<Vec<RetentionCandidate>> {
        self.snapshots_for_retention()
    }

    fn audit_rows(&self) -> ZenithResult<i64> {
        self.audit_row_count()
    }

    fn apply(&self, plan: &PrunePlan, confirmed: &[String]) -> ZenithResult<u64> {
        self.apply_prune(plan, confirmed)
    }
}

/// Run the retention planner against the live store and apply only the
/// no-consent half of its plan.
pub fn apply_retention(store: &Store) -> MaintenanceReport {
    plan_and_apply(store)
}

/// The actual pass, over an injected store.
///
/// Every failure is recorded in `retention_read_failed` instead of being folded
/// into a zero. Skipping is the right *action* in all three cases - nothing is
/// ever deleted without a real count - but a pass that did less than it planned
/// must not look like a pass with nothing to do, or the log lies by omission.
fn plan_and_apply(source: &impl RetentionStore) -> MaintenanceReport {
    let mut report = MaintenanceReport::default();

    let (max_rows, max_bytes, _audit_cap) = published_caps();
    let candidates = match source.candidates() {
        Ok(candidates) => candidates,
        Err(_) => {
            // Nothing can be planned without the snapshot list.
            report.retention_read_failed = Some("snapshots");
            return report;
        }
    };
    let audit_rows = match source.audit_rows() {
        Ok(rows) => rows,
        Err(_) => {
            // Assume nothing rather than zero: audit pruning is skipped, which
            // is the safe action, and the reason is reported below.
            report.retention_read_failed = Some("audit_rows");
            0
        }
    };

    let plan = retention::plan(candidates, audit_rows, max_rows, max_bytes);
    report.awaiting_consent = plan.needs_consent.len();

    if !plan.automatic.is_empty() || plan.audit_rows_to_delete > 0 {
        // The second argument is the consented set. Passing an empty slice is
        // the whole point: nothing here has been consented to.
        match source.apply(&plan, &[]) {
            Ok(pruned) => {
                report.pruned_snapshots = pruned;
                report.pruned_audit_rows = plan.audit_rows_to_delete;
            }
            Err(_) => {
                // The plan is reported but nothing was removed; say so rather
                // than reporting zero pruned and no reason.
                report.retention_read_failed = Some("prune");
            }
        }
    }

    report
}

/// Delete quarantined files once they outlive `QUARANTINE_DAYS`, and any
/// crash-leftover `.tmp` immediately.
pub fn sweep_quarantine(paths: &Paths) -> MaintenanceReport {
    let mut report = MaintenanceReport::default();
    let dir = paths.quarantine_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return report;
    };

    let cutoff = Duration::from_secs(QUARANTINE_DAYS.max(0) as u64 * 24 * 60 * 60);
    let now = SystemTime::now();

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();

        match retention::classify_orphan(&name) {
            // A `.tmp` never held committed data: the writer crashed before the
            // rename, so it is deleted on sight rather than aged out.
            OrphanDecision::DeleteTemp => {
                if std::fs::remove_file(&path).is_ok() {
                    report.quarantine_temp_removed += 1;
                }
            }
            OrphanDecision::Quarantine => {
                let age = entry
                    .metadata()
                    .and_then(|meta| meta.modified())
                    .ok()
                    .and_then(|modified| now.duration_since(modified).ok());
                if age.is_some_and(|age| age >= cutoff) && std::fs::remove_file(&path).is_ok() {
                    report.quarantine_expired += 1;
                }
            }
        }
    }

    report
}

/// Both passes, merged. Called once at startup.
pub fn run(store: &Store, paths: &Paths) -> MaintenanceReport {
    let mut report = apply_retention(store);
    let quarantine = sweep_quarantine(paths);
    report.quarantine_expired = quarantine.quarantine_expired;
    report.quarantine_temp_removed = quarantine.quarantine_temp_removed;
    report
}

/// The caps this pass enforces, for the Trust screen and `04-02`.
pub const fn published_caps() -> (i64, u64, i64) {
    (SNAPSHOT_MAX_ROWS, SNAPSHOT_MAX_BYTES, AUDIT_MAX_ROWS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use zenith_core::engine::snapshot::SnapshotKey;

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::for_root(dir.path());
        paths.ensure_layout();
        let (store, _) = Store::open(&paths, SnapshotKey::from_bytes([7u8; 32])).expect("open");
        (dir, store)
    }

    #[test]
    fn published_caps_match_the_documented_values() {
        let (rows, bytes, audit) = published_caps();
        assert_eq!(rows, 200);
        assert_eq!(bytes, 2 * 1024 * 1024 * 1024);
        assert_eq!(audit, 5_000);
    }

    #[test]
    fn a_fresh_store_needs_no_maintenance() {
        let (_dir, store) = store();
        assert!(apply_retention(&store).is_empty());
    }

    #[test]
    fn a_tmp_file_in_quarantine_is_removed_immediately() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::for_root(dir.path());
        paths.ensure_layout();
        let stale = paths.quarantine_dir().join("crashed.zip.tmp");
        std::fs::write(&stale, b"partial").expect("seed");

        let report = sweep_quarantine(&paths);
        assert_eq!(report.quarantine_temp_removed, 1);
        assert!(!stale.exists());
    }

    #[test]
    fn a_recent_quarantined_zip_survives() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::for_root(dir.path());
        paths.ensure_layout();
        let kept = paths.quarantine_dir().join("orphan.zip");
        std::fs::write(&kept, b"payload").expect("seed");

        let report = sweep_quarantine(&paths);
        assert_eq!(report.quarantine_expired, 0);
        assert!(kept.exists(), "a fresh orphan must not be deleted");
    }

    #[test]
    fn an_empty_retention_plan_deletes_nothing() {
        let (_dir, store) = store();
        let report = apply_retention(&store);
        assert_eq!(report.pruned_snapshots, 0);
        assert_eq!(report.pruned_audit_rows, 0);
        assert_eq!(report.awaiting_consent, 0);
    }

    #[test]
    fn a_summary_names_each_change_by_key_not_prose() {
        let report = MaintenanceReport {
            pruned_snapshots: 2,
            pruned_audit_rows: 5,
            awaiting_consent: 1,
            quarantine_expired: 3,
            quarantine_temp_removed: 0,
            retention_read_failed: None,
        };
        let lines = report.summary();
        assert_eq!(lines.len(), 4, "{lines:?}");
        assert!(lines.iter().all(|line| line.starts_with("maintenance.")));
        assert!(lines.contains(&"maintenance.pruned_snapshots 2".to_string()));
    }
}

/// DEF-126: a failed store read must not look like a pass with nothing to do.
///
/// The old code had three silent paths - `else { return report }` for the
/// snapshot list, `unwrap_or(0)` for the audit count, and dropping the error
/// from `apply_prune` - and every one of them produced a `MaintenanceReport`
/// identical to a clean run, so a startup that pruned nothing for a bad reason
/// logged nothing at all.
#[cfg(test)]
mod retention_failure_tests {
    use super::*;
    use zenith_core::engine::retention::RetentionCandidate;
    use zenith_core::error::{ErrorCode, ZenithError};

    struct Fake {
        candidates: ZenithResult<Vec<RetentionCandidate>>,
        audit_rows: ZenithResult<i64>,
        apply: ZenithResult<u64>,
        applied: std::cell::Cell<usize>,
    }

    impl Fake {
        fn healthy(candidates: Vec<RetentionCandidate>, audit_rows: i64) -> Self {
            Self {
                candidates: Ok(candidates),
                audit_rows: Ok(audit_rows),
                apply: Ok(0),
                applied: std::cell::Cell::new(0),
            }
        }
    }

    fn boom<T>(what: &str) -> ZenithResult<T> {
        Err(ZenithError::new(ErrorCode::Internal).with("reason", what))
    }

    fn candidate(id: &str, restored: bool) -> RetentionCandidate {
        RetentionCandidate {
            snapshot_id: id.into(),
            created_at_utc: "2026-01-01T00:00:00Z".into(),
            est_bytes: 1_000,
            is_restored: restored,
        }
    }

    impl RetentionStore for Fake {
        fn candidates(&self) -> ZenithResult<Vec<RetentionCandidate>> {
            match &self.candidates {
                Ok(rows) => Ok(rows.clone()),
                Err(error) => Err(error.clone()),
            }
        }

        fn audit_rows(&self) -> ZenithResult<i64> {
            match &self.audit_rows {
                Ok(rows) => Ok(*rows),
                Err(error) => Err(error.clone()),
            }
        }

        fn apply(&self, _plan: &PrunePlan, _confirmed: &[String]) -> ZenithResult<u64> {
            self.applied.set(self.applied.get() + 1);
            match &self.apply {
                Ok(removed) => Ok(*removed),
                Err(error) => Err(error.clone()),
            }
        }
    }

    #[test]
    fn a_healthy_store_produces_an_empty_report() {
        let fake = Fake::healthy(Vec::new(), 10);
        assert!(plan_and_apply(&fake).is_empty());
    }

    #[test]
    fn a_failed_snapshot_read_is_reported_not_silent() {
        let fake = Fake {
            candidates: boom("db locked"),
            ..Fake::healthy(Vec::new(), 10)
        };
        let report = plan_and_apply(&fake);
        // The old code returned a default report here and the caller skipped
        // logging entirely (`if !report.is_empty()`).
        assert_eq!(report.retention_read_failed, Some("snapshots"));
        assert!(!report.is_empty(), "a failure must reach the log");
        assert!(
            report
                .summary()
                .contains(&"maintenance.retention_unreadable snapshots".to_string())
        );
    }

    #[test]
    fn a_failed_audit_read_is_reported_and_prunes_no_audit_rows() {
        let fake = Fake {
            audit_rows: boom("count failed"),
            // 400 restored snapshots exceed the 200-row cap, so pruning would
            // happen if the audit count came back as a plausible number.
            ..Fake::healthy(
                (0..400)
                    .map(|n| candidate(&format!("s{n}"), true))
                    .collect(),
                0,
            )
        };
        let report = plan_and_apply(&fake);
        assert_eq!(report.retention_read_failed, Some("audit_rows"));
        // Snapshots are still pruned - the failure is scoped to audit rows -
        // but a zero audit count must not be *claimed* as measured.
        assert_eq!(report.pruned_audit_rows, 0);
        assert_eq!(fake.applied.get(), 1, "the snapshot half still runs");
    }

    #[test]
    fn a_failed_prune_is_reported_not_zeroed() {
        let fake = Fake {
            apply: boom("disk full"),
            ..Fake::healthy(
                (0..400)
                    .map(|n| candidate(&format!("s{n}"), true))
                    .collect(),
                0,
            )
        };
        let report = plan_and_apply(&fake);
        assert_eq!(report.retention_read_failed, Some("prune"));
        // Reporting 0 pruned with no reason is what the old code did.
        assert_eq!(report.pruned_snapshots, 0);
        assert!(!report.is_empty(), "the caller must not skip the log line");
    }

    #[test]
    fn a_clean_pass_reports_no_failure_reason() {
        let fake = Fake {
            // The store reports what it actually removed; the report must carry
            // that number rather than the plan's length.
            apply: Ok(200),
            ..Fake::healthy(
                (0..400)
                    .map(|n| candidate(&format!("s{n}"), true))
                    .collect(),
                10,
            )
        };
        let report = plan_and_apply(&fake);
        assert_eq!(report.retention_read_failed, None);
        assert_eq!(report.pruned_snapshots, 200);
    }
}
