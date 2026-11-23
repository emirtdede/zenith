//! Shared types crossing the core boundary.
//!
//! Everything here is `Serialize + Deserialize` and mirrors the TypeScript
//! surface in `docs/03-architecture/03-04-ipc-contract.md` §4 field for field.
//! Renaming a field is an IPC major change, so this file is deliberately boring:
//! names match the contract exactly, including `camelCase` on the wire.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error::{ErrorCode, ZenithError};

/// The closed set of actions. Adding one is a manifest change plus this variant,
/// and CI fails if the two disagree (`T-CONTRACT-01`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActionId {
    CleanTempCache,
    EmptyRecycleBin,
    ArchiveScreenshots,
    WingetUpgradeAll,
    WindowsUpdateScan,
    FlushDnsCache,
    ResetWinsockStack,
    ClearStuckProxyVpn,
    SyncNtpTime,
    CopySysadminInfo,
    DismRestoreHealth,
    SfcSystemScan,
    RestartExplorer,
    RebuildIconCache,
    RestartBluetooth,
    ResetPrintSpooler,
    ResetGpuDriver,
    ControlledReboot,
    UnlockDevPorts,
    CloseHungOffice,
    ClearTeamsOutlookCache,
    ReclaimWslDockerRam,
}

impl ActionId {
    /// Stable wire identifier - kebab-case, never localised, never reordered.
    pub const fn as_str(self) -> &'static str {
        use ActionId::*;
        match self {
            CleanTempCache => "clean-temp-cache",
            EmptyRecycleBin => "empty-recycle-bin",
            ArchiveScreenshots => "archive-screenshots",
            WingetUpgradeAll => "winget-upgrade-all",
            WindowsUpdateScan => "windows-update-scan",
            FlushDnsCache => "flush-dns-cache",
            ResetWinsockStack => "reset-winsock-stack",
            ClearStuckProxyVpn => "clear-stuck-proxy-vpn",
            SyncNtpTime => "sync-ntp-time",
            CopySysadminInfo => "copy-sysadmin-info",
            DismRestoreHealth => "dism-restore-health",
            SfcSystemScan => "sfc-system-scan",
            RestartExplorer => "restart-explorer",
            RebuildIconCache => "rebuild-icon-cache",
            RestartBluetooth => "restart-bluetooth",
            ResetPrintSpooler => "reset-print-spooler",
            ResetGpuDriver => "reset-gpu-driver",
            ControlledReboot => "controlled-reboot",
            UnlockDevPorts => "unlock-dev-ports",
            CloseHungOffice => "close-hung-office",
            ClearTeamsOutlookCache => "clear-teams-outlook-cache",
            ReclaimWslDockerRam => "reclaim-wsl-docker-ram",
        }
    }

    /// Parse from the wire form. Case-sensitive on purpose: an id that differs by
    /// case is a bug in the caller, not something to forgive silently.
    pub fn parse(value: &str) -> Option<Self> {
        crate::manifest::ACTIONS
            .iter()
            .find(|def| def.id.as_str() == value)
            .map(|def| def.id)
    }
}

impl std::fmt::Display for ActionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl std::str::FromStr for ActionId {
    type Err = ZenithError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s).ok_or_else(|| {
            ZenithError::new(ErrorCode::InvalidArgument)
                .with("field", "actionId")
                .with("reason", s.to_string())
        })
    }
}

/// How much of an action can be undone. Four honest values, no percentages.
///
/// `controlled-reboot` is **not** here as a tier; it is `irreversible` plus
/// `abortable = true`, because "abortable during a countdown" and "reversible
/// after the fact" are different promises (ADR-004).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReversibilityTier {
    /// The exact prior state can be restored and verified.
    FullyReversible,
    /// A prior state exists but some effects regenerate differently.
    PartiallyReversible,
    /// An out-of-band artefact (hive export, restore point) allows a best-effort
    /// return; not an exact restore, and the UI says so.
    CompensatingRecovery,
    /// Nothing is preserved. The UI must say this before the click.
    Irreversible,
}

impl ReversibilityTier {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::FullyReversible => "fully_reversible",
            Self::PartiallyReversible => "partially_reversible",
            Self::CompensatingRecovery => "compensating_recovery",
            Self::Irreversible => "irreversible",
        }
    }

    /// Whether the UI may offer a rollback affordance at all.
    pub const fn is_rollbackable(self) -> bool {
        matches!(
            self,
            Self::FullyReversible | Self::PartiallyReversible | Self::CompensatingRecovery
        )
    }

    /// Whether the confirmation must be *blocking* (names the object and count,
    /// destructive button unfocused).
    pub const fn requires_strong_confirmation(self) -> bool {
        matches!(self, Self::Irreversible)
    }

    /// Read the declared tier for an action from the manifest.
    pub fn from_action(id: crate::models::ActionId) -> Self {
        crate::manifest::action_by_id(id).tier
    }
}

