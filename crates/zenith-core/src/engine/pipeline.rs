//! The execution pipeline: the only place where a destructive action is
//! allowed to run.
//!
//! Everything here exists to make one ordering guarantee (03-01 Â§7.1):
//!
//! ```text
//! validate â†’ plan â†’ free space â†’ write archive â†’ verify â†’ COMMIT ROW â†’ mutate
//! ```
//!
//! The database row is the commit point. A crash before it leaves a `PENDING`
//! row and an orphan archive that startup recovery classifies; a crash after it
//! leaves a rollback that works. There is no ordering in which the mutation
//! happens without a committed snapshot covering it.
//!
//! The same module owns [`rollback`], because the restore path and the capture
//! path must agree on the archive layout. Splitting them across modules is how
//! the layout drifts.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use crate::adapters::actions::{ActionContext, ActionRequest};
use crate::adapters::{actions, system};
use crate::config::{self, Paths};
use crate::engine::audit::{AuditEntry, AuditPhase, AuditStatus};
use crate::engine::db::{Store, TxStatus};
use crate::engine::executor::{CancelToken, Confirmation, validate_execution};
use crate::engine::scope::{self, ScopeRoots};
use crate::engine::snapshot;
use crate::error::{ErrorCode, ZenithError, ZenithResult};
use crate::manifest::{self, ActionScope};
use crate::models::{
    ActionId, ExecutionOutcome, ExecutionPhase, ReversibilityTier, StepResult, VerifiedPidTarget,
};

/// Everything one run needs, injected so nothing is read ambiently.
pub struct RunContext<'a> {
    pub store: &'a Store,
    pub paths: Paths,
    pub roots: ScopeRoots,
    pub elevated: bool,
    pub cancel: Arc<CancelToken>,
}

impl<'a> RunContext<'a> {
    pub fn new(
        store: &'a Store,
        paths: Paths,
        roots: ScopeRoots,
        elevated: bool,
        cancel: Arc<CancelToken>,
    ) -> Self {
        Self {
            store,
            paths,
            roots,
            elevated,
            cancel,
        }
    }

    fn action_context(&self) -> ActionContext {
        ActionContext {
            paths: self.paths.clone(),
            cancel: Arc::clone(&self.cancel),
            scope_roots: self.roots.clone(),
            elevated: self.elevated,
        }
    }
}

/// Actions whose blast radius is the user's selection, not a directory.
const SELECTION_ACTIONS: &[ActionId] = &[ActionId::UnlockDevPorts, ActionId::CloseHungOffice];

