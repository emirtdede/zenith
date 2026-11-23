//! Candidate discovery for the selection-driven actions.
//!
//! Every function here answers "what could I act on?" without acting. The
//! results carry the identity triple ([`crate::models::VerifiedPidTarget`]) the
//! kill path re-checks, so a recycled PID cannot be terminated by a stale list
//! (ADR-017).
//!
//! A scan that cannot run returns an error. An empty `Vec` always means "the
//! mechanism ran and found nothing", never "we did not look" (REQ-F-072).

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::config::{DEV_PORT_MAX, DEV_PORT_MIN};
use crate::engine::audit::now_utc;
use crate::engine::executor::CancelToken;
use crate::error::{ErrorCode, ZenithError, ZenithResult};
use crate::models::PortListener;

use super::{child, probes, process};

/// The four candidate families the UI can ask for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateKind {
    DevPorts,
    HungOffice,
    PrintJobs,
    Wsl,
}

impl CandidateKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::DevPorts => "dev_ports",
            Self::HungOffice => "hung_office",
            Self::PrintJobs => "print_jobs",
            Self::Wsl => "wsl",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "dev_ports" => Some(Self::DevPorts),
            "hung_office" => Some(Self::HungOffice),
            "print_jobs" => Some(Self::PrintJobs),
            "wsl" => Some(Self::Wsl),
            _ => None,
        }
    }
}

/// The lower bound any `HungWindow` may report, in milliseconds.
///
/// Windows exposes hung-ness as the boolean `IsHungAppWindow`, whose documented
/// threshold is five seconds. There is no API that returns *how long* a window
/// has been unresponsive, so a producer that reported 12 400 ms would be
/// inventing it. `hung_for_ms` therefore carries this floor, and the catalogue
/// renders it as "at least 5 s" - the number is true, and the UI cannot turn a
/// floor into a measured duration (DEF-112).
pub const HUNG_WINDOW_FLOOR_MS: u64 = 5_000;

/// A windowed Office process the OS considers hung.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HungWindow {
    pub pid: u32,
    pub process_name: String,
    pub start_time_unix_ms: u64,
    pub window_title_raw: String,
    pub memory_mb: u64,
    /// Lower bound in milliseconds - always [`HUNG_WINDOW_FLOOR_MS`]. Windows
    /// only flags a window as hung after its own five-second threshold, so the
    /// value means "unresponsive for at least 5 s", never a measured duration.
    pub hung_for_ms: u64,
}

/// One queued print job.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintJob {
    pub job_id: u32,
    pub printer: String,
    pub document: String,
    pub owner: String,
    pub pages: u32,
    pub submitted_at_utc: Option<String>,
}

