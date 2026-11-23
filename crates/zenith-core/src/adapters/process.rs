//! Process identity and port ownership.
//!
//! The central rule from ADR-017: a PID is not an identity. PIDs are recycled, so
//! termination requires the triple `(pid, image name, creation time)` to match at
//! the moment of the kill. Anything less killed the wrong process in v1.0.0.
//!
//! Everything displayed is redacted before it leaves this module; the raw command
//! line never escapes.

use crate::engine::redact;
use crate::error::ZenithResult;
use crate::models::{PortListener, VerifiedPidTarget};

/// A process as this machine currently sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub name: String,
    pub start_time_unix_ms: u64,
    pub memory_mb: u64,
    pub command_line_redacted: String,
}

impl ProcessIdentity {
    /// The triple the executor compares before terminating.
    pub fn target(&self) -> VerifiedPidTarget {
        VerifiedPidTarget {
            pid: self.pid,
            expected_name: self.name.clone(),
            expected_start_time_unix_ms: self.start_time_unix_ms,
        }
    }
}

/// Per-target termination outcome. Never all-or-nothing (`REQ-F-066`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminateOutcome {
    Terminated,
    IdentityMismatch,
    AccessDenied,
    Gone,
    /// The target is Zenith itself. Refused unconditionally: the app cannot be
    /// asked to kill the process that is executing the request, and a user who
    /// ticked their own row by mistake must not be able to crash it mid-change.
    RefusedSelf,
}

impl TerminateOutcome {
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Terminated => "terminated",
            Self::IdentityMismatch => "identity_mismatch",
            Self::AccessDenied => "access_denied",
            Self::Gone => "gone",
            Self::RefusedSelf => "refused_self",
        }
    }
}

/// Summary returned to the UI.
#[derive(Debug, Clone, Default)]
pub struct TerminateSummary {
    pub results: Vec<(u32, TerminateOutcome)>,
}

impl TerminateSummary {
    pub fn terminated(&self) -> usize {
        self.results
            .iter()
            .filter(|(_, outcome)| *outcome == TerminateOutcome::Terminated)
            .count()
    }
}