/// Run one action end to end.
///
/// The returned [`ExecutionOutcome`] is a fact about what happened, including a
/// failed run: only validation errors (which happen before any mutation) are
/// returned as `Err`. A mutation that fails halfway is an outcome with
/// `success: false` and the failing step named, because the user has to know
/// what state their machine is in.
pub fn run(
    ctx: &RunContext<'_>,
    action: ActionId,
    confirmation: Option<Confirmation>,
    targets: Vec<VerifiedPidTarget>,
) -> ZenithResult<ExecutionOutcome> {
    let started = Instant::now();
    let def = manifest::action_by_id(action);

    // 1..2 â€” privilege and confirmation, cheapest and most security-relevant
    // first, before a single probe or file is touched.
    let tier = validate_execution(action, confirmation, ctx.elevated)?;

    if SELECTION_ACTIONS.contains(&action) && targets.is_empty() {
        return Err(ZenithError::invalid_argument(
            "targets",
            "this action requires an explicit selection",
        ));
    }
    if !SELECTION_ACTIONS.contains(&action) && !targets.is_empty() {
        // A forged target list must not widen another action's blast radius.
        return Err(ZenithError::invalid_argument(
            "targets",
            "this action does not accept a selection",
        ));
    }
    if def.read_only {
        return Err(ZenithError::invalid_argument(
            "actionId",
            "read-only actions have no execution path",
        ));
    }

    // 3 â€” plan, and validate every planned file against the rollback scope
    // before archiving it. A plan entry outside the allowlist is a scope
    // violation, not a warning.
    let actx = ctx.action_context();
    let plan = actions::plan(action, &actx)?;
    for entry in &plan.entries {
        let (_, relative) = split_entry_name(&entry.name)?;
        scope::resolve_path(def.scope, relative, &ctx.roots)?;
    }

    // 4 â€” free space, measured before writing rather than after failing.
    if plan.est_bytes > 0 {
        let disk = system::disk_for(&ctx.paths.data)?;
        if !config::has_space_for(disk.free_bytes, plan.est_bytes) {
            return Err(ZenithError::new(ErrorCode::InsufficientDisk)
                .with("neededMb", mb(plan.est_bytes))
                .with("freeMb", mb(disk.free_bytes)));
        }
    }

    // 5..7 â€” snapshot, commit, then mutate.
    let snapshot_id = capture_snapshot(ctx, action, &plan)?;

    let audit_started = AuditEntry::started(
        action,
        AuditPhase::Execute,
        crate::engine::audit::new_correlation_id(),
        ctx.elevated,
    )
    .with_snapshot(snapshot_id.clone().unwrap_or_default());

    let request = ActionRequest { action, targets };
    let execution = actions::execute(&request, &actx);

    let duration_ms = elapsed_ms(started);
    match execution {
        Ok(execution) => {
            let bytes_freed = execution.bytes_freed;
            let items_affected = execution.items_affected;
            let outcome = outcome_from(action, tier, execution, snapshot_id, duration_ms);
            let entry = audit_started
                .finish(
                    if outcome.success {
                        AuditStatus::Success
                    } else {
                        AuditStatus::Error
                    },
                    outcome.summary_key.clone(),
                )
                .with_counts(bytes_freed, items_affected);
            // An audit write can fail (a locked or full store) and that must not
            // rewrite what the user was told: the mutation already happened. It
            // must not vanish either, or the ledger silently loses a row. This
            // comment used to claim the failure was "surfaced through the log
            // sink"; there is no sink - `let _ =` dropped it, which is exactly
            // the silent-loss defect the project forbids. The failure is written
            // to stderr with its error code, so a support log carries it.
            if let Err(error) = ctx.store.insert_audit(&entry) {
                eprintln!("audit insert failed: {}", error.code.as_str());
            }
            Ok(outcome)
        }
        Err(err) => {
            let entry = audit_started
                .finish(AuditStatus::Error, err.code.message_key())
                .with_error(err.code);
            // Same rule as the success arm: the error still goes back to the
            // caller, but a failed audit write is reported rather than dropped.
            if let Err(audit_error) = ctx.store.insert_audit(&entry) {
                eprintln!("audit insert failed: {}", audit_error.code.as_str());
            }
            Err(err)
        }
    }
}

/// Capture + commit. Returns `None` when the action has nothing worth keeping,
/// and says so in the audit row rather than inventing a snapshot id.
fn capture_snapshot(
    ctx: &RunContext<'_>,
    action: ActionId,
    plan: &actions::SnapshotPlan,
) -> ZenithResult<Option<String>> {
    if plan.is_empty() {
        return Ok(None);
    }

    let correlation_id = crate::engine::audit::new_correlation_id();
    let snapshot_id = ctx.store.begin_snapshot(
        action,
        plan.snapshot_type,
        &plan.payload_json,
        &correlation_id,
        plan.est_bytes,
    )?;

    if !plan.entries.is_empty() {
        let archive_path = ctx.paths.backups_dir().join(format!("{snapshot_id}.zip"));
        let written = match snapshot::write_archive(&archive_path, &plan.entries) {
            Ok(written) => written,
            Err(err) => {
                // Nothing was mutated, so the row is abandoned rather than
                // committed. It stays as `ABORTED` for forensics.
                let _ = ctx.store.abort_snapshot(&snapshot_id);
                return Err(err);
            }
        };
        // Read every entry back before declaring the snapshot usable. A
        // truncated archive that hashes to itself would be a lie.
        if let Err(err) = snapshot::verify_archive(&written.path) {
            let _ = ctx.store.abort_snapshot(&snapshot_id);
            return Err(err);
        }
        ctx.store.record_archive(
            &snapshot_id,
            &written.path.display().to_string(),
            &written.sha256,
            written.file_count,
            written.total_bytes,
        )?;
    }

    // Commit point. After this line the action may mutate anything.
    ctx.store.commit_snapshot(&snapshot_id)?;
    Ok(Some(snapshot_id))
}

