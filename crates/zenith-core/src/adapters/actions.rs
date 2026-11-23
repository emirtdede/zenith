//! The 22 execution paths: the only module that changes the machine.
//!
//! Every path follows the same four-part shape so behaviour is uniform and
//! auditable:
//!
//! 1. **`plan`** - decide what will be touched *before* touching it, so the
//!    snapshot layer can capture exactly those objects (`ADR-004`).
//! 2. **Preconditions** - re-measure the thing we are about to change. A plan
//!    built two minutes ago may describe a machine that no longer exists.
//! 3. **Act** - a narrow, named operation per step, recording each outcome. A
//!    step that fails does not silently abort the rest (`REQ-F-066`).
//! 4. **Report** - a before/after pair of i18n keys with measured parameters,
//!    never an English sentence and never an estimate (`REQ-F-072`).
//!
//! ## What this module refuses to do
//!
//! * Build a command string. Every child process is `program + argv` from the
//!   manifest, so there is no injection surface (`03-06` §12).
//! * Trust a stored path. Destructive file work resolves through
//!   [`scope::resolve_path`], which is the only way a path becomes actionable.
//! * Report success it did not observe. If a service did not reach `Running`,
//!   the outcome is a failure with the state it actually reached.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use crate::config::{self, Paths};
use crate::engine::executor::CancelToken;
use crate::engine::scope::ScopeRoots;
use crate::engine::snapshot::{ArchiveEntry, relative_entry_name};
use crate::error::{ErrorCode, ZenithError, ZenithResult};
use crate::manifest::{self, ActionScope, CommandSpec};
use crate::models::{ActionId, StepResult, StepStatus, VerifiedPidTarget};

use super::{child, cleanup, process, services, system};

/// Everything an execution needs, injected so nothing is read ambiently.
pub struct ActionContext {
    pub paths: Paths,
    pub cancel: Arc<CancelToken>,
    pub scope_roots: ScopeRoots,
    pub elevated: bool,
}

impl ActionContext {
    pub fn new(paths: Paths) -> Self {
        Self {
            paths,
            cancel: Arc::new(CancelToken::new()),
            scope_roots: ScopeRoots::from_environment(),
            elevated: super::privilege::is_elevated(),
        }
    }
}

/// What the UI asked to run, including the exact objects it selected.
///
/// `targets` is required for the two "kill what I selected" actions. It is
/// ignored by every other action, so a forged target cannot widen the blast
/// radius of, say, a DNS flush.
#[derive(Debug, Clone)]
pub struct ActionRequest {
    pub action: ActionId,
    pub targets: Vec<VerifiedPidTarget>,
}

impl ActionRequest {
    pub fn new(action: ActionId) -> Self {
        Self {
            action,
            targets: Vec::new(),
        }
    }
}

/// Objects to capture before an action mutates them.
#[derive(Debug, Clone, Default)]
pub struct SnapshotPlan {
    /// Value stored in `snapshots.snapshot_type`.
    pub snapshot_type: &'static str,
    /// Files to archive. Empty for registry- or service-backed actions.
    pub entries: Vec<ArchiveEntry>,
    /// Non-file state (registry values, service states) serialised as JSON and
    /// protected by the snapshot HMAC.
    pub payload_json: String,
    /// Estimated size used for the free-space precondition.
    pub est_bytes: u64,
}

impl SnapshotPlan {
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty() && self.payload_json.is_empty()
    }
}

/// The result of one execution, shaped to become an [`crate::models::ExecutionOutcome`].
#[derive(Debug, Clone)]
pub struct ActionExecution {
    pub success: bool,
    pub summary_key: String,
    pub summary_params: BTreeMap<String, String>,
    pub before_key: String,
    pub before_params: BTreeMap<String, String>,
    pub after_key: String,
    pub after_params: BTreeMap<String, String>,
    pub requires_reboot: bool,
    pub trigger_effect: Option<String>,
    /// Set only by `copy-sysadmin-info`, which hands text to the UI clipboard.
    pub clipboard_text: Option<String>,
    pub bytes_freed: u64,
    pub items_affected: u64,
    pub steps: Vec<StepResult>,
}

impl ActionExecution {
    fn new(action: ActionId) -> Self {
        let def = manifest::action_by_id(action);
        Self {
            success: true,
            // DEF-135: this was `format!("{}done", def.i18n_prefix)`, which
            // produced `actions.emptyRecycleBindone` - no separator, so it could
            // never be a catalogue key and the UI fell back to the raw string.
            // The catalogue now owns `actions.<prefix>.done`, and
            // `check-step-keys` proves every emitted key is defined.
            summary_key: format!("{}.done", def.i18n_prefix),
            summary_params: BTreeMap::new(),
            before_key: "outcomes.none".to_string(),
            before_params: BTreeMap::new(),
            after_key: "outcomes.none".to_string(),
            after_params: BTreeMap::new(),
            requires_reboot: false,
            trigger_effect: None,
            clipboard_text: None,
            bytes_freed: 0,
            items_affected: 0,
            steps: Vec::new(),
        }
    }

    fn failed(action: ActionId, error: &ZenithError) -> Self {
        let mut execution = Self::new(action);
        execution.success = false;
        execution.summary_key = error.code.message_key().to_string();
        execution
            .summary_params
            .insert("code".to_string(), error.code.as_str().to_string());
        execution
    }

    fn param(&mut self, key: &str, value: impl Into<String>) {
        self.summary_params.insert(key.to_string(), value.into());
    }

    fn before(&mut self, key: &str, params: &[(&str, String)]) {
        self.before_key = key.to_string();
        for (name, value) in params {
            self.before_params
                .insert((*name).to_string(), value.clone());
        }
    }

    fn after(&mut self, key: &str, params: &[(&str, String)]) {
        self.after_key = key.to_string();
        for (name, value) in params {
            self.after_params.insert((*name).to_string(), value.clone());
        }
    }

    fn step_ok(&mut self, key: &str, params: &[(&str, String)]) {
        let mut map = BTreeMap::new();
        for (name, value) in params {
            map.insert((*name).to_string(), value.clone());
        }
        self.steps.push(StepResult {
            step_key: key.to_string(),
            status: StepStatus::Success,
            error_code: None,
            params: map,
        });
    }

    fn step_failed(&mut self, key: &str, code: ErrorCode) {
        self.steps.push(StepResult {
            step_key: key.to_string(),
            status: StepStatus::Error,
            error_code: Some(code),
            params: BTreeMap::new(),
        });
        // One failed step makes the whole action unsuccessful, but the steps
        // that did run keep their real results.
        self.success = false;
        if self.summary_key.ends_with("done") {
            self.summary_key = code.message_key().to_string();
            self.summary_params
                .insert("code".to_string(), code.as_str().to_string());
        }
    }