/// List TCP listeners inside `[min_port, max_port]`.
#[cfg(windows)]
pub fn list_listeners(min_port: u16, max_port: u16) -> ZenithResult<Vec<PortListener>> {
    use crate::error::{ErrorCode, ZenithError};
    use std::net::Ipv4Addr;
    use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID,
        TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows::Win32::Networking::WinSock::AF_INET;

    // 8-byte aligned storage: `MIB_TCPTABLE_OWNER_PID` requires pointer alignment
    // the allocator does not promise for `Vec<u8>` (`03-06` §3.1).
    let mut buffer: Vec<u64> = Vec::new();
    let mut attempts = 0;

    loop {
        attempts += 1;
        let capacity_bytes = (buffer.len() * std::mem::size_of::<u64>()) as u32;
        let mut size = capacity_bytes;

        // SAFETY: when `buffer` is empty we pass a null pointer with size 0,
        // which is the documented size-query form. Otherwise the buffer is live,
        // and `capacity_bytes` is exactly its byte length.
        let status = unsafe {
            GetExtendedTcpTable(
                if buffer.is_empty() {
                    None
                } else {
                    Some(buffer.as_mut_ptr().cast())
                },
                &mut size,
                false, // bOrder: the table must NOT be sorted (windows expects BOOL)
                AF_INET.0 as u32,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };

        if status == NO_ERROR.0 {
            break;
        }
        if status == ERROR_INSUFFICIENT_BUFFER.0 && attempts <= 4 {
            // Grow to the size the API reported, rounded up to u64 units.
            let units = (size as usize).div_ceil(8);
            buffer.resize(units.max(64), 0);
            continue;
        }
        if status == ERROR_INSUFFICIENT_BUFFER.0 {
            return Err(
                ZenithError::new(ErrorCode::Internal).with("reason", "tcp table kept growing")
            );
        }
        return Err(ZenithError::new(ErrorCode::Internal)
            .with("reason", "GetExtendedTcpTable failed")
            .detail(format!("status=0x{status:08X}")));
    }

    // Recompute the real capacity and clamp the entry count to it.
    let capacity_bytes = buffer.len() * std::mem::size_of::<u64>();
    if capacity_bytes < std::mem::size_of::<u32>() {
        return Ok(Vec::new());
    }

    // SAFETY: the buffer was filled by a successful call and is at least a u32.
    let table = unsafe { &*(buffer.as_ptr() as *const MIB_TCPTABLE_OWNER_PID) };
    let row_size = std::mem::size_of::<MIB_TCPROW_OWNER_PID>();
    let max_rows = (capacity_bytes - std::mem::size_of::<u32>()) / row_size;
    let declared = table.dwNumEntries as usize;
    // Clamp: a lying count must not let us read past the allocation.
    let count = declared.min(max_rows);

    // SAFETY: `dwTable` is the first entry of `count` rows inside the buffer.
    let rows = unsafe {
        std::slice::from_raw_parts(table.table.as_ptr().cast::<MIB_TCPROW_OWNER_PID>(), count)
    };

    let mut listeners = Vec::new();
    for row in rows {
        // `dwLocalPort` is in network byte order in the low 16 bits.
        let port = u16::from_be((row.dwLocalPort & 0xFFFF) as u16);
        if port < min_port || port > max_port {
            continue;
        }
        let address = Ipv4Addr::from(u32::from_be(row.dwLocalAddr));
        let pid = row.dwOwningPid;
        if pid == 0 {
            continue;
        }

        // Identity lookup is best-effort: a process can exit between the table
        // snapshot and the query, and that is a normal race, not an error.
        let identity = identify(pid).ok();

        listeners.push(PortListener {
            port,
            protocol: "TCP".to_string(),
            local_address: address.to_string(),
            pid,
            process_name: identity
                .as_ref()
                .map(|id| id.name.clone())
                .unwrap_or_else(|| "unknown".to_string()),
            start_time_unix_ms: identity
                .as_ref()
                .map(|id| id.start_time_unix_ms)
                .unwrap_or(0),
            command_line_redacted: identity
                .as_ref()
                .map(|id| id.command_line_redacted.clone())
                .unwrap_or_default(),
            memory_mb: identity.as_ref().map(|id| id.memory_mb).unwrap_or(0),
            is_self: pid == std::process::id(),
        });
    }

    listeners.sort_by_key(|listener| listener.port);
    Ok(listeners)
}

#[cfg(not(windows))]
pub fn list_listeners(_min_port: u16, _max_port: u16) -> ZenithResult<Vec<PortListener>> {
    Err(crate::adapters::unsupported("process.list_listeners"))
}

/// Read the identity triple for a live process.
#[cfg(windows)]
pub fn identify(pid: u32) -> ZenithResult<ProcessIdentity> {
    use crate::error::{ErrorCode, ZenithError};
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
    use windows::Win32::System::ProcessStatus::K32GetProcessMemoryInfo;
    use windows::Win32::System::ProcessStatus::PROCESS_MEMORY_COUNTERS;
    use windows::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // SAFETY: `OpenProcess` does not dereference Rust memory; the returned handle
    // is checked and closed below.
    let handle: HANDLE = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
        .map_err(|err| {
            // `err.code()` is an HRESULT; the Win32 code lives in the low bits.
            if crate::adapters::win32_code(&err) == crate::adapters::win32::ACCESS_DENIED {
                ZenithError::new(ErrorCode::AccessDenied).with("pid", pid.to_string())
            } else {
                ZenithError::new(ErrorCode::ProcessGone)
                    .with("pid", pid.to_string())
                    .detail(err.to_string())
            }
        })?;

    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();

    // SAFETY: all four out-pointers reference live locals, and `handle` is valid.
    let times =
        unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) };
    if times.is_err() {
        // SAFETY: `handle` came from a successful `OpenProcess`.
        unsafe {
            let _ = CloseHandle(handle);
        }
        return Err(ZenithError::new(ErrorCode::ProcessGone).with("pid", pid.to_string()));
    }

    let mut counters = PROCESS_MEMORY_COUNTERS::default();
    // SAFETY: `handle` is a live handle to this PID with
    // `PROCESS_QUERY_LIMITED_INFORMATION`, `counters` is a correctly sized
    // `PROCESS_MEMORY_COUNTERS`, and the size passed matches `counters`.
    let memory_mb = unsafe {
        if K32GetProcessMemoryInfo(
            handle,
            &mut counters,
            std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        )
        .as_bool()
        {
            counters.WorkingSetSize as u64 / (1024 * 1024)
        } else {
            0
        }
    };

    let name = image_name(pid).unwrap_or_else(|| "unknown".to_string());
    let command_line = command_line(pid).map(|raw| redact::redact_command_line(&raw));

    // SAFETY: `handle` came from a successful `OpenProcess`.
    unsafe {
        let _ = CloseHandle(handle);
    }

    Ok(ProcessIdentity {
        pid,
        name,
        start_time_unix_ms: filetime_to_unix_ms((created.dwLowDateTime, created.dwHighDateTime)),
        memory_mb,
        command_line_redacted: command_line.unwrap_or_default(),
    })
}

