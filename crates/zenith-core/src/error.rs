//! One error type for the whole core.
//!
//! Rules that this module enforces (and tests assert):
//!
//! 1. Every failure has a **stable** machine code. Codes never change meaning.
//! 2. The core never emits English prose to the user. It emits an i18n key plus
//!    typed parameters, and the UI resolves them in the active locale (ADR-010).
//! 3. Every code carries a *remedy* key - "what should the user do next" - so no
//!    screen can show a dead end (REQ-N-101).
//! 4. Unknown failures still get a correlation id, so support can find them
//!    (REQ-F-144).

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

/// Stable machine-readable failure codes.
///
/// The string form is part of the IPC contract (`docs/03-architecture/03-04-ipc-contract.md` §7)
/// and must not change without an IPC major bump.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidArgument,
    AlreadyRunning,
    ElevationRequired,
    ElevationHandoverInvalid,
    ConfirmationRequired,
    AccessDenied,
    InsufficientDisk,
    DependencyNotMet,
    ScopeViolation,
    IntegrityError,
    ZipTraversalBlocked,
    SnapshotNotFound,
    AlreadyRestored,
    SnapshotFailed,
    PidVerificationFailed,
    ProcessGone,
    ServiceUnavailable,
    ToolMissing,
    Timeout,
    Cancelled,
    StoreQuarantined,
    SchemaMigrationFailed,
    DatabaseBusy,
    NotImplemented,
    Internal,
}

