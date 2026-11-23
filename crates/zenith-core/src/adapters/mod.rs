//! Operating-system adapters.
//!
//! This is the **only** layer permitted to call the OS, and the only place
//! `unsafe` is allowed (see `docs/03-architecture/03-06-win32-ffi-safety.md`).
//! Everything above it deals in plain data.
//!
//! Division of responsibility:
//!
//! | Module | Owns |
//! | :--- | :--- |
//! | [`system`] | Memory, uptime, OS build, disk space |
//! | [`privilege`] | Elevation detection |
//! | [`process`] | Local port listeners, process identity, verified termination |
//! | [`cleanup`] | Temp scanning and deletion, recycle-bin stats |
//! | [`services`] | Service state read/write/restart |
//! | [`child`] | Cancellable, time-boxed child processes in a job object |
//! | [`probes`] | The 22 diagnostic probes, one function per action |
//! | [`actions`] | The 22 execution paths |
//!
//! Every Windows call is behind `#[cfg(windows)]`. On any other target the
//! module returns `NotImplemented` - never `Ok(())`, which is the silent-success
//! stub that v1.0.0 hid behind `#[cfg(not(windows))]`.

pub mod actions;
pub mod candidates;
pub mod child;
pub mod cleanup;
pub mod console;
pub mod dpapi;
pub mod privilege;
pub mod probes;
pub mod process;
pub mod services;
pub mod system;

/// Capability probe result, used by the UI to disable what cannot work on this
/// machine instead of failing at click time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capability {
    pub available: bool,
    pub reason: &'static str,
}

impl Capability {
    pub const AVAILABLE: Self = Self {
        available: true,
        reason: "",
    };

    pub const fn unavailable(reason: &'static str) -> Self {
        Self {
            available: false,
            reason,
        }
    }
}

/// Returned by every adapter that needs Windows when running elsewhere.
pub fn unsupported(feature: &str) -> crate::error::ZenithError {
    crate::error::ZenithError::not_implemented(feature)
}

/// Recover the original Win32 error code from a `windows` crate error.
///
/// The `windows` crate surfaces Win32 failures as `HRESULT`, where the real
/// code lives in the low 16 bits under `FACILITY_WIN32` (0x8007xxxx). Comparing
/// the raw `i32` against a Win32 constant therefore never matches - the exact
/// bug that made a missing service report `Internal` and an access-denied
/// process report `ProcessGone`. Every adapter routes error codes through here.
#[cfg(windows)]
pub fn win32_code(err: &windows::core::Error) -> u32 {
    let hresult = err.code().0 as u32;
    if hresult & 0xFFFF_0000 == 0x8007_0000 {
        hresult & 0x0000_FFFF
    } else {
        hresult
    }
}

/// Win32 codes the adapters branch on, named once so no module re-derives them.
pub mod win32 {
    pub const ACCESS_DENIED: u32 = 5;
    pub const INVALID_PARAMETER: u32 = 87;
    pub const FILE_NOT_FOUND: u32 = 2;
    pub const SHARING_VIOLATION: u32 = 32;
    pub const SERVICE_DOES_NOT_EXIST: u32 = 1060;
    pub const SERVICE_NOT_ACTIVE: u32 = 1062;
}

/// Decode a NUL-terminated UTF-16LE byte buffer into a `String`.
///
/// `RegQueryValueExW` hands back raw bytes even for `REG_SZ`, and three adapters
/// need the same conversion. An odd trailing byte is ignored rather than
/// treated as corruption: the registry guarantees an even length, so a stray
/// byte can only come from a truncated read, and dropping it is the only
/// non-panicking behaviour. Returns `None` on unpaired surrogates.
pub fn utf16le_to_string(bytes: &[u8]) -> Option<String> {
    let mut units = Vec::with_capacity(bytes.len() / 2);
    let mut index = 0;
    while index + 1 < bytes.len() {
        let unit = u16::from_le_bytes([bytes[index], bytes[index + 1]]);
        if unit == 0 {
            break;
        }
        units.push(unit);
        index += 2;
    }
    String::from_utf16(&units).ok()
}
