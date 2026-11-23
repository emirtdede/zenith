//! The fifteen IPC commands of `03-04` §3.
//!
//! Each command is a thin adapter: parse and validate the request shape, move
//! the work onto a blocking thread, and translate `ZenithError` into
//! [`IpcError`]. No command contains business logic - that lives in
//! `zenith-core`, where it is tested.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use zenith_core::adapters::candidates::{self, CandidateKind};
use zenith_core::adapters::{privilege, probes, process};
use zenith_core::engine::db::Store;
use zenith_core::engine::executor::{CancelToken, Confirmation};
use zenith_core::engine::{health, pipeline, purge, support};
use zenith_core::error::{ErrorCode, ZenithError};
use zenith_core::manifest;
use zenith_core::models::{
    ActionId, DiagnosticReport, ExecutionOutcome, ExecutionPhase, ReversibilityTier,
    SnapshotRecord, StepStatus, SystemTelemetry, VerifiedPidTarget,
};

use crate::error::{IpcError, IpcResult};
use crate::state::AppState;

/// Serialises diagnoses against each other. Separate from the execution
/// registry because a read-only scan may legally run beside nothing else, but
/// two scans would double the probe load for no benefit.
static DIAGNOSE_RUNNING: AtomicBool = AtomicBool::new(false);

/// Tracks every in-flight `candidates_scan` so `action_cancel { scope: 'scan' }`
/// can tell "the user asked to stop a running scan" from "nothing was running".
///
/// This is a *registry*, not a flag: each run publishes its own token and this
/// guard removes exactly that token on drop (including on a panic inside the
/// task). A single `AtomicBool` could say "something is running" but not *what*,
/// and a single shared token reset per run would let one scan clear another's
/// cancellation - the same defect as the diagnosis-token borrow it replaced.
struct ScanGuard {
    cancels: Arc<Mutex<Vec<Arc<CancelToken>>>>,
    token: Arc<CancelToken>,
}

impl Drop for ScanGuard {
    fn drop(&mut self) {
        let mut running = self.cancels.lock();
        running.retain(|token| !Arc::ptr_eq(token, &self.token));
    }
}

/// Start one scan: create its token, publish it, and hand back the guard that
/// retires it. Pulled out of the command so the registry's behaviour is
/// testable without a Tauri `State`.
fn register_scan(cancels: &Arc<Mutex<Vec<Arc<CancelToken>>>>) -> (Arc<CancelToken>, ScanGuard) {
    let token = Arc::new(CancelToken::new());
    cancels.lock().push(Arc::clone(&token));
    let guard = ScanGuard {
        cancels: Arc::clone(cancels),
        token: Arc::clone(&token),
    };
    (token, guard)
}

/// Stop every scan that is actually running. Returns how many were asked.
fn cancel_all_scans(cancels: &Mutex<Vec<Arc<CancelToken>>>) -> usize {
    let running = cancels.lock();
    // Cloning out of the lock keeps `cancel()` - which runs a kernel-calling
    // hook - off the mutex, so a worker retiring its guard cannot deadlock
    // against a cancellation that is mid-kill.
    let tokens: Vec<Arc<CancelToken>> = running.iter().cloned().collect();
    drop(running);
    for token in &tokens {
        token.cancel();
    }
    tokens.len()
}

/// Clears the diagnosis gate on drop.
///
/// The earlier version cleared the flag *after* the `spawn_blocking` await, so a
/// panic inside the task - or any early `?` - left it `true` forever and every
/// later diagnosis returned `ALREADY_RUNNING` until the process restarted. A
/// guard makes the release impossible to forget.
struct DiagnoseGuard;

