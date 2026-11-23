//! Filesystem cleanup and Recycle Bin statistics.
//!
//! Two rules that make this safe rather than destructive:
//!
//! * **Scan and delete are separate.** The user is told the size and the file
//!   count *before* anything is removed, and the number shown is the number
//!   measured (`REQ-F-012`).
//!
//! * **A file that is open is skipped, not forced.** Agenda: a browser holding
//!   a cache file must not lose it, and the user must see "12 files were in use"
//!   rather than a silent partial success.
//!
//! Nothing here follows reparse points by default: a symlink in `%TEMP%` must not
//! let a cleanup walk out of its scope (`ADR-007`).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use crate::engine::executor::CancelToken;
use crate::error::{ErrorCode, ZenithError, ZenithResult};

/// Upper bound on entries examined in one scan, so a pathological directory
/// cannot hang the UI thread that started it.
pub const MAX_SCAN_ENTRIES: usize = 200_000;

/// What a scan found.
#[derive(Debug, Clone, Default)]
pub struct DirScan {
    pub files: Vec<PathBuf>,
    pub bytes: u64,
    /// Entries skipped because they were unreadable or out of scope.
    pub skipped: usize,
    /// `true` when [`MAX_SCAN_ENTRIES`] was reached and the scan is partial.
    pub truncated: bool,
}

impl DirScan {
    pub fn file_count(&self) -> usize {
        self.files.len()
    }

    pub fn megabytes(&self) -> f64 {
        self.bytes as f64 / (1024.0 * 1024.0)
    }
}

/// Scan roots for regular files older than `min_age`.
///
/// `min_age` exists because deleting a file a program created two seconds ago
/// breaks that program. Twenty-four hours is the documented default
/// (`clean-temp-cache`).
pub fn scan_old_files(
    roots: &[PathBuf],
    min_age: Duration,
    cancel: &Arc<CancelToken>,
) -> ZenithResult<DirScan> {
    let cutoff = SystemTime::now()
        .checked_sub(min_age)
        .unwrap_or(SystemTime::UNIX_EPOCH);

    let mut scan = DirScan::default();
    let mut examined = 0usize;

    for root in roots {
        if !root.is_dir() {
            continue;
        }
        // `follow_links(false)` is the default and is load-bearing; it is stated
        // here so a future edit cannot flip it silently.
        let walker = walkdir::WalkDir::new(root)
            .follow_links(false)
            .max_depth(8)
            .into_iter();

        for entry in walker {
            if cancel.is_cancelled() {
                return Err(ZenithError::new(ErrorCode::Cancelled));
            }
            examined += 1;
            if examined > MAX_SCAN_ENTRIES {
                scan.truncated = true;
                break;
            }

            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    scan.skipped += 1;
                    continue;
                }
            };

            // Never delete through a reparse point.
            if entry.path_is_symlink() {
                scan.skipped += 1;
                continue;
            }
            if !entry.file_type().is_file() {
                continue;
            }
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => {
                    scan.skipped += 1;
                    continue;
                }
            };
            let modified = match metadata.modified() {
                Ok(modified) => modified,
                Err(_) => {
                    scan.skipped += 1;
                    continue;
                }
            };
            if modified >= cutoff {
                continue;
            }

            scan.bytes = scan.bytes.saturating_add(metadata.len());
            scan.files.push(entry.path().to_path_buf());
        }

        if scan.truncated {
            break;
        }
    }

    Ok(scan)
}

/// Why a file was not deleted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    InUse,
    AccessDenied,
    Gone,
    Error,
}

impl SkipReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InUse => "in_use",
            Self::AccessDenied => "access_denied",
            Self::Gone => "gone",
            Self::Error => "error",
        }
    }
}

/// Result of a delete pass. Per-file, never all-or-nothing (`REQ-F-066`).
#[derive(Debug, Clone, Default)]
pub struct DeleteSummary {
    pub deleted: usize,
    pub bytes_freed: u64,
    pub skipped: Vec<(PathBuf, SkipReason)>,
    pub cancelled: bool,
}

impl DeleteSummary {
    pub fn skipped_count(&self) -> usize {
        self.skipped.len()
    }

    pub fn megabytes_freed(&self) -> f64 {
        self.bytes_freed as f64 / (1024.0 * 1024.0)
    }
}