/// One running WSL distribution.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WslSession {
    pub distro: String,
    pub state: String,
    /// The utility VM's working set in MB, reported only when exactly one
    /// distribution is running. WSL2 shares one VM, so attributing the total to
    /// each of several distributions would be a fabricated number.
    pub vm_memory_mb: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CandidateItems {
    Ports(Vec<PortListener>),
    Hung(Vec<HungWindow>),
    Print(Vec<PrintJob>),
    Wsl(Vec<WslSession>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidates {
    pub kind: CandidateKind,
    pub scanned_at_utc: String,
    pub items: CandidateItems,
}

/// Scan one family. `cancel` is honoured between printers, between jobs, between
/// Office binaries and between PIDs, so a slow spooler or a hung-Office sweep
/// cannot hold the UI hostage. Every family takes the token: the Stop button in
/// the candidate dialog names one scope, so it must be able to stop whichever
/// family the user is looking at (DEF-108).
pub fn scan(kind: CandidateKind, cancel: &Arc<CancelToken>) -> ZenithResult<Candidates> {
    // Checked before the family runs: a stop requested while the dialog was
    // opening must not be answered with a full scan.
    check(cancel)?;
    let items = match kind {
        CandidateKind::DevPorts => CandidateItems::Ports(dev_ports(cancel)?),
        CandidateKind::HungOffice => CandidateItems::Hung(hung_office(cancel)?),
        CandidateKind::PrintJobs => CandidateItems::Print(print_jobs(cancel)?),
        CandidateKind::Wsl => CandidateItems::Wsl(wsl_sessions(cancel)?),
    };
    Ok(Candidates {
        kind,
        scanned_at_utc: now_utc(),
        items,
    })
}

fn check(cancel: &Arc<CancelToken>) -> ZenithResult<()> {
    if cancel.is_cancelled() {
        return Err(ZenithError::new(ErrorCode::Cancelled));
    }
    Ok(())
}

/// Listeners inside the developer port window, newest identity first.
///
/// The token is honoured before the table walk. Reading the listener table is a
/// single kernel call, so there is nothing to interleave inside it, but a stop
/// requested before the scan began must not be answered with a full scan.
#[cfg(windows)]
pub fn dev_ports(cancel: &Arc<CancelToken>) -> ZenithResult<Vec<PortListener>> {
    check(cancel)?;
    let mut listeners = process::list_listeners(DEV_PORT_MIN, DEV_PORT_MAX)?;
    check(cancel)?;
    listeners.sort_by_key(|item| item.port);
    listeners.dedup_by_key(|item| (item.port, item.pid));
    Ok(listeners)
}

#[cfg(not(windows))]
pub fn dev_ports(_cancel: &Arc<CancelToken>) -> ZenithResult<Vec<PortListener>> {
    Err(super::unsupported("candidates.dev_ports"))
}

/// Office binaries whose main window the OS has declared hung.
///
/// The token is honoured between binaries and between PIDs: [`process::hung_window`]
/// enumerates every top-level window once per process, which is the slow part,
/// and four Office binaries times N instances is exactly the sweep a user may
/// want to abandon.
///
/// `hung_for_ms` is the OS threshold, not a stopwatch. Windows exposes
/// `IsHungAppWindow` as a boolean and never reports how long the window has been
/// unresponsive, so the only honest value is the floor: "at least this long".
/// The struct field documents that, and the catalogue says "at least" because
/// the UI used to print "Unresponsive for 5 s" - a duration nobody measured
/// (DEF-112).
#[cfg(windows)]
pub fn hung_office(cancel: &Arc<CancelToken>) -> ZenithResult<Vec<HungWindow>> {
    const OFFICE: &[&str] = &["WINWORD.EXE", "EXCEL.EXE", "POWERPNT.EXE", "OUTLOOK.EXE"];
    let mut found = Vec::new();
    for name in OFFICE {
        check(cancel)?;
        for identity in process::find_by_name(name)? {
            check(cancel)?;
            // One enumeration answers both questions: whether a window is hung
            // and which window that is. Reading them separately is what let the
            // dialog name a window that was not the frozen one (DEF-112).
            let Some(title) = process::hung_window(identity.pid)? else {
                continue;
            };
            found.push(HungWindow {
                pid: identity.pid,
                process_name: identity.name.clone(),
                start_time_unix_ms: identity.start_time_unix_ms,
                window_title_raw: title,
                memory_mb: identity.memory_mb,
                hung_for_ms: HUNG_WINDOW_FLOOR_MS,
            });
        }
    }
    found.sort_by_key(|item| item.pid);
    Ok(found)
}

#[cfg(not(windows))]
pub fn hung_office(_cancel: &Arc<CancelToken>) -> ZenithResult<Vec<HungWindow>> {
    Err(super::unsupported("candidates.hung_office"))
}

/// Jobs in any local or connected queue.
#[cfg(windows)]
pub fn print_jobs(cancel: &Arc<CancelToken>) -> ZenithResult<Vec<PrintJob>> {
    use windows::Win32::Graphics::Printing::{
        ClosePrinter, EnumPrintersW, OpenPrinterW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL,
        PRINTER_HANDLE, PRINTER_INFO_4W,
    };
    use windows::core::PCWSTR;

    // Two-call pattern: size, then fill. `ERROR_INSUFFICIENT_BUFFER` on the
    // sizing call is the expected success path, not a failure.
    let mut needed = 0u32;
    let mut returned = 0u32;
    // SAFETY: no buffer is passed, so only the two out-parameters are written.
    let _ = unsafe {
        EnumPrintersW(
            PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS,
            PCWSTR::null(),
            4,
            None,
            &mut needed,
            &mut returned,
        )
    };
    if needed == 0 {
        return Ok(Vec::new());
    }

    let mut buffer = vec![0u8; needed as usize];
    // SAFETY: `buffer` is exactly `needed` bytes as reported above.
    unsafe {
        EnumPrintersW(
            PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS,
            PCWSTR::null(),
            4,
            Some(&mut buffer),
            &mut needed,
            &mut returned,
        )
    }
    .map_err(|err| {
        ZenithError::new(ErrorCode::ServiceUnavailable)
            .with("service", "spooler")
            .detail(format!("EnumPrintersW: {}", super::win32_code(&err)))
    })?;

    let printers: &[PRINTER_INFO_4W] = {
        let count = returned as usize;
        // SAFETY: the API filled `buffer` with `count` `PRINTER_INFO_4W`
        // records, and the buffer is still alive.
        unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<PRINTER_INFO_4W>(), count) }
    };

    let mut jobs = Vec::new();
    for printer in printers {
        check(cancel)?;
        // SAFETY: `pPrinterName` points into `buffer`, which the API filled and
        // which outlives this loop; `to_string` only reads to the NUL.
        let name = match unsafe { printer.pPrinterName.to_string() } {
            Ok(name) if !name.is_empty() => name,
            _ => continue,
        };
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        let mut handle = PRINTER_HANDLE::default();
        // SAFETY: `wide` is a NUL-terminated name and `handle` is an out-param.
        if unsafe { OpenPrinterW(PCWSTR(wide.as_ptr()), &mut handle, None) }.is_err() {
            // A single unavailable queue (offline network printer) must not
            // fail the whole scan.
            continue;
        }
        let collected = jobs_for_queue(handle, &name, cancel);
        // SAFETY: `handle` was opened above and is closed exactly once here.
        let _ = unsafe { ClosePrinter(handle) };
        jobs.extend(collected?);
    }

    jobs.sort_by_key(|job| (job.printer.clone(), job.job_id));
    Ok(jobs)
}

