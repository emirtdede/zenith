//! Elevation detection.
//!
//! The only trustworthy source is the process token, never the username - a
//! member of Administrators running unelevated is still a standard token, and a
//! tool that assumes otherwise shows a false "ready" state on a privileged
//! action (`REQ-F-006`).

/// Whether the current process token is elevated.
///
/// Returns `false` on a non-Windows target, which is also where every privileged
/// adapter refuses to run, so the two agree.
#[cfg(windows)]
pub fn is_elevated() -> bool {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token = HANDLE::default();
    // SAFETY: `GetCurrentProcess` returns a pseudo-handle that must not be
    // closed; `token` is a live local closed below.
    let opened = unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) };
    if opened.is_err() {
        return false;
    }

    let mut elevation = TOKEN_ELEVATION::default();
    let mut returned = 0u32;
    // SAFETY: `elevation` is exactly the size passed, and `token` is valid.
    let queried = unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut core::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        )
    };
    // SAFETY: `token` came from a successful `OpenProcessToken`.
    unsafe {
        let _ = CloseHandle(token);
    }

    queried.is_ok() && elevation.TokenIsElevated != 0
}

#[cfg(not(windows))]
pub fn is_elevated() -> bool {
    false
}

/// The SID of the account behind a process token, as a string.
///
/// Used only by the elevation handover, which must prove that the elevated
/// instance's owner is the same user that asked for elevation (DEF-009). A PID
/// alone proves nothing: PIDs are recycled.
#[cfg(windows)]
pub fn sid_for_pid(pid: u32) -> Option<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Security::TOKEN_QUERY;
    use windows::Win32::System::Threading::{
        OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    if pid == 0 {
        return None;
    }
    // SAFETY: no Rust memory is dereferenced; the handle is closed below.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut token = windows::Win32::Foundation::HANDLE::default();
    // SAFETY: `process` is a live handle and `token` is an out-parameter.
    let opened = unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) };
    // SAFETY: the process handle is no longer needed.
    unsafe {
        let _ = CloseHandle(process);
    }
    if opened.is_err() {
        return None;
    }
    let sid = token_sid_string(token);
    // SAFETY: the token handle came from a successful `OpenProcessToken`.
    unsafe {
        let _ = CloseHandle(token);
    }
    sid
}

/// The SID of the current process token.
#[cfg(windows)]
pub fn current_sid() -> Option<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Security::TOKEN_QUERY;
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token = windows::Win32::Foundation::HANDLE::default();
    // SAFETY: the pseudo-handle must not be closed; `token` is closed below.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }.is_err() {
        return None;
    }
    let sid = token_sid_string(token);
    // SAFETY: `token` was opened above and is closed exactly once.
    unsafe {
        let _ = CloseHandle(token);
    }
    sid
}

#[cfg(windows)]
fn token_sid_string(token: windows::Win32::Foundation::HANDLE) -> Option<String> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Security::{GetTokenInformation, TOKEN_USER, TokenUser};
    use windows::core::PWSTR;

    let mut needed = 0u32;
    // SAFETY: a sizing call with a null buffer is the documented pattern; the
    // returned length is used to allocate below.
    let _ = unsafe { GetTokenInformation(token, TokenUser, None, 0, &mut needed) };
    if needed == 0 {
        return None;
    }
    let mut buffer = vec![0u8; needed as usize];
    // SAFETY: `buffer` is exactly `needed` bytes, which is what is passed.
    unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            Some(buffer.as_mut_ptr().cast()),
            needed,
            &mut needed,
        )
    }
    .ok()?;

    // SAFETY: the API wrote a `TOKEN_USER` at the start of the buffer.
    let user = unsafe { &*(buffer.as_ptr().cast::<TOKEN_USER>()) };
    let mut text = PWSTR::null();
    // SAFETY: `user.User.Sid` points into `buffer`, which is still alive.
    unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) }.ok()?;
    // SAFETY: the API allocated the string with `LocalAlloc`.
    let value = unsafe { text.to_string() }.ok();
    // SAFETY: the string came from `ConvertSidToStringSidW` and is freed once.
    unsafe {
        LocalFree(Some(HLOCAL(text.0.cast())));
    }
    value
}

#[cfg(not(windows))]
pub fn sid_for_pid(_pid: u32) -> Option<String> {
    None
}

#[cfg(not(windows))]
pub fn current_sid() -> Option<String> {
    None
}

/// The honest capability statement for an action on this process.
pub fn capability_for(requires_admin: bool, elevated: bool) -> crate::adapters::Capability {
    if requires_admin && !elevated {
        crate::adapters::Capability::unavailable("elevation_required")
    } else {
        crate::adapters::Capability::AVAILABLE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_reflects_elevation_honestly() {
        assert!(!capability_for(true, false).available);
        assert!(capability_for(true, true).available);
        assert!(capability_for(false, false).available);
    }

    #[cfg(windows)]
    #[test]
    fn elevation_detection_returns_a_bool_without_panicking() {
        // Either answer is valid depending on how the test process was started;
        // what matters is that the call is safe and definitive.
        let _ = is_elevated();
    }
}