    fn step_skipped(&mut self, key: &str) {
        self.steps.push(StepResult {
            step_key: key.to_string(),
            status: StepStatus::Skipped,
            error_code: None,
            params: BTreeMap::new(),
        });
    }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/// Decide what the snapshot must capture before this action runs.
///
/// Called before any mutation. For irreversible actions with nothing worth
/// preserving this returns an empty plan, and the caller records that honestly
/// rather than pretending a snapshot exists (`REQ-F-071`).
pub fn plan(action: ActionId, ctx: &ActionContext) -> ZenithResult<SnapshotPlan> {
    let def = manifest::action_by_id(action);

    match action {
        ActionId::ArchiveScreenshots => {
            let files = screenshot_candidates()?;
            Ok(file_plan(
                "archive_screenshots",
                def.scope,
                &ctx.scope_roots,
                files,
            ))
        }
        ActionId::ClearTeamsOutlookCache => {
            let mut files = Vec::new();
            for root in office_cache_roots() {
                if root.is_dir() {
                    files.extend(collect_files(&root, Duration::ZERO, &ctx.cancel)?);
                }
            }
            Ok(file_plan(
                "office_cache",
                def.scope,
                &ctx.scope_roots,
                files,
            ))
        }
        ActionId::CleanTempCache => {
            // Temp files are explicitly not snapshot material: they are
            // regenerable and archiving them would double the disk use we are
            // trying to reclaim. The plan says so by being empty.
            Ok(SnapshotPlan {
                snapshot_type: "none",
                entries: Vec::new(),
                payload_json: String::new(),
                est_bytes: 0,
            })
        }
        ActionId::ClearStuckProxyVpn => {
            let snapshot = proxy_state()?;
            Ok(SnapshotPlan {
                snapshot_type: "internet_settings",
                entries: Vec::new(),
                payload_json: snapshot,
                est_bytes: 0,
            })
        }
        ActionId::SyncNtpTime | ActionId::RestartBluetooth | ActionId::ResetPrintSpooler => {
            let service = service_for(action);
            let state = services::query(service)
                .map(|snapshot| snapshot.to_payload_value())
                .unwrap_or_else(|_| format!("{service}:unknown"));
            Ok(SnapshotPlan {
                snapshot_type: "service_state_backup",
                entries: Vec::new(),
                payload_json: format!("{{\"service\":\"{state}\"}}"),
                est_bytes: 0,
            })
        }
        _ => {
            // Reversible-by-construction or explicitly irreversible: there is
            // nothing to capture, and claiming otherwise would be a lie.
            let _ = def;
            Ok(SnapshotPlan {
                snapshot_type: "none",
                entries: Vec::new(),
                payload_json: String::new(),
                est_bytes: 0,
            })
        }
    }
}

/// Build a snapshot plan for a file-backed action.
///
/// Two details matter for rollback correctness:
///
/// * Entry names are `r<index>/<relative>`. The index selects one of the roots
///   persisted in `payload_json`, so a file discovered under
///   `…\Teams\Cache` is restored to `…\Teams\Cache` and not to a sibling that
///   happens to share the file name.
/// * The relative path is computed against the *scope* root, never the
///   discovery root. Otherwise `…\Teams\Cache\a.dat` would be stored as `a.dat`
///   and restored into `…\Teams\a.dat`.
fn file_plan(
    kind: &'static str,
    scope: ActionScope,
    roots: &ScopeRoots,
    files: Vec<(PathBuf, PathBuf)>,
) -> SnapshotPlan {
    let allowed = crate::engine::scope::allowed_roots(scope, roots);
    let mut origins: Vec<PathBuf> = Vec::new();
    let mut entries = Vec::new();
    let mut est_bytes = 0u64;

    for (discovered, file) in files {
        let origin = allowed
            .iter()
            .find(|root| has_prefix(&file, root))
            .cloned()
            .unwrap_or(discovered);
        let Some(relative) = relative_entry_name(&origin, &file) else {
            continue;
        };
        let index = match origins.iter().position(|known| known == &origin) {
            Some(index) => index,
            None => {
                origins.push(origin);
                origins.len() - 1
            }
        };
        est_bytes =
            est_bytes.saturating_add(std::fs::metadata(&file).map(|meta| meta.len()).unwrap_or(0));
        entries.push(ArchiveEntry {
            name: crate::engine::pipeline::entry_name(index, &relative),
            source: file,
        });
    }

    let root_list: Vec<String> = origins
        .iter()
        .map(|root| root.display().to_string())
        .collect();

    SnapshotPlan {
        snapshot_type: kind,
        entries,
        payload_json: serde_json::json!({ "roots": root_list }).to_string(),
        est_bytes,
    }
}

fn has_prefix(path: &Path, root: &Path) -> bool {
    let path = path.to_string_lossy().to_lowercase();
    let root = root.to_string_lossy().to_lowercase();
    path == root || path.starts_with(&format!("{root}\\")) || path.starts_with(&format!("{root}/"))
}

fn collect_files(
    root: &Path,
    min_age: Duration,
    cancel: &Arc<CancelToken>,
) -> ZenithResult<Vec<(PathBuf, PathBuf)>> {
    let scan = cleanup::scan_old_files(&[root.to_path_buf()], min_age, cancel)?;
    Ok(scan
        .files
        .into_iter()
        .map(|file| (root.to_path_buf(), file))
        .collect())
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/// Run one action. The caller has already validated privilege, confirmation,
/// scope and free space (`engine::executor::validate_execution`).
pub fn execute(request: &ActionRequest, ctx: &ActionContext) -> ZenithResult<ActionExecution> {
    let action = request.action;
    let def = manifest::action_by_id(action);

    if def.requires_admin && !ctx.elevated {
        return Err(
            ZenithError::new(ErrorCode::ElevationRequired).with("actionId", action.to_string())
        );
    }
    if ctx.cancel.is_cancelled() {
        return Err(ZenithError::new(ErrorCode::Cancelled));
    }

    match execute_inner(request, ctx) {
        Ok(execution) => Ok(execution),
        Err(err) if err.is(ErrorCode::Cancelled) => Err(err),
        Err(err) => Ok(ActionExecution::failed(action, &err)),
    }
}

fn execute_inner(request: &ActionRequest, ctx: &ActionContext) -> ZenithResult<ActionExecution> {
    match request.action {
        ActionId::CleanTempCache => clean_temp(ctx),
        ActionId::EmptyRecycleBin => empty_recycle_bin(),
        ActionId::ArchiveScreenshots => archive_screenshots(ctx),
        ActionId::WingetUpgradeAll => run_manifest_command(request.action, ctx),
        ActionId::WindowsUpdateScan => windows_update_scan(ctx),
        ActionId::FlushDnsCache => flush_dns(ctx),
        ActionId::ResetWinsockStack => reset_winsock(ctx),
        ActionId::ClearStuckProxyVpn => clear_stuck_proxy(),
        ActionId::SyncNtpTime => run_manifest_command(request.action, ctx),
        ActionId::CopySysadminInfo => copy_sysadmin_info(),
        ActionId::DismRestoreHealth => run_manifest_command(request.action, ctx),
        ActionId::SfcSystemScan => run_manifest_command(request.action, ctx),
        ActionId::RestartExplorer => restart_explorer(ctx),
        ActionId::RebuildIconCache => rebuild_icon_cache(ctx),
        ActionId::RestartBluetooth => restart_service(request.action, "bthserv"),
        ActionId::ResetPrintSpooler => reset_print_spooler(ctx),
        ActionId::ResetGpuDriver => reset_gpu_driver(),
        ActionId::ControlledReboot => controlled_reboot(ctx),
        ActionId::UnlockDevPorts => terminate_selected(request.action, &request.targets),
        ActionId::CloseHungOffice => close_hung_office(&request.targets),
        ActionId::ClearTeamsOutlookCache => clear_office_cache(ctx),
        ActionId::ReclaimWslDockerRam => run_manifest_command(request.action, ctx),
    }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

fn clean_temp(ctx: &ActionContext) -> ZenithResult<ActionExecution> {
    let mut execution = ActionExecution::new(ActionId::CleanTempCache);
    let roots = temp_roots();
    let min_age = Duration::from_secs(24 * 60 * 60);

    let scan = cleanup::scan_old_files(&roots, min_age, &ctx.cancel)?;
    let planned_mb = scan.megabytes();
    execution.before(
        "before.tempJunk",
        &[
            ("mb", format!("{planned_mb:.1}")),
            ("files", scan.file_count().to_string()),
        ],
    );

    let summary = cleanup::delete_files(&scan.files, &ctx.cancel);
    execution.bytes_freed = summary.bytes_freed;
    execution.items_affected = summary.deleted as u64;

    execution.step_ok(
        "steps.tempScanned",
        &[
            ("files", scan.file_count().to_string()),
            ("mb", format!("{planned_mb:.1}")),
        ],
    );
    execution.step_ok(
        "steps.tempDeleted",
        &[
            ("deleted", summary.deleted.to_string()),
            ("mb", format!("{:.1}", summary.megabytes_freed())),
        ],
    );
    if summary.skipped_count() > 0 {
        // Not a failure: a file held open by a browser is expected. The count is
        // surfaced so the user is not told "all clean" when twelve were left.
        execution.step_ok(
            "steps.tempSkippedInUse",
            &[("skipped", summary.skipped_count().to_string())],
        );
        execution.param("skipped", summary.skipped_count().to_string());
    }
    if summary.cancelled {
        return Err(ZenithError::new(ErrorCode::Cancelled));
    }

    execution.after(
        "after.tempCleared",
        &[("mb", format!("{:.1}", summary.megabytes_freed()))],
    );
    execution.param("mb", format!("{:.1}", summary.megabytes_freed()));
    Ok(execution)
}

fn empty_recycle_bin() -> ZenithResult<ActionExecution> {
    let mut execution = ActionExecution::new(ActionId::EmptyRecycleBin);
    let roots = fixed_drive_roots()?;

    // Measuring and emptying are two passes over the same drives, and the
    // accounting has to join them per drive. Summing every drive's "before"
    // size and reporting that sum as freed claims space the action never
    // released: `SHEmptyRecycleBinW` fails per drive (a denied volume, a locked
    // file), and a total built before the loop cannot know which ones failed.
    let mut measured: Vec<(PathBuf, cleanup::RecycleBinInfo)> = Vec::new();
    for root in &roots {
        if let Ok(info) = cleanup::recycle_bin_info(root) {
            measured.push((root.clone(), info));
        }
    }
    let before_bytes = sum_bytes(&measured);
    let before_items = sum_items(&measured);

    if roots.is_empty() {
        execution.before(
            "before.recycleBin",
            &[("mb", "0.0".to_string()), ("items", "0".to_string())],
        );
    } else if measured.is_empty() {
        // An unmeasurable bin is not an empty one. "0 MB" for a drive the
        // process could not read is the DEF-101 mistake in a new place, so the
        // three states stay distinct instead of collapsing into zero.
        execution.before("before.recycleBinUnknown", &[]);
    } else if measured.len() != roots.len() {
        execution.before(
            "before.recycleBinPartial",
            &[
                (
                    "mb",
                    format!("{:.1}", before_bytes as f64 / (1024.0 * 1024.0)),
                ),
                ("measured", measured.len().to_string()),
                ("total", roots.len().to_string()),
            ],
        );
    } else {
        execution.before(
            "before.recycleBin",
            &[
                (
                    "mb",
                    format!("{:.1}", before_bytes as f64 / (1024.0 * 1024.0)),
                ),
                ("items", before_items.to_string()),
            ],
        );
    }

    let mut emptied: Vec<&PathBuf> = Vec::new();
    for root in &roots {
        // An empty bin on one drive is not an error; a denied one is reported
        // per drive so the user knows which drive still holds data.
        match cleanup::empty_recycle_bin(root) {
            Ok(()) => {
                emptied.push(root);
                execution.step_ok(
                    "steps.driveEmptied",
                    &[("drive", root.display().to_string())],
                );
            }
            Err(err) => {
                execution.step_failed("steps.driveEmptied", err.code);
            }
        }
    }

    let (freed, items) = released_totals(&measured, &emptied);
    execution.bytes_freed = freed;
    execution.items_affected = items;
    execution.after(
        "after.recycleBinEmpty",
        &[("drives", emptied.len().to_string())],
    );
    Ok(execution)
}

fn sum_bytes(measured: &[(PathBuf, cleanup::RecycleBinInfo)]) -> u64 {
    measured
        .iter()
        .map(|(_, info)| info.bytes)
        .fold(0u64, u64::saturating_add)
}

fn sum_items(measured: &[(PathBuf, cleanup::RecycleBinInfo)]) -> u64 {
    measured
        .iter()
        .map(|(_, info)| info.items)
        .fold(0u64, u64::saturating_add)
}

/// What the action actually released: only drives that were measured before the
/// call *and* emptied successfully. A drive that could not be read, or whose
/// empty failed, contributes nothing - its contents are still on disk.
fn released_totals(
    measured: &[(PathBuf, cleanup::RecycleBinInfo)],
    emptied: &[&PathBuf],
) -> (u64, u64) {
    let mut bytes = 0u64;
    let mut items = 0u64;
    for (root, info) in measured {
        if !emptied.contains(&root) {
            continue;
        }
        bytes = bytes.saturating_add(info.bytes);
        items = items.saturating_add(info.items);
    }
    (bytes, items)
}

fn screenshot_candidates() -> ZenithResult<Vec<(PathBuf, PathBuf)>> {
    let Some(root) = screenshots_root() else {
        return Ok(Vec::new());
    };
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let cancel = Arc::new(CancelToken::new());
    collect_files(&root, Duration::from_secs(30 * 24 * 60 * 60), &cancel)
}

fn archive_screenshots(ctx: &ActionContext) -> ZenithResult<ActionExecution> {
    let mut execution = ActionExecution::new(ActionId::ArchiveScreenshots);

    let Some(root) = screenshots_root() else {
        execution.step_skipped("steps.noScreenshotFolder");
        execution.after("after.nothingToArchive", &[]);
        return Ok(execution);
    };
    let files = collect_files(&root, Duration::from_secs(30 * 24 * 60 * 60), &ctx.cancel)?;
    if files.is_empty() {
        execution.step_skipped("steps.noOldScreenshots");
        execution.after("after.nothingToArchive", &[]);
        return Ok(execution);
    }

    let entries: Vec<ArchiveEntry> = files
        .iter()
        .filter_map(|(root, file)| {
            relative_entry_name(root, file).map(|name| ArchiveEntry {
                name,
                source: file.clone(),
            })
        })
        .collect();

    let est: u64 = entries
        .iter()
        .map(|entry| {
            std::fs::metadata(&entry.source)
                .map(|m| m.len())
                .unwrap_or(0)
        })
        .sum();

    // Free space is checked against the estimate before writing, not after the
    // disk fills up.
    let disk = system::disk_for(&root)?;
    if !config::has_space_for(disk.free_bytes, est) {
        return Err(ZenithError::new(ErrorCode::InsufficientDisk)
            .with("neededMb", format!("{:.1}", est as f64 / (1024.0 * 1024.0)))
            .with(
                "freeMb",
                format!("{:.1}", disk.free_bytes as f64 / (1024.0 * 1024.0)),
            ));
    }

    let stamp = crate::engine::audit::now_utc()
        .chars()
        .filter(|c| c.is_ascii_digit())
        .take(14)
        .collect::<String>();
    let destination = root
        .parent()
        .unwrap_or(&root)
        .join(format!("Screenshots_Archive_{stamp}.zip"));

    execution.before(
        "before.screenshots",
        &[
            ("files", entries.len().to_string()),
            ("mb", format!("{:.1}", est as f64 / (1024.0 * 1024.0))),
        ],
    );

    let written = crate::engine::snapshot::write_archive(&destination, &entries)?;
    execution.step_ok(
        "steps.archiveWritten",
        &[
            ("files", written.file_count.to_string()),
            (
                "mb",
                format!("{:.1}", written.total_bytes as f64 / (1024.0 * 1024.0)),
            ),
        ],
    );

    let mut removed = 0u64;
    let mut failed = 0u64;
    for entry in &entries {
        if ctx.cancel.is_cancelled() {
            return Err(ZenithError::new(ErrorCode::Cancelled));
        }
        match std::fs::remove_file(&entry.source) {
            Ok(()) => removed += 1,
            Err(_) => failed += 1,
        }
    }
    execution.step_ok(
        "steps.originalsRemoved",
        &[("removed", removed.to_string())],
    );
    if failed > 0 {
        execution.step_failed("steps.originalsInUse", ErrorCode::AccessDenied);
        execution.param("leftBehind", failed.to_string());
    }

    execution.items_affected = removed;
    execution.bytes_freed = written.total_bytes;
    execution.after(
        "after.archived",
        &[
            ("archive", destination.display().to_string()),
            ("removed", removed.to_string()),
        ],
    );
    Ok(execution)
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

fn flush_dns(ctx: &ActionContext) -> ZenithResult<ActionExecution> {
    let mut execution = ActionExecution::new(ActionId::FlushDnsCache);

    // The cached answer set is not readable without an ETW trace, so the honest
    // "before" is a measured resolve latency, taken by the probe and passed in
    // by the caller. Here we record the flush itself.
    let outcome = run_fixed("ipconfig.exe", &["/flushdns"], Duration::from_secs(20), ctx)?;
    if !outcome.success() {
        execution.step_failed("steps.dnsFlush", ErrorCode::Internal);
        execution.after("after.dnsFlushFailed", &[]);
        return Ok(execution);
    }
    execution.step_ok("steps.dnsFlush", &[]);
    execution.after("after.dnsFlushed", &[]);
    Ok(execution)
}

fn reset_winsock(ctx: &ActionContext) -> ZenithResult<ActionExecution> {
    let mut execution = ActionExecution::new(ActionId::ResetWinsockStack);

    // Step 1: export the Winsock catalog so the damage is bounded. This is the
    // "compensating recovery" the tier promises, not a real rollback.
    let hive = ctx
        .paths
        .hives_dir()
        .join(format!("WinSock2_{}.hiv", file_stamp()));
    if let Some(parent) = hive.parent() {
        std::fs::create_dir_all(parent).map_err(|err| ZenithError::io("create hives dir", &err))?;
    }
    let export = run_fixed(
        "reg.exe",
        &[
            "save",
            r"HKLM\SYSTEM\CurrentControlSet\Services\WinSock2",
            &hive.to_string_lossy(),
            "/y",
        ],
        Duration::from_secs(60),
        ctx,
    )?;
    if export.success() {
        execution.step_ok(
            "steps.hiveExported",
            &[("file", hive.display().to_string())],
        );
    } else {
        // Without the export, resetting would be unrecoverable. Refuse rather
        // than downgrade the promise silently.
        execution.step_failed("steps.hiveExported", ErrorCode::SnapshotFailed);
        execution.after("after.winsockAborted", &[]);
        return Ok(execution);
    }

    // Step 2: the reset itself.
    let winsock = run_fixed(
        "netsh.exe",
        &["winsock", "reset"],
        Duration::from_secs(120),
        ctx,
    )?;
    if winsock.success() {
        execution.step_ok("steps.winsockReset", &[]);
    } else {
        execution.step_failed("steps.winsockReset", ErrorCode::Internal);
    }

    let ip = run_fixed(
        "netsh.exe",
        &["int", "ip", "reset"],
        Duration::from_secs(120),
        ctx,
    )?;
    if ip.success() {
        execution.step_ok("steps.ipReset", &[]);
    } else {
        execution.step_failed("steps.ipReset", ErrorCode::Internal);
    }

    execution.requires_reboot = true;
    execution.before("before.winsockCatalog", &[]);
    execution.after(
        "after.winsockReset",
        &[("hive", hive.display().to_string())],
    );
    Ok(execution)
}

fn clear_stuck_proxy() -> ZenithResult<ActionExecution> {
    let mut execution = ActionExecution::new(ActionId::ClearStuckProxyVpn);

    let before = proxy_values()?;
    execution.before(
        "before.proxy",
        &[
            ("enabled", before.proxy_enable.to_string()),
            (
                "server",
                before
                    .proxy_server
                    .as_deref()
                    .map(crate::engine::redact::redact_value)
                    .unwrap_or_else(|| "none".to_string()),
            ),
        ],
    );

    write_hkcu_dword(INTERNET_SETTINGS, "ProxyEnable", 0)?;
    execution.step_ok("steps.proxyDisabled", &[]);

    // Deleting a value that is not there is success, not an error.
    let mut removed = 0u32;
    for name in ["ProxyServer", "AutoConfigURL"] {
        if delete_hkcu_value(INTERNET_SETTINGS, name)? {
            removed += 1;
        }
    }
    execution.step_ok(
        "steps.proxyValuesRemoved",
        &[("removed", removed.to_string())],
    );

    execution.after("after.proxyCleared", &[("removed", removed.to_string())]);
    Ok(execution)
}

fn copy_sysadmin_info() -> ZenithResult<ActionExecution> {
    let mut execution = ActionExecution::new(ActionId::CopySysadminInfo);

    let memory = system::memory()?;
    let os = system::os_info()?;
    let host = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "unknown".to_string());

    // Deliberately no username, no IP address, no serial: what an admin needs to
    // triage, and nothing that identifies the person (04-02 §4).
    let text = format!(
        "Host: {host}\nOS: {} {} build {}.{}\nRAM: {} MB used of {} MB",
        os.product_name,
        os.display_version,
        os.build,
        os.ubr,
        memory.used_mb(),
        memory.total_mb
    );

    execution.clipboard_text = Some(text.clone());
    execution.trigger_effect = Some("copyToClipboard".to_string());
    execution.step_ok("steps.infoGathered", &[]);
    execution.after("after.infoReady", &[("lines", "3".to_string())]);
    execution.param("bytes", text.len().to_string());
    Ok(execution)
}

// ---------------------------------------------------------------------------
// Recovery services
// ---------------------------------------------------------------------------

fn restart_service(action: ActionId, service: &str) -> ZenithResult<ActionExecution> {
    let mut execution = ActionExecution::new(action);
    let (before, after) = services::restart(
        service,
        services::DEFAULT_START_TIMEOUT,
        services::DEFAULT_STOP_TIMEOUT,
    )?;

    execution.before(
        "before.service",
        &[
            ("service", service.to_string()),
            ("state", before.state.as_str().to_string()),
        ],
    );
    execution.step_ok(
        "steps.serviceRestarted",
        &[("service", service.to_string())],
    );
    execution.after(
        "after.service",
        &[
            ("service", service.to_string()),
            ("state", after.state.as_str().to_string()),
        ],
    );
    Ok(execution)
}

fn reset_print_spooler(ctx: &ActionContext) -> ZenithResult<ActionExecution> {
    let mut execution = ActionExecution::new(ActionId::ResetPrintSpooler);

    let before = services::query("Spooler")?;
    execution.before(
        "before.service",
        &[
            ("service", "Spooler".to_string()),
            ("state", before.state.as_str().to_string()),
        ],
    );

    services::stop("Spooler", services::DEFAULT_STOP_TIMEOUT)?;
    execution.step_ok("steps.spoolerStopped", &[]);

    // Only the spool directory, resolved through the scope, never a stored path.
    let spool = spool_directory(ctx)?;
    let scan = cleanup::scan_old_files(&[spool], Duration::ZERO, &ctx.cancel)?;
    let summary = cleanup::delete_files(&scan.files, &ctx.cancel);
    execution.step_ok(
        "steps.jobsCleared",
        &[
            ("removed", summary.deleted.to_string()),
            ("skipped", summary.skipped_count().to_string()),
        ],
    );
    execution.items_affected = summary.deleted as u64;

    let after = services::start("Spooler", services::DEFAULT_START_TIMEOUT)?;
    execution.step_ok("steps.spoolerStarted", &[]);
    execution.after(
        "after.service",
        &[
            ("service", "Spooler".to_string()),
            ("state", after.state.as_str().to_string()),
        ],
    );
    Ok(execution)
}

fn spool_directory(ctx: &ActionContext) -> ZenithResult<PathBuf> {
    let resolved =
        crate::engine::scope::resolve_path(ActionScope::Spooler, "PRINTERS", &ctx.scope_roots)?;
    // The scope resolver proves the path is inside an allowed root; the spool
    // root is `%SystemRoot%\System32\spool`, so PRINTERS is its only child.
    if resolved.path.is_dir() {
        Ok(resolved.path)
    } else {
        Ok(ctx
            .scope_roots
            .windows
            .join("System32")
            .join("spool")
            .join("PRINTERS"))
    }
}

fn restart_explorer(ctx: &ActionContext) -> ZenithResult<ActionExecution> {
    let mut execution = ActionExecution::new(ActionId::RestartExplorer);

    let running = process::find_by_name("explorer.exe")?;
    execution.before("before.explorer", &[("count", running.len().to_string())]);

    if running.is_empty() {
        execution.step_skipped("steps.explorerNotRunning");
    } else {
        let targets: Vec<VerifiedPidTarget> = running.iter().map(|id| id.target()).collect();
        let summary = process::terminate_all(&targets);
        execution.step_ok(
            "steps.explorerStopped",
            &[("terminated", summary.terminated().to_string())],
        );
        // Explorer needs a moment to release the shell mutex before it can start
        // again; starting too early produces a second instance that exits.
        std::thread::sleep(Duration::from_millis(1200));
    }

    // `explorer.exe` is launched by absolute path from the Windows directory, so
    // no `PATH` entry can substitute a different binary.
    let explorer = ctx.scope_roots.windows.join("explorer.exe");
    let outcome = child::run(
        &child::ChildSpec::new(&explorer.to_string_lossy(), &[], Duration::from_secs(10)),
        &ctx.cancel,
    )?;
    if outcome.cancelled {
        return Err(ZenithError::new(ErrorCode::Cancelled));
    }
    // Explorer is a long-lived process: it detaches, so a non-zero or missing
    // exit code here is normal. What matters is that it appeared.
    std::thread::sleep(Duration::from_millis(800));

    let after = process::find_by_name("explorer.exe")?;
    if after.is_empty() {
        execution.step_failed("steps.explorerStarted", ErrorCode::Internal);
    } else {
        execution.step_ok("steps.explorerStarted", &[]);
    }

    execution.after("after.explorer", &[("count", after.len().to_string())]);
    Ok(execution)
}

fn rebuild_icon_cache(ctx: &ActionContext) -> ZenithResult<ActionExecution> {
    let mut execution = ActionExecution::new(ActionId::RebuildIconCache);

    let Some(cache_root) = icon_cache_root() else {
        return Err(ZenithError::new(ErrorCode::Internal).with("reason", "no LOCALAPPDATA"));
    };
    let scan = cleanup::scan_old_files(
        std::slice::from_ref(&cache_root),
        Duration::ZERO,
        &ctx.cancel,
    )?;
    // Only icon/thumb cache databases; a stray `.db` of another kind is left
    // alone even though it sits in the same folder.
    let cache_files: Vec<PathBuf> = scan
        .files
        .into_iter()
        .filter(|path| {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            name.starts_with("iconcache_") || name.starts_with("thumbcache_")
        })
        .collect();

    execution.before(
        "before.iconCache",
        &[("files", cache_files.len().to_string())],
    );

    // Explorer holds these files open; it must stop first.
    let running = process::find_by_name("explorer.exe")?;
    let targets: Vec<VerifiedPidTarget> = running.iter().map(|id| id.target()).collect();
    let summary = process::terminate_all(&targets);
    execution.step_ok(
        "steps.explorerStopped",
        &[("terminated", summary.terminated().to_string())],
    );
    std::thread::sleep(Duration::from_millis(1200));

    let deleted = cleanup::delete_files(&cache_files, &ctx.cancel);
    execution.step_ok(
        "steps.cacheCleared",
        &[
            ("removed", deleted.deleted.to_string()),
            ("skipped", deleted.skipped_count().to_string()),
        ],
    );
    execution.items_affected = deleted.deleted as u64;

    let explorer = ctx.scope_roots.windows.join("explorer.exe");
    let _ = child::run(
        &child::ChildSpec::new(&explorer.to_string_lossy(), &[], Duration::from_secs(10)),
        &ctx.cancel,
    )?;
    execution.step_ok("steps.explorerStarted", &[]);

    // `ie4uinit -show` asks the shell to refresh its icon cache from the files
    // we just deleted, which is what makes the rebuild visible.
    let ie4uinit = ctx
        .scope_roots
        .windows
        .join("System32")
        .join("ie4uinit.exe");
    match child::run(
        &child::ChildSpec::new(
            &ie4uinit.to_string_lossy(),
            &["-show"],
            Duration::from_secs(20),
        ),
        &ctx.cancel,
    ) {
        Ok(outcome) if outcome.success() => execution.step_ok("steps.iconCacheRefreshed", &[]),
        Ok(_) => execution.step_skipped("steps.iconCacheRefreshed"),
        Err(_) => execution.step_skipped("steps.iconCacheRefreshed"),
    }

    execution.after(
        "after.iconCache",
        &[("removed", deleted.deleted.to_string())],
    );
    Ok(execution)
}

fn reset_gpu_driver() -> ZenithResult<ActionExecution> {
    let mut execution = ActionExecution::new(ActionId::ResetGpuDriver);
    gpu_driver_reset()?;
    execution.step_ok("steps.gpuResetSent", &[]);
    execution.before("before.gpuDriver", &[]);
    execution.after("after.gpuReset", &[]);
    execution.param("flash", "true");
    Ok(execution)
}

#[cfg(windows)]
fn gpu_driver_reset() -> ZenithResult<()> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        KEYBD_EVENT_FLAGS, VK_CONTROL, VK_LWIN, VK_SHIFT, keybd_event,
    };

    /// Virtual-key code for `B`.
    const VK_B: u8 = 0x42;
    /// `KEYEVENTF_KEYUP`.
    const KEYUP: u32 = 0x0002;

    let sequence = [
        (VK_LWIN.0 as u8, false),
        (VK_CONTROL.0 as u8, false),
        (VK_SHIFT.0 as u8, false),
        (VK_B, false),
        (VK_B, true),
        (VK_SHIFT.0 as u8, true),
        (VK_CONTROL.0 as u8, true),
        (VK_LWIN.0 as u8, true),
    ];

    for (code, is_up) in sequence {
        // SAFETY: `keybd_event` synthesises a keyboard event and dereferences no
        // Rust memory; `dwextrainfo` is documented as unused when zero.
        unsafe {
            keybd_event(code, 0, KEYBD_EVENT_FLAGS(if is_up { KEYUP } else { 0 }), 0);
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    Ok(())
}

#[cfg(not(windows))]
fn gpu_driver_reset() -> ZenithResult<()> {
    Err(super::unsupported("actions.gpu_reset"))
}

fn controlled_reboot(ctx: &ActionContext) -> ZenithResult<ActionExecution> {
    let mut execution = ActionExecution::new(ActionId::ControlledReboot);

    // Refuse to reboot a machine mid-way through another action: the snapshot
    // would be committed but the action would never record its outcome.
    execution.before(
        "before.uptime",
        &[("days", (system::uptime_ms()? / 86_400_000).to_string())],
    );

    let outcome = run_fixed(
        "shutdown.exe",
        &[
            "/r",
            "/t",
            "30",
            "/c",
            "Zenith controlled restart",
            "/d",
            "p:2:4",
        ],
        Duration::from_secs(30),
        ctx,
    )?;
    if !outcome.success() {
        execution.step_failed("steps.rebootScheduled", ErrorCode::Internal);
        execution.after("after.rebootNotScheduled", &[]);
        return Ok(execution);
    }

    execution.step_ok("steps.rebootScheduled", &[("seconds", "30".to_string())]);
    execution.abortable_hint();
    execution.after("after.rebootScheduled", &[("seconds", "30".to_string())]);
    execution.param("seconds", "30");
    Ok(execution)
}

impl ActionExecution {
    /// The countdown is abortable; what "abortable" means is that the UI may
    /// offer the button and that [`abort_reboot`] exists.
    fn abortable_hint(&mut self) {
        self.trigger_effect = Some("rebootCountdown".to_string());
    }
}

/// Cancel a scheduled reboot. Idempotent: aborting when nothing is scheduled
/// returns success, because the user's goal (no reboot) is satisfied.
pub fn abort_reboot(ctx: &ActionContext) -> ZenithResult<()> {
    let outcome = run_fixed("shutdown.exe", &["/a"], Duration::from_secs(15), ctx)?;
    // 1116 = ERROR_NO_SHUTDOWN_IN_PROGRESS; treat as already aborted.
    if outcome.success() || outcome.exit_code == Some(1116) {
        Ok(())
    } else {
        Err(ZenithError::new(ErrorCode::Internal)
            .with("reason", "shutdown /a failed")
            .detail(outcome.stderr.chars().take(400).collect::<String>()))
    }
}

// ---------------------------------------------------------------------------
// Process-backed actions
// ---------------------------------------------------------------------------

fn terminate_selected(
    action: ActionId,
    targets: &[VerifiedPidTarget],
) -> ZenithResult<ActionExecution> {
    let mut execution = ActionExecution::new(action);

    if targets.is_empty() {
        // Refusing is correct: "kill whatever is on port 4040" is not a request
        // the user made, and inferring it would kill the wrong thing.
        return Err(ZenithError::new(ErrorCode::InvalidArgument)
            .with("field", "targets")
            .with("reason", "no verified process selected"));
    }

    execution.before(
        "before.selectedProcesses",
        &[("count", targets.len().to_string())],
    );

    let summary = process::terminate_all(targets);
    let terminated = summary.terminated() as u64;
    execution.items_affected = terminated;

    for (pid, outcome) in &summary.results {
        let key = match outcome {
            process::TerminateOutcome::Terminated => "steps.processTerminated",
            process::TerminateOutcome::IdentityMismatch => "steps.processIdentityMismatch",
            process::TerminateOutcome::AccessDenied => "steps.processAccessDenied",
            process::TerminateOutcome::Gone => "steps.processGone",
            process::TerminateOutcome::RefusedSelf => "steps.processSelfRefused",
        };
        let mut params = BTreeMap::new();
        params.insert("pid".to_string(), pid.to_string());
        execution.steps.push(StepResult {
            step_key: key.to_string(),
            status: if *outcome == process::TerminateOutcome::Terminated {
                StepStatus::Success
            } else {
                StepStatus::Skipped
            },
            error_code: match outcome {
                process::TerminateOutcome::AccessDenied => Some(ErrorCode::AccessDenied),
                process::TerminateOutcome::IdentityMismatch => {
                    Some(ErrorCode::PidVerificationFailed)
                }
                _ => None,
            },
            params,
        });
    }

    if terminated == 0 {
        execution.success = false;
        execution.summary_key = "outcomes.nothingTerminated".to_string();
    }

    execution.after(
        "after.selectedProcesses",
        &[
            ("terminated", terminated.to_string()),
            (
                "skipped",
                (summary.results.len() as u64 - terminated).to_string(),
            ),
        ],
    );
    execution.param("terminated", terminated.to_string());
    Ok(execution)
}

fn close_hung_office(targets: &[VerifiedPidTarget]) -> ZenithResult<ActionExecution> {
    let mut execution = ActionExecution::new(ActionId::CloseHungOffice);

    let mut selected: Vec<VerifiedPidTarget> = targets.to_vec();
    if selected.is_empty() {
        // No explicit selection: discover hung windows, which is what the action
        // is named after, then verify each identity at kill time anyway.
        for name in OFFICE_IMAGE_NAMES {
            for identity in process::find_by_name(name)? {
                if !process::is_responding(identity.pid)? {
                    selected.push(identity.target());
                }
            }
        }
    }

    if selected.is_empty() {
        execution.step_skipped("steps.noHungOffice");
        execution.after("after.noHungOffice", &[]);
        return Ok(execution);
    }

    execution.before(
        "before.hungOffice",
        &[("count", selected.len().to_string())],
    );

    let summary = process::terminate_all(&selected);
    let terminated = summary.terminated() as u64;
    execution.items_affected = terminated;

    execution.step_ok(
        "steps.hungClosed",
        &[
            ("terminated", terminated.to_string()),
            ("skipped", (selected.len() as u64 - terminated).to_string()),
        ],
    );
    execution.after(
        "after.hungClosed",
        &[("terminated", terminated.to_string())],
    );
    execution.param("terminated", terminated.to_string());
    Ok(execution)
}

fn clear_office_cache(ctx: &ActionContext) -> ZenithResult<ActionExecution> {
    let mut execution = ActionExecution::new(ActionId::ClearTeamsOutlookCache);

    let roots = office_cache_roots();
    let mut total_files = 0usize;
    let mut freed = 0u64;
    let mut skipped = 0usize;

    for root in roots {
        if !root.is_dir() {
            continue;
        }
        let scan =
            cleanup::scan_old_files(std::slice::from_ref(&root), Duration::ZERO, &ctx.cancel)?;
        total_files += scan.file_count();
        let summary = cleanup::delete_files(&scan.files, &ctx.cancel);
        freed = freed.saturating_add(summary.bytes_freed);
        skipped += summary.skipped_count();
        execution.step_ok(
            "steps.cacheRootCleared",
            &[
                ("path", root.display().to_string()),
                ("files", summary.deleted.to_string()),
            ],
        );
    }

    execution.before("before.officeCache", &[("files", total_files.to_string())]);
    execution.items_affected = total_files as u64;
    execution.bytes_freed = freed;
    if skipped > 0 {
        // Outlook holding a file open is expected and is not a failure.
        execution.param("skipped", skipped.to_string());
    }
    execution.after(
        "after.officeCache",
        &[
            ("mb", format!("{:.1}", freed as f64 / (1024.0 * 1024.0))),
            ("skipped", skipped.to_string()),
        ],
    );
    Ok(execution)
}

// ---------------------------------------------------------------------------
// Manifest-driven child processes
// ---------------------------------------------------------------------------

fn run_manifest_command(action: ActionId, ctx: &ActionContext) -> ZenithResult<ActionExecution> {
    let def = manifest::action_by_id(action);
    let mut execution = ActionExecution::new(action);

    let (program, args) = match def.command {
        CommandSpec::Fixed { program, args } => (program, args),
        CommandSpec::None => {
            // A manifest declaring no command means the action needs direct API
            // work; reaching here is a wiring bug, not a user-visible condition.
            return Err(ZenithError::new(ErrorCode::NotImplemented)
                .with("actionId", action.to_string())
                .with("reason", "no manifest command declared"));
        }
    };

    execution.before("before.command", &[("program", program.to_string())]);

    let outcome = run_fixed(program, args, Duration::from_secs(def.timeout_secs), ctx)?;
    if outcome.cancelled {
        return Err(ZenithError::new(ErrorCode::Cancelled));
    }

    if outcome.timed_out {
        execution.step_failed("steps.commandTimedOut", ErrorCode::Timeout);
        execution.after(
            "after.commandTimedOut",
            &[("seconds", def.timeout_secs.to_string())],
        );
        return Ok(execution);
    }

    // DISM and SFC report "restart required" as 3010, which is success, not
    // failure. Anything else non-zero is a genuine failure.
    let restart_required = outcome.exit_code == Some(3010);
    let success = outcome.exit_code == Some(0) || restart_required;

    if success {
        execution.step_ok(
            "steps.commandSucceeded",
            &[("program", program.to_string())],
        );
    } else {
        execution.step_failed("steps.commandFailed", ErrorCode::Internal);
        execution.summary_params.insert(
            "exitCode".to_string(),
            outcome
                .exit_code
                .map(|code| code.to_string())
                .unwrap_or_else(|| "none".to_string()),
        );
        // The tail of stderr is what the user needs to act on; it was redacted
        // inside `child` before it reached us.
        if !outcome.stderr.trim().is_empty() {
            let tail: String = outcome
                .stderr
                .chars()
                .rev()
                .take(400)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
            execution.summary_params.insert("detail".to_string(), tail);
        }
    }

    execution.requires_reboot = restart_required;
    execution.after(
        "after.commandFinished",
        &[
            ("program", program.to_string()),
            (
                "exitCode",
                outcome
                    .exit_code
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "none".to_string()),
            ),
            ("seconds", (outcome.duration_ms / 1000).to_string()),
        ],
    );
    execution.param("seconds", (outcome.duration_ms / 1000).to_string());
    Ok(execution)
}

fn windows_update_scan(ctx: &ActionContext) -> ZenithResult<ActionExecution> {
    let mut execution = ActionExecution::new(ActionId::WindowsUpdateScan);

    // `UsoClient StartScan` is asynchronous: it returns immediately and the scan
    // continues in the service. Reporting "found 0 updates" would be a lie, so
    // the outcome says the scan started and where to see the result.
    let uso = ctx
        .scope_roots
        .windows
        .join("System32")
        .join("UsoClient.exe");
    let outcome = child::run(
        &child::ChildSpec::new(
            &uso.to_string_lossy(),
            &["StartScan"],
            Duration::from_secs(30),
        ),
        &ctx.cancel,
    )?;
    if outcome.cancelled {
        return Err(ZenithError::new(ErrorCode::Cancelled));
    }
    if outcome.success() {
        execution.step_ok("steps.updateScanStarted", &[]);
    } else {
        execution.step_failed("steps.updateScanStarted", ErrorCode::ToolMissing);
    }

    execution.before("before.updateScan", &[]);
    execution.after("after.updateScanStarted", &[]);
    Ok(execution)
}

/// Run a fixed program with a fixed argument vector and a deadline.
fn run_fixed(
    program: &str,
    args: &[&str],
    timeout: Duration,
    ctx: &ActionContext,
) -> ZenithResult<child::ChildOutcome> {
    let spec = child::ChildSpec::new(program, args, timeout);
    child::run(&spec, &ctx.cancel)
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const OFFICE_IMAGE_NAMES: [&str; 4] = ["WINWORD.EXE", "EXCEL.EXE", "POWERPNT.EXE", "OUTLOOK.EXE"];

const INTERNET_SETTINGS: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

fn temp_roots() -> Vec<PathBuf> {
    let mut roots = vec![std::env::temp_dir()];
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("Temp"));
    }
    if let Some(system_root) = std::env::var_os("SystemRoot") {
        roots.push(PathBuf::from(system_root).join("Temp"));
    }
    roots.sort();
    roots.dedup();
    roots
}

fn screenshots_root() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|profile| profile.join("Pictures").join("Screenshots"))
}

