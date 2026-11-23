//! Append-only audit trail and correlation identifiers.
//!
//! Why this module exists at all: v1.0.0 could not answer "what changed on this
//! machine, and did it work". A remediation tool without that answer is a
//! liability in an incident review (JTBD-10).
//!
//! Rules:
//!
//! * One row per terminal state, written by the executor, never by the UI.
//! * No column stores file contents, environment variables or raw command lines.
//! * Correlation ids are generated per user intent and propagated to logs,
//!   events and the support bundle.

use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, UtcOffset};
use uuid::Uuid;

use crate::error::ErrorCode;
use crate::models::ActionId;

/// A fresh, URL-safe correlation id. Not a security token - an identifier.
pub fn new_correlation_id() -> String {
    Uuid::new_v4().simple().to_string()
}

/// RFC 3339 with millisecond precision, always UTC and always `Z`.
///
/// Formatting is explicit rather than delegated to a well-known format, because
/// `Rfc3339` omits the fraction when it is zero and emits 3, 6 or 9 digits
/// depending on the value. Audit rows must be fixed-width and byte-comparable,
/// so every timestamp is written as exactly `YYYY-MM-DDTHH:MM:SS.sssZ`.
pub fn now_utc() -> String {
    format_utc_millis(OffsetDateTime::now_utc())
}

/// Render an instant in the one format this module writes.
pub fn format_utc_millis(value: OffsetDateTime) -> String {
    let v = value.to_offset(UtcOffset::UTC);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        v.year(),
        u8::from(v.month()),
        v.day(),
        v.hour(),
        v.minute(),
        v.second(),
        v.millisecond()
    )
}

/// The compact `YYYYMMDDTHHMMSSZ` stamp used in generated file names.
pub fn compact_utc_stamp(value: OffsetDateTime) -> String {
    let v = value.to_offset(UtcOffset::UTC);
    format!(
        "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
        v.year(),
        u8::from(v.month()),
        v.day(),
        v.hour(),
        v.minute(),
        v.second()
    )
}

/// Parse a timestamp this module produced. Returns `None` rather than panicking
/// on a hand-edited database row.
pub fn parse_utc(value: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(value, &Rfc3339)
        .ok()
        .map(|dt| dt.to_offset(UtcOffset::UTC))
}

/// What kind of work produced a row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditPhase {
    Diagnose,
    Execute,
    Rollback,
}

impl AuditPhase {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Diagnose => "diagnose",
            Self::Execute => "execute",
            Self::Rollback => "rollback",
        }
    }

    /// Parse a stored phase. Unknown values are an integrity problem, not a
    /// default to paper over.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "diagnose" => Some(Self::Diagnose),
            "execute" => Some(Self::Execute),
            "rollback" => Some(Self::Rollback),
            _ => None,
        }
    }
}

/// Terminal status of an audited operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditStatus {
    Success,
    Error,
    Cancelled,
    Skipped,
    Timeout,
}

impl AuditStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Error => "error",
            Self::Cancelled => "cancelled",
            Self::Skipped => "skipped",
            Self::Timeout => "timeout",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "success" => Some(Self::Success),
            "error" => Some(Self::Error),
            "cancelled" => Some(Self::Cancelled),
            "skipped" => Some(Self::Skipped),
            "timeout" => Some(Self::Timeout),
            _ => None,
        }
    }
}

/// One immutable audit row.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub correlation_id: String,
    pub action_id: ActionId,
    pub phase: AuditPhase,
    pub started_at_utc: String,
    pub completed_at_utc: Option<String>,
    pub duration_ms: Option<u64>,
    pub status: AuditStatus,
    pub snapshot_id: Option<String>,
    pub error_code: Option<ErrorCode>,
    pub message_key: String,
    pub params_json: String,
    pub bytes_freed: u64,
    pub items_affected: u64,
    pub elevated: bool,
}

impl AuditEntry {
    pub fn started(
        action_id: ActionId,
        phase: AuditPhase,
        correlation_id: impl Into<String>,
        elevated: bool,
    ) -> Self {
        Self {
            correlation_id: correlation_id.into(),
            action_id,
            phase,
            started_at_utc: now_utc(),
            completed_at_utc: None,
            duration_ms: None,
            status: AuditStatus::Success,
            snapshot_id: None,
            error_code: None,
            message_key: "audit.started".into(),
            params_json: "{}".into(),
            bytes_freed: 0,
            items_affected: 0,
            elevated,
        }
    }