/// What a rollback did, shaped for the IPC contract (`03-04` Â§5.7).
#[derive(Debug, Clone)]
pub struct RollbackOutcome {
    pub snapshot_id: String,
    pub success: bool,
    pub restored_items: u64,
    pub skipped_items: u64,
    pub skipped_reasons: Vec<(String, String)>,
    pub duration_ms: u64,
    pub correlation_id: String,
}

/// Restore files from a committed snapshot.
///
/// Order: row â†’ HMAC â†’ already-restored â†’ privilege â†’ scope â†’ archive hash â†’
/// extract to staging â†’ move each entry through the allowlist. Every refusal
/// happens before the first write, so a rejected rollback leaves the disk
/// untouched.
pub fn rollback(
    store: &Store,
    roots: &ScopeRoots,
    snapshot_id: &str,
    elevated: bool,
) -> ZenithResult<RollbackOutcome> {
    let started = Instant::now();

    let stored = store.get_snapshot(snapshot_id)?.ok_or_else(|| {
        ZenithError::new(ErrorCode::SnapshotNotFound).with("snapshotId", snapshot_id)
    })?;

    if stored.tx_status != TxStatus::Committed && stored.tx_status != TxStatus::Broken {
        return Err(ZenithError::new(ErrorCode::SnapshotNotFound)
            .with("snapshotId", snapshot_id)
            .with("status", stored.tx_status.as_str()));
    }

    // HMAC over the row. A row edited by a standard user fails here.
    store.verify_snapshot(&stored)?;

    if stored.is_restored {
        return Err(ZenithError::new(ErrorCode::AlreadyRestored).with("snapshotId", snapshot_id));
    }

    let action = ActionId::parse(&stored.action_id).ok_or_else(|| {
        ZenithError::new(ErrorCode::IntegrityError)
            .with("reason", "snapshot names an unknown action")
            .detail(stored.action_id.clone())
    })?;
    let def = manifest::action_by_id(action);

    if def.requires_admin && !elevated {
        return Err(
            ZenithError::new(ErrorCode::ElevationRequired).with("actionId", action.as_str())
        );
    }
    if def.tier == ReversibilityTier::Irreversible {
        // The row should not exist for these; if it does, refuse rather than
        // pretend an irreversible action has a restore path.
        return Err(ZenithError::new(ErrorCode::IntegrityError)
            .with("reason", "irreversible action has no rollback"));
    }

    let mut restored = 0u64;
    let mut skipped: Vec<(String, String)> = Vec::new();

    if let Some((zip_path, zip_sha256)) = store.archive_for(snapshot_id)? {
        let persisted_roots = payload_roots(&stored.payload_json)?;
        let archive = PathBuf::from(&zip_path);
        if !archive.is_file() {
            return Err(ZenithError::new(ErrorCode::SnapshotFailed)
                .with("reason", "archive missing")
                .detail(zip_path));
        }

        let staging = store
            .paths()
            .quarantine_dir()
            .join(format!("restore-{snapshot_id}"));
        let _ = std::fs::remove_dir_all(&staging);
        let extracted = snapshot::extract_archive(&archive, &zip_sha256, &staging)?;

        for file in extracted {
            let Ok(relative) = file.strip_prefix(&staging) else {
                skipped.push((file.display().to_string(), "staging_prefix".into()));
                continue;
            };
            let name = relative.to_string_lossy().replace('\\', "/");
            let (index, inner) = match split_entry_name(&name) {
                Ok(parts) => parts,
                Err(_) => {
                    skipped.push((name, "malformed_entry".into()));
                    continue;
                }
            };
            let Some(root) = persisted_roots.get(index) else {
                skipped.push((name, "unknown_root".into()));
                continue;
            };
            // The persisted root is hostile input: it must still be inside the
            // scope allowlist today, not just when it was captured.
            if !root_is_allowed(def.scope, root, roots) {
                skipped.push((name, "scope_violation".into()));
                continue;
            }
            let target = match safe_join(root, inner) {
                Some(path) => path,
                None => {
                    skipped.push((name, "scope_violation".into()));
                    continue;
                }
            };
            if let Some(parent) = target.parent()
                && std::fs::create_dir_all(parent).is_err()
            {
                skipped.push((name, "mkdir_failed".into()));
                continue;
            }
            match std::fs::copy(&file, &target) {
                Ok(_) => restored += 1,
                Err(err) => {
                    skipped.push((name, error_tag(&err)));
                }
            }
        }
        let _ = std::fs::remove_dir_all(&staging);

        // Only a rollback with no skipped entry is marked restored. A partial
        // restore must remain rollback-able rather than reporting success.
        if skipped.is_empty() {
            store.mark_restored(snapshot_id)?;
        }
    } else {
        // Registry- or service-backed snapshot: payload carries the state.
        return Err(ZenithError::new(ErrorCode::NotImplemented)
            .with("feature", "rollback.payload_only")
            .detail("this snapshot has no archive; payload restore is action-specific"));
    }

    Ok(RollbackOutcome {
        snapshot_id: snapshot_id.to_string(),
        success: skipped.is_empty(),
        restored_items: restored,
        skipped_items: skipped.len() as u64,
        skipped_reasons: skipped,
        duration_ms: elapsed_ms(started),
        correlation_id: crate::engine::audit::new_correlation_id(),
    })
}