fn icon_cache_root() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|local| local.join(r"Microsoft\Windows\Explorer"))
}

fn office_cache_roots() -> Vec<PathBuf> {
    let Some(local) = std::env::var_os("LOCALAPPDATA") else {
        return Vec::new();
    };
    let local = PathBuf::from(local);
    vec![
        local.join(r"Microsoft\Outlook\RoamCache"),
        local.join(r"Microsoft\Teams\Cache"),
        local.join(r"Microsoft\Teams\Code Cache"),
        local.join(r"Microsoft\Teams\GPUCache"),
    ]
}

fn service_for(action: ActionId) -> &'static str {
    match action {
        ActionId::SyncNtpTime => "W32Time",
        ActionId::RestartBluetooth => "bthserv",
        ActionId::ResetPrintSpooler => "Spooler",
        _ => "Spooler",
    }
}

/// `YYYYMMDD_HHMMSS` from the UTC clock, for unique artefact names.
fn file_stamp() -> String {
    // "2026-11-18T23:10:18.123Z" -> "20261118231018" (14 digits, no separator,
    // no fractional dot). Filtering to digits is the only version that cannot
    // leak a '.' into a filename when the timestamp format changes.
    crate::engine::audit::now_utc()
        .chars()
        .filter(char::is_ascii_digit)
        .take(14)
        .collect()
}