    /// Close the row. Durations are computed from wall clock, so a clock jump
    /// yields zero rather than an underflow panic.
    pub fn finish(mut self, status: AuditStatus, message_key: impl Into<String>) -> Self {
        let completed = OffsetDateTime::now_utc();
        self.completed_at_utc = Some(format_utc_millis(completed));
        if let Some(started) = parse_utc(&self.started_at_utc) {
            let delta = (completed - started).whole_milliseconds();
            self.duration_ms = Some(delta.max(0) as u64);
        }
        self.status = status;
        self.message_key = message_key.into();
        self
    }

    pub fn with_error(mut self, code: ErrorCode) -> Self {
        self.error_code = Some(code);
        self
    }

    pub fn with_counts(mut self, bytes_freed: u64, items_affected: u64) -> Self {
        self.bytes_freed = bytes_freed;
        self.items_affected = items_affected;
        self
    }

    pub fn with_snapshot(mut self, snapshot_id: impl Into<String>) -> Self {
        self.snapshot_id = Some(snapshot_id.into());
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ActionId;

    #[test]
    fn correlation_ids_are_unique_and_url_safe() {
        let a = new_correlation_id();
        let b = new_correlation_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn timestamps_round_trip() {
        let stamp = now_utc();
        assert!(stamp.ends_with('Z'), "{stamp}");
        assert!(parse_utc(&stamp).is_some());
        assert!(parse_utc("not-a-date").is_none());
    }

    #[test]
    fn timestamps_are_fixed_width_milliseconds() {
        // `Rfc3339` omits the fraction when it is zero and emits 3, 6 or 9
        // digits otherwise. Audit rows must be byte-comparable, so the shape is
        // pinned here rather than assumed from the dependency.
        let stamp = now_utc();
        assert_eq!(stamp.len(), 24, "{stamp}");
        assert_eq!(&stamp[4..5], "-", "{stamp}");
        assert_eq!(&stamp[7..8], "-", "{stamp}");
        assert_eq!(&stamp[10..11], "T", "{stamp}");
        assert_eq!(&stamp[13..14], ":", "{stamp}");
        assert_eq!(&stamp[16..17], ":", "{stamp}");
        assert_eq!(&stamp[19..20], ".", "{stamp}");
        assert_eq!(&stamp[23..24], "Z", "{stamp}");
        assert!(stamp[20..23].chars().all(|c| c.is_ascii_digit()), "{stamp}");
    }

    #[test]
    fn a_parsed_offset_is_normalised_to_utc() {
        let parsed = parse_utc("2026-11-20T12:34:56.789+02:00").expect("valid RFC 3339");
        assert_eq!(format_utc_millis(parsed), "2026-11-20T10:34:56.789Z");
    }

    #[test]
    fn the_compact_stamp_drops_separators_but_not_meaning() {
        let parsed = parse_utc("2026-11-20T12:34:56.789Z").expect("valid RFC 3339");
        assert_eq!(compact_utc_stamp(parsed), "20261120T123456Z");
    }

    #[test]
    fn audit_rows_close_with_a_non_negative_duration() {
        let entry = AuditEntry::started(
            ActionId::FlushDnsCache,
            AuditPhase::Execute,
            new_correlation_id(),
            false,
        )
        .finish(AuditStatus::Success, "outcomes.dnsFlushed");
        assert!(entry.completed_at_utc.is_some());
        assert!(entry.duration_ms.unwrap_or(1) < 60_000);
        assert_eq!(entry.status, AuditStatus::Success);
    }

    #[test]
    fn a_finished_entry_carries_the_error_code_and_counts() {
        let entry = AuditEntry::started(
            ActionId::SfcSystemScan,
            AuditPhase::Execute,
            new_correlation_id(),
            true,
        )
        .with_error(ErrorCode::Timeout)
        .with_counts(0, 0)
        .finish(AuditStatus::Timeout, "errors.timeout");
        assert_eq!(entry.error_code, Some(ErrorCode::Timeout));
        assert!(entry.elevated);
    }
}