#[cfg(windows)]
fn jobs_for_queue(
    handle: windows::Win32::Graphics::Printing::PRINTER_HANDLE,
    printer: &str,
    cancel: &Arc<CancelToken>,
) -> ZenithResult<Vec<PrintJob>> {
    use windows::Win32::Graphics::Printing::{EnumJobsW, JOB_INFO_1W};

    let mut needed = 0u32;
    let mut returned = 0u32;
    // SAFETY: no buffer is passed; only out-parameters are written.
    let _ = unsafe { EnumJobsW(handle, 0, u32::MAX, 1, None, &mut needed, &mut returned) };
    if needed == 0 {
        return Ok(Vec::new());
    }

    let mut buffer = vec![0u8; needed as usize];
    // SAFETY: `buffer` is exactly `needed` bytes as reported above.
    let result = unsafe {
        EnumJobsW(
            handle,
            0,
            u32::MAX,
            1,
            Some(&mut buffer),
            &mut needed,
            &mut returned,
        )
    };
    if let Err(err) = result {
        // ACCESS_DENIED on a queue we can see but not read is expected; report
        // it as an empty queue for that printer rather than losing the others.
        if super::win32_code(&err) == super::win32::ACCESS_DENIED {
            return Ok(Vec::new());
        }
        return Err(ZenithError::new(ErrorCode::ServiceUnavailable)
            .with("service", "spooler")
            .detail(format!("EnumJobsW: {}", super::win32_code(&err))));
    }

    let records: &[JOB_INFO_1W] = {
        let count = returned as usize;
        // SAFETY: the API filled `buffer` with `count` `JOB_INFO_1W` records.
        unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<JOB_INFO_1W>(), count) }
    };

    let mut jobs = Vec::with_capacity(records.len());
    for record in records {
        check(cancel)?;
        // SAFETY: both `PWSTR`s point into the `buffer` filled by `EnumJobsW`
        // above and stay valid for this iteration.
        let (document, owner) = unsafe {
            (
                record.pDocument.to_string().unwrap_or_default(),
                record.pUserName.to_string().unwrap_or_default(),
            )
        };
        jobs.push(PrintJob {
            job_id: record.JobId,
            printer: printer.to_string(),
            document,
            owner,
            pages: record.TotalPages,
            submitted_at_utc: system_time_to_utc(&record.Submitted),
        });
    }
    Ok(jobs)
}