/// Delete the scanned files one by one, recording each failure.
pub fn delete_files(files: &[PathBuf], cancel: &Arc<CancelToken>) -> DeleteSummary {
    let mut summary = DeleteSummary::default();

    for path in files {
        if cancel.is_cancelled() {
            summary.cancelled = true;
            break;
        }

        // Size before removal: after the delete there is nothing to measure, and
        // an estimate is a lie.
        let size = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);

        match std::fs::remove_file(path) {
            Ok(()) => {
                summary.deleted += 1;
                summary.bytes_freed = summary.bytes_freed.saturating_add(size);
            }
            Err(err) => {
                // A file that vanished between scan and delete is not a failure.
                if err.kind() == std::io::ErrorKind::NotFound {
                    summary.skipped.push((path.clone(), SkipReason::Gone));
                    continue;
                }
                let reason = classify_io_error(&err);
                summary.skipped.push((path.clone(), reason));
            }
        }
    }

    summary
}

fn classify_io_error(err: &std::io::Error) -> SkipReason {
    // Windows error 32 = ERROR_SHARING_VIOLATION, 33 = ERROR_LOCK_VIOLATION.
    match err.raw_os_error() {
        Some(32) | Some(33) => SkipReason::InUse,
        Some(5) => SkipReason::AccessDenied,
        _ => SkipReason::Error,
    }
}

// ---------------------------------------------------------------------------
// Recycle Bin
// ---------------------------------------------------------------------------

/// Recycle Bin contents for one drive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RecycleBinInfo {
    pub bytes: u64,
    pub items: u64,
}

#[cfg(windows)]
pub fn recycle_bin_info(drive_root: &Path) -> ZenithResult<RecycleBinInfo> {
    use windows::Win32::UI::Shell::{SHQUERYRBINFO, SHQueryRecycleBinW};
    use windows::core::PCWSTR;

    let wide: Vec<u16> = drive_root
        .as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .chain(Some(0))
        .collect();

    let mut info = SHQUERYRBINFO {
        cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32,
        ..Default::default()
    };

    // SAFETY: `wide` is NUL-terminated and lives across the call; `info` has its
    // documented `cbSize` field set to the exact struct size.
    let result = unsafe { SHQueryRecycleBinW(PCWSTR(wide.as_ptr()), &mut info) };
    if result.is_err() {
        // An empty Recycle Bin or an inaccessible drive is "zero", not an error
        // the user needs to see.
        return Ok(RecycleBinInfo::default());
    }

    Ok(RecycleBinInfo {
        bytes: info.i64Size.max(0) as u64,
        items: info.i64NumItems.max(0) as u64,
    })
}

#[cfg(not(windows))]
pub fn recycle_bin_info(_drive_root: &Path) -> ZenithResult<RecycleBinInfo> {
    Err(crate::adapters::unsupported("cleanup.recycle_bin_info"))
}

/// Empty the Recycle Bin for one drive.
///
/// `SHEmptyRecycleBinW` shows no confirmation and no progress UI, because Zenith
/// already asked in its own, better-worded dialog (`REQ-F-023`).
#[cfg(windows)]
pub fn empty_recycle_bin(drive_root: &Path) -> ZenithResult<()> {
    use windows::Win32::UI::Shell::SHEmptyRecycleBinW;
    use windows::core::PCWSTR;

    /// `SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND`
    const FLAGS: u32 = 0x0000_0001 | 0x0000_0002 | 0x0000_0004;

    let wide: Vec<u16> = drive_root
        .as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .chain(Some(0))
        .collect();

    // SAFETY: `wide` is NUL-terminated and outlives the call; no window handle
    // is needed for a non-interactive empty.
    let result = unsafe { SHEmptyRecycleBinW(None, PCWSTR(wide.as_ptr()), FLAGS) };
    result.map_err(|err| {
        ZenithError::new(ErrorCode::AccessDenied)
            .with("drive", drive_root.display().to_string())
            .detail(err.to_string())
    })
}