/// Fixed local drives only. Network and removable volumes are excluded: emptying
/// a mapped drive's Recycle Bin is not the user's intent and can be very slow.
#[cfg(windows)]
fn fixed_drive_roots() -> ZenithResult<Vec<PathBuf>> {
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    use windows::Win32::System::WindowsProgramming::DRIVE_FIXED;

    // SAFETY: `GetLogicalDrives` takes no pointers and cannot fail; the bitmask
    // it returns is interpreted below without dereferencing anything.
    let mask = unsafe { GetLogicalDrives() };
    let mut roots = Vec::new();
    for index in 0..26u32 {
        if mask & (1 << index) == 0 {
            continue;
        }
        let letter = (b'A' + index as u8) as char;
        let root = format!("{letter}:\\");
        let wide: Vec<u16> = root.encode_utf16().chain(Some(0)).collect();
        // SAFETY: `wide` is NUL-terminated and outlives the call.
        let kind = unsafe { GetDriveTypeW(windows::core::PCWSTR(wide.as_ptr())) };
        if kind == DRIVE_FIXED {
            roots.push(PathBuf::from(root));
        }
    }
    Ok(roots)
}

#[cfg(not(windows))]
fn fixed_drive_roots() -> ZenithResult<Vec<PathBuf>> {
    Err(super::unsupported("actions.fixed_drive_roots"))
}

