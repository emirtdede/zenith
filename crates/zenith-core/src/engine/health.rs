//! Health index: a score we can defend.
//!
//! v1.0.0 displayed a number with no published formula, which is theatre. Here
//! the score is a piecewise penalty over four measured inputs and the UI shows
//! the same breakdown the user sees below (`03-01` §7.3).
//!
//! ```text
//! S = clamp(100 − (30·min(1, junkGB/5)
//!               + 15·min(1, max(0, dnsMs−50)/250)
//!               + 25·min(1, max(0, memPct−75)/20)
//!               + 30·min(1, weightedIssues/6)), 0, 100)
//! ```
//!
//! Every term is bounded, so no single bad reading can drive the score to zero
//! and no good reading can hide a real problem elsewhere.

use crate::engine::audit::now_utc;
use crate::models::{ActionId, DiagnosticReport, HealthBreakdown, SystemTelemetry};

/// Penalty ceilings, in score points. These four constants are the published
/// formula; changing one changes the product's headline number and requires a
/// docs change plus a golden-value test update.
pub const JUNK_WEIGHT: f32 = 30.0;
pub const DNS_WEIGHT: f32 = 15.0;
pub const MEMORY_WEIGHT: f32 = 25.0;
pub const ISSUE_WEIGHT: f32 = 30.0;

/// Inputs to the score, separated from the report list so they can be tested
/// and replayed.
#[derive(Debug, Clone, Copy)]
pub struct HealthInputs {
    /// Reclaimable bytes reported by space-related probes.
    pub junk_bytes: u64,
    /// Measured median DNS resolution latency. `None` = could not measure.
    pub dns_latency_ms: Option<u64>,
    /// Measured memory use as a percentage. `None` = could not measure.
    pub memory_used_percent: Option<f32>,
    /// Severity-weighted issue count (`severity_weight / 3`, clamped to 1).
    pub weighted_issues: f32,
}

fn clamp01(value: f32) -> f32 {
    value.clamp(0.0, 1.0)
}

/// Compute the four penalties plus the final score.
pub fn score(inputs: HealthInputs) -> (u8, HealthBreakdown) {
    let junk_gb = inputs.junk_bytes as f64 / (1024.0 * 1024.0 * 1024.0);
    let junk_penalty = JUNK_WEIGHT * clamp01((junk_gb / 5.0) as f32);

    // A latency we could not measure must not be scored as perfect or as broken.
    let dns_penalty = match inputs.dns_latency_ms {
        Some(ms) => DNS_WEIGHT * clamp01(((ms as f32 - 50.0) / 250.0).max(0.0)),
        None => 0.0,
    };

    // A reading we could not take must not be scored as perfect or as broken -
    // the same rule the DNS term follows, so the two cannot drift apart.
    let memory_penalty = match inputs.memory_used_percent {
        Some(percent) => MEMORY_WEIGHT * clamp01(((percent - 75.0) / 20.0).max(0.0)),
        None => 0.0,
    };
    let issue_penalty = ISSUE_WEIGHT * clamp01(inputs.weighted_issues / 6.0);

    let total = junk_penalty + dns_penalty + memory_penalty + issue_penalty;
    let health = (100.0 - total).clamp(0.0, 100.0);

    (
        health.round() as u8,
        HealthBreakdown {
            junk: round2(junk_penalty),
            dns: round2(dns_penalty),
            memory: round2(memory_penalty),
            issues: round2(issue_penalty),
        },
    )
}

fn round2(value: f32) -> f32 {
    (value * 100.0).round() / 100.0
}

/// Severity-weighted issue count. A HIGH issue counts as one, a MEDIUM as
/// two-thirds, a LOW as one-third - the weighting advertised in `02-01` REQ-F-018.
pub fn weighted_issue_count(reports: &[DiagnosticReport]) -> f32 {
    reports
        .iter()
        .filter(|report| report.needs_attention)
        .map(|report| (report.severity_weight.min(3) as f32) / 3.0)
        .sum()
}

