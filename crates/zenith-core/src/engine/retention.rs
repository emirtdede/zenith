//! Retention and garbage collection.
//!
//! The rule that makes this more than a `DELETE` statement: **an unrestored
//! snapshot is the user's only way back**, so it is never pruned silently
//! (ADR-021). Pruning is a plan first, an action second, and both are audited.
//!
//! Pure planning lives here; the database applies the plan.

// Limits are injected by the caller (`db::snapshots_for_retention` reads them
// from `config`), so this module stays pure and testable with arbitrary caps.

/// A snapshot candidate for pruning.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetentionCandidate {
    pub snapshot_id: String,
    pub created_at_utc: String,
    pub est_bytes: u64,
    pub is_restored: bool,
}

/// What a prune pass would remove, and why.
#[derive(Debug, Clone, Default)]
pub struct PrunePlan {
    /// Restored snapshots safe to delete without asking.
    pub automatic: Vec<String>,
    /// Unrestored snapshots that would exceed the cap. Only removed with
    /// explicit consent.
    pub needs_consent: Vec<String>,
    pub bytes_reclaimed: u64,
    pub audit_rows_to_delete: i64,
}

impl PrunePlan {
    pub fn is_empty(&self) -> bool {
        self.automatic.is_empty() && self.needs_consent.is_empty() && self.audit_rows_to_delete == 0
    }

    pub fn requires_consent(&self) -> bool {
        !self.needs_consent.is_empty()
    }
}

/// Plan a prune pass.
///
/// Order of deletion is oldest-first, restored-before-unrestored, so the newest
/// undo points survive longest.
pub fn plan(
    mut snapshots: Vec<RetentionCandidate>,
    audit_rows: i64,
    max_rows: i64,
    max_bytes: u64,
) -> PrunePlan {
    // Newest first, so we can walk the tail.
    snapshots.sort_by(|a, b| b.created_at_utc.cmp(&a.created_at_utc));

    let mut plan = PrunePlan::default();

    // Audit rows: bounded, and never today's rows. We keep the newest N.
    if audit_rows > max_rows {
        plan.audit_rows_to_delete = audit_rows - max_rows;
    }

    // Restored snapshots are expendable; collect them oldest-first.
    let mut expendable: Vec<&RetentionCandidate> =
        snapshots.iter().filter(|c| c.is_restored).collect();
    expendable.sort_by(|a, b| a.created_at_utc.cmp(&b.created_at_utc));

    let mut unrestored: Vec<&RetentionCandidate> =
        snapshots.iter().filter(|c| !c.is_restored).collect();
    unrestored.sort_by(|a, b| a.created_at_utc.cmp(&b.created_at_utc));

    let mut total_bytes: u64 = snapshots.iter().map(|c| c.est_bytes).sum();
    let mut total_rows = snapshots.len() as i64;

    // First pass: drop restored snapshots until both caps are satisfied.
    for candidate in expendable {
        if total_rows <= max_rows && total_bytes <= max_bytes {
            break;
        }
        plan.automatic.push(candidate.snapshot_id.clone());
        plan.bytes_reclaimed += candidate.est_bytes;
        total_rows -= 1;
        total_bytes = total_bytes.saturating_sub(candidate.est_bytes);
    }

    // Second pass: unrestored snapshots are only *proposed*.
    for candidate in unrestored {
        if total_rows <= max_rows && total_bytes <= max_bytes {
            break;
        }
        plan.needs_consent.push(candidate.snapshot_id.clone());
        plan.bytes_reclaimed += candidate.est_bytes;
        total_rows -= 1;
        total_bytes = total_bytes.saturating_sub(candidate.est_bytes);
    }

    plan
}

/// Classify an orphaned archive file found on disk with no ledger row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrphanDecision {
    /// A `.tmp` file: the writer crashed before committing. Delete immediately.
    DeleteTemp,
    /// A `.zip` with no row: move to quarantine, delete after 7 days.
    Quarantine,
}

