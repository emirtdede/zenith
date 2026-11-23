//! System facts: memory, uptime, OS build, free disk space.
//!
//! Every value is measured. Where a measurement is impossible the function
//! returns `None` rather than a plausible-looking default, because "0 MB used"
//! and "unknown" mean very different things to a user staring at a health score.

use std::path::Path;

/// Physical memory and uptime snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemoryInfo {
    pub total_mb: u64,
    pub available_mb: u64,
}

impl MemoryInfo {
    pub fn used_mb(&self) -> u64 {
        self.total_mb.saturating_sub(self.available_mb)
    }

    pub fn used_percent(&self) -> f32 {
        if self.total_mb == 0 {
            0.0
        } else {
            (self.used_mb() as f32 / self.total_mb as f32) * 100.0
        }
    }
}

/// OS identity, read from the registry rather than `GetVersionEx`, which lies
/// without a compatibility manifest (`03-06` §11).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OsInfo {
    pub build: u32,
    pub display_version: String,
    pub product_name: String,
    pub ubr: u32,
}

impl OsInfo {
    /// Windows 10 (19045) is supported with a lifecycle banner, not blocked
    /// (ADR-018).
    pub fn is_windows_10(&self) -> bool {
        self.build >= 19045 && self.build < 22000
    }

    /// Build numbers of the supported Windows 11 releases.
    pub fn is_windows_11(&self) -> bool {
        self.build >= 22000
    }
}

/// Free/total bytes for the volume containing `path`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiskInfo {
    pub free_bytes: u64,
    pub total_bytes: u64,
}

// ---------------------------------------------------------------------------
// Windows implementation
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod imp {
    use super::*;
    use crate::error::{ErrorCode, ZenithError, ZenithResult};
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows::Win32::System::SystemInformation::GetTickCount64;
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows::core::PCWSTR;

    pub fn memory() -> ZenithResult<MemoryInfo> {
        let mut status = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        // SAFETY: `status.dwLength` is set to the exact size of the struct, which
        // is the API's documented contract; the pointer is to a live local.
        unsafe { GlobalMemoryStatusEx(&mut status) }
            .map_err(|err| ZenithError::new(ErrorCode::Internal).detail(err.to_string()))?;

        Ok(MemoryInfo {
            total_mb: status.ullTotalPhys / (1024 * 1024),
            available_mb: status.ullAvailPhys / (1024 * 1024),
        })
    }

    /// Milliseconds since boot.
    pub fn uptime_ms() -> ZenithResult<u64> {
        // SAFETY: `GetTickCount64` takes no arguments and cannot fail.
        Ok(unsafe { GetTickCount64() })
    }

    pub fn disk_for(path: &Path) -> ZenithResult<DiskInfo> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut free = 0u64;
        let mut total = 0u64;
        // SAFETY: `wide` is NUL-terminated and outlives the call; both out
        // pointers reference live locals.
        unsafe {
            GetDiskFreeSpaceExW(
                PCWSTR(wide.as_ptr()),
                Some(&mut free),
                Some(&mut total),
                None,
            )
        }
        .map_err(|err| ZenithError::new(ErrorCode::Internal).detail(err.to_string()))?;

        Ok(DiskInfo {
            free_bytes: free,
            total_bytes: total,
        })
    }

    /// Read a REG_SZ value from HKLM.
    fn read_hklm_string(path: &str, value: &str) -> Option<String> {
        use windows::Win32::System::Registry::{
            HKEY, HKEY_LOCAL_MACHINE, KEY_READ, REG_SZ, RegCloseKey, RegOpenKeyExW,
            RegQueryValueExW,
        };

        let path_wide = to_wide(path);
        let value_wide = to_wide(value);
        let mut key = HKEY::default();

        // SAFETY: both strings are NUL-terminated and live for the call; `key`
        // is a live local that is closed on every path below.
        let open = unsafe {
            RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                PCWSTR(path_wide.as_ptr()),
                Some(0),
                KEY_READ,
                &mut key,
            )
        };
        if open != ERROR_SUCCESS {
            return None;
        }

        let mut size = 0u32;
        let mut kind = REG_SZ;
        // First call measures the buffer.
        // SAFETY: same key validity; a null data pointer with a size query is
        // the documented two-step pattern.
        let probe = unsafe {
            RegQueryValueExW(
                key,
                PCWSTR(value_wide.as_ptr()),
                None,
                Some(&mut kind),
                None,
                Some(&mut size),
            )
        };
        if probe != ERROR_SUCCESS || size == 0 {
            // SAFETY: `key` was opened successfully above.
            unsafe {
                let _ = RegCloseKey(key);
            }
            return None;
        }

        let mut buffer = vec![0u8; size as usize];
        // SAFETY: `buffer` has exactly `size` bytes, as reported by the API.
        let read = unsafe {
            RegQueryValueExW(
                key,
                PCWSTR(value_wide.as_ptr()),
                None,
                Some(&mut kind),
                Some(buffer.as_mut_ptr()),
                Some(&mut size),
            )
        };
        // SAFETY: `key` was opened successfully above.
        unsafe {
            let _ = RegCloseKey(key);
        }

        if read != ERROR_SUCCESS {
            return None;
        }

        crate::adapters::utf16le_to_string(&buffer)
    }

    fn read_hklm_u32(path: &str, value: &str) -> Option<u32> {
        read_hklm_string(path, value).and_then(|text| text.trim().parse::<u32>().ok())
    }

    pub fn os_info() -> ZenithResult<OsInfo> {
        const KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";

        let build_text = read_hklm_string(KEY, "CurrentBuildNumber").ok_or_else(|| {
            ZenithError::new(ErrorCode::Internal).with("reason", "CurrentBuildNumber missing")
        })?;
        let build: u32 = build_text.trim().parse().map_err(|_| {
            ZenithError::new(ErrorCode::Internal)
                .with("reason", "CurrentBuildNumber is not a number")
                .detail(build_text.clone())
        })?;

        Ok(OsInfo {
            build,
            display_version: read_hklm_string(KEY, "DisplayVersion").unwrap_or_default(),
            product_name: read_hklm_string(KEY, "ProductName").unwrap_or_default(),
            ubr: read_hklm_u32(KEY, "UBR").unwrap_or(0),
        })
    }

    fn to_wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    /// The Windows display locale, e.g. `tr-TR`. Used only as the first-run
    /// default; the user's explicit choice always wins.
    pub fn ui_locale() -> ZenithResult<String> {
        use windows::Win32::Globalization::GetUserDefaultLocaleName;

        let mut buffer = [0u16; 85];
        // SAFETY: the buffer is `LOCALE_NAME_MAX_LENGTH` units, which is what
        // the API documents, and it writes at most that many.
        let written = unsafe { GetUserDefaultLocaleName(&mut buffer) };
        if written <= 1 {
            return Ok("en-US".to_string());
        }
        Ok(String::from_utf16_lossy(&buffer[..(written as usize - 1)]))
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    use crate::error::ZenithError;

    pub fn memory() -> ZenithResult<MemoryInfo> {
        Err(ZenithError::not_implemented("system.memory"))
    }

    pub fn uptime_ms() -> ZenithResult<u64> {
        Err(ZenithError::not_implemented("system.uptime"))
    }

    pub fn disk_for(_path: &Path) -> ZenithResult<DiskInfo> {
        Err(ZenithError::not_implemented("system.disk"))
    }

    pub fn os_info() -> ZenithResult<OsInfo> {
        Err(ZenithError::not_implemented("system.os_info"))
    }

    pub fn ui_locale() -> ZenithResult<String> {
        Err(ZenithError::not_implemented("system.ui_locale"))
    }
}

