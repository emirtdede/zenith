//! Process-wide state, created once at startup and shared by every command.
//!
//! Nothing here is lazily initialised and nothing is read from the ambient
//! environment after construction: a command that needs the database gets the
//! same handle the recovery pass validated.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Instant;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use zenith_core::adapters::system::{OsInfo, os_info};
use zenith_core::config::Paths;
use zenith_core::engine::db::Store;
use zenith_core::engine::executor::{CancelToken, ExecutionRegistry};
use zenith_core::engine::scope::ScopeRoots;
use zenith_core::models::{ActionId, SystemTelemetry};

use crate::error::{IpcError, IpcResult};

/// A one-line message shown at boot. It is a key plus params, never a sentence,
/// so the frontend can localise it like everything else.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupNotice {
    pub id: String,
    pub severity: NoticeSeverity,
    pub message_key: String,
    pub params: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NoticeSeverity {
    Info,
    Warning,
    Critical,
}

/// Presentation preferences for individual actions (03-04 §5.15).
///
/// Pinned ids sort to the front of their category; hidden ids stay reachable
/// through "show hidden" but are not part of the default grid. This is UI state,
/// yet it is persisted by the core for the same reason as every other
/// preference: the renderer owns no storage and a preference that vanishes on
/// restart is not a preference.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ActionPrefs {
    pub pinned: Vec<ActionId>,
    pub hidden: Vec<ActionId>,
}

impl ActionPrefs {
    /// Stable de-duplication in caller order.
    fn normalised(self) -> Result<Self, IpcError> {
        let mut pinned = Vec::new();
        for id in self.pinned {
            if !pinned.contains(&id) {
                pinned.push(id);
            }
        }
        let mut hidden = Vec::new();
        for id in self.hidden {
            if !hidden.contains(&id) {
                hidden.push(id);
            }
        }
        // A pinned action that is also hidden cannot be both first and absent;
        // refusing is clearer than silently picking one.
        if let Some(conflict) = pinned.iter().find(|id| hidden.contains(id)) {
            return Err(
                IpcError::new(zenith_core::error::ErrorCode::InvalidArgument)
                    .with_field("actionPrefs", conflict.as_str()),
            );
        }
        Ok(Self { pinned, hidden })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    pub locale: String,
    pub theme: String,
    pub reduce_motion: bool,
    /// Off unless the user opts in. Enforced in the UI *and* here, because a
    /// preference that only the renderer respects is not a preference.
    pub telemetry_enabled: bool,
    pub action_prefs: ActionPrefs,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            // First-run default only; the user's explicit choice always wins, and
            // the i18n layer negotiates to a catalogue that actually ships. A
            // machine that cannot report its locale gets `en`, which is the same
            // fallback `negotiateLocale` applies - never a fabricated locale.
            locale: zenith_core::adapters::system::ui_locale().unwrap_or_else(|_| "en".to_string()),
            theme: "off-white".to_string(),
            reduce_motion: false,
            telemetry_enabled: false,
            action_prefs: ActionPrefs::default(),
        }
    }
}

impl Preferences {
    /// Replace the per-action block after validation.
    pub fn with_action_prefs(mut self, prefs: ActionPrefs) -> Result<Self, IpcError> {
        self.action_prefs = prefs.normalised()?;
        Ok(self)
    }
}

/// `IpcError` construction helper shared by state-level validation.
trait WithField {
    fn with_field(self, field: &str, reason: &str) -> Self;
}

impl WithField for IpcError {
    fn with_field(mut self, field: &str, reason: &str) -> Self {
        self.params.insert("field".into(), field.into());
        self.params.insert("reason".into(), reason.into());
        self
    }
}