pub fn classify_orphan(file_name: &str) -> OrphanDecision {
    if file_name.ends_with(".zip.tmp") || file_name.ends_with(".tmp") {
        OrphanDecision::DeleteTemp
    } else {
        OrphanDecision::Quarantine
    }
}

/// Days a quarantined file is kept before deletion.
pub const QUARANTINE_DAYS: i64 = 7;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AUDIT_MAX_ROWS, SNAPSHOT_MAX_BYTES, SNAPSHOT_MAX_ROWS};

    fn snap(id: &str, day: &str, bytes: u64, restored: bool) -> RetentionCandidate {
        RetentionCandidate {
            snapshot_id: id.into(),
            created_at_utc: format!("2026-11-{day}T10:00:00.000Z"),
            est_bytes: bytes,
            is_restored: restored,
        }
    }

    #[test]
    fn under_the_cap_nothing_is_pruned() {
        let plan = plan(vec![snap("a", "01", 100, false)], 10, 200, 1024);
        assert!(plan.is_empty());
        assert!(!plan.requires_consent());
    }

    #[test]
    fn row_cap_prunes_restored_first() {
        let snapshots = vec![
            snap("old-restored", "01", 10, true),
            snap("mid-restored", "02", 10, true),
            snap("new-live", "03", 10, false),
        ];
        let plan = plan(snapshots, 0, 1, 1024 * 1024);
        assert_eq!(plan.automatic, vec!["old-restored", "mid-restored"]);
        assert!(plan.needs_consent.is_empty());
    }

    #[test]
    fn unrestored_snapshots_require_consent() {
        let snapshots = vec![snap("a", "01", 10, false), snap("b", "02", 10, false)];
        let plan = plan(snapshots, 0, 1, 1024);
        assert!(plan.automatic.is_empty());
        assert_eq!(plan.needs_consent, vec!["a"]);
        assert!(plan.requires_consent());
    }

    #[test]
    fn byte_cap_is_honoured_independently_of_rows() {
        let big = 600 * 1024 * 1024;
        let snapshots = vec![
            snap("a", "01", big, true),
            snap("b", "02", big, true),
            snap("c", "03", big, true),
            snap("d", "04", big, true),
        ];
        // 2.4 GB total against a 2 GB cap → at least one must go.
        let plan = plan(snapshots, 0, 100, SNAPSHOT_MAX_BYTES);
        assert_eq!(plan.automatic.len(), 1);
        assert_eq!(plan.automatic[0], "a");
        assert_eq!(plan.bytes_reclaimed, big);
    }

    #[test]
    fn audit_rows_over_the_cap_are_counted() {
        let plan = plan(vec![], AUDIT_MAX_ROWS + 17, AUDIT_MAX_ROWS, u64::MAX);
        assert_eq!(plan.audit_rows_to_delete, 17);
        assert!(!plan.is_empty());
    }

    #[test]
    fn default_caps_are_the_documented_ones() {
        assert_eq!(SNAPSHOT_MAX_ROWS, 200);
        assert_eq!(AUDIT_MAX_ROWS, 5_000);
        assert_eq!(SNAPSHOT_MAX_BYTES, 2 * 1024 * 1024 * 1024);
    }

    #[test]
    fn tmp_files_are_deleted_and_zips_are_quarantined() {
        assert_eq!(classify_orphan("x.zip.tmp"), OrphanDecision::DeleteTemp);
        assert_eq!(classify_orphan("x.zip"), OrphanDecision::Quarantine);
        assert_eq!(classify_orphan("x.part"), OrphanDecision::Quarantine);
    }

    #[test]
    fn pruning_is_stable_regardless_of_input_order() {
        let mut a = vec![snap("1", "01", 10, true), snap("2", "02", 10, true)];
        let mut b = a.clone();
        a.reverse();
        b.sort_by(|x, y| x.snapshot_id.cmp(&y.snapshot_id));
        assert_eq!(plan(a, 0, 1, 1024).automatic, plan(b, 0, 1, 1024).automatic);
    }
}