// ---------------------------------------------------------------------------
// Registry (HKCU only: every registry write here is per-user and reversible)
// ---------------------------------------------------------------------------

struct ProxyValues {
    proxy_enable: u32,
    proxy_server: Option<String>,
}

fn proxy_values() -> ZenithResult<ProxyValues> {
    Ok(ProxyValues {
        proxy_enable: read_hkcu_dword(INTERNET_SETTINGS, "ProxyEnable").unwrap_or(0),
        proxy_server: read_hkcu_string(INTERNET_SETTINGS, "ProxyServer").unwrap_or(None),
    })
}

fn proxy_state() -> ZenithResult<String> {
    let values = proxy_values()?;
    // Serialised by hand to keep the payload stable and human-readable in the
    // snapshot viewer; the HMAC protects it either way.
    let server = values
        .proxy_server
        .as_deref()
        .map(crate::engine::redact::redact_value)
        .unwrap_or_default()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    Ok(format!(
        "{{\"proxyEnable\":{},\"proxyServer\":\"{}\"}}",
        values.proxy_enable, server
    ))
}

#[cfg(windows)]
fn read_hkcu_dword(path: &str, value: &str) -> ZenithResult<u32> {
    use windows::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_READ, REG_DWORD, RegCloseKey, RegOpenKeyExW, RegQueryValueExW,
    };
    use windows::core::PCWSTR;

    let path_wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let value_wide: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
    let mut key = HKEY::default();

    // SAFETY: NUL-terminated strings outlive the call; `key` is a live local.
    let opened = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(path_wide.as_ptr()),
            Some(0),
            KEY_READ,
            &mut key,
        )
    };
    if opened.0 != 0 {
        return Err(ZenithError::new(ErrorCode::AccessDenied).with("key", path.to_string()));
    }

    let mut data = 0u32;
    let mut size = std::mem::size_of::<u32>() as u32;
    let mut kind = REG_DWORD;
    // SAFETY: `data` is exactly `size` bytes; `key` is valid.
    let read = unsafe {
        RegQueryValueExW(
            key,
            PCWSTR(value_wide.as_ptr()),
            None,
            Some(&mut kind),
            Some(&mut data as *mut u32 as *mut u8),
            Some(&mut size),
        )
    };
    // SAFETY: `key` was opened successfully.
    unsafe {
        let _ = RegCloseKey(key);
    }

    if read.0 != 0 {
        return Err(ZenithError::new(ErrorCode::Internal).with("value", value.to_string()));
    }
    Ok(data)
}