impl ErrorCode {
    /// Stable wire code.
    pub const fn as_str(self) -> &'static str {
        use ErrorCode::*;
        match self {
            InvalidArgument => "INVALID_ARGUMENT",
            AlreadyRunning => "ALREADY_RUNNING",
            ElevationRequired => "ELEVATION_REQUIRED",
            ElevationHandoverInvalid => "ELEVATION_HANDOVER_INVALID",
            ConfirmationRequired => "CONFIRMATION_REQUIRED",
            AccessDenied => "ACCESS_DENIED",
            InsufficientDisk => "INSUFFICIENT_DISK",
            DependencyNotMet => "DEPENDENCY_NOT_MET",
            ScopeViolation => "SCOPE_VIOLATION",
            IntegrityError => "INTEGRITY_ERROR",
            ZipTraversalBlocked => "ZIP_TRAVERSAL_BLOCKED",
            SnapshotNotFound => "SNAPSHOT_NOT_FOUND",
            AlreadyRestored => "ALREADY_RESTORED",
            SnapshotFailed => "SNAPSHOT_FAILED",
            PidVerificationFailed => "PID_VERIFICATION_FAILED",
            ProcessGone => "PROCESS_GONE",
            ServiceUnavailable => "SERVICE_UNAVAILABLE",
            ToolMissing => "TOOL_MISSING",
            Timeout => "TIMEOUT",
            Cancelled => "CANCELLED",
            StoreQuarantined => "STORE_QUARANTINED",
            SchemaMigrationFailed => "SCHEMA_MIGRATION_FAILED",
            DatabaseBusy => "DATABASE_BUSY",
            NotImplemented => "NOT_IMPLEMENTED",
            Internal => "INTERNAL",
        }
    }

    /// ICU key for the human explanation.
    pub const fn message_key(self) -> &'static str {
        use ErrorCode::*;
        match self {
            InvalidArgument => "errors.invalidArgument",
            AlreadyRunning => "errors.alreadyRunning",
            ElevationRequired => "errors.elevationRequired",
            ElevationHandoverInvalid => "errors.handoverInvalid",
            ConfirmationRequired => "errors.confirmationRequired",
            AccessDenied => "errors.accessDenied",
            InsufficientDisk => "errors.insufficientDisk",
            DependencyNotMet => "errors.dependencyNotMet",
            ScopeViolation => "errors.scopeViolation",
            IntegrityError => "errors.integrity",
            ZipTraversalBlocked => "errors.zipTraversal",
            SnapshotNotFound => "errors.snapshotNotFound",
            AlreadyRestored => "errors.alreadyRestored",
            SnapshotFailed => "errors.snapshotFailed",
            PidVerificationFailed => "errors.pidVerification",
            ProcessGone => "errors.processGone",
            ServiceUnavailable => "errors.serviceUnavailable",
            ToolMissing => "errors.toolMissing",
            Timeout => "errors.timeout",
            Cancelled => "errors.cancelled",
            StoreQuarantined => "errors.storeQuarantined",
            SchemaMigrationFailed => "errors.migrationFailed",
            DatabaseBusy => "errors.databaseBusy",
            NotImplemented => "errors.notImplemented",
            Internal => "errors.internal",
        }
    }

    /// ICU key for the actionable next step.
    pub const fn remedy_key(self) -> &'static str {
        use ErrorCode::*;
        match self {
            InvalidArgument => "remedy.checkSelection",
            AlreadyRunning => "remedy.waitOrCancel",
            ElevationRequired => "remedy.restartAsAdmin",
            ElevationHandoverInvalid => "remedy.restartManually",
            ConfirmationRequired => "remedy.confirmAction",
            AccessDenied => "remedy.closeHandlesOrElevate",
            InsufficientDisk => "remedy.freeSpace",
            DependencyNotMet => "remedy.runPrerequisite",
            ScopeViolation => "remedy.reportBug",
            IntegrityError => "remedy.createSupportBundle",
            ZipTraversalBlocked => "remedy.reportBug",
            SnapshotNotFound => "remedy.refreshList",
            AlreadyRestored => "remedy.none",
            SnapshotFailed => "remedy.freeSpaceOrRetry",
            PidVerificationFailed => "remedy.rescan",
            ProcessGone => "remedy.rescan",
            ServiceUnavailable => "remedy.checkService",
            ToolMissing => "remedy.installTool",
            Timeout => "remedy.retryOrCancel",
            Cancelled => "remedy.none",
            StoreQuarantined => "remedy.openTrustCenter",
            SchemaMigrationFailed => "remedy.createSupportBundle",
            DatabaseBusy => "remedy.retry",
            NotImplemented => "remedy.updateApp",
            Internal => "remedy.createSupportBundle",
        }
    }

    /// Parse a stored wire code back into a variant. Used when reading the
    /// audit table; an unknown string is `None`, never a guess.
    pub fn parse(value: &str) -> Option<Self> {
        use ErrorCode::*;
        Some(match value {
            "INVALID_ARGUMENT" => InvalidArgument,
            "ALREADY_RUNNING" => AlreadyRunning,
            "ELEVATION_REQUIRED" => ElevationRequired,
            "ELEVATION_HANDOVER_INVALID" => ElevationHandoverInvalid,
            "CONFIRMATION_REQUIRED" => ConfirmationRequired,
            "ACCESS_DENIED" => AccessDenied,
            "INSUFFICIENT_DISK" => InsufficientDisk,
            "DEPENDENCY_NOT_MET" => DependencyNotMet,
            "SCOPE_VIOLATION" => ScopeViolation,
            "INTEGRITY_ERROR" => IntegrityError,
            "ZIP_TRAVERSAL_BLOCKED" => ZipTraversalBlocked,
            "SNAPSHOT_NOT_FOUND" => SnapshotNotFound,
            "ALREADY_RESTORED" => AlreadyRestored,
            "SNAPSHOT_FAILED" => SnapshotFailed,
            "PID_VERIFICATION_FAILED" => PidVerificationFailed,
            "PROCESS_GONE" => ProcessGone,
            "SERVICE_UNAVAILABLE" => ServiceUnavailable,
            "TOOL_MISSING" => ToolMissing,
            "TIMEOUT" => Timeout,
            "CANCELLED" => Cancelled,
            "STORE_QUARANTINED" => StoreQuarantined,
            "SCHEMA_MIGRATION_FAILED" => SchemaMigrationFailed,
            "DATABASE_BUSY" => DatabaseBusy,
            "NOT_IMPLEMENTED" => NotImplemented,
            "INTERNAL" => Internal,
            _ => return None,
        })
    }

    /// True when the user can fix it without support.
    pub const fn is_user_fixable(self) -> bool {
        use ErrorCode::*;
        matches!(
            self,
            InvalidArgument
                | AlreadyRunning
                | ElevationRequired
                | ConfirmationRequired
                | InsufficientDisk
                | DependencyNotMet
                | SnapshotNotFound
                | AlreadyRestored
                | Timeout
                | Cancelled
        )
    }
}

/// The single error type crossing every core boundary.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZenithError {
    pub code: ErrorCode,
    /// Typed parameters for `code.message_key()`. Values are already redacted.
    pub params: BTreeMap<String, String>,
    /// English technical detail for logs only. **Never** shown to a user.
    pub detail: Option<String>,
    pub correlation_id: String,
}