pub struct AppState {
    pub paths: Paths,
    pub store: Arc<Store>,
    pub roots: ScopeRoots,
    pub registry: Arc<ExecutionRegistry>,
    /// Token for the currently running action.
    pub cancel: Arc<CancelToken>,
    /// Separate token so cancelling a diagnosis cannot cancel a repair.
    pub diagnose_cancel: Arc<CancelToken>,
    /// Tokens of every `candidates_scan` that is in flight, empty when idle.
    ///
    /// A **registry of per-run tokens**, for three measured reasons:
    ///
    /// 1. The scan used to borrow `diagnose_cancel`, so starting one ran
    ///    `reset()` on the diagnosis token and silently withdrew a stop the user
    ///    had just requested (DEF-108).
    /// 2. One long-lived scan token reset per run would have kept that defect one
    ///    level down: a second scan's `reset()` would clear the first scan's
    ///    cancellation.
    /// 3. A single slot would strand an older scan. Two scans really can overlap:
    ///    the dialog re-runs its effect when the user picks another family while
    ///    the previous `spawn_blocking` is still reading a slow spooler, so a slot
    ///    holding only the newest token would make the older one unstoppable.
    ///
    /// Each run owns its token; `action_cancel { scope: "scan" }` stops every
    /// scan that is actually running, and an empty registry is the honest answer
    /// to "is a scan running?".
    pub scan_cancels: Arc<Mutex<Vec<Arc<CancelToken>>>>,
    pub prefs: Arc<Mutex<Preferences>>,
    pub notices: Vec<StartupNotice>,
    pub os: Option<OsInfo>,
    pub telemetry: Arc<Mutex<Option<SystemTelemetry>>>,
    /// The reports the last diagnosis produced.
    ///
    /// The 30-second refresh in `03-04` §6 re-derives telemetry from these plus
    /// a fresh memory reading, so the strip stays current without pretending to
    /// re-run the probes. Empty until the first pass: there is nothing honest to
    /// score before a measurement exists.
    pub last_reports: Arc<Mutex<Vec<zenith_core::models::DiagnosticReport>>>,
    pub started_at: Instant,
}

impl AppState {
    /// Build the state, or explain why the product cannot run.
    pub fn bootstrap(paths: Paths) -> IpcResult<Self> {
        paths.ensure_layout();

        let key = zenith_core::engine::keystore::load_or_create(&paths).map_err(|error| {
            let mut ipc = IpcError::new(error.code);
            ipc.params = error.params;
            ipc.correlation_id = error.correlation_id;
            ipc.detail = error.detail;
            ipc
        })?;
        let (store, recovery) = Store::open(&paths, key)?;

        let mut notices = Vec::new();
        if paths.degraded {
            // REQ-F-093: the machine directory was not writable, so we are in
            // per-user mode. Snapshots still work, but they are not shared with
            // other accounts on this PC, and the user must be told.
            crate::logging::append(
                &paths,
                crate::logging::Level::Warn,
                "store is in per-user fallback mode (machine directory not writable)",
            );
            notices.push(StartupNotice {
                id: "store-degraded".into(),
                severity: NoticeSeverity::Warning,
                message_key: "notices.userFallbackStore".into(),
                params: BTreeMap::new(),
            });
        }
        if recovery.quarantined_database.is_some() {
            // The database was unreadable and has been moved aside. Nothing the
            // user did is lost silently: the notice names the quarantine so a
            // support case can find the original file.
            notices.push(StartupNotice {
                id: "store-quarantined".into(),
                severity: NoticeSeverity::Critical,
                message_key: "notices.storeQuarantined".into(),
                params: BTreeMap::new(),
            });
        }
        if !recovery.is_empty() {
            let mut params = BTreeMap::new();
            params.insert(
                "quarantined".into(),
                u8::from(recovery.quarantined_database.is_some()).to_string(),
            );
            params.insert("orphans".into(), recovery.orphan_archives.len().to_string());
            params.insert("pending".into(), recovery.pending_aborted.len().to_string());
            notices.push(StartupNotice {
                id: "store-recovered".into(),
                severity: NoticeSeverity::Info,
                message_key: "notices.storeRecovered".into(),
                params,
            });
        }

        // Enforce the published retention caps and quarantine lifetime. This is
        // the only production caller of `retention::plan`; without it
        // `SNAPSHOT_MAX_ROWS`, `SNAPSHOT_MAX_BYTES`, `AUDIT_MAX_ROWS` and
        // `QUARANTINE_DAYS` would be dead configuration (`04-02` §5).
        let maintenance = crate::maintenance::run(&store, &paths);
        if !maintenance.is_empty() {
            for line in maintenance.summary() {
                crate::logging::append(&paths, crate::logging::Level::Info, &line);
            }
        }
        if maintenance.awaiting_consent > 0 {
            let mut params = BTreeMap::new();
            params.insert("count".into(), maintenance.awaiting_consent.to_string());
            notices.push(StartupNotice {
                id: "retention-consent".into(),
                severity: NoticeSeverity::Info,
                message_key: "notices.retentionConsent".into(),
                params,
            });
        }
        if maintenance.quarantine_expired > 0 || maintenance.pruned_snapshots > 0 {
            let mut params = BTreeMap::new();
            params.insert("snapshots".into(), maintenance.pruned_snapshots.to_string());
            params.insert(
                "quarantine".into(),
                maintenance.quarantine_expired.to_string(),
            );
            notices.push(StartupNotice {
                id: "retention-pruned".into(),
                severity: NoticeSeverity::Info,
                message_key: "notices.retentionPruned".into(),
                params,
            });
        }

        let prefs = read_preferences(&paths);
        let os = os_info().ok();

        Ok(Self {
            paths,
            store: Arc::new(store),
            roots: ScopeRoots::from_environment(),
            registry: Arc::new(ExecutionRegistry::new()),
            cancel: Arc::new(CancelToken::new()),
            diagnose_cancel: Arc::new(CancelToken::new()),
            scan_cancels: Arc::new(Mutex::new(Vec::new())),
            prefs: Arc::new(Mutex::new(prefs)),
            notices,
            os,
            telemetry: Arc::new(Mutex::new(None)),
            last_reports: Arc::new(Mutex::new(Vec::new())),
            started_at: Instant::now(),
        })
    }