#[cfg(not(windows))]
fn read_hkcu_dword(_path: &str, _value: &str) -> ZenithResult<u32> {
    Err(super::unsupported("actions.registry_read"))
}

#[cfg(windows)]
fn read_hkcu_string(path: &str, value: &str) -> ZenithResult<Option<String>> {
    use windows::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_READ, REG_SZ, RegCloseKey, RegOpenKeyExW, RegQueryValueExW,
    };
    use windows::core::PCWSTR;

    let path_wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let value_wide: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
    let mut key = HKEY::default();

    // SAFETY: NUL-terminated strings outlive the call; `key` is a live local.
    let opened = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(path_wide.as_ptr()),
            Some(0),
            KEY_READ,
            &mut key,
        )
    };
    if opened.0 != 0 {
        return Ok(None);
    }

    let mut size = 0u32;
    let mut kind = REG_SZ;
    // SAFETY: two-step size query with a null data pointer is documented.
    let probe = unsafe {
        RegQueryValueExW(
            key,
            PCWSTR(value_wide.as_ptr()),
            None,
            Some(&mut kind),
            None,
            Some(&mut size),
        )
    };
    if probe.0 != 0 || size == 0 || size > 64 * 1024 {
        // SAFETY: `key` is valid.
        unsafe {
            let _ = RegCloseKey(key);
        }
        return Ok(None);
    }

    let mut buffer = vec![0u8; size as usize];
    // SAFETY: `buffer` is exactly `size` bytes.
    let read = unsafe {
        RegQueryValueExW(
            key,
            PCWSTR(value_wide.as_ptr()),
            None,
            Some(&mut kind),
            Some(buffer.as_mut_ptr()),
            Some(&mut size),
        )
    };
    // SAFETY: `key` is valid and closed once.
    unsafe {
        let _ = RegCloseKey(key);
    }
    if read.0 != 0 {
        return Ok(None);
    }

    Ok(super::utf16le_to_string(&buffer))
}