impl ZenithError {
    pub fn new(code: ErrorCode) -> Self {
        Self {
            code,
            params: BTreeMap::new(),
            detail: None,
            correlation_id: crate::engine::audit::new_correlation_id(),
        }
    }

    pub fn with(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.params.insert(key.into(), value.into());
        self
    }

    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn code(&self) -> ErrorCode {
        self.code
    }

    pub fn is(&self, code: ErrorCode) -> bool {
        self.code == code
    }

    /// i18n keys the UI needs. Kept as a method so a missing key is a compile-time
    /// concern rather than a runtime string search.
    pub fn i18n_keys(&self) -> (&'static str, &'static str) {
        (self.code.message_key(), self.code.remedy_key())
    }
}

impl fmt::Display for ZenithError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.code.as_str())?;
        if let Some(detail) = &self.detail {
            write!(f, ": {detail}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ZenithError {}

/// Shorthand used throughout the core.
pub type ZenithResult<T> = Result<T, ZenithError>;

// ---------------------------------------------------------------------------
// Constructors for the codes the core raises most often.
// ---------------------------------------------------------------------------

impl ZenithError {
    pub fn invalid_argument(field: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidArgument)
            .with("field", field)
            .with("reason", reason)
    }

    /// The honest gap. Used instead of `todo!()` so a partially built binary is
    /// still a truthful one (ADR-019, Zero-Stub Law L1).
    pub fn not_implemented(feature: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotImplemented).with("feature", feature)
    }

    pub fn access_denied(path: impl Into<String>) -> Self {
        Self::new(ErrorCode::AccessDenied).with("path", path)
    }

    pub fn io(context: impl Into<String>, err: &std::io::Error) -> Self {
        Self::new(ErrorCode::Internal)
            .with("context", context)
            .detail(err.to_string())
    }
}

impl From<std::io::Error> for ZenithError {
    fn from(err: std::io::Error) -> Self {
        Self::new(ErrorCode::Internal).detail(err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_has_distinct_stable_text() {
        // Guards against a copy-paste where two variants share a wire code.
        let codes = [
            ErrorCode::InvalidArgument,
            ErrorCode::AlreadyRunning,
            ErrorCode::ElevationRequired,
            ErrorCode::ElevationHandoverInvalid,
            ErrorCode::ConfirmationRequired,
            ErrorCode::AccessDenied,
            ErrorCode::InsufficientDisk,
            ErrorCode::DependencyNotMet,
            ErrorCode::ScopeViolation,
            ErrorCode::IntegrityError,
            ErrorCode::ZipTraversalBlocked,
            ErrorCode::SnapshotNotFound,
            ErrorCode::AlreadyRestored,
            ErrorCode::SnapshotFailed,
            ErrorCode::PidVerificationFailed,
            ErrorCode::ProcessGone,
            ErrorCode::ServiceUnavailable,
            ErrorCode::ToolMissing,
            ErrorCode::Timeout,
            ErrorCode::Cancelled,
            ErrorCode::StoreQuarantined,
            ErrorCode::SchemaMigrationFailed,
            ErrorCode::DatabaseBusy,
            ErrorCode::NotImplemented,
            ErrorCode::Internal,
        ];
        let mut seen = std::collections::HashSet::new();
        for code in codes {
            assert!(seen.insert(code.as_str()), "duplicate code {code:?}");
            assert!(code.message_key().starts_with("errors."));
            assert!(code.remedy_key().starts_with("remedy."));
        }
        assert_eq!(seen.len(), codes.len());
    }

    #[test]
    fn error_serialises_to_the_ipc_shape() {
        let err = ZenithError::not_implemented("gpu-reset").with("actionId", "reset-gpu-driver");
        let value = serde_json::to_value(&err).expect("serialise");
        assert_eq!(value["code"], "NOT_IMPLEMENTED");
        assert_eq!(value["params"]["feature"], "gpu-reset");
        assert!(
            value["correlationId"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
        );
    }

    #[test]
    fn correlation_ids_are_unique() {
        let a = ZenithError::new(ErrorCode::Internal);
        let b = ZenithError::new(ErrorCode::Internal);
        assert_ne!(a.correlation_id, b.correlation_id);
    }
}