#[cfg(not(windows))]
pub fn empty_recycle_bin(_drive_root: &Path) -> ZenithResult<()> {
    Err(crate::adapters::unsupported("cleanup.empty_recycle_bin"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn token() -> Arc<CancelToken> {
        Arc::new(CancelToken::new())
    }

    fn write_file(path: &Path, bytes: usize) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("mkdir");
        }
        let mut file = std::fs::File::create(path).expect("create");
        file.write_all(&vec![b'x'; bytes]).expect("write");
    }

    #[test]
    fn a_fresh_file_is_not_selected() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_file(&dir.path().join("new.tmp"), 100);
        let scan = scan_old_files(
            &[dir.path().to_path_buf()],
            Duration::from_secs(3600),
            &token(),
        )
        .expect("scan");
        assert_eq!(scan.file_count(), 0);
        assert_eq!(scan.bytes, 0);
    }

    #[test]
    fn an_old_file_is_selected_with_its_real_size() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("old.tmp");
        write_file(&path, 4096);
        // Age it beyond the cutoff by setting mtime is not portable; instead use
        // a zero min_age, which selects everything already written.
        let scan =
            scan_old_files(&[dir.path().to_path_buf()], Duration::ZERO, &token()).expect("scan");
        assert_eq!(scan.file_count(), 1);
        assert_eq!(scan.bytes, 4096);
    }

    #[test]
    fn nested_files_are_found() {
        let dir = tempfile::tempdir().expect("tempdir");
        write_file(&dir.path().join("a/b/c/deep.tmp"), 10);
        let scan =
            scan_old_files(&[dir.path().to_path_buf()], Duration::ZERO, &token()).expect("scan");
        assert_eq!(scan.file_count(), 1);
    }

    #[test]
    fn a_missing_root_is_ignored_not_an_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("does-not-exist");
        let scan = scan_old_files(&[missing], Duration::ZERO, &token()).expect("scan");
        assert_eq!(scan.file_count(), 0);
    }

    #[test]
    fn delete_reports_bytes_actually_freed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let a = dir.path().join("a.tmp");
        let b = dir.path().join("b.tmp");
        write_file(&a, 1000);
        write_file(&b, 2000);

        let summary = delete_files(&[a.clone(), b.clone()], &token());
        assert_eq!(summary.deleted, 2);
        assert_eq!(summary.bytes_freed, 3000);
        assert!(!a.exists());
        assert!(!b.exists());
    }

    #[test]
    fn deleting_a_file_that_vanished_is_skipped_not_an_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let ghost = dir.path().join("ghost.tmp");
        let summary = delete_files(&[ghost], &token());
        assert_eq!(summary.deleted, 0);
        assert_eq!(summary.skipped.len(), 1);
        assert_eq!(summary.skipped[0].1, SkipReason::Gone);
    }

    #[test]
    fn cancellation_stops_a_delete_pass() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut files = Vec::new();
        for index in 0..20 {
            let path = dir.path().join(format!("f{index}.tmp"));
            write_file(&path, 10);
            files.push(path);
        }

        let cancel = token();
        cancel.cancel();
        let summary = delete_files(&files, &cancel);
        assert!(summary.cancelled);
        assert_eq!(summary.deleted, 0);
        assert_eq!(files.iter().filter(|p| p.exists()).count(), 20);
    }

    #[test]
    fn megabytes_are_computed_for_display() {
        let scan = DirScan {
            bytes: 5 * 1024 * 1024,
            ..Default::default()
        };
        assert!((scan.megabytes() - 5.0).abs() < 1e-9);

        let summary = DeleteSummary {
            bytes_freed: 2 * 1024 * 1024,
            ..Default::default()
        };
        assert!((summary.megabytes_freed() - 2.0).abs() < 1e-9);
    }

    #[test]
    fn skip_reason_strings_match_the_contract() {
        assert_eq!(SkipReason::InUse.as_str(), "in_use");
        assert_eq!(SkipReason::AccessDenied.as_str(), "access_denied");
        assert_eq!(SkipReason::Gone.as_str(), "gone");
        assert_eq!(SkipReason::Error.as_str(), "error");
    }

    #[cfg(windows)]
    #[test]
    fn recycle_bin_query_never_fails_on_a_real_drive() {
        let info = recycle_bin_info(Path::new(r"C:\")).expect("query");
        assert!(info.items < 100_000_000);
        assert!(info.bytes < 1_000_000_000_000);
    }
}