impl Drop for DiagnoseGuard {
    fn drop(&mut self) {
        DIAGNOSE_RUNNING.store(false, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------------
// 1. app_info_get
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureInfo {
    pub status: String,
    pub publisher: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub build_commit: String,
    pub tauri_version: String,
    /// `None` when `tauri::webview_version()` failed.
    ///
    /// The old value was the English literal `"unknown"`, which the Trust Center
    /// printed verbatim, so a Turkish UI read "WebView: unknown" (DEF-128).
    pub webview_version: Option<String>,
    /// `None` when the OS version could not be read.
    ///
    /// These two were `u32` and `String`, so `app_info_get` sent `0` and `""`
    /// when `os_info()` failed, and the Trust Center rendered the pair as
    /// `" (0)"` - a version claim invented from a failed read (DEF-127).
    /// `None` serialises as `null`, which the screen renders as an em dash.
    pub os_build: Option<u32>,
    pub os_display_version: Option<String>,
    pub arch: String,
    pub is_elevated: bool,
    pub signature: SignatureInfo,
    pub store_path: String,
    pub store_mode: String,
    pub simulator: bool,
}

#[tauri::command]
pub fn app_info_get(state: State<'_, AppState>) -> IpcResult<AppInfo> {
    let os = state.os.clone();
    Ok(AppInfo {
        version: zenith_core::VERSION.to_string(),
        build_commit: option_env!("ZENITH_BUILD_COMMIT")
            .unwrap_or("dev")
            .to_string(),
        tauri_version: tauri::VERSION.to_string(),
        webview_version: tauri::webview_version().ok(),
        // DEF-127: the OS pair is where the app learns which Windows it is on.
        // Pretending to know when the registry read failed is the one thing this
        // screen must not do, so the `Option` survives all the way to the wire.
        os_build: os.as_ref().map(|info| info.build),
        os_display_version: os.as_ref().map(|info| info.display_version.clone()),
        arch: std::env::consts::ARCH.to_string(),
        is_elevated: privilege::is_elevated(),
        // Authenticode status is measured by the installer and the updater.
        // Reporting "unknown" is the honest answer from a running process that
        // was not itself verified; inventing "valid" would be a false claim.
        signature: SignatureInfo {
            status: "unknown".to_string(),
            publisher: None,
        },
        store_path: state.paths.data.display().to_string(),
        store_mode: if state.paths.degraded {
            "user_fallback".to_string()
        } else {
            "machine".to_string()
        },
        simulator: std::env::var("ZENITH_SIMULATOR").is_ok_and(|value| value == "1"),
    })
}

// ---------------------------------------------------------------------------
// 2. state_get
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionSummary {
    pub snapshots: u64,
    pub snapshot_bytes: u64,
    pub audit_rows: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateSnapshot {
    pub locale: String,
    pub theme: String,
    pub reduce_motion: bool,
    pub telemetry_enabled: bool,
    pub phases: BTreeMap<String, ExecutionPhase>,
    pub active_action_id: Option<ActionId>,
    pub last_scan_at_utc: Option<String>,
    pub telemetry: Option<SystemTelemetry>,
    /// `None` when the store could not be read.
    ///
    /// The type is optional because "I could not measure the store" and "the
    /// store is empty" are different facts, and only one of them is a zero.
    /// The previous shape was a non-optional `RetentionSummary` built with
    /// `list_snapshots(1_000).unwrap_or_default()` and `audit_row_count()
    /// .unwrap_or(0)`, so an unreadable database was reported to the user as
    /// "0 snapshots (0 B), 0 audit rows" - a confident claim about a store
    /// nobody had read. It also left the renderer's `null` branch dead code:
    /// the wire type could never carry `null`, so the `-` path DEF-118 added
    /// was unreachable in production (DEF-123).
    pub retention: Option<RetentionSummary>,
    /// Per-action display preferences (`03-04` §4). Additive field: a client
    /// that predates it simply ignores it.
    pub action_prefs: crate::state::ActionPrefs,
    pub notices: Vec<crate::state::StartupNotice>,
    /// Milliseconds since this process created the store. Additive field; the
    /// UI uses it only for the "session info" line in the Trust Center.
    pub session_uptime_ms: u64,
}

/// The two store reads `read_retention` needs, behind a trait.
///
/// The defect being fixed is only observable when a read *fails*, so the read
/// has to be injectable: a `Store` that is open enough to answer `state_get`
/// will answer these queries too, and a test could never reach the failure
/// path. The trait is private to this module - it exists for the test below,
/// not as an extensibility seam.
trait RetentionSource {
    fn snapshots(&self) -> zenith_core::error::ZenithResult<Vec<SnapshotRecord>>;
    fn audit_rows(&self) -> zenith_core::error::ZenithResult<i64>;
}

impl RetentionSource for Store {
    fn snapshots(&self) -> zenith_core::error::ZenithResult<Vec<SnapshotRecord>> {
        self.list_snapshots(1_000)
    }

    fn audit_rows(&self) -> zenith_core::error::ZenithResult<i64> {
        self.audit_row_count()
    }
}

/// Read the store's retention figures, or `None` if either read failed.
///
/// The two reads are separate queries, so one can fail while the other
/// succeeds. If either fails the whole summary is `None`: a snapshot count with
/// an invented audit-row count is worse than no answer, because the good half
/// makes the bad half look measured.
fn read_retention(source: &impl RetentionSource) -> Option<RetentionSummary> {
    let snapshots = source.snapshots().ok()?;
    let audit_rows = source.audit_rows().ok()?;
    Some(RetentionSummary {
        snapshots: snapshots.len() as u64,
        snapshot_bytes: snapshots.iter().map(|row| row.est_bytes).sum(),
        // `.max(0)` stays: the count is `i64` because SQLite returns one, and a
        // negative count is nonsense rather than a measurement worth showing.
        audit_rows: audit_rows.max(0) as u64,
    })
}

#[tauri::command]
pub fn state_get(state: State<'_, AppState>) -> IpcResult<StateSnapshot> {
    let prefs = state.preferences();

    let mut phases = BTreeMap::new();
    for (action, phase) in state.registry.snapshot() {
        phases.insert(action.as_str().to_string(), phase);
    }

    let retention = read_retention(state.store.as_ref());
    if retention.is_none() {
        // The snapshot is still valid - phases, preferences and telemetry are
        // readable - so this is a warning, not a failed command. But it must be
        // written down: a diagnostics product that cannot read its own store
        // and says nothing about it is the defect this line exists to prevent.
        crate::logging::append(
            &state.paths,
            crate::logging::Level::Warn,
            "state_get: store unreadable; retention reported as unknown",
        );
    }

    let telemetry = state.telemetry.lock().clone();
    let last_scan_at_utc = telemetry
        .as_ref()
        .map(|value| value.measured_at_utc.clone());

    Ok(StateSnapshot {
        locale: prefs.locale,
        theme: prefs.theme,
        reduce_motion: prefs.reduce_motion,
        telemetry_enabled: prefs.telemetry_enabled,
        phases,
        active_action_id: state.registry.active(),
        last_scan_at_utc,
        telemetry,
        retention,
        action_prefs: prefs.action_prefs,
        notices: state.notices.clone(),
        session_uptime_ms: state.started_at.elapsed().as_millis() as u64,
    })
}

// ---------------------------------------------------------------------------
// 2b. preferences_set
// ---------------------------------------------------------------------------

/// Partial update. Every field is optional so the renderer can send only the
/// thing the user changed; a missing field keeps its stored value rather than
/// resetting to the default.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PreferencesPatch {
    pub locale: Option<String>,
    pub theme: Option<String>,
    pub reduce_motion: Option<bool>,
    pub telemetry_enabled: Option<bool>,
}

const THEMES: [&str; 3] = ["off-white", "true-black", "spatial-glass"];

#[tauri::command]
pub fn preferences_set(
    state: State<'_, AppState>,
    patch: PreferencesPatch,
) -> IpcResult<StateSnapshot> {
    let mut next = state.preferences();

    if let Some(locale) = patch.locale {
        // Only a locale the build actually ships may be stored: persisting
        // `de-DE` would silently fall back to English on every launch while
        // telling the user their choice was saved.
        if !zenith_core::i18n::SUPPORTED_LOCALES.contains(&locale.as_str()) {
            return Err(IpcError::new(ErrorCode::InvalidArgument).with_field("locale", &locale));
        }
        next.locale = locale;
    }
    if let Some(theme) = patch.theme {
        if !THEMES.contains(&theme.as_str()) {
            return Err(IpcError::new(ErrorCode::InvalidArgument).with_field("theme", &theme));
        }
        next.theme = theme;
    }
    if let Some(reduce_motion) = patch.reduce_motion {
        next.reduce_motion = reduce_motion;
    }
    if let Some(telemetry_enabled) = patch.telemetry_enabled {
        next.telemetry_enabled = telemetry_enabled;
    }

    state.save_preferences(next)?;
    state_get(state)
}

// ---------------------------------------------------------------------------
// 2c. action_prefs_set
// ---------------------------------------------------------------------------

/// Replace the per-action presentation preferences.
///
/// The request is the complete set, not a patch: pinning and hiding are small
/// lists whose order is meaningful, and a merge protocol for them would need a
/// conflict rule nobody asked for. Unknown ids are rejected at deserialization
/// (`ActionId` is a closed enum); duplicates are collapsed in caller order; an
/// id that is both pinned and hidden is `INVALID_ARGUMENT` rather than a silent
/// choice.
#[tauri::command]
pub fn action_prefs_set(
    state: State<'_, AppState>,
    prefs: crate::state::ActionPrefs,
) -> IpcResult<crate::state::ActionPrefs> {
    let next = state.preferences().with_action_prefs(prefs)?;
    let stored = next.action_prefs.clone();
    state.save_preferences(next)?;
    Ok(stored)
}

// ---------------------------------------------------------------------------
// 3. diagnose_run
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DiagnoseRequest {
    pub action_ids: Option<Vec<ActionId>>,
    pub include_slow: Option<bool>,
}

#[tauri::command]
pub async fn diagnose_run(
    app: AppHandle,
    state: State<'_, AppState>,
    request: Option<DiagnoseRequest>,
) -> IpcResult<Vec<DiagnosticReport>> {
    let request = request.unwrap_or_default();
    let selection: Vec<ActionId> = match request.action_ids {
        Some(ids) if !ids.is_empty() => ids,
        _ => manifest::ACTIONS.iter().map(|def| def.id).collect(),
    };
    // Reject unknown ids before spawning: the enum parse already failed in
    // deserialization, but an empty list is a caller bug worth naming.
    for id in &selection {
        if manifest::action_by_id(*id).id != *id {
            return Err(
                IpcError::new(ErrorCode::InvalidArgument).with_field("actionIds", "unknown")
            );
        }
    }

    if DIAGNOSE_RUNNING.swap(true, Ordering::SeqCst) {
        return Err(IpcError::new(ErrorCode::AlreadyRunning));
    }
    // From here on every exit path - success, cancellation, panic, or an early
    // `?` - releases the gate, because the guard is dropped with the future.
    let _guard = DiagnoseGuard;

    // A slow probe (DISM's component-store check) is excluded when the caller
    // asked for a fast pass. `includeSlow` defaults to `true` per 03-04 §5.3,
    // so only an explicit `false` narrows the set.
    let include_slow = request.include_slow.unwrap_or(true);
    let selection: Vec<ActionId> = if include_slow {
        selection
    } else {
        selection
            .into_iter()
            .filter(|action| {
                manifest::action_by_id(*action).diagnose_budget_ms
                    <= manifest::FAST_DIAGNOSE_BUDGET_MS
            })
            .collect()
    };

    let cancel = Arc::clone(&state.diagnose_cancel);
    cancel.reset();
    let paths = state.paths.clone();
    let telemetry_slot = Arc::clone(&state.telemetry);
    // The 30 s refresh (`telemetry.rs`) re-derives the header from the last
    // real reports. Without storing them it would have nothing to score and the
    // promised periodic update would never fire.
    let reports_slot = Arc::clone(&state.last_reports);
    let total = selection.len();
    let app_for_task = app.clone();
    let registry = Arc::clone(&state.registry);
    // The registry is what `state_get` reads, and the closure takes ownership of
    // `selection` and `paths`. Keep copies so the failure path can still retire
    // every card and log a refused transition.
    let selection_for_registry: Vec<ActionId> = selection.clone();
    let paths_for_registry = paths.clone();

    // `state_get` answers from the registry, so a phase that is only emitted
    // disappears at the next `state/replaced`. Every transition goes through
    // `apply_phase`, which records first and then emits.
    for action in &selection {
        apply_phase(
            &app,
            &registry,
            &paths_for_registry,
            *action,
            ExecutionPhase::Diagnosing,
        );
    }

    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let ctx = probes::ProbeContext {
            paths,
            cancel: Arc::clone(&cancel),
            dns_probe_hosts: vec![("www.msftconnecttest.com", 443), ("one.one.one.one", 443)],
        };

        let mut reports = Vec::with_capacity(total);
        for (index, action) in selection.iter().enumerate() {
            if cancel.is_cancelled() {
                return Err(ZenithError::new(ErrorCode::Cancelled));
            }
            let report = match probes::probe(*action, &ctx) {
                Ok(report) => report,
                Err(err) => probes::unavailable(*action, &err),
            };
            reports.push(report);
            emit(
                &app_for_task,
                "diagnose_progress",
                serde_json::json!({
                    "v": 1,
                    "completed": index + 1,
                    "total": total,
                    "actionId": action.as_str(),
                }),
            );
        }

        // Memory and OS build are measured after the probes, so the telemetry
        // header always describes the same instant as the report list.
        let memory = zenith_core::adapters::system::memory().ok();
        let os_build = zenith_core::adapters::system::os_info()
            .map(|info| info.build)
            .unwrap_or(0);
        let telemetry = health::build_telemetry(
            &reports,
            memory.as_ref().map(|info| (info.used_mb(), info.total_mb)),
            os_build,
        );
        emit(
            &app_for_task,
            "telemetry_update",
            serde_json::json!({ "v": 1, "telemetry": telemetry }),
        );
        *telemetry_slot.lock() = Some(telemetry);
        // Keep the reports so the 30 s refresh can re-derive the header from a
        // real measurement instead of publishing a guess (`telemetry.rs`).
        *reports_slot.lock() = reports.clone();
        Ok(reports)
    })
    .await
    .map_err(|_| IpcError::internal("diagnose task panicked"))?;

    // Terminal phases are recorded per action, from the reports that were
    // actually produced. A cancelled or failed pass still leaves every card in
    // a terminal state rather than stranded on `diagnosing`.
    match &outcome {
        Ok(reports) => {
            for report in reports {
                let phase = if report.needs_attention {
                    ExecutionPhase::NeedsAttention
                } else {
                    ExecutionPhase::Healthy
                };
                apply_phase(
                    &app,
                    &registry,
                    &paths_for_registry,
                    report.action_id,
                    phase,
                );
            }
            // A diagnosis is the product's *read-only* core operation, and it has
            // to leave a durable trace. The support bundle (`04-02` §5) carries
            // `audit.json`, `snapshots.json`, `environment.json` and the logs -
            // no diagnostic reports - so before this line a bundle filed after a
            // diagnosis recorded nothing at all about what the diagnosis found.
            // A repair left an audit row; merely looking left silence.
            let needing_attention = reports.iter().filter(|r| r.needs_attention).count();
            crate::logging::append(
                &state.paths,
                crate::logging::Level::Info,
                &format!(
                    "diagnosis {} probes, {} need attention",
                    reports.len(),
                    needing_attention
                ),
            );
        }
        Err(err) => {
            let phase = if err.is(ErrorCode::Cancelled) {
                ExecutionPhase::Cancelled
            } else {
                ExecutionPhase::Error
            };
            for action in &selection_for_registry {
                apply_phase(&app, &registry, &paths_for_registry, *action, phase);
            }
            // Both terminal failures are facts a bundle must show. The latency
            // comes from the token, so REQ-F-052 is auditable from a shipped
            // bundle rather than only from a test (DEF-102, DEF-105).
            if err.is(ErrorCode::Cancelled) {
                let latency = state
                    .diagnose_cancel
                    .latency_ms()
                    .map(|ms| format!(" after {ms} ms"))
                    .unwrap_or_default();
                crate::logging::append(
                    &state.paths,
                    crate::logging::Level::Info,
                    &format!("diagnosis cancelled{latency}"),
                );
            } else {
                crate::logging::append(
                    &state.paths,
                    crate::logging::Level::Error,
                    &format!("diagnosis failed: {}", err.code.as_str()),
                );
            }
        }
    }

    outcome.map_err(IpcError::from)
}

// ---------------------------------------------------------------------------
// 4. action_execute
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmationDto {
    pub acknowledged_tier: ReversibilityTier,
    #[serde(default)]
    pub typed_count: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ExecuteOptions {
    pub targets: Option<Vec<VerifiedPidTarget>>,
    pub ports: Option<Vec<u16>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteRequest {
    pub action_id: ActionId,
    #[serde(default)]
    pub confirmation: Option<ConfirmationDto>,
    #[serde(default)]
    pub options: Option<ExecuteOptions>,
}

#[tauri::command]
pub async fn action_execute(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ExecuteRequest,
) -> IpcResult<ExecutionOutcome> {
    let action = request.action_id;
    let def = manifest::action_by_id(action);
    let elevated = privilege::is_elevated();

    // Shape validation happens before the registry is touched, so a malformed
    // request never blocks the machine mutex.
    if let Some(ports) = request
        .options
        .as_ref()
        .and_then(|options| options.ports.as_ref())
    {
        if ports.contains(&0) {
            return Err(
                IpcError::new(ErrorCode::InvalidArgument).with_field("ports", "zero is not a port")
            );
        }
        if def.scope != zenith_core::manifest::ActionScope::None
            && !matches!(action, ActionId::UnlockDevPorts)
        {
            return Err(IpcError::new(ErrorCode::InvalidArgument)
                .with_field("ports", "this action does not accept a port range"));
        }
    }

    let targets = request
        .options
        .and_then(|options| options.targets)
        .unwrap_or_default();

    // `typedCount` is the renderer's typed-confirmation affordance. It is
    // optional by contract, but a caller that sends zero is contradicting
    // itself: it claims the user confirmed while reporting nothing typed.
    // Checked before the registry is touched so a rejected request cannot
    // leave the machine mutex held.
    if request
        .confirmation
        .as_ref()
        .and_then(|field| field.typed_count)
        == Some(0)
    {
        return Err(IpcError::new(ErrorCode::ConfirmationRequired).with_field("typedCount", "zero"));
    }
    let confirmation = request.confirmation.map(|value| Confirmation {
        acknowledged_tier: value.acknowledged_tier,
    });

    // Machine mutex: one mutation at a time, process-wide.
    state.registry.begin(action).map_err(IpcError::from)?;

    apply_phase(
        &app,
        &state.registry,
        &state.paths,
        action,
        ExecutionPhase::Running,
    );

    let cancel = Arc::clone(&state.cancel);
    cancel.reset();
    let store = Arc::clone(&state.store);
    let paths = state.paths.clone();
    let roots = state.roots.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        let ctx = pipeline::RunContext::new(&store, paths, roots, elevated, Arc::clone(&cancel));
        pipeline::run(&ctx, action, confirmation, targets)
    })
    .await
    .map_err(|_| IpcError::internal("execution task panicked"));

    state.registry.finish();

    let outcome = match result {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(err)) => {
            let phase = match err.code {
                ErrorCode::Cancelled => ExecutionPhase::Cancelled,
                _ => ExecutionPhase::Error,
            };
            apply_phase(&app, &state.registry, &state.paths, action, phase);
            // Persist the failure, not just the event. The in-memory console
            // stream is lost when the window closes; the log is what a support
            // bundle carries (`04-02` §5, D6).
            if err.code == ErrorCode::Cancelled {
                // A cancel is not an error, but it *is* an event a support
                // bundle must be able to see: "the user pressed Stop" and "the
                // app died" otherwise look identical from the log alone. The
                // measured latency is recorded too, so REQ-F-052 can be checked
                // from a real machine's bundle instead of only from a test.
                let latency = state
                    .cancel
                    .latency_ms()
                    .map(|ms| format!(" after {ms} ms"))
                    .unwrap_or_default();
                crate::logging::append(
                    &state.paths,
                    crate::logging::Level::Info,
                    &format!("action {} cancelled{latency}", action.as_str()),
                );
            } else {
                crate::logging::append(
                    &state.paths,
                    crate::logging::Level::Error,
                    &format!("action {} failed: {}", action.as_str(), err.code.as_str()),
                );
            }
            return Err(IpcError::from(err));
        }
        Err(err) => {
            apply_phase(
                &app,
                &state.registry,
                &state.paths,
                action,
                ExecutionPhase::Error,
            );
            crate::logging::append(
                &state.paths,
                crate::logging::Level::Error,
                &format!("action {} task error: {}", action.as_str(), err.code),
            );
            return Err(err);
        }
    };