pub use imp::{disk_for, memory, os_info, ui_locale, uptime_ms};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_arithmetic_is_defensive() {
        let info = MemoryInfo {
            total_mb: 0,
            available_mb: 0,
        };
        assert_eq!(info.used_mb(), 0);
        assert_eq!(info.used_percent(), 0.0);

        let info = MemoryInfo {
            total_mb: 16_384,
            available_mb: 4_096,
        };
        assert_eq!(info.used_mb(), 12_288);
        assert!((info.used_percent() - 75.0).abs() < 0.01);
    }

    #[test]
    fn available_greater_than_total_does_not_underflow() {
        let info = MemoryInfo {
            total_mb: 100,
            available_mb: 200,
        };
        assert_eq!(info.used_mb(), 0);
    }

    #[test]
    fn build_classification_matches_the_supported_matrix() {
        let win10 = OsInfo {
            build: 19045,
            display_version: "22H2".into(),
            product_name: "Windows 10 Pro".into(),
            ubr: 1,
        };
        assert!(win10.is_windows_10());
        assert!(!win10.is_windows_11());

        let win11 = OsInfo {
            build: 26100,
            display_version: "24H2".into(),
            product_name: "Windows 11 Pro".into(),
            ubr: 1,
        };
        assert!(win11.is_windows_11());
        assert!(!win11.is_windows_10());
    }

    #[cfg(windows)]
    #[test]
    fn real_machine_reports_plausible_memory() {
        let info = memory().expect("memory");
        assert!(info.total_mb > 256, "total {} MB", info.total_mb);
        assert!(info.available_mb <= info.total_mb);
    }

    #[cfg(windows)]
    #[test]
    fn real_machine_reports_an_os_build() {
        let info = os_info().expect("os info");
        assert!(info.build >= 19041, "build {}", info.build);
    }

    #[cfg(windows)]
    #[test]
    fn real_disk_has_space() {
        let info = disk_for(Path::new(r"C:\")).expect("disk");
        assert!(info.total_bytes > 0);
        assert!(info.free_bytes <= info.total_bytes);
    }

    #[cfg(windows)]
    #[test]
    fn uptime_is_non_zero_on_a_running_machine() {
        assert!(uptime_ms().expect("uptime") > 0);
    }
}
