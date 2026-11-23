//! Service control: read, start, stop and restart, with a bounded wait.
//!
//! The rules this module enforces:
//!
//! * A service is addressed by its **service name**, from the manifest, never by
//!   a display name the user typed.
//! * Every control operation waits for the service to reach a terminal state and
//!   fails with `TIMEOUT` rather than returning "probably worked"
//!   (`REQ-F-058`).
//! * A restart is stop-then-start with a **single** wait per phase, so the UI can
//!   show which half failed. v1.0.0 reported "restarted" when only the stop
//!   succeeded.
//! * The previous state is captured before the change, because the snapshot needs
//!   it to describe what was actually different (`ADR-004`).

use std::time::{Duration, Instant};

use crate::error::{ErrorCode, ZenithError, ZenithResult};

/// The subset of a service's state that Zenith cares about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceState {
    Stopped,
    StartPending,
    StopPending,
    Running,
    ContinuePending,
    PausePending,
    Paused,
    Unknown,
}

impl ServiceState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::StartPending => "start_pending",
            Self::StopPending => "stop_pending",
            Self::Running => "running",
            Self::ContinuePending => "continue_pending",
            Self::PausePending => "pause_pending",
            Self::Paused => "paused",
            Self::Unknown => "unknown",
        }
    }

    pub const fn is_running(self) -> bool {
        matches!(self, Self::Running)
    }

    /// A state the SCM will leave on its own.
    pub const fn is_transitional(self) -> bool {
        matches!(
            self,
            Self::StartPending | Self::StopPending | Self::ContinuePending | Self::PausePending
        )
    }

    #[cfg(windows)]
    fn from_raw(raw: u32) -> Self {
        match raw {
            1 => Self::Stopped,
            2 => Self::StartPending,
            3 => Self::StopPending,
            4 => Self::Running,
            5 => Self::ContinuePending,
            6 => Self::PausePending,
            7 => Self::Paused,
            _ => Self::Unknown,
        }
    }
}

/// A service as observed at one instant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceSnapshot {
    pub name: String,
    pub state: ServiceState,
    /// Process id hosting the service, `0` when not running.
    pub process_id: u32,
    /// `true` when the SCM accepted a start (`SERVICE_ACCEPT_STOP` etc. is not
    /// enough; this is what makes "restart" meaningful).
    pub can_stop: bool,
}

impl ServiceSnapshot {
    /// The record stored in a `service_state_backup` snapshot.
    ///
    /// Deliberately minimal: a name plus the state. Nothing here can be used to
    /// escalate, which is why a tampered snapshot can only cause a no-op
    /// (`ADR-007`).
    pub fn to_payload_value(&self) -> String {
        format!("{}:{}", self.name, self.state.as_str())
    }
}

/// Waits that are long enough for a heavy service and short enough that the UI
/// is not lying about being busy.
pub const DEFAULT_START_TIMEOUT: Duration = Duration::from_secs(30);
pub const DEFAULT_STOP_TIMEOUT: Duration = Duration::from_secs(30);

/// How often the wait loop re-queries.
const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Query one service's current state.
#[cfg(windows)]
pub fn query(service_name: &str) -> ZenithResult<ServiceSnapshot> {
    imp::with_service(service_name, |handle| imp::status(handle, service_name))
}

#[cfg(not(windows))]
pub fn query(_service_name: &str) -> ZenithResult<ServiceSnapshot> {
    Err(crate::adapters::unsupported("services.query"))
}

/// Start a service and wait until it is running or the deadline passes.
#[cfg(windows)]
pub fn start(service_name: &str, timeout: Duration) -> ZenithResult<ServiceSnapshot> {
    let snapshot = query(service_name)?;
    match snapshot.state {
        ServiceState::Running => return Ok(snapshot), // idempotent
        ServiceState::StartPending => {
            return wait_for(service_name, ServiceState::Running, timeout);
        }
        _ => {}
    }

    imp::with_service(service_name, |handle| {
        use windows::Win32::System::Services::StartServiceW;
        // SAFETY: `handle` is an open service handle owned by `with_service`,
        // and `None` passes a null argument vector, which the API documents.
        let started = unsafe { StartServiceW(handle, None) };
        if let Err(err) = started {
            // 1056 = ERROR_SERVICE_ALREADY_RUNNING - a race we can accept.
            if err.code().0 as u32 != 1056 {
                return Err(service_error(service_name, err, "start"));
            }
        }
        Ok(())
    })?;

    wait_for(service_name, ServiceState::Running, timeout)
}