/// Archive entry names are `r<index>/<relative path>`. The index selects the
/// persisted root, which keeps multi-root actions (Office caches) unambiguous.
pub fn entry_name(root_index: usize, relative: &str) -> String {
    format!("r{root_index}/{relative}")
}

fn split_entry_name(name: &str) -> ZenithResult<(usize, &str)> {
    let Some((prefix, rest)) = name.split_once('/') else {
        return Err(ZenithError::new(ErrorCode::IntegrityError)
            .with("reason", "entry has no root prefix")
            .detail(name.to_string()));
    };
    let index = prefix
        .strip_prefix('r')
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or_else(|| {
            ZenithError::new(ErrorCode::IntegrityError)
                .with("reason", "entry root prefix is not r<index>")
                .detail(name.to_string())
        })?;
    if rest.is_empty() {
        return Err(ZenithError::new(ErrorCode::IntegrityError)
            .with("reason", "entry has an empty relative path")
            .detail(name.to_string()));
    }
    Ok((index, rest))
}

fn payload_roots(payload_json: &str) -> ZenithResult<Vec<PathBuf>> {
    if payload_json.trim().is_empty() {
        return Ok(Vec::new());
    }
    let value: serde_json::Value = serde_json::from_str(payload_json).map_err(|err| {
        ZenithError::new(ErrorCode::IntegrityError)
            .with("reason", "snapshot payload is not JSON")
            .detail(err.to_string())
    })?;
    let Some(items) = value.get("roots").and_then(|roots| roots.as_array()) else {
        return Ok(Vec::new());
    };
    let mut roots = Vec::with_capacity(items.len());
    for item in items {
        let Some(text) = item.as_str() else {
            return Err(
                ZenithError::new(ErrorCode::IntegrityError).with("reason", "root is not a string")
            );
        };
        roots.push(PathBuf::from(text));
    }
    Ok(roots)
}