#[cfg(not(windows))]
pub fn identify(_pid: u32) -> ZenithResult<ProcessIdentity> {
    Err(crate::adapters::unsupported("process.identify"))
}

/// Convert a Windows FILETIME (100 ns ticks since 1601) to Unix milliseconds.
///
/// Pure and tested: this conversion is where a units bug silently breaks the
/// TOCTOU guard, so it does not get to be inline.
pub fn filetime_to_unix_ms(created: (u32, u32)) -> u64 {
    let ticks = ((created.1 as u64) << 32) | created.0 as u64;
    // 116444736000000000 ticks between 1601-01-01 and 1970-01-01.
    const EPOCH_DIFFERENCE: u64 = 116_444_736_000_000_000;
    if ticks <= EPOCH_DIFFERENCE {
        return 0;
    }
    (ticks - EPOCH_DIFFERENCE) / 10_000
}

/// Terminate one target only if its identity still matches.
#[cfg(windows)]
pub fn terminate_if_identity_matches(target: &VerifiedPidTarget) -> TerminateOutcome {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, TerminateProcess,
    };

    // Self-protection comes first, before any identity read: killing the
    // process that is running this code would abort the request midway and can
    // leave a snapshot uncommitted. `ports.self` states this promise, so it is
    // enforced here rather than only greying out a checkbox.
    if target.pid == std::process::id() {
        return TerminateOutcome::RefusedSelf;
    }

    // Re-read identity immediately before acting, with no await and no user
    // interaction in between.
    let current = match identify(target.pid) {
        Ok(identity) => identity,
        Err(err) => {
            return if err.is(crate::error::ErrorCode::AccessDenied) {
                TerminateOutcome::AccessDenied
            } else {
                TerminateOutcome::Gone
            };
        }
    };

    let name_matches = current.name.eq_ignore_ascii_case(&target.expected_name);
    let start_matches = current.start_time_unix_ms == target.expected_start_time_unix_ms;
    if !name_matches || !start_matches {
        return TerminateOutcome::IdentityMismatch;
    }

    // SAFETY: `OpenProcess` does not dereference Rust memory; handle checked.
    let handle = match unsafe {
        OpenProcess(
            PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
            false,
            target.pid,
        )
    } {
        Ok(handle) => handle,
        Err(_) => return TerminateOutcome::AccessDenied,
    };

    // SAFETY: `handle` is valid and carries PROCESS_TERMINATE.
    let killed = unsafe { TerminateProcess(handle, 1) };
    // SAFETY: `handle` came from a successful `OpenProcess`.
    unsafe {
        let _ = CloseHandle(handle);
    }

    if killed.is_ok() {
        TerminateOutcome::Terminated
    } else {
        TerminateOutcome::AccessDenied
    }
}

#[cfg(not(windows))]
pub fn terminate_if_identity_matches(_target: &VerifiedPidTarget) -> TerminateOutcome {
    TerminateOutcome::AccessDenied
}