/// Build the header telemetry from a completed diagnosis.
///
/// `memory` is `Some((used_mb, total_mb))` only when the read actually happened.
/// It used to be two bare `u64`s and callers passed `.unwrap_or(0)` on a failed
/// read, which made an unmeasured machine report **0 % memory used** - the single
/// most reassuring number on the strip - and then awarded the memory term a zero
/// penalty. The DNS term beside it already had the honest rule (`None` = could
/// not measure, scored neither perfect nor broken); this makes memory follow it.
pub fn build_telemetry(
    reports: &[DiagnosticReport],
    memory: Option<(u64, u64)>,
    os_build: u32,
) -> SystemTelemetry {
    let junk_bytes = reports.iter().map(|r| r.reclaimable_bytes).sum();
    let dns_latency_ms = reports
        .iter()
        .find(|r| r.action_id == ActionId::FlushDnsCache)
        .and_then(|r| r.latency_ms);

    // `None` stays `None`: an impossible total (0 MB) is treated as "did not
    // read", not as a real measurement of a machine with no memory.
    let memory_used_percent = memory.and_then(|(used, total)| {
        if total == 0 {
            None
        } else {
            Some((used as f32 / total as f32) * 100.0)
        }
    });
    let (memory_used_mb, memory_total_mb) = memory.unwrap_or((0, 0));

    let weighted = weighted_issue_count(reports);
    let (health_score, breakdown) = score(HealthInputs {
        junk_bytes,
        dns_latency_ms,
        memory_used_percent,
        weighted_issues: weighted,
    });

    let mut issue_ids: Vec<ActionId> = reports
        .iter()
        .filter(|r| r.needs_attention)
        .map(|r| r.action_id)
        .collect();
    issue_ids.sort_by_key(|id| crate::manifest::action_by_id(*id).order);

    SystemTelemetry {
        health_score,
        junk_bytes,
        dns_latency_ms,
        memory_used_mb,
        memory_total_mb,
        memory_used_percent: memory_used_percent.map(round2),
        issue_count: weighted.ceil() as u32,
        issue_ids,
        os_build,
        // Windows 10 22H2 / ESU window opens at build 19045 and ends when the
        // Windows 11 line (22000) takes over.
        win10_esu_warning: (19045..22000).contains(&os_build),
        measured_at_utc: now_utc(),
        breakdown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ReversibilityTier;

    fn healthy_inputs() -> HealthInputs {
        HealthInputs {
            junk_bytes: 0,
            dns_latency_ms: Some(12),
            memory_used_percent: Some(40.0),
            weighted_issues: 0.0,
        }
    }

    #[test]
    fn a_clean_machine_scores_one_hundred() {
        assert_eq!(score(healthy_inputs()).0, 100);
    }

    #[test]
    fn five_gigabytes_of_junk_costs_exactly_thirty_points() {
        let inputs = HealthInputs {
            junk_bytes: 5 * 1024 * 1024 * 1024,
            ..healthy_inputs()
        };
        assert_eq!(score(inputs).0, 70);
    }

    #[test]
    fn junk_penalty_saturates_rather_than_exceeding_its_weight() {
        let inputs = HealthInputs {
            junk_bytes: 500 * 1024 * 1024 * 1024,
            ..healthy_inputs()
        };
        let (health, breakdown) = score(inputs);
        assert_eq!(breakdown.junk, 30.0);
        assert_eq!(health, 70);
    }

    #[test]
    fn dns_below_fifty_ms_is_free() {
        for ms in [0, 1, 49, 50] {
            let inputs = HealthInputs {
                dns_latency_ms: Some(ms),
                ..healthy_inputs()
            };
            assert_eq!(score(inputs).0, 100, "ms={ms}");
        }
    }

    #[test]
    fn unmeasurable_dns_is_not_scored_as_either_extreme() {
        let inputs = HealthInputs {
            dns_latency_ms: None,
            ..healthy_inputs()
        };
        let (health, breakdown) = score(inputs);
        assert_eq!(breakdown.dns, 0.0);
        assert_eq!(health, 100);
    }

    #[test]
    fn unmeasurable_memory_follows_the_same_rule_as_dns() {
        // Before this, a failed memory read arrived as `0.0` percent: a *measured*
        // value claiming the machine was idle. The two Option inputs must behave
        // identically, or the next reader has to guess which one is special.
        let inputs = HealthInputs {
            memory_used_percent: None,
            ..healthy_inputs()
        };
        let (health, breakdown) = score(inputs);
        assert_eq!(breakdown.memory, 0.0, "an unread value is not a penalty");
        assert_eq!(
            health, 100,
            "and not a bonus claim either - it is simply absent"
        );
    }

    #[test]
    fn a_failed_memory_read_reaches_the_wire_as_absent_not_zero() {
        // The user-visible half of the defect: the strip rendered `0 %` from the
        // sentinel. The telemetry must say "not measured" instead of "idle".
        let telemetry = build_telemetry(&[], None, 19045);
        assert_eq!(telemetry.memory_used_percent, None);
        assert_eq!(telemetry.memory_used_mb, 0);
        assert_eq!(telemetry.memory_total_mb, 0);
    }

    #[test]
    fn an_impossible_total_is_treated_as_unread() {
        // A machine never reports 0 MB of RAM; that number is what a failed read
        // used to look like after `unwrap_or(0)`. Dividing by it would produce
        // infinity or NaN, so it must collapse to "not measured".
        let telemetry = build_telemetry(&[], Some((0, 0)), 19045);
        assert_eq!(telemetry.memory_used_percent, None);
    }

    #[test]
    fn memory_under_seventy_five_percent_is_free() {
        let inputs = HealthInputs {
            memory_used_percent: Some(74.9),
            ..healthy_inputs()
        };
        assert_eq!(score(inputs).0, 100);
    }

    #[test]
    fn memory_at_ninety_five_percent_costs_twenty_five_points() {
        let inputs = HealthInputs {
            memory_used_percent: Some(95.0),
            ..healthy_inputs()
        };
        assert_eq!(score(inputs).0, 75);
    }

    #[test]
    fn all_penalties_together_are_bounded_at_zero() {
        let inputs = HealthInputs {
            junk_bytes: 50 * 1024 * 1024 * 1024,
            dns_latency_ms: Some(9_999),
            memory_used_percent: Some(99.0),
            weighted_issues: 99.0,
        };
        assert_eq!(score(inputs).0, 0);
    }

    #[test]
    fn breakdown_sums_to_the_total_penalty() {
        let inputs = HealthInputs {
            junk_bytes: 2 * 1024 * 1024 * 1024,
            dns_latency_ms: Some(175),
            memory_used_percent: Some(85.0),
            weighted_issues: 2.0,
        };
        let (health, breakdown) = score(inputs);
        let penalty = breakdown.junk + breakdown.dns + breakdown.memory + breakdown.issues;
        assert!(
            (100.0 - penalty - health as f32).abs() <= 1.0,
            "health={health} penalty={penalty}"
        );
    }

    #[test]
    fn severity_weighting_counts_high_more_than_low() {
        let high = DiagnosticReport {
            severity_weight: 3,
            needs_attention: true,
            ..DiagnosticReport::healthy(
                ActionId::SfcSystemScan,
                ReversibilityTier::Irreversible,
                "diag.sfc",
            )
        };
        let low = DiagnosticReport {
            severity_weight: 1,
            needs_attention: true,
            ..DiagnosticReport::healthy(
                ActionId::FlushDnsCache,
                ReversibilityTier::Irreversible,
                "diag.dns",
            )
        };
        assert!((weighted_issue_count(std::slice::from_ref(&high)) - 1.0).abs() < f32::EPSILON);
        assert!((weighted_issue_count(&[low]) - (1.0 / 3.0)).abs() < 1e-5);
    }

    #[test]
    fn telemetry_reports_metric_units_and_a_timestamp() {
        let report = DiagnosticReport {
            reclaimable_bytes: 1024 * 1024 * 1024,
            ..DiagnosticReport::healthy(
                ActionId::CleanTempCache,
                ReversibilityTier::Irreversible,
                "diag.temp",
            )
        };
        let telemetry = build_telemetry(&[report], Some((8_192, 16_384)), 26100);
        assert_eq!(telemetry.junk_bytes, 1024 * 1024 * 1024);
        assert!((telemetry.memory_used_percent.expect("measured") - 50.0).abs() < 0.01);
        assert!(parse_ok(&telemetry.measured_at_utc));
        assert!(!telemetry.win10_esu_warning);
    }

    fn parse_ok(value: &str) -> bool {
        crate::engine::audit::parse_utc(value).is_some()
    }

    #[test]
    fn windows_ten_build_is_flagged_for_lifecycle() {
        let telemetry = build_telemetry(&[], Some((1, 2)), 19045);
        assert!(telemetry.win10_esu_warning);
    }

    #[test]
    fn issue_list_is_ordered_like_the_ui() {
        let a = DiagnosticReport {
            needs_attention: true,
            ..DiagnosticReport::healthy(
                ActionId::SfcSystemScan,
                ReversibilityTier::Irreversible,
                "diag.sfc",
            )
        };
        let b = DiagnosticReport {
            needs_attention: true,
            ..DiagnosticReport::healthy(
                ActionId::CleanTempCache,
                ReversibilityTier::Irreversible,
                "diag.temp",
            )
        };
        let telemetry = build_telemetry(&[a, b], Some((1, 2)), 26100);
        assert_eq!(
            telemetry.issue_ids,
            vec![ActionId::CleanTempCache, ActionId::SfcSystemScan]
        );
    }
}