/// `root.join(relative)`, refusing anything that escapes `root`.
fn safe_join(root: &Path, relative: &str) -> Option<PathBuf> {
    let relative = Path::new(relative);
    if relative.is_absolute() {
        return None;
    }
    let mut out = root.to_path_buf();
    for component in relative.components() {
        match component {
            std::path::Component::Normal(part) => out.push(part),
            _ => return None,
        }
    }
    Some(out)
}

fn root_is_allowed(scope_kind: ActionScope, candidate: &Path, roots: &ScopeRoots) -> bool {
    let Ok(candidate) = std::fs::canonicalize(candidate) else {
        return false;
    };
    scope::allowed_roots(scope_kind, roots)
        .into_iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .any(|root| candidate == root || candidate.starts_with(&root))
}

fn error_tag(err: &std::io::Error) -> String {
    use std::io::ErrorKind;
    match err.kind() {
        ErrorKind::PermissionDenied => "access_denied",
        ErrorKind::NotFound => "gone",
        ErrorKind::AlreadyExists => "exists",
        _ => "io_error",
    }
    .to_string()
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

fn mb(bytes: u64) -> String {
    format!("{:.1}", bytes as f64 / (1024.0 * 1024.0))
}

fn outcome_from(
    action: ActionId,
    tier: ReversibilityTier,
    execution: actions::ActionExecution,
    snapshot_id: Option<String>,
    duration_ms: u64,
) -> ExecutionOutcome {
    let def = manifest::action_by_id(action);
    let steps: Vec<StepResult> = execution.steps;
    let success = execution.success
        && steps
            .iter()
            .all(|step| step.status != crate::models::StepStatus::Error);
    ExecutionOutcome {
        action_id: action,
        phase: if success {
            ExecutionPhase::Success
        } else {
            ExecutionPhase::Error
        },
        success,
        duration_ms,
        summary_key: execution.summary_key,
        summary_params: execution.summary_params,
        before_key: execution.before_key,
        before_params: execution.before_params,
        after_key: execution.after_key,
        after_params: execution.after_params,
        snapshot_id,
        tier,
        requires_reboot: execution.requires_reboot,
        abortable: def.abortable,
        trigger_effect: execution.trigger_effect,
        correlation_id: crate::engine::audit::new_correlation_id(),
        steps,
    }
}

/// Convenience for the audit UI: run without touching the filesystem.
pub fn dry_run(action: ActionId, elevated: bool) -> ZenithResult<ReversibilityTier> {
    validate_execution(action, None, elevated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_names_round_trip() {
        let name = entry_name(3, "Teams/Cache/a.dat");
        let (index, rest) = split_entry_name(&name).expect("split");
        assert_eq!(index, 3);
        assert_eq!(rest, "Teams/Cache/a.dat");
    }

    #[test]
    fn entry_names_without_a_root_prefix_are_rejected() {
        assert!(split_entry_name("Teams/a.dat").is_err());
        assert!(split_entry_name("x1/a.dat").is_err());
        assert!(split_entry_name("r1/").is_err());
        assert!(split_entry_name("r-1/a.dat").is_err());
    }

    #[test]
    fn safe_join_refuses_traversal_and_absolute_paths() {
        let root = Path::new(r"C:\Users\Public");
        assert!(safe_join(root, r"..\Windows\System32\evil.dll").is_none());
        assert!(safe_join(root, r"C:\Windows\evil.dll").is_none());
        assert!(safe_join(root, "a/b/c.txt").is_some());
    }

    #[test]
    fn an_empty_payload_has_no_roots() {
        assert!(payload_roots("").expect("empty").is_empty());
        assert!(payload_roots("{}").expect("object").is_empty());
        let roots = payload_roots(r#"{"roots":["C:\\Temp"]}"#).expect("roots");
        assert_eq!(roots, vec![PathBuf::from(r"C:\Temp")]);
        assert!(payload_roots("not json").is_err());
    }
}