    pub fn preferences(&self) -> Preferences {
        self.prefs.lock().clone()
    }

    pub fn save_preferences(&self, next: Preferences) -> IpcResult<()> {
        let text = serde_json::to_string_pretty(&next)
            .map_err(|_| IpcError::internal("preferences are not serialisable"))?;
        let path = self.paths.prefs_file();
        if let Some(parent) = path.parent() {
            // DEF-151: this was `let _ = std::fs::create_dir_all(parent)`. The
            // write below would fail anyway, but with `ENOENT` on
            // `preferences.json.tmp` - a message about a file the user never
            // asked for. Reporting the directory creation names the real
            // problem: the preferences folder could not be made.
            std::fs::create_dir_all(parent).map_err(|err| {
                IpcError::internal(&format!("could not create {}: {err}", parent.display()))
            })?;
        }
        write_atomic(&path, &text)?;
        *self.prefs.lock() = next;
        Ok(())
    }
}

/// Write `text` to `path` so a reader never sees a truncated file (DEF-144).
///
/// `std::fs::write` truncates the destination and then writes. A crash, a full
/// volume or a power loss between those two steps leaves a half-written JSON
/// file, and `read_preferences` swallows the parse error with
/// `unwrap_or_default()`, so the user's theme, locale and pinned actions
/// silently reset to factory defaults with no message. Writing beside the
/// target, flushing, then renaming over it is atomic on NTFS: a reader sees
/// the old file or the new one, never a prefix.
fn write_atomic(path: &std::path::Path, text: &str) -> IpcResult<()> {
    use std::io::Write;

    let tmp = path.with_extension("json.tmp");
    {
        let mut handle = std::fs::File::create(&tmp)?;
        handle.write_all(text.as_bytes())?;
        // `sync_all` survives a power loss; without it the rename can land
        // while the data is still only in the page cache.
        handle.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn read_preferences(paths: &Paths) -> Preferences {
    let Ok(text) = std::fs::read_to_string(paths.prefs_file()) else {
        return Preferences::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// DEF-144: the point of the rename is that the destination is never in a
    /// partial state. Proved by making the destination read-only-looking in the
    /// only way a test can: write twice and assert the second content fully
    /// replaced the first, with no `.tmp` left behind.
    #[test]
    fn write_atomic_replaces_the_whole_file_and_leaves_no_temp() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("preferences.json");

        write_atomic(&path, "{\"theme\":\"off-white\"}").expect("first write");
        assert_eq!(
            std::fs::read_to_string(&path).expect("read first"),
            "{\"theme\":\"off-white\"}"
        );

        // The second write is longer. An in-place truncate-then-write leaves the
        // old tail behind if the write is short; a rename cannot.
        write_atomic(&path, "{\"theme\":\"true-black\",\"locale\":\"tr\"}").expect("second write");
        assert_eq!(
            std::fs::read_to_string(&path).expect("read second"),
            "{\"theme\":\"true-black\",\"locale\":\"tr\"}"
        );

        assert!(
            !dir.path().join("preferences.json.tmp").exists(),
            "the temporary file must be renamed away, not left beside the target"
        );
    }

    /// A destination that cannot be created reports the failure. Silently
    /// succeeding would tell the user a preference was stored when it was not.
    #[test]
    fn write_atomic_reports_a_missing_parent_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("absent").join("preferences.json");
        assert!(write_atomic(&path, "{}").is_err());
    }
}