#[cfg(windows)]
fn system_time_to_utc(time: &windows::Win32::Foundation::SYSTEMTIME) -> Option<String> {
    use time::{Date, Month, PrimitiveDateTime, Time};

    // An out-of-range component (0 month, 13 month, day 32) is a malformed
    // SYSTEMTIME, not a job time: yield `None` rather than clamping.
    let month = Month::try_from(u8::try_from(time.wMonth).ok()?).ok()?;
    let date =
        Date::from_calendar_date(i32::from(time.wYear), month, u8::try_from(time.wDay).ok()?)
            .ok()?;
    let clock = Time::from_hms_milli(
        u8::try_from(time.wHour).ok()?,
        u8::try_from(time.wMinute).ok()?,
        u8::try_from(time.wSecond).ok()?,
        time.wMilliseconds,
    )
    .ok()?;
    Some(crate::engine::audit::format_utc_millis(
        PrimitiveDateTime::new(date, clock).assume_utc(),
    ))
}

#[cfg(not(windows))]
pub fn print_jobs(_cancel: &Arc<CancelToken>) -> ZenithResult<Vec<PrintJob>> {
    Err(super::unsupported("candidates.print_jobs"))
}

/// Running distributions, measured through `wsl.exe`. Absent WSL is not an
/// error for the product, but it is reported as a missing tool so the UI can
/// hide the card instead of showing a permanent empty list.
#[cfg(windows)]
pub fn wsl_sessions(cancel: &Arc<CancelToken>) -> ZenithResult<Vec<WslSession>> {
    let Some(program) = probes::which("wsl.exe") else {
        return Err(ZenithError::new(ErrorCode::ToolMissing).with("tool", "wsl.exe"));
    };
    let outcome = child::run(
        &child::ChildSpec {
            program: &program,
            args: &["--list", "--running", "--quiet"],
            timeout: Duration::from_secs(8),
            working_dir: None,
        },
        cancel,
    )?;
    if outcome.exit_code != Some(0) {
        return Err(ZenithError::new(ErrorCode::ServiceUnavailable)
            .with("service", "wsl")
            .detail(format!(
                "exit {:?}: {}",
                outcome.exit_code,
                outcome.stderr.trim()
            )));
    }

    let distros: Vec<String> = outcome
        .stdout
        .replace('\0', "")
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect();

    // WSL2 runs one utility VM; its working set is attributable only when a
    // single distribution is running.
    let vm_memory = if distros.len() == 1 {
        process::find_by_name("vmmemWSL")?
            .first()
            .map(|identity| identity.memory_mb)
    } else {
        None
    };

    Ok(distros
        .into_iter()
        .map(|distro| WslSession {
            distro,
            state: "running".to_string(),
            vm_memory_mb: vm_memory,
        })
        .collect())
}