/// Find every process whose image name matches `name` (case-insensitive).
///
/// Enumeration can race with process exit, so a process that vanishes between
/// enumeration and identity read is skipped rather than reported as an error.
/// The returned identities carry the creation time, which is what makes them
/// safe to hand to [`terminate_if_identity_matches`].
#[cfg(windows)]
pub fn find_by_name(name: &str) -> ZenithResult<Vec<ProcessIdentity>> {
    use windows::Win32::System::ProcessStatus::EnumProcesses;

    // Start with room for 1024 pids; grow if the API says it filled the buffer.
    let mut capacity = 1024usize;
    loop {
        let mut pids = vec![0u32; capacity];
        let mut needed = 0u32;
        let bytes = (pids.len() * std::mem::size_of::<u32>()) as u32;

        // SAFETY: `pids` is exactly `bytes` long, and `needed` is a live local.
        let enumerated = unsafe { EnumProcesses(pids.as_mut_ptr(), bytes, &mut needed) };

        if enumerated.is_err() {
            return Ok(Vec::new());
        }

        let count = (needed as usize / std::mem::size_of::<u32>()).min(pids.len());
        // A full buffer means the list may have been truncated; retry bigger
        // once rather than silently missing processes.
        if count == pids.len() && capacity < 65_536 {
            capacity *= 2;
            continue;
        }

        let mut found = Vec::new();
        for pid in &pids[..count] {
            if *pid == 0 {
                continue;
            }
            // Identity read gives us the name; a race that removed the process
            // yields an error we simply skip.
            let Ok(identity) = identify(*pid) else {
                continue;
            };
            if identity.name.eq_ignore_ascii_case(name) {
                found.push(identity);
            }
        }
        return Ok(found);
    }
}

#[cfg(not(windows))]
pub fn find_by_name(_name: &str) -> ZenithResult<Vec<ProcessIdentity>> {
    Err(crate::adapters::unsupported("process.find_by_name"))
}

/// The title of the first window Windows reports as hung, or `None` when the
/// process has no hung window.
///
/// `Some(title)` means "this process has at least one window the OS calls
/// unresponsive"; `title` is empty when that window has no caption.
///
/// Hung-ness and the title are read in **one** enumeration of the **same**
/// window. The pair of functions this replaces did not: hung-ness came from
/// `IsHungAppWindow` over every window, while the displayed title came from a
/// separate walk that returned the first *titled* window in z-order. Those are
/// not the same window - z-order puts dialogs and the print preview ahead of the
/// document - so a user could be told "Quarterly report.docx is frozen" about a
/// process whose frozen window was something else entirely, and then close the
/// app believing they knew which document was lost (DEF-112).
///
/// A process with no windows at all is *not* hung: it cannot be "not responding"
/// in the sense the user means, and the Office probe only acts on windowed
/// applications.
#[cfg(windows)]
pub fn hung_window(pid: u32) -> ZenithResult<Option<String>> {
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsHungAppWindow,
    };

    struct Search {
        pid: u32,
        found: bool,
        title: String,
    }

    /// `EnumWindows` callback. Returning `false` stops enumeration once the
    /// first hung window of the PID has been recorded with its own caption.
    unsafe extern "system" fn callback(
        hwnd: windows::Win32::Foundation::HWND,
        lparam: windows::Win32::Foundation::LPARAM,
    ) -> windows::core::BOOL {
        // SAFETY: `lparam` is the `&mut Search` passed to `EnumWindows` below and
        // is valid for the duration of the call.
        let search = unsafe { &mut *(lparam.0 as *mut Search) };
        let mut owner = 0u32;
        // SAFETY: `hwnd` comes from the enumeration; `owner` is a live local.
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut owner)) };
        if owner != search.pid {
            return windows::core::BOOL(1);
        }
        // SAFETY: `hwnd` is a live window handle supplied by the system.
        if !unsafe { IsHungAppWindow(hwnd) }.as_bool() {
            return windows::core::BOOL(1);
        }
        // This *is* the hung window; its caption is the one to name.
        // SAFETY: `hwnd` is a live window handle supplied by the system.
        let length = unsafe { GetWindowTextLengthW(hwnd) };
        if length > 0 {
            let mut buffer = vec![0u16; length as usize + 1];
            // SAFETY: the buffer is `length + 1` units, matching the API contract.
            let written = unsafe { GetWindowTextW(hwnd, &mut buffer) };
            if written > 0 {
                search.title = String::from_utf16_lossy(&buffer[..written as usize]);
            }
        }
        search.found = true;
        // Non-zero keeps enumerating; the first hung window is enough.
        windows::core::BOOL(0)
    }

    let mut search = Search {
        pid,
        found: false,
        title: String::new(),
    };

    // SAFETY: the callback only touches `search`, which outlives this call.
    let _ = unsafe {
        EnumWindows(
            Some(callback),
            windows::Win32::Foundation::LPARAM(&mut search as *mut Search as isize),
        )
    };

    Ok(if search.found {
        Some(search.title)
    } else {
        None
    })
}