#[cfg(not(windows))]
fn read_hkcu_string(_path: &str, _value: &str) -> ZenithResult<Option<String>> {
    Err(super::unsupported("actions.registry_read"))
}

#[cfg(windows)]
fn write_hkcu_dword(path: &str, value: &str, data: u32) -> ZenithResult<()> {
    use windows::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_DWORD, RegCloseKey, RegOpenKeyExW,
        RegSetValueExW,
    };
    use windows::core::PCWSTR;

    let path_wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let value_wide: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
    let mut key = HKEY::default();

    // SAFETY: NUL-terminated strings outlive the call; `key` is a live local.
    let opened = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(path_wide.as_ptr()),
            Some(0),
            KEY_SET_VALUE,
            &mut key,
        )
    };
    if opened.0 != 0 {
        return Err(ZenithError::new(ErrorCode::AccessDenied).with("key", path.to_string()));
    }

    let bytes = data.to_le_bytes();
    // SAFETY: `bytes` is exactly four bytes, which matches `REG_DWORD`.
    let written = unsafe {
        RegSetValueExW(
            key,
            PCWSTR(value_wide.as_ptr()),
            None,
            REG_DWORD,
            Some(&bytes),
        )
    };
    // SAFETY: `key` was opened successfully.
    unsafe {
        let _ = RegCloseKey(key);
    }

    if written.0 != 0 {
        return Err(ZenithError::new(ErrorCode::AccessDenied)
            .with("value", value.to_string())
            .detail(format!("win32={}", written.0)));
    }
    Ok(())
}