/// Blast radius, separate from reversibility. A safe action can still be
/// irreversible (`clean-temp-cache`); an unsafe one is never batchable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Risk {
    Safe,
    Moderate,
    Destructive,
}

impl Risk {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Safe => "safe",
            Self::Moderate => "moderate",
            Self::Destructive => "destructive",
        }
    }
}

/// Lifecycle of a single action as observed by the UI and the executor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionPhase {
    Idle,
    Diagnosing,
    Healthy,
    NeedsAttention,
    Running,
    Success,
    Error,
    SkippedDependency,
    Cancelled,
    RolledBack,
}

impl ExecutionPhase {
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Success
                | Self::Error
                | Self::SkippedDependency
                | Self::Cancelled
                | Self::RolledBack
                | Self::Healthy
                | Self::NeedsAttention
        )
    }

    pub const fn is_active(self) -> bool {
        matches!(self, Self::Diagnosing | Self::Running)
    }
}

/// Result of one probe. Numbers are measured, never estimated; a field that
/// cannot be measured is `None` and the UI renders "unknown", not zero
/// (REQ-F-072).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticReport {
    pub action_id: ActionId,
    pub needs_attention: bool,
    pub severity_weight: u8,
    pub metric_key: String,
    pub metric_params: BTreeMap<String, String>,
    pub reclaimable_bytes: u64,
    pub latency_ms: Option<u64>,
    pub tier: ReversibilityTier,
    pub can_rollback: bool,
    /// `true` for probes that are observational only. The UI must not render a
    /// "fix" button for these.
    pub read_only: bool,
    pub measured_at_utc: String,
}

impl DiagnosticReport {
    pub fn healthy(action: ActionId, tier: ReversibilityTier, metric_key: &str) -> Self {
        Self {
            action_id: action,
            needs_attention: false,
            severity_weight: 1,
            metric_key: metric_key.to_string(),
            metric_params: BTreeMap::new(),
            reclaimable_bytes: 0,
            latency_ms: None,
            tier,
            can_rollback: tier.is_rollbackable(),
            read_only: false,
            measured_at_utc: crate::engine::audit::now_utc(),
        }
    }
}

/// Aggregate health signals shown in the header strip.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemTelemetry {
    pub health_score: u8,
    pub junk_bytes: u64,
    pub dns_latency_ms: Option<u64>,
    pub memory_used_mb: u64,
    pub memory_total_mb: u64,
    /// Measured memory use as a percentage. `None` = could not measure.
    ///
    /// `Option`, not `f32`, for the same reason `dns_latency_ms` is: a failed
    /// reading used to arrive as `0`, which the strip rendered as "0 %" - the
    /// most reassuring number available - and the score treated as a free pass
    /// on the memory term. Two lies from one sentinel.
    pub memory_used_percent: Option<f32>,
    /// Severity-weighted count of actions that need attention.
    pub issue_count: u32,
    pub issue_ids: Vec<ActionId>,
    pub os_build: u32,
    pub win10_esu_warning: bool,
    pub measured_at_utc: String,
    pub breakdown: HealthBreakdown,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthBreakdown {
    pub junk: f32,
    pub dns: f32,
    pub memory: f32,
    pub issues: f32,
}

/// One step inside an action (archive, delete, restart-service, …).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepResult {
    pub step_key: String,
    pub status: StepStatus,
    pub error_code: Option<ErrorCode>,
    pub params: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Success,
    Error,
    Skipped,
}

impl StepStatus {
    /// Stable lowercase wire word.
    ///
    /// The shell used `{:?}` on this enum, so the technical log line read
    /// `steps.dnsFlush: Success` - a `Debug` rendering, which is an internal
    /// representation, not a contract. It also put a raw catalogue key in front
    /// of the user (DEF-088). The renderer localizes `stepKey`; this string is
    /// only the support-facing fallback, so it must be a fixed wire token that
    /// never changes when a variant is renamed.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Error => "error",
            Self::Skipped => "skipped",
        }
    }
}