#[cfg(not(windows))]
pub fn hung_window(_pid: u32) -> ZenithResult<Option<String>> {
    Err(crate::adapters::unsupported("process.hung_window"))
}

/// Whether the process has at least one window that is not hung.
///
/// A thin reading of [`hung_window`], so the probe that only counts hung
/// processes and the dialog that names them can never disagree about which
/// windows are hung.
pub fn is_responding(pid: u32) -> ZenithResult<bool> {
    Ok(hung_window(pid)?.is_none())
}

/// Terminate every target, reporting each result independently.
pub fn terminate_all(targets: &[VerifiedPidTarget]) -> TerminateSummary {
    let mut summary = TerminateSummary::default();
    for target in targets {
        let outcome = terminate_if_identity_matches(target);
        summary.results.push((target.pid, outcome));
    }
    summary
}

#[cfg(windows)]
fn image_name(pid: u32) -> Option<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::ProcessStatus::K32GetModuleBaseNameW;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    // SAFETY: no Rust memory is dereferenced; handle is checked and closed.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut buffer = [0u16; 260];
    // SAFETY: `buffer` is a live array of 260 u16 values, which is the size the
    // API is told about.
    let len = unsafe { K32GetModuleBaseNameW(handle, None, &mut buffer) };
    // SAFETY: handle from a successful `OpenProcess`.
    unsafe {
        let _ = CloseHandle(handle);
    }
    if len == 0 {
        return None;
    }
    String::from_utf16(&buffer[..len as usize]).ok()
}

#[cfg(not(windows))]
fn image_name(_pid: u32) -> Option<String> {
    None
}

#[cfg(windows)]
fn command_line(pid: u32) -> Option<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };

    // The full command line needs a PEB read, which requires more than
    // PROCESS_QUERY_LIMITED_INFORMATION on some builds. We take the image path,
    // which is available with the narrow right, and treat it as the "command
    // line" for display. This is deliberate: it is always available, never
    // contains arguments that could hold secrets, and cannot fail for a
    // protected process that we could not kill anyway.
    // SAFETY: no Rust memory dereferenced; handle checked and closed.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut buffer = vec![0u16; 1024];
    let mut size = buffer.len() as u32;
    // SAFETY: `buffer` has `size` u16 elements and `size` says so.
    let result = unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut size,
        )
    };
    // SAFETY: handle from a successful `OpenProcess`.
    unsafe {
        let _ = CloseHandle(handle);
    }
    if result.is_err() || size == 0 {
        return None;
    }
    String::from_utf16(&buffer[..size as usize]).ok()
}