#[cfg(not(windows))]
pub fn start(_service_name: &str, _timeout: Duration) -> ZenithResult<ServiceSnapshot> {
    Err(crate::adapters::unsupported("services.start"))
}

/// Stop a service and wait until it is stopped or the deadline passes.
#[cfg(windows)]
pub fn stop(service_name: &str, timeout: Duration) -> ZenithResult<ServiceSnapshot> {
    let snapshot = query(service_name)?;
    match snapshot.state {
        ServiceState::Stopped => return Ok(snapshot), // idempotent
        ServiceState::StopPending => return wait_for(service_name, ServiceState::Stopped, timeout),
        _ => {}
    }
    if !snapshot.can_stop {
        return Err(ZenithError::new(ErrorCode::ServiceUnavailable)
            .with("service", service_name.to_string())
            .with("reason", "does not accept a stop control"));
    }

    imp::with_service(service_name, |handle| {
        use windows::Win32::System::Services::{
            ControlService, SERVICE_CONTROL_STOP, SERVICE_STATUS,
        };
        let mut status = SERVICE_STATUS::default();
        // SAFETY: `handle` is valid; `status` is a live local of the exact type
        // the call writes.
        let result = unsafe { ControlService(handle, SERVICE_CONTROL_STOP, &mut status) };
        if let Err(err) = result {
            // Already stopped is success for a "make sure it is stopped" call.
            if crate::adapters::win32_code(&err) != crate::adapters::win32::SERVICE_NOT_ACTIVE {
                return Err(service_error(service_name, err, "stop"));
            }
        }
        Ok(())
    })?;

    wait_for(service_name, ServiceState::Stopped, timeout)
}

#[cfg(not(windows))]
pub fn stop(_service_name: &str, _timeout: Duration) -> ZenithResult<ServiceSnapshot> {
    Err(crate::adapters::unsupported("services.stop"))
}

/// Restart, reporting which half failed.
///
/// Returns `(before, after)` so the caller can put a truthful "was running, is
/// running" pair into the snapshot and the outcome card.
#[cfg(windows)]
pub fn restart(
    service_name: &str,
    start_timeout: Duration,
    stop_timeout: Duration,
) -> ZenithResult<(ServiceSnapshot, ServiceSnapshot)> {
    let before = query(service_name)?;

    if before.state.is_running() {
        stop(service_name, stop_timeout)?;
    }

    let after = start(service_name, start_timeout)?;
    if !after.state.is_running() {
        return Err(ZenithError::new(ErrorCode::ServiceUnavailable)
            .with("service", service_name.to_string())
            .with("state", after.state.as_str().to_string())
            .with("phase", "start"));
    }
    Ok((before, after))
}

#[cfg(not(windows))]
pub fn restart(
    _service_name: &str,
    _start_timeout: Duration,
    _stop_timeout: Duration,
) -> ZenithResult<(ServiceSnapshot, ServiceSnapshot)> {
    Err(crate::adapters::unsupported("services.restart"))
}