/// Terminal result of an execution. Every human-facing string is a key plus
/// parameters; the core never ships English (ADR-010).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionOutcome {
    pub action_id: ActionId,
    pub phase: ExecutionPhase,
    pub success: bool,
    pub duration_ms: u64,
    pub summary_key: String,
    pub summary_params: BTreeMap<String, String>,
    pub before_key: String,
    pub before_params: BTreeMap<String, String>,
    pub after_key: String,
    pub after_params: BTreeMap<String, String>,
    pub snapshot_id: Option<String>,
    pub tier: ReversibilityTier,
    pub requires_reboot: bool,
    pub abortable: bool,
    pub trigger_effect: Option<String>,
    pub correlation_id: String,
    pub steps: Vec<StepResult>,
}

impl ExecutionOutcome {
    pub fn cancelled(action: ActionId, tier: ReversibilityTier, duration_ms: u64) -> Self {
        Self {
            action_id: action,
            phase: ExecutionPhase::Cancelled,
            success: false,
            duration_ms,
            summary_key: "outcomes.cancelled".into(),
            summary_params: BTreeMap::new(),
            before_key: "outcomes.none".into(),
            before_params: BTreeMap::new(),
            after_key: "outcomes.none".into(),
            after_params: BTreeMap::new(),
            snapshot_id: None,
            tier,
            requires_reboot: false,
            abortable: false,
            trigger_effect: None,
            correlation_id: crate::engine::audit::new_correlation_id(),
            steps: Vec::new(),
        }
    }
}

/// A listener occupying a local port, with the identity triple needed to kill
/// it safely (ADR-017).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortListener {
    pub port: u16,
    pub protocol: String,
    pub local_address: String,
    pub pid: u32,
    pub process_name: String,
    pub start_time_unix_ms: u64,
    pub command_line_redacted: String,
    pub memory_mb: u64,
    /// True when this listener is the running Zenith process.
    ///
    /// The UI must be able to say "that is Zenith itself" *before* the user
    /// ticks it, not only after a refused kill. Measured here, where the PID is
    /// authoritative, rather than guessed in the renderer.
    pub is_self: bool,
}

/// The triple that must match at kill time, or the kill is refused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedPidTarget {
    pub pid: u32,
    pub expected_name: String,
    pub expected_start_time_unix_ms: u64,
}

/// One entry in snapshot history.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRecord {
    pub snapshot_id: String,
    pub action_id: ActionId,
    pub created_at_utc: String,
    pub tier: ReversibilityTier,
    pub snapshot_type: String,
    pub is_restored: bool,
    pub restored_at_utc: Option<String>,
    pub est_bytes: u64,
    pub status: SnapshotStatus,
    pub summary_key: String,
    pub summary_params: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotStatus {
    Committed,
    Broken,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_ids_round_trip_through_the_wire_form() {
        for def in crate::manifest::ACTIONS {
            let text = def.id.as_str();
            assert_eq!(ActionId::parse(text), Some(def.id), "parse {text}");
            assert_eq!(text.parse::<ActionId>().unwrap(), def.id);
        }
    }

    #[test]
    fn action_ids_serialise_as_kebab_case() {
        let json = serde_json::to_string(&ActionId::UnlockDevPorts).unwrap();
        assert_eq!(json, "\"unlock-dev-ports\"");
    }

    #[test]
    fn tiers_report_rollbackability_honestly() {
        assert!(ReversibilityTier::FullyReversible.is_rollbackable());
        assert!(ReversibilityTier::PartiallyReversible.is_rollbackable());
        assert!(ReversibilityTier::CompensatingRecovery.is_rollbackable());
        assert!(!ReversibilityTier::Irreversible.is_rollbackable());
        // Only irreversible needs the strong, unfocused-destructive confirmation.
        assert!(ReversibilityTier::Irreversible.requires_strong_confirmation());
        assert!(!ReversibilityTier::FullyReversible.requires_strong_confirmation());
    }

    #[test]
    fn parsing_an_unknown_action_fails_loudly() {
        let err = "not-an-action".parse::<ActionId>().unwrap_err();
        assert!(err.is(ErrorCode::InvalidArgument));
        assert_eq!(
            err.params.get("field").map(String::as_str),
            Some("actionId")
        );
    }

    #[test]
    fn terminal_phases_are_not_active() {
        assert!(ExecutionPhase::Success.is_terminal());
        assert!(!ExecutionPhase::Running.is_terminal());
        assert!(ExecutionPhase::Running.is_active());
        assert!(!ExecutionPhase::Idle.is_active());
    }
}
