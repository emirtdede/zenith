// Build identity for the Trust Center (DEF-075).
//
// `app_info_get` reports `build_commit`, and until now nothing set
// `ZENITH_BUILD_COMMIT` unless the caller exported it - so every packaged
// build displayed `Derleme: dev`. A release screen that says "dev" is worse
// than no screen: it tells the user they are running a development build.
//
// Resolution order, most to least authoritative:
//
//   1. `ZENITH_BUILD_COMMIT` - the CI pipeline exports this (`08-02` §2.3).
//   2. `git rev-parse --short HEAD` - a local build from a checkout.
//   3. A date stamp for release builds, `dev` for debug builds.
//
// The date stamp is not a fake hash: it is the truth about a build made from a
// source tree with no revision identifier, and it is reproducible from
// `SOURCE_DATE_EPOCH` so a byte-identical rebuild keeps the same value.

use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    // Watch every input this script actually reads.
    //
    // Emitting *only* `rerun-if-env-changed` disables cargo's default behaviour
    // of re-running the build script when any file in the package changes. That
    // narrowing is the DEF-092 defect: dozens of source files changed on
    // 2026-11-21, the binary was rebuilt at 10:43 that day, and its embedded
    // identity still said `release-20261120` because the script never ran again.
    // A Trust Center that reports the wrong build date is worse than one that
    // reports none - it is a confident lie about provenance.
    println!("cargo:rerun-if-env-changed=ZENITH_BUILD_COMMIT");
    // The date stamp is derived from this epoch when the caller supplies one
    // (`08-02` §2.3, reproducible builds), so a changed value must re-stamp.
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    // DEF-113: the stamp names the day of *this* build, but Cargo only re-runs a
    // build script when a watched input changes. A rebuild that touches only the
    // renderer (`src/i18n/en.ts`, `src/ui/*.tsx`) or only a dependency relinks
    // the binary without ever re-running this script, so the Trust Center
    // reported `release-20261121` for an executable linked on 2026-11-22 - a
    // confident one-day lie about provenance, and the identity gate caught it
    // (DEF-092's message, one level up). Naming a path that never exists makes
    // Cargo treat the script as out of date on every build (a watched path that
    // is missing counts as changed), which costs one cheap script run and makes
    // the stamped day equal the day the binary is produced.
    println!("cargo:rerun-if-changed=FORCE_RESTAMP_EVERY_BUILD");

    let identity = std::env::var("ZENITH_BUILD_COMMIT")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(git_sha)
        .unwrap_or_else(date_stamp);

    println!("cargo:rustc-env=ZENITH_BUILD_COMMIT={identity}");
    tauri_build::build()
}

/// Short SHA of the checked-out revision, or `None` outside a git worktree.
fn git_sha() -> Option<String> {
    let output = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let sha = String::from_utf8(output.stdout).ok()?.trim().to_string();
    let is_hex = !sha.is_empty() && sha.chars().all(|c| c.is_ascii_hexdigit());
    is_hex.then_some(sha)
}

/// `release-YYYYMMDD` for a release build, `dev` for a debug build.
fn date_stamp() -> String {
    if std::env::var("PROFILE").as_deref() != Ok("release") {
        return "dev".to_string();
    }

    // `SOURCE_DATE_EPOCH` is the reproducible-build convention: honour it so a
    // rebuild of the same source produces the same identity.
    let seconds = std::env::var("SOURCE_DATE_EPOCH")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .unwrap_or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|elapsed| elapsed.as_secs())
                .unwrap_or(0)
        });

    let (year, month, day) = civil_from_days((seconds / 86_400) as i64);
    format!("release-{year:04}{month:02}{day:02}")
}

/// Days since 1970-01-01 to a civil date: Howard Hinnant's `civil_from_days`.
///
/// The build script cannot depend on `chrono` (it is a build dependency of
/// nothing else here, and pulling a date crate into `build.rs` for one
/// formatting call is not a trade this project makes).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = (z - era * 146_097) as u64;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

// No `#[cfg(test)]` here on purpose: `build.rs` is compiled as its own binary
// and Cargo never runs its tests, so a test in this file would be dead code
// wearing a green tick. `civil_from_days` is exercised instead by the identity
// the built binary reports (`app_info_get` → Trust Center), which is the value
// that actually ships.