#[cfg(not(windows))]
fn command_line(_pid: u32) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filetime_conversion_is_correct_at_the_epoch() {
        // 1970-01-01T00:00:00Z exactly.
        let ticks: u64 = 116_444_736_000_000_000;
        let low = (ticks & 0xFFFF_FFFF) as u32;
        let high = (ticks >> 32) as u32;
        assert_eq!(filetime_to_unix_ms((low, high)), 0);
    }

    #[test]
    fn filetime_conversion_advances_one_second_per_ten_million_ticks() {
        let base: u64 = 116_444_736_000_000_000;
        let one_second_later = base + 10_000_000;
        let low = (one_second_later & 0xFFFF_FFFF) as u32;
        let high = (one_second_later >> 32) as u32;
        assert_eq!(filetime_to_unix_ms((low, high)), 1_000);
    }

    #[test]
    fn filetime_conversion_clamps_a_pre_epoch_value() {
        assert_eq!(filetime_to_unix_ms((0, 0)), 0);
    }

    #[test]
    fn a_target_is_derived_from_identity_without_loss() {
        let identity = ProcessIdentity {
            pid: 4242,
            name: "node.exe".into(),
            start_time_unix_ms: 1_700_000_000_000,
            memory_mb: 320,
            command_line_redacted: "node server.js".into(),
        };
        let target = identity.target();
        assert_eq!(target.pid, 4242);
        assert_eq!(target.expected_name, "node.exe");
        assert_eq!(target.expected_start_time_unix_ms, 1_700_000_000_000);
    }

    #[test]
    fn summary_counts_only_real_terminations() {
        let summary = TerminateSummary {
            results: vec![
                (1, TerminateOutcome::Terminated),
                (2, TerminateOutcome::AccessDenied),
                (3, TerminateOutcome::Terminated),
            ],
        };
        assert_eq!(summary.terminated(), 2);
    }

    #[test]
    fn outcome_strings_match_the_ipc_contract() {
        assert_eq!(TerminateOutcome::Terminated.as_str(), "terminated");
        assert_eq!(
            TerminateOutcome::IdentityMismatch.as_str(),
            "identity_mismatch"
        );
        assert_eq!(TerminateOutcome::AccessDenied.as_str(), "access_denied");
        assert_eq!(TerminateOutcome::Gone.as_str(), "gone");
    }

    #[cfg(windows)]
    #[test]
    fn identifying_our_own_process_succeeds() {
        let pid = std::process::id();
        let identity = identify(pid).expect("own process");
        assert_eq!(identity.pid, pid);
        assert!(identity.start_time_unix_ms > 0);
        assert!(!identity.name.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn a_recycled_pid_never_matches() {
        // A child, not our own PID: self-protection now returns before the
        // identity comparison, so the own process can no longer demonstrate
        // "the name matched but the start time did not" (DEF-090).
        let mut child = spawn_long_child();
        let mut target = identify(child.id()).expect("child").target();
        // Claim a different start time, as a recycled PID would have.
        target.expected_start_time_unix_ms += 1;
        assert_eq!(
            terminate_if_identity_matches(&target),
            TerminateOutcome::IdentityMismatch
        );
        let _ = child.kill();
        let _ = child.wait();
    }

    #[cfg(windows)]
    #[test]
    fn a_wrong_name_never_matches() {
        let mut child = spawn_long_child();
        let mut target = identify(child.id()).expect("child").target();
        target.expected_name = "definitely-not-this.exe".into();
        assert_eq!(
            terminate_if_identity_matches(&target),
            TerminateOutcome::IdentityMismatch
        );
        let _ = child.kill();
        let _ = child.wait();
    }

    /// Zenith must refuse to terminate its own process, and must do so *before*
    /// reading identity - killing the process running this code would abort the
    /// request that asked for it (DEF-090, `ports.self`).
    #[cfg(windows)]
    #[test]
    fn our_own_process_is_refused_not_terminated() {
        let target = identify(std::process::id()).expect("own process").target();
        assert_eq!(
            terminate_if_identity_matches(&target),
            TerminateOutcome::RefusedSelf
        );
        assert_eq!(TerminateOutcome::RefusedSelf.as_str(), "refused_self");
    }

    /// A live process that is not us and is not about to exit on its own.
    #[cfg(windows)]
    fn spawn_long_child() -> std::process::Child {
        use std::process::{Command, Stdio};
        let child = Command::new("cmd.exe")
            .args(["/c", "ping 127.0.0.1 -n 30 > nul"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn child");
        // Give the OS a moment to finish creating the process object.
        std::thread::sleep(std::time::Duration::from_millis(150));
        child
    }

    #[cfg(windows)]
    #[test]
    fn a_terminated_child_is_confirmed_gone() {
        use std::process::{Command, Stdio};

        let mut child = Command::new("cmd.exe")
            .args(["/c", "ping 127.0.0.1 -n 30 > nul"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn");

        let pid = child.id();
        // Give the OS a moment to create the process fully.
        std::thread::sleep(std::time::Duration::from_millis(120));

        let identity = identify(pid).expect("identify child");
        assert_eq!(
            terminate_if_identity_matches(&identity.target()),
            TerminateOutcome::Terminated
        );

        // Reap and drop the handle first: while any handle to the process
        // object is open, `OpenProcess` keeps succeeding and the PID looks
        // alive even though it is dead. A real caller does not hold one.
        let _ = child.wait();
        drop(child);

        // The kernel may need a beat to tear the object down.
        let mut gone = false;
        for _ in 0..50 {
            if identify(pid).is_err() {
                gone = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(
            gone,
            "pid {pid} still resolves after the process was killed"
        );
    }

    #[cfg(windows)]
    #[test]
    fn listeners_are_returned_in_ascending_port_order() {
        let listeners = list_listeners(1, 65535).expect("list");
        let ports: Vec<u16> = listeners.iter().map(|l| l.port).collect();
        let mut sorted = ports.clone();
        sorted.sort_unstable();
        assert_eq!(ports, sorted);
    }
}