    // One batch of genuine step records, capped by the contract at twenty
    // lines. These are facts from the run, not synthesised narration.
    let lines: Vec<serde_json::Value> = outcome
        .steps
        .iter()
        .take(20)
        .enumerate()
        .map(|(index, step)| {
            serde_json::json!({
                "seq": index + 1,
                "atUtc": zenith_core::engine::audit::now_utc(),
                "level": if step.status == StepStatus::Error { "error" } else { "info" },
                // Support-facing fallback only: `stepKey` is what the renderer
                // localizes. `as_str()` instead of `{:?}` keeps a Debug
                // rendering (an internal representation) out of the payload -
                // DEF-088, where the console showed `steps.dnsFlush: Success`.
                "text": format!("{}: {}", step.step_key, step.status.as_str()),
                "stepKey": step.step_key,
            })
        })
        .collect();
    if !lines.is_empty() {
        emit(
            &app,
            "terminal_log",
            serde_json::json!({ "v": 1, "actionId": action.as_str(), "lines": lines }),
        );
    }

    // Put the same facts on disk, not only on the socket.
    //
    // `03-04` §6 promised that a closed window loses nothing. It did: `emit` is
    // best-effort by design, and the failure paths were the only ones writing to
    // the log - so a *successful* action's step trace existed exactly as long as
    // a listener did, and a support bundle opened afterwards carried no record of
    // what ran. The rotating log is the artefact a bundle ships (`04-02` §5), so
    // the trace goes there too, bounded to the same twenty lines the event
    // carries and redacted by the same writer as every other line.
    let step_lines: Vec<crate::logging::StepLine<'_>> = outcome
        .steps
        .iter()
        .take(20)
        .map(|step| crate::logging::StepLine {
            key: &step.step_key,
            status: step.status.as_str(),
            is_error: step.status == StepStatus::Error,
        })
        .collect();
    crate::logging::append_steps(&state.paths, action.as_str(), &step_lines, 20);

