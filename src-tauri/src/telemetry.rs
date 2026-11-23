//! The 30-second header refresh promised by `03-04` §6.
//!
//! The contract says `telemetry_update` fires "after diagnosis, and every 30 s
//! while visible". Only the first half existed: `commands.rs` emitted it once,
//! at the end of a pass, and nothing else ever published it - so a window left
//! open showed the memory figure from its first diagnosis indefinitely. The
//! frontend already listened for the event; the core simply never sent it.
//!
//! Two rules keep the refresh honest:
//!
//! * it never invents a measurement. With no prior diagnosis there is nothing
//!   to score, so [`refresh`] returns `None` rather than a perfect 100.
//! * it re-uses the *last real reports* and re-reads only memory, which is the
//!   one input that changes on its own. The probes are not re-run: a background
//!   DISM check every 30 seconds would be a load the user never asked for.

use std::time::Duration;

use zenith_core::adapters::system::{self, MemoryInfo};
use zenith_core::engine::health;
use zenith_core::models::{DiagnosticReport, SystemTelemetry};

/// The interval `03-04` §6 publishes.
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(30);

/// Re-derive telemetry from the last diagnosis and a fresh memory reading.
///
/// Returns `None` when no diagnosis has run yet: the strip shows "never
/// measured", not a fabricated score.
pub fn refresh(
    reports: &[DiagnosticReport],
    memory: Option<&MemoryInfo>,
    os_build: u32,
) -> Option<SystemTelemetry> {
    if reports.is_empty() {
        return None;
    }
    // An unreadable memory reading stays absent all the way to the UI, which
    // renders "-" rather than the "0 %" a sentinel used to produce.
    let memory = memory.map(|info| (info.used_mb(), info.total_mb));
    Some(health::build_telemetry(reports, memory, os_build))
}

/// Read memory and refresh, or `None` when there is nothing to refresh.
///
/// Split from the timer so the decision is testable without waiting 30 seconds.
pub fn refresh_now(reports: &[DiagnosticReport], os_build: u32) -> Option<SystemTelemetry> {
    let memory = system::memory().ok();
    refresh(reports, memory.as_ref(), os_build)
}

/// Whether this tick should publish, from the two facts that decide it.
///
/// The contract's wording is "every 30 s **while visible**". A hidden or
/// minimised window has nobody reading the strip, and waking the process every
/// 30 seconds to update a surface no one can see is the kind of quiet waste a
/// diagnostics tool should not commit. Split out so the decision is tested
/// without a window or a clock.
pub fn should_publish(visible: bool, has_reports: bool) -> bool {
    visible && has_reports
}

/// Start the refresh loop. The thread is detached: the loop ends with the
/// process, and a failed emit is ignored exactly as every other event is.
pub fn spawn(app: tauri::AppHandle) {
    use tauri::Manager as _;

    std::thread::spawn(move || {
        loop {
            std::thread::sleep(REFRESH_INTERVAL);
            let Some(state) = app.try_state::<crate::state::AppState>() else {
                return;
            };
            let reports = state.last_reports.lock().clone();
            // `is_visible` is false for a minimised window on Windows as well as one
            // that was closed, which is precisely the "nobody is looking" case.
            let visible = app
                .get_webview_window("main")
                .and_then(|window| window.is_visible().ok())
                .unwrap_or(false);
            if !should_publish(visible, !reports.is_empty()) {
                // Either nothing has been measured or no one is looking; keep
                // waiting rather than publishing a guess into a dark window.
                continue;
            }
            let os_build = state.os.as_ref().map(|info| info.build).unwrap_or(0);
            let Some(telemetry) = refresh_now(&reports, os_build) else {
                continue;
            };
            *state.telemetry.lock() = Some(telemetry.clone());
            let _ = tauri::Emitter::emit(
                &app,
                "telemetry_update",
                serde_json::json!({ "v": 1, "telemetry": telemetry }),
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use zenith_core::models::{ActionId, ReversibilityTier};

    #[test]
    fn no_diagnosis_means_no_score_rather_than_a_perfect_one() {
        // The failure this prevents: a fresh window with no measurement showing
        // "100" because the score was computed from an empty report list.
        assert!(refresh(&[], None, 19045).is_none());
    }

    #[test]
    fn a_real_report_produces_a_score_from_a_real_denominator() {
        let report = DiagnosticReport::healthy(
            ActionId::FlushDnsCache,
            ReversibilityTier::FullyReversible,
            "diag.metric.dns",
        );
        let memory = MemoryInfo {
            total_mb: 16_384,
            available_mb: 8_192,
        };
        let telemetry = refresh(&[report], Some(&memory), 19045).expect("a score");
        // 8 GiB of 16 GiB used is 50%, under the 75% free threshold.
        assert_eq!(telemetry.memory_used_mb, 8_192);
        assert_eq!(telemetry.memory_total_mb, 16_384);
        assert!((telemetry.memory_used_percent.expect("measured") - 50.0).abs() < 0.01);
        assert_eq!(telemetry.health_score, 100);
        assert_eq!(telemetry.os_build, 19045);
        // The timestamp is the refresh time, not the diagnosis time.
        assert!(!telemetry.measured_at_utc.is_empty());
    }

    #[test]
    fn the_interval_is_the_published_thirty_seconds() {
        assert_eq!(REFRESH_INTERVAL, Duration::from_secs(30));
    }

    #[test]
    fn a_hidden_window_is_not_refreshed() {
        // The contract says "every 30 s while visible". Before this guard the
        // loop published unconditionally, so a minimised window woke the process
        // every 30 s to update a strip nobody could see - a promise implemented
        // with the wrong half missing.
        assert!(!should_publish(false, true));
        assert!(!should_publish(false, false));
    }

    #[test]
    fn a_visible_window_with_no_measurement_is_not_refreshed() {
        assert!(!should_publish(true, false));
    }

    #[test]
    fn a_visible_window_with_a_measurement_is_refreshed() {
        assert!(should_publish(true, true));
    }
}