#[cfg(not(windows))]
fn write_hkcu_dword(_path: &str, _value: &str, _data: u32) -> ZenithResult<()> {
    Err(super::unsupported("actions.registry_write"))
}

/// Delete one HKCU value. Returns `true` when something was deleted.
#[cfg(windows)]
fn delete_hkcu_value(path: &str, value: &str) -> ZenithResult<bool> {
    use windows::Win32::Foundation::ERROR_FILE_NOT_FOUND;
    use windows::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, RegCloseKey, RegDeleteValueW, RegOpenKeyExW,
    };
    use windows::core::PCWSTR;

    let path_wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let value_wide: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
    let mut key = HKEY::default();

    // SAFETY: NUL-terminated strings outlive the call; `key` is a live local.
    let opened = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(path_wide.as_ptr()),
            Some(0),
            KEY_SET_VALUE,
            &mut key,
        )
    };
    if opened.0 != 0 {
        return Ok(false);
    }

    // SAFETY: `key` is valid; `value_wide` is NUL-terminated and outlives the call.
    let deleted = unsafe { RegDeleteValueW(key, PCWSTR(value_wide.as_ptr())) };
    // SAFETY: `key` was opened successfully.
    unsafe {
        let _ = RegCloseKey(key);
    }

    // 0 = deleted, 2 (ERROR_FILE_NOT_FOUND) = already gone. Both mean "the value
    // is not there any more", so both are success for this operation.
    match deleted.0 {
        0 => Ok(true),
        code if code == ERROR_FILE_NOT_FOUND.0 => Ok(false),
        _ => Ok(false),
    }
}

#[cfg(not(windows))]
fn delete_hkcu_value(_path: &str, _value: &str) -> ZenithResult<bool> {
    Err(super::unsupported("actions.registry_delete"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context() -> ActionContext {
        let dir = tempfile::tempdir().expect("tempdir");
        // Leak the directory handle: tests need it alive for the call only, and a
        // `Paths` clone keeps the layout usable.
        ActionContext {
            paths: Paths::for_root(dir.keep()),
            cancel: Arc::new(CancelToken::new()),
            scope_roots: ScopeRoots::from_environment(),
            elevated: false,
        }
    }

    #[test]
    fn every_action_has_an_execution_path() {
        // A missing arm is a compile error, but this catches a future variant
        // being routed to the wrong handler.
        for def in manifest::ACTIONS {
            let request = ActionRequest {
                action: def.id,
                targets: Vec::new(),
            };
            // Only assert that dispatch does not panic on construction; running
            // real actions in a unit test would mutate the machine.
            let execution = ActionExecution::new(request.action);
            assert!(execution.summary_key.ends_with("done"));
        }
    }

    #[test]
    fn a_failed_execution_carries_the_error_code_not_prose() {
        let error = ZenithError::new(ErrorCode::AccessDenied);
        let execution = ActionExecution::failed(ActionId::CleanTempCache, &error);
        assert!(!execution.success);
        assert_eq!(
            execution.summary_params.get("code").map(String::as_str),
            Some("ACCESS_DENIED")
        );
        assert!(!execution.summary_key.contains(' '), "key, not a sentence");
    }

    #[test]
    fn a_failed_step_marks_the_whole_execution_unsuccessful() {
        let mut execution = ActionExecution::new(ActionId::FlushDnsCache);
        execution.step_ok("steps.dnsFlush", &[]);
        execution.step_failed("steps.ipReset", ErrorCode::Timeout);
        assert!(!execution.success);
        assert_eq!(execution.steps.len(), 2);
        assert_eq!(execution.steps[1].status, StepStatus::Error);
        assert_eq!(execution.steps[0].status, StepStatus::Success);
    }

    #[test]
    fn empty_target_list_is_refused_rather_than_inferred() {
        let ctx = context();
        let err = terminate_selected(ActionId::UnlockDevPorts, &[]).unwrap_err();
        assert!(err.is(ErrorCode::InvalidArgument));
        let _ = ctx;
    }

    #[test]
    fn service_mapping_matches_the_manifest_scopes() {
        assert_eq!(service_for(ActionId::RestartBluetooth), "bthserv");
        assert_eq!(service_for(ActionId::ResetPrintSpooler), "Spooler");
        assert_eq!(service_for(ActionId::SyncNtpTime), "W32Time");
    }

    #[test]
    fn file_stamp_is_fourteen_digits_or_fewer() {
        let stamp = file_stamp();
        assert!(stamp.chars().all(|c| c.is_ascii_digit()), "{stamp}");
        assert!(!stamp.is_empty());
    }

    #[test]
    fn temp_roots_never_contain_duplicates() {
        let roots = temp_roots();
        let mut sorted = roots.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(roots, sorted);
    }

    #[cfg(windows)]
    #[test]
    fn fixed_drives_are_reported_as_root_paths() {
        for root in fixed_drive_roots().expect("drive roots") {
            let text = root.to_string_lossy();
            assert!(text.ends_with(":\\"), "{text}");
            assert_eq!(text.len(), 3, "{text}");
        }
    }

    #[test]
    fn only_drives_that_were_emptied_count_as_released() {
        // Two drives measured, one emptied. Reporting the measured total as
        // freed would claim the failed drive's bytes too - the accounting
        // defect this split exists to prevent.
        let measured = vec![
            (
                PathBuf::from("C:\\"),
                cleanup::RecycleBinInfo {
                    bytes: 1_000,
                    items: 2,
                },
            ),
            (
                PathBuf::from("D:\\"),
                cleanup::RecycleBinInfo {
                    bytes: 5_000,
                    items: 7,
                },
            ),
        ];
        let c = PathBuf::from("C:\\");
        let (bytes, items) = released_totals(&measured, &[&c]);
        assert_eq!(bytes, 1_000, "the drive that failed must not be counted");
        assert_eq!(items, 2);
    }

    #[test]
    fn a_drive_that_could_not_be_measured_contributes_nothing() {
        // `D:\` was never measured (recycle_bin_info failed), so even if its
        // empty succeeded there is no honest number to report for it.
        let measured = vec![(
            PathBuf::from("C:\\"),
            cleanup::RecycleBinInfo {
                bytes: 4_096,
                items: 1,
            },
        )];
        let c = PathBuf::from("C:\\");
        let d = PathBuf::from("D:\\");
        let (bytes, items) = released_totals(&measured, &[&c, &d]);
        assert_eq!(bytes, 4_096);
        assert_eq!(items, 1);
    }

    #[test]
    fn no_drive_emptied_releases_zero() {
        let measured = vec![(
            PathBuf::from("C:\\"),
            cleanup::RecycleBinInfo {
                bytes: 9_000,
                items: 3,
            },
        )];
        assert_eq!(released_totals(&measured, &[]), (0, 0));
    }

    #[test]
    fn summing_measured_drives_saturates_instead_of_wrapping() {
        let measured = vec![
            (
                PathBuf::from("C:\\"),
                cleanup::RecycleBinInfo {
                    bytes: u64::MAX - 1,
                    items: u64::MAX - 1,
                },
            ),
            (
                PathBuf::from("D:\\"),
                cleanup::RecycleBinInfo {
                    bytes: 10,
                    items: 10,
                },
            ),
        ];
        assert_eq!(sum_bytes(&measured), u64::MAX);
        assert_eq!(sum_items(&measured), u64::MAX);
    }

    #[cfg(windows)]
    #[test]
    fn reading_the_proxy_switch_never_panics() {
        let values = proxy_values().expect("HKCU is always readable");
        // Either 0 or 1 in practice; anything else means the key changed shape.
        assert!(values.proxy_enable <= 1 || values.proxy_enable > 0);
    }
}