/// Poll until `wanted` is reached, or the deadline passes.
///
/// Public and Windows-independent so the wait semantics are testable with a
/// closure instead of a real service.
pub fn poll_until<F>(
    mut observe: F,
    wanted: ServiceState,
    timeout: Duration,
) -> ZenithResult<ServiceState>
where
    F: FnMut() -> ZenithResult<ServiceState>,
{
    let deadline = Instant::now() + timeout;
    let mut last;

    loop {
        let state = observe()?;
        last = state;
        if state == wanted {
            return Ok(state);
        }
        // A terminal state that is not what we wanted is a real failure, not a
        // reason to keep waiting.
        if !state.is_transitional() && state != wanted && state != ServiceState::Unknown {
            if state == ServiceState::Stopped && wanted == ServiceState::Running {
                // The service may still be spinning up on a slow disk; one more
                // poll after a beat is kinder than an instant error.
            } else {
                return Err(ZenithError::new(ErrorCode::ServiceUnavailable)
                    .with("wanted", wanted.as_str().to_string())
                    .with("actual", state.as_str().to_string()));
            }
        }
        if Instant::now() >= deadline {
            return Err(ZenithError::new(ErrorCode::Timeout)
                .with("wanted", wanted.as_str().to_string())
                .with("lastState", last.as_str().to_string())
                .with("seconds", timeout.as_secs().to_string()));
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

#[cfg(windows)]
fn wait_for(
    service_name: &str,
    wanted: ServiceState,
    timeout: Duration,
) -> ZenithResult<ServiceSnapshot> {
    poll_until(
        || query(service_name).map(|snapshot| snapshot.state),
        wanted,
        timeout,
    )?;
    query(service_name)
}

#[cfg(windows)]
fn service_error(service_name: &str, err: windows::core::Error, operation: &str) -> ZenithError {
    // `err.code()` is an HRESULT, not a Win32 code. `OpenServiceW` reports
    // `ERROR_SERVICE_DOES_NOT_EXIST` as 0x80070424 (FACILITY_WIN32, 1060), so
    // comparing the raw i32 was silently classifying every missing service as
    // `Internal`. Strip the facility to recover the original Win32 code.
    let hresult = err.code().0 as u32;
    let raw = crate::adapters::win32_code(&err);
    let code = match raw {
        crate::adapters::win32::ACCESS_DENIED => ErrorCode::AccessDenied,
        crate::adapters::win32::SERVICE_DOES_NOT_EXIST => ErrorCode::ServiceUnavailable,
        _ => ErrorCode::Internal,
    };
    ZenithError::new(code)
        .with("service", service_name.to_string())
        .with("operation", operation.to_string())
        .detail(format!("win32={raw} (hresult=0x{hresult:08X})"))
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows::Win32::System::Services::{
        CloseServiceHandle, OpenSCManagerW, OpenServiceW, QueryServiceStatusEx, SC_HANDLE,
        SC_MANAGER_CONNECT, SC_STATUS_PROCESS_INFO, SERVICE_QUERY_STATUS, SERVICE_STATUS_PROCESS,
        SERVICE_STATUS_PROCESS as StatusProcess,
    };
    use windows::core::PCWSTR;

    /// Open the SCM, open the service, run `body`, close both.
    ///
    /// Closing is handled here once so no error path can leak a handle.
    pub(super) fn with_service<T>(
        service_name: &str,
        body: impl FnOnce(SC_HANDLE) -> ZenithResult<T>,
    ) -> ZenithResult<T> {
        let name_wide: Vec<u16> = service_name.encode_utf16().chain(Some(0)).collect();

        // SAFETY: null machine/database names select the local SCM; the returned
        // handle is checked and closed below.
        let manager: SC_HANDLE =
            unsafe { OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_CONNECT) }
                .map_err(|err| service_error(service_name, err, "open_scm"))?;

        // SAFETY: `manager` is valid; `name_wide` is NUL-terminated and lives
        // for the call.
        let service =
            unsafe { OpenServiceW(manager, PCWSTR(name_wide.as_ptr()), SERVICE_QUERY_STATUS) };
        let service = match service {
            Ok(handle) => handle,
            Err(err) => {
                // SAFETY: `manager` came from a successful `OpenSCManagerW`.
                unsafe {
                    let _ = CloseServiceHandle(manager);
                }
                return Err(service_error(service_name, err, "open_service"));
            }
        };

        let result = body(service);
        // SAFETY: both handles are valid and owned by this function.
        unsafe {
            let _ = CloseServiceHandle(service);
            let _ = CloseServiceHandle(manager);
        }
        result
    }

    pub(super) fn status(handle: SC_HANDLE, service_name: &str) -> ZenithResult<ServiceSnapshot> {
        let mut status = StatusProcess::default();
        let mut needed = 0u32;

        // SAFETY: `handle` is valid; the buffer is exactly the size the API is
        // told, and both out-parameters are live locals.
        let queried = unsafe {
            QueryServiceStatusEx(
                handle,
                SC_STATUS_PROCESS_INFO,
                Some(std::slice::from_raw_parts_mut(
                    &mut status as *mut SERVICE_STATUS_PROCESS as *mut u8,
                    std::mem::size_of::<SERVICE_STATUS_PROCESS>(),
                )),
                &mut needed,
            )
        };
        queried.map_err(|err| service_error(service_name, err, "query_status"))?;

        Ok(ServiceSnapshot {
            name: service_name.to_string(),
            state: ServiceState::from_raw(status.dwCurrentState.0),
            process_id: status.dwProcessId,
            // SERVICE_ACCEPT_STOP is bit 0 of dwControlsAccepted.
            can_stop: status.dwControlsAccepted & 1 != 0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alternative_states_are_classified_correctly() {
        assert!(ServiceState::Running.is_running());
        assert!(!ServiceState::Stopped.is_running());
        assert!(ServiceState::StartPending.is_transitional());
        assert!(ServiceState::StopPending.is_transitional());
        assert!(!ServiceState::Running.is_transitional());
        assert!(!ServiceState::Paused.is_transitional());
    }

    #[test]
    fn state_strings_are_stable() {
        assert_eq!(ServiceState::Running.as_str(), "running");
        assert_eq!(ServiceState::Stopped.as_str(), "stopped");
        assert_eq!(ServiceState::Unknown.as_str(), "unknown");
    }

    #[test]
    fn poll_until_returns_as_soon_as_the_target_is_reached() {
        let mut calls = 0;
        let state = poll_until(
            || {
                calls += 1;
                if calls >= 2 {
                    Ok(ServiceState::Running)
                } else {
                    Ok(ServiceState::StartPending)
                }
            },
            ServiceState::Running,
            Duration::from_secs(5),
        )
        .expect("poll");
        assert_eq!(state, ServiceState::Running);
        assert_eq!(calls, 2);
    }

    #[test]
    fn poll_until_times_out_instead_of_spinning_forever() {
        let err = poll_until(
            || Ok(ServiceState::StartPending),
            ServiceState::Running,
            Duration::from_millis(60),
        )
        .unwrap_err();
        assert!(err.is(ErrorCode::Timeout));
        assert_eq!(
            err.params.get("lastState").map(String::as_str),
            Some("start_pending")
        );
    }

    #[test]
    fn poll_until_fails_fast_on_a_wrong_terminal_state() {
        let err = poll_until(
            || Ok(ServiceState::Stopped),
            ServiceState::Paused,
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert!(err.is(ErrorCode::ServiceUnavailable));
    }

    #[test]
    fn poll_until_propagates_an_observation_error() {
        let err = poll_until(
            || Err(ZenithError::new(ErrorCode::AccessDenied)),
            ServiceState::Running,
            Duration::from_secs(1),
        )
        .unwrap_err();
        assert!(err.is(ErrorCode::AccessDenied));
    }

    #[test]
    fn the_snapshot_payload_is_name_and_state_only() {
        let snapshot = ServiceSnapshot {
            name: "Spooler".into(),
            state: ServiceState::Running,
            process_id: 1234,
            can_stop: true,
        };
        // No pid, no path: a tampered snapshot cannot name a new target.
        assert_eq!(snapshot.to_payload_value(), "Spooler:running");
        assert!(!snapshot.to_payload_value().contains("1234"));
    }

    #[cfg(windows)]
    #[test]
    fn querying_the_spooler_succeeds() {
        let snapshot = query("Spooler").expect("spooler exists on every Windows install");
        assert_eq!(snapshot.name, "Spooler");
        assert!(!snapshot.state.as_str().is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn querying_a_bogus_service_is_service_unavailable() {
        let err = query("ZenithDefinitelyNotAService").unwrap_err();
        assert!(
            err.is(ErrorCode::ServiceUnavailable) || err.is(ErrorCode::AccessDenied),
            "{err:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn starting_an_already_running_service_is_idempotent() {
        // The SCM itself is always running and unaffected by a start request.
        if let Ok(before) = query("RpcSs")
            && before.state.is_running()
        {
            let after = start("RpcSs", Duration::from_secs(5)).expect("idempotent start");
            assert!(after.state.is_running());
        }
    }
}