    apply_phase(&app, &state.registry, &state.paths, action, outcome.phase);
    if outcome.snapshot_id.is_some() {
        emit(
            &app,
            "snapshot_changed",
            serde_json::json!({
                "v": 1,
                "snapshotId": outcome.snapshot_id,
                "kind": "created",
            }),
        );
    }

    Ok(outcome)
}

// ---------------------------------------------------------------------------
// 5. action_cancel
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelResult {
    pub cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[tauri::command]
pub fn action_cancel(state: State<'_, AppState>, scope: String) -> IpcResult<CancelResult> {
    if scope == "diagnose" {
        if !DIAGNOSE_RUNNING.load(Ordering::SeqCst) {
            return Ok(CancelResult {
                cancelled: false,
                reason: Some("nothing_running".into()),
            });
        }
        state.diagnose_cancel.cancel();
        return Ok(CancelResult {
            cancelled: true,
            reason: None,
        });
    }

    // A scan honours its token between printers and between jobs, so this is
    // where a slow spooler stops holding the dialog hostage. The scope only
    // exists because `candidates_scan` now owns tokens of its own; before that it
    // borrowed the diagnosis token and there was nothing to name here.
    if scope == "scan" {
        if cancel_all_scans(&state.scan_cancels) == 0 {
            return Ok(CancelResult {
                cancelled: false,
                reason: Some("nothing_running".into()),
            });
        }
        return Ok(CancelResult {
            cancelled: true,
            reason: None,
        });
    }

    let action = ActionId::parse(&scope).ok_or_else(|| {
        IpcError::new(ErrorCode::InvalidArgument).with_field("scope", "unknown action")
    })?;

    match state.registry.active() {
        Some(active) if active == action => {
            state.cancel.cancel();
            Ok(CancelResult {
                cancelled: true,
                reason: None,
            })
        }
        Some(active) => Ok(CancelResult {
            cancelled: false,
            reason: Some(format!("running:{}", active.as_str())),
        }),
        None => Ok(CancelResult {
            cancelled: false,
            reason: Some("nothing_running".into()),
        }),
    }
}

// ---------------------------------------------------------------------------
// 6. snapshot_list
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn snapshot_list(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> IpcResult<Vec<SnapshotRecord>> {
    let limit = limit.unwrap_or(100).clamp(1, 1_000);
    state.store.list_snapshots(limit).map_err(IpcError::from)
}

// ---------------------------------------------------------------------------
// 7. snapshot_rollback
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackOutcomeDto {
    pub snapshot_id: String,
    pub success: bool,
    pub restored_items: u64,
    pub skipped_items: u64,
    pub skipped_reasons: Vec<SkippedReason>,
    pub duration_ms: u64,
    pub correlation_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedReason {
    pub item_key: String,
    pub reason_code: String,
}

#[tauri::command]
pub async fn snapshot_rollback(
    app: AppHandle,
    state: State<'_, AppState>,
    snapshot_id: String,
) -> IpcResult<RollbackOutcomeDto> {
    if state.registry.active().is_some() {
        return Err(IpcError::new(ErrorCode::AlreadyRunning));
    }

    let store = Arc::clone(&state.store);
    let roots = state.roots.clone();
    let elevated = privilege::is_elevated();
    let app_for_task = app.clone();
    let id_for_event = snapshot_id.clone();

    // The rollback transition is documented as `Success -> Running ->
    // RolledBack` (03-01 §6.1), so the owning action has to be known before the
    // work starts. A missing row is an error the pipeline would raise anyway,
    // but reading it here means the phase is recorded against a real action
    // rather than guessed at.
    let owner = state
        .store
        .get_snapshot(&snapshot_id)
        .map_err(IpcError::from)?
        .and_then(|row| ActionId::parse(&row.action_id))
        .ok_or_else(|| {
            IpcError::new(ErrorCode::SnapshotNotFound).with_field("snapshotId", &snapshot_id)
        })?;

    apply_phase(
        &app,
        &state.registry,
        &state.paths,
        owner,
        ExecutionPhase::Running,
    );

    let result = tauri::async_runtime::spawn_blocking(move || {
        pipeline::rollback(&store, &roots, &snapshot_id, elevated)
    })
    .await
    .map_err(|_| IpcError::internal("rollback task panicked"));

    let outcome = match result {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(err)) => {
            // The card must not stay on `running` because the restore was
            // refused: the phase is part of the answer, not decoration.
            apply_phase(
                &app_for_task,
                &state.registry,
                &state.paths,
                owner,
                ExecutionPhase::Error,
            );
            crate::logging::append(
                &state.paths,
                crate::logging::Level::Error,
                &format!("rollback {} failed: {}", id_for_event, err.code.as_str()),
            );
            return Err(IpcError::from(err));
        }
        Err(err) => {
            apply_phase(
                &app_for_task,
                &state.registry,
                &state.paths,
                owner,
                ExecutionPhase::Error,
            );
            return Err(err);
        }
    };

    // A partial restore is not a rollback: the row stays rollback-able and the
    // card keeps showing where it actually is.
    if outcome.success {
        apply_phase(
            &app_for_task,
            &state.registry,
            &state.paths,
            owner,
            ExecutionPhase::RolledBack,
        );
    } else {
        apply_phase(
            &app_for_task,
            &state.registry,
            &state.paths,
            owner,
            ExecutionPhase::Error,
        );
    }

    emit(
        &app_for_task,
        "snapshot_changed",
        serde_json::json!({
            "v": 1,
            "snapshotId": id_for_event,
            "kind": if outcome.success { "restored" } else { "broken" },
        }),
    );

    Ok(RollbackOutcomeDto {
        snapshot_id: outcome.snapshot_id,
        success: outcome.success,
        restored_items: outcome.restored_items,
        skipped_items: outcome.skipped_items,
        skipped_reasons: outcome
            .skipped_reasons
            .into_iter()
            .map(|(item_key, reason_code)| SkippedReason {
                item_key,
                reason_code,
            })
            .collect(),
        duration_ms: outcome.duration_ms,
        correlation_id: outcome.correlation_id,
    })
}

// ---------------------------------------------------------------------------
// 8. candidates_scan
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn candidates_scan(
    state: State<'_, AppState>,
    kind: String,
) -> IpcResult<candidates::Candidates> {
    let kind = CandidateKind::parse(&kind)
        .ok_or_else(|| IpcError::new(ErrorCode::InvalidArgument).with_field("kind", "unknown"))?;
    // One fresh token per run. It used to borrow `diagnose_cancel`, so starting a
    // scan ran `reset()` on the diagnosis token: a stop the user had just
    // requested was withdrawn, and one core operation could cancel another's
    // intent without either side being able to observe it (DEF-108).
    //
    // The guard is held across the await, so `action_cancel { scope: 'scan' }`
    // can never report success for a scan that has already ended, nor leave a
    // token behind for one that panicked.
    let (cancel, _guard) = register_scan(&state.scan_cancels);
    tauri::async_runtime::spawn_blocking(move || candidates::scan(kind, &cancel))
        .await
        .map_err(|_| IpcError::internal("candidate scan panicked"))?
        .map_err(IpcError::from)
}

// ---------------------------------------------------------------------------
// 9. process_terminate
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminateRequest {
    pub action_id: ActionId,
    pub targets: Vec<VerifiedPidTarget>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminateResultRow {
    pub pid: u32,
    pub outcome: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminateSummaryDto {
    pub requested: u64,
    pub terminated: u64,
    pub results: Vec<TerminateResultRow>,
    pub correlation_id: String,
}

#[tauri::command]
pub fn process_terminate(request: TerminateRequest) -> IpcResult<TerminateSummaryDto> {
    if !matches!(
        request.action_id,
        ActionId::UnlockDevPorts | ActionId::CloseHungOffice
    ) {
        return Err(IpcError::new(ErrorCode::InvalidArgument)
            .with_field("actionId", "not a selection action"));
    }
    if request.targets.is_empty() {
        return Err(IpcError::new(ErrorCode::InvalidArgument).with_field("targets", "empty"));
    }
    for target in &request.targets {
        if target.expected_name.trim().is_empty() || target.expected_start_time_unix_ms == 0 {
            return Err(IpcError::new(ErrorCode::InvalidArgument)
                .with_field("targets", "identity triple incomplete"));
        }
    }

    let summary = process::terminate_all(&request.targets);
    Ok(TerminateSummaryDto {
        requested: request.targets.len() as u64,
        terminated: summary.terminated() as u64,
        results: summary
            .results
            .into_iter()
            .map(|(pid, outcome)| TerminateResultRow {
                pid,
                outcome: outcome.as_str().to_string(),
            })
            .collect(),
        correlation_id: zenith_core::engine::audit::new_correlation_id(),
    })
}

// ---------------------------------------------------------------------------
// 10. file_save_text
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTextRequest {
    pub suggested_name: String,
    pub content: String,
    pub format: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFile {
    pub path: Option<String>,
    pub bytes: u64,
}

const MAX_SAVE_BYTES: usize = 2 * 1024 * 1024;

#[tauri::command]
pub async fn file_save_text(app: AppHandle, request: SaveTextRequest) -> IpcResult<SavedFile> {
    let extension = match request.format.as_str() {
        "ps1" => ("PowerShell script", "ps1"),
        "bat" => ("Batch file", "bat"),
        "csv" => ("CSV", "csv"),
        "json" => ("JSON", "json"),
        other => return Err(IpcError::new(ErrorCode::InvalidArgument).with_field("format", other)),
    };
    if request.content.len() > MAX_SAVE_BYTES {
        return Err(IpcError::new(ErrorCode::InvalidArgument).with_field("content", "exceeds 2 MB"));
    }
    // The suggested name is a hint, never a path: strip separators so a caller
    // cannot preselect a directory.
    let suggested = request
        .suggested_name
        .replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_");
    let suggested = if suggested.trim().is_empty() {
        format!("zenith.{}", extension.1)
    } else {
        suggested
    };

    let handle = app.clone();
    let content = request.content;
    let path = tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        handle
            .dialog()
            .file()
            .set_file_name(&suggested)
            .add_filter(extension.0, &[extension.1])
            .blocking_save_file()
    })
    .await
    .map_err(|_| IpcError::internal("save dialog panicked"))?;

    let Some(path) = path else {
        // Cancelling a dialog is not an error (03-04 §5.10).
        return Ok(SavedFile {
            path: None,
            bytes: 0,
        });
    };
    let path = path
        .into_path()
        .map_err(|_| IpcError::internal("dialog returned a non-file path"))?;
    std::fs::write(&path, content.as_bytes())?;
    Ok(SavedFile {
        path: Some(path.display().to_string()),
        bytes: content.len() as u64,
    })
}

// ---------------------------------------------------------------------------
// 11. support_bundle_create
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn support_bundle_create(
    state: State<'_, AppState>,
    note: Option<String>,
) -> IpcResult<support::SupportBundle> {
    let store = Arc::clone(&state.store);
    let paths = state.paths.clone();
    let elevated = privilege::is_elevated();
    let note = note.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || support::create(&store, &paths, elevated, &note))
        .await
        .map_err(|_| IpcError::internal("support bundle task panicked"))?
        .map_err(IpcError::from)
}

// ---------------------------------------------------------------------------
// 12. app_data_purge
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeRequest {
    pub scope: String,
    pub confirm_token: String,
    #[serde(default)]
    pub force: bool,
}

#[tauri::command]
pub async fn app_data_purge(
    state: State<'_, AppState>,
    request: PurgeRequest,
) -> IpcResult<purge::PurgeSummary> {
    let scope = purge::PurgeScope::parse(&request.scope)
        .ok_or_else(|| IpcError::new(ErrorCode::InvalidArgument).with_field("scope", "unknown"))?;
    let store = Arc::clone(&state.store);
    let paths = state.paths.clone();
    tauri::async_runtime::spawn_blocking(move || {
        purge::purge(&store, &paths, scope, &request.confirm_token, request.force)
    })
    .await
    .map_err(|_| IpcError::internal("purge task panicked"))?
    .map_err(IpcError::from)
}

// ---------------------------------------------------------------------------
// 13. elevation_handover
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoverRequest {
    pub resume_queue: Vec<ActionId>,
    pub next_theme: String,
    pub locale: String,
}

#[tauri::command]
pub async fn elevation_handover(
    app: AppHandle,
    state: State<'_, AppState>,
    request: HandoverRequest,
) -> IpcResult<()> {
    if privilege::is_elevated() {
        return Err(
            IpcError::new(ErrorCode::InvalidArgument).with_field("reason", "already elevated")
        );
    }
    let queue: Vec<String> = request
        .resume_queue
        .iter()
        .map(|action| action.as_str().to_string())
        .collect();
    let paths = state.paths.clone();
    // DEF-149: this used to be `let _ = state.save_preferences(..)`. The
    // elevated instance reads theme and locale from `preferences.json`, so a
    // failed write meant the user cleared a UAC prompt and the new window came
    // up in the previous theme and language with no message - a silent reset
    // the user could only fix by finding the setting again. Refusing the
    // handover before the ticket is written is the honest failure: nothing has
    // been elevated yet, so the error lands on the window they are looking at.
    state.save_preferences(crate::state::Preferences {
        locale: request.locale,
        theme: request.next_theme,
        ..state.preferences()
    })?;

    let app_for_task = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::handover::launch(&paths, &queue)?;
        // The elevated instance owns the session now. Exiting here is the
        // documented behaviour: the handover never resolves successfully in the
        // original process, it ends it.
        app_for_task.exit(0);
        Ok::<(), ZenithError>(())
    })
    .await
    .map_err(|_| IpcError::internal("handover task panicked"))?
    .map_err(IpcError::from)?;

    // Unreachable in practice; the app is already exiting.
    Ok(())
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn emit(app: &AppHandle, event: &str, payload: serde_json::Value) {
    // A closed window is not a failure: events are best-effort by contract.
    let _ = app.emit(event, payload);
}

/// Record a phase in the registry, then tell the renderer.
///
/// The registry is what `state_get` answers from, so emitting without recording
/// produces a phase that the card shows until the next `state/replaced` and then
/// silently loses. An illegal transition is a bug in the caller, not in the
/// user's request: it is logged and the state machine keeps its current value
/// rather than being forced into an impossible state.
fn apply_phase(
    app: &AppHandle,
    registry: &zenith_core::engine::executor::ExecutionRegistry,
    paths: &zenith_core::config::Paths,
    action: ActionId,
    phase: ExecutionPhase,
) {
    if let Err(err) = registry.set_phase(action, phase) {
        crate::logging::append(
            paths,
            crate::logging::Level::Warn,
            &format!(
                "phase transition {} -> {:?} refused: {}",
                action.as_str(),
                phase,
                err.code.as_str()
            ),
        );
        return;
    }
    emit(
        app,
        "phase_changed",
        serde_json::json!({
            "v": 1,
            "actionId": action.as_str(),
            "phase": phase,
            "atUtc": zenith_core::engine::audit::now_utc(),
        }),
    );
}

/// Convenience so command bodies read as one expression.
trait WithField: Sized {
    fn with_field(self, field: &str, reason: &str) -> Self;
}

impl WithField for IpcError {
    fn with_field(mut self, field: &str, reason: &str) -> Self {
        self.params.insert("field".into(), field.into());
        self.params.insert("reason".into(), reason.into());
        self
    }
}

/// Guards DEF-108: a scan owns one token per run, in a registry.
///
/// These tests exist because the defect was a *sharing* bug, and a sharing bug
/// is invisible to a test that only checks "cancel works". The second test is the
/// one that would fail against every simpler design: a single shared token, a
/// single slot, or the original borrow of `diagnose_cancel`.
#[cfg(test)]
mod scan_registry_tests {
    use super::*;

    fn empty() -> Arc<Mutex<Vec<Arc<CancelToken>>>> {
        Arc::new(Mutex::new(Vec::new()))
    }

    #[test]
    fn a_running_scan_is_stoppable_and_an_idle_one_is_not() {
        let cancels = empty();
        let (token, guard) = register_scan(&cancels);
        assert_eq!(cancels.lock().len(), 1, "the run must be published");
        assert!(!token.is_cancelled());

        assert_eq!(cancel_all_scans(&cancels), 1, "a stop reaches the live run");
        assert!(
            token.is_cancelled(),
            "the token the worker holds is stopped"
        );

        // The guard is what makes "is a scan running?" answerable: once the run
        // ends, `action_cancel` must report `nothing_running` rather than claim
        // it stopped something.
        drop(guard);
        assert!(cancels.lock().is_empty(), "the run must retire its token");
        assert_eq!(cancel_all_scans(&cancels), 0);
    }

    #[test]
    fn a_second_scan_cannot_clear_or_strand_the_first() {
        let cancels = empty();
        let (first, first_guard) = register_scan(&cancels);
        let (second, second_guard) = register_scan(&cancels);
        assert_eq!(cancels.lock().len(), 2, "two runs, two tokens");

        // Retiring the older run must not touch the newer one, and must not
        // leave a dangling token that a later stop would call "running".
        drop(first_guard);
        assert_eq!(cancels.lock().len(), 1);
        assert!(
            !second.is_cancelled(),
            "starting/ending one run is not a stop"
        );

        // The survivor is still reachable - this is what a single slot would
        // lose, and what one shared token reset per run would corrupt.
        assert_eq!(cancel_all_scans(&cancels), 1);
        assert!(second.is_cancelled());
        assert!(
            !first.is_cancelled(),
            "a retired run must not be marked cancelled by a later stop"
        );

        drop(second_guard);
        assert!(cancels.lock().is_empty());
    }

    #[test]
    fn a_stop_reaches_every_scan_that_is_actually_running() {
        let cancels = empty();
        let (a, _ga) = register_scan(&cancels);
        let (b, _gb) = register_scan(&cancels);
        let (c, _gc) = register_scan(&cancels);
        assert_eq!(cancel_all_scans(&cancels), 3);
        for token in [&a, &b, &c] {
            assert!(token.is_cancelled(), "a stop is not a lottery");
        }
    }

    /// The defect stated as an assertion: `candidates_scan` must not borrow the
    /// diagnosis token.
    ///
    /// A behavioural test cannot catch this. `diagnose_cancel` and the scan
    /// registry are independent objects, so any test that creates its own tokens
    /// passes no matter how the command is wired - a no-op test is worse than no
    /// test because it certifies the bug. The fact lives in the wiring, so the
    /// guard reads the wiring: the command must build its token through
    /// `register_scan`, and its **code** must not mention the diagnosis token.
    ///
    /// Comments are stripped before the check. The first version of this test
    /// read the raw text, and the explanatory comment naming the retired field
    /// made it fail - a test that cannot tell prose from code measures the wrong
    /// thing, and would equally have failed to notice a real borrow hidden
    /// behind a comment that mentioned the registry.
    #[test]
    fn candidates_scan_does_not_borrow_the_diagnosis_token() {
        let source = include_str!("commands.rs");
        let body = source
            .split("pub async fn candidates_scan(")
            .nth(1)
            .expect("candidates_scan must exist");
        // Up to the next top-level item, so this cannot be satisfied by code far
        // below in the file.
        let body = body.split("\n// ----").next().unwrap_or(body);
        // Strip `//` comments (the file uses no block comments) so only
        // executable lines are inspected.
        let code: String = body
            .lines()
            .map(|line| match line.find("//") {
                Some(index) => &line[..index],
                None => line,
            })
            .collect::<Vec<_>>()
            .join("\n");

        assert!(
            code.contains("register_scan(&state.scan_cancels)"),
            "the scan must publish its own token through the registry"
        );
        assert!(
            !code.contains("diagnose_cancel"),
            "borrowing the diagnosis token is DEF-108: a stop the user just \
             requested is silently withdrawn by `reset()`"
        );
        // And the old reset must not come back in any form.
        assert!(
            !code.contains(".reset()"),
            "a per-run token is fresh; resetting one is the sharing bug again"
        );
    }

    /// Two runs published at once are two tokens, not one shared object. This is
    /// the property a single long-lived scan token would violate.
    #[test]
    fn concurrent_scans_get_distinct_tokens() {
        let cancels = empty();
        let (first, _g1) = register_scan(&cancels);
        let (second, _g2) = register_scan(&cancels);
        assert!(
            !Arc::ptr_eq(&first, &second),
            "two runs must never share one token, or one stops the other"
        );
        assert_eq!(cancels.lock().len(), 2);
    }
}

/// `read_retention` is where "not measured" used to become "zero" (DEF-123).
///
/// The bug was invisible while both reads succeeded: a healthy store and an
/// unreadable store both produced a struct. These tests hold each read open as
/// a failure and assert the answer is `None`, because the only alternative the
/// old code offered was a confident `0`.
#[cfg(test)]
mod retention_tests {
    use super::*;
    use zenith_core::error::{ErrorCode, ZenithError, ZenithResult};

    /// A store stand-in where each read can be made to fail independently.
    struct Fake {
        snapshots: ZenithResult<Vec<SnapshotRecord>>,
        audit_rows: ZenithResult<i64>,
    }

    fn failing<T>(what: &str) -> ZenithResult<T> {
        Err(ZenithError::new(ErrorCode::Internal).with("reason", what))
    }

    impl RetentionSource for Fake {
        fn snapshots(&self) -> ZenithResult<Vec<SnapshotRecord>> {
            match &self.snapshots {
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
    }

    fn record(bytes: u64) -> SnapshotRecord {
        SnapshotRecord {
            snapshot_id: "snap-1".into(),
            action_id: ActionId::EmptyRecycleBin,
            created_at_utc: "2026-11-22T00:00:00Z".into(),
            tier: ReversibilityTier::PartiallyReversible,
            snapshot_type: "registry".into(),
            is_restored: false,
            restored_at_utc: None,
            est_bytes: bytes,
            status: zenith_core::models::SnapshotStatus::Committed,
            summary_key: "snapshots.summary.registry".into(),
            summary_params: BTreeMap::new(),
        }
    }

    #[test]
    fn a_readable_store_reports_its_real_figures() {
        let fake = Fake {
            snapshots: Ok(vec![record(100), record(250)]),
            audit_rows: Ok(37),
        };
        let summary = read_retention(&fake).expect("both reads succeeded");
        assert_eq!(summary.snapshots, 2);
        assert_eq!(summary.snapshot_bytes, 350);
        assert_eq!(summary.audit_rows, 37);
    }

    #[test]
    fn a_failed_snapshot_read_is_unknown_not_zero() {
        let fake = Fake {
            snapshots: failing("disk gone"),
            audit_rows: Ok(37),
        };
        // The old code produced `snapshots: 0` here. `None` is the only honest
        // answer: the store was not read, so its size was not measured.
        assert!(
            read_retention(&fake).is_none(),
            "an unreadable snapshot table must not be reported as an empty one"
        );
    }

    #[test]
    fn a_failed_audit_read_is_unknown_not_zero() {
        let fake = Fake {
            snapshots: Ok(vec![record(10)]),
            audit_rows: failing("locked"),
        };
        assert!(
            read_retention(&fake).is_none(),
            "a good snapshot count must not launder an invented audit count"
        );
    }

    #[test]
    fn a_negative_audit_count_is_clamped_rather_than_underflowed() {
        let fake = Fake {
            snapshots: Ok(Vec::new()),
            audit_rows: Ok(-5),
        };
        let summary = read_retention(&fake).expect("reads succeeded");
        assert_eq!(summary.audit_rows, 0);
    }

    /// The wire type is what makes the renderer's `null` branch reachable.
    #[test]
    fn an_unknown_retention_serialises_as_null() {
        let snapshot = StateSnapshot {
            locale: "en".into(),
            theme: "midnight".into(),
            reduce_motion: false,
            telemetry_enabled: true,
            phases: BTreeMap::new(),
            active_action_id: None,
            last_scan_at_utc: None,
            telemetry: None,
            retention: None,
            action_prefs: crate::state::ActionPrefs::default(),
            notices: Vec::new(),
            session_uptime_ms: 0,
        };
        let json = serde_json::to_value(&snapshot).expect("serialise");
        // `null`, not `{}` and not `0`: the UI keys its `-` on exactly this.
        assert_eq!(json["retention"], serde_json::Value::Null);
    }
}

/// The Trust Center's machine facts must not be invented in Rust (DEF-127,
/// DEF-128).
///
/// Both defects had the same shape: a fallible read was flattened to a plausible
/// value (`0`, `""`, `"unknown"`) that the panel then printed as a measurement.
/// No behavioural test can catch the second half, because the flattened value is
/// perfectly valid data - `Option<String>` holding `Some("unknown")` renders, type
/// checks and passes every test in the tree. Mutation proved the gap: reverting
/// `webview_version` to `…ok().or_else(|| Some("unknown".to_string()))` survived.
/// The fact lives in the constructor, so the guard reads the constructor.
#[cfg(test)]
mod app_info_tests {
    /// The fields whose whole job is to report what was measured.
    const DISPLAY_FACTS: [&str; 3] = ["os_build", "os_display_version", "webview_version"];

    fn strip_comments(body: &str) -> String {
        body.lines()
            .map(|line| match line.find("//") {
                Some(index) => &line[..index],
                None => line,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn display_facts_are_optional_on_the_wire() {
        let source = include_str!("commands.rs");
        let struct_body = source
            .split("pub struct AppInfo {")
            .nth(1)
            .expect("AppInfo must exist")
            .split("\n}")
            .next()
            .expect("struct body");
        for field in DISPLAY_FACTS {
            let declaration = struct_body
                .lines()
                .find(|line| line.trim_start().starts_with(&format!("pub {field}:")))
                .unwrap_or_else(|| panic!("{field} must be declared on AppInfo"));
            assert!(
                declaration.contains("Option<"),
                "`{field}` must be `Option`: a non-optional field cannot carry \
                 \"not measured\", so a failed read becomes a value the panel prints \
                 as a measurement (DEF-127/DEF-128)"
            );
        }
    }

    #[test]
    fn app_info_get_never_falls_back_to_a_literal() {
        let source = include_str!("commands.rs");
        let body = source
            .split("pub fn app_info_get(")
            .nth(1)
            .expect("app_info_get must exist");
        // Up to the function's `Ok(AppInfo { … })` closer, so the check cannot be
        // satisfied by an unrelated field further down the file.
        let body = body
            .split("\n    })\n")
            .next()
            .expect("app_info_get must end with its Ok(AppInfo) closer");
        let code = strip_comments(body);

        for field in DISPLAY_FACTS {
            let start = code
                .find(&format!("\n        {field}:"))
                .unwrap_or_else(|| panic!("{field} must be set in app_info_get"));
            let rest = &code[start + 1..];
            // The initialiser runs to the next field at the same indentation.
            let end = rest[1..]
                .find("\n        ")
                .map(|index| index + 1)
                .unwrap_or(rest.len());
            let initialiser = &rest[..end];
            assert!(
                !initialiser.contains('"'),
                "`{field}` is initialised with a string literal: {initialiser:?}\n\
                 An English literal here crosses the wire as display text - it \
                 cannot be localised (ADR-010) and it turns a failed read into a \
                 plausible value (DEF-128). Emit the identifier or `None`."
            );
        }
    }
}