#[cfg(not(windows))]
pub fn wsl_sessions(_cancel: &Arc<CancelToken>) -> ZenithResult<Vec<WslSession>> {
    Err(super::unsupported("candidates.wsl"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidate_kinds_round_trip() {
        for kind in [
            CandidateKind::DevPorts,
            CandidateKind::HungOffice,
            CandidateKind::PrintJobs,
            CandidateKind::Wsl,
        ] {
            assert_eq!(CandidateKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(CandidateKind::parse("everything"), None);
    }

    #[test]
    fn a_cancelled_scan_is_an_error_not_an_empty_list() {
        let cancel = Arc::new(CancelToken::new());
        cancel.cancel();
        assert!(check(&cancel).is_err());
    }

    /// DEF-108: a stop requested before the scan starts must be honoured by
    /// **every** family, not only the two that read a queue.
    ///
    /// The old `scan` passed the token to `print_jobs` and `wsl_sessions` only,
    /// so pressing Stop while the port or Office table was being built looked
    /// like it worked - the dialog closed - while the scan ran to completion. The
    /// check is before the family runs, so it holds on any platform.
    #[test]
    fn every_family_honours_a_stop_requested_before_the_scan() {
        for kind in [
            CandidateKind::DevPorts,
            CandidateKind::HungOffice,
            CandidateKind::PrintJobs,
            CandidateKind::Wsl,
        ] {
            let cancel = Arc::new(CancelToken::new());
            cancel.cancel();
            let error = scan(kind, &cancel).expect_err("a stopped scan must not return a list");
            assert!(
                error.is(ErrorCode::Cancelled),
                "{kind:?} must report CANCELLED, not an implementation error"
            );
        }
    }

    /// The two sweeps that used to ignore the token now take it. On Windows a
    /// cancelled token is a `Cancelled`; elsewhere the adapter is unsupported,
    /// which is still an error - the compile-time half of this proof is the
    /// call itself, which would not type-check against the old signature.
    #[test]
    fn the_port_and_office_sweeps_take_the_token() {
        let cancel = Arc::new(CancelToken::new());
        cancel.cancel();
        assert!(dev_ports(&cancel).is_err());
        assert!(hung_office(&cancel).is_err());
        #[cfg(windows)]
        {
            assert!(dev_ports(&cancel).unwrap_err().is(ErrorCode::Cancelled));
            assert!(hung_office(&cancel).unwrap_err().is(ErrorCode::Cancelled));
        }
    }

    /// DEF-112: the floor is a named constant, and the producer that fills the
    /// struct reads hung-ness and the window title from **one** enumeration.
    ///
    /// The test this replaces built a `HungWindow` by hand and asserted the
    /// number it had just written - a tautology that would pass for any value,
    /// including the invented duration the UI printed. The regression it must
    /// catch is not "is the field 5000" but "does the dialog name the frozen
    /// window": `hung_office` used to call `is_responding` (every window) and
    /// then a separate `window_title` (first *titled* window), so the title could
    /// belong to a window that was not the hung one. This is a source guard
    /// because the mistake is structural - two enumerations - not a value.
    #[test]
    fn the_producer_names_the_window_it_measured() {
        // The constant is the OS threshold, and the struct's floor must be it.
        assert_eq!(HUNG_WINDOW_FLOOR_MS, 5_000);

        let source = include_str!("candidates.rs");
        // Strip `//` comments so this test cannot be satisfied by its own prose
        // or fail on it - the same trap DEF-108's guard fell into.
        let code: String = source
            .lines()
            .map(|line| match line.find("//") {
                Some(at) => &line[..at],
                None => line,
            })
            .collect::<Vec<_>>()
            .join("\n");

        // The production sweep (not the test module) must use the shared
        // one-enumeration reader and the named constant.
        let producer = code
            .split("#[cfg(test)]")
            .next()
            .expect("the file always has a pre-test section");
        assert!(
            producer.contains("process::hung_window(identity.pid)"),
            "hung_office must read hung-ness and title from process::hung_window"
        );
        assert!(
            !producer.contains("window_title(identity.pid)"),
            "the separate window_title walk is what let the dialog name the wrong window"
        );
        assert!(
            !producer.contains("is_responding(identity.pid)"),
            "a second enumeration is the defect: hung-ness and title must agree by construction"
        );
        assert!(
            producer.contains("hung_for_ms: HUNG_WINDOW_FLOOR_MS"),
            "the producer must carry the named floor, not a typed literal"
        );
        assert!(
            !producer.contains("hung_for_ms: 5_000"),
            "a literal floor drifts from its documentation"
        );
    }
}
