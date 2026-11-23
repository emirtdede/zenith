//! Filesystem layout and limits, in one place.
//!
//! Every path the product writes is declared here. If a path is not in this
//! file, the app does not write it - which is what makes the uninstall and
//! "delete all data" promises testable rather than aspirational (`04-02` §6).

use std::path::{Path, PathBuf};

/// Log rotation: 5 MB per file, 3 rotated files (REQ-N-081).
pub const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
pub const LOG_MAX_FILES: usize = 3;

/// Snapshot retention defaults (ADR-021).
pub const SNAPSHOT_MAX_ROWS: i64 = 200;
pub const SNAPSHOT_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Audit retention.
pub const AUDIT_MAX_ROWS: i64 = 5_000;

/// Support bundle cap (REQ-N-082).
pub const SUPPORT_BUNDLE_MAX_BYTES: u64 = 5 * 1024 * 1024;
pub const SUPPORT_BUNDLE_MAX_FILES: usize = 10;

/// Explicit loopback port range for the dev-port probe.
pub const DEV_PORT_MIN: u16 = 3000;
pub const DEV_PORT_MAX: u16 = 9999;

/// Free-space headroom required before writing an archive: estimated size + 10%
/// (REQ-F-142).
pub const DISK_HEADROOM_PERCENT: u64 = 10;
pub const DISK_HEADROOM_MIN_BYTES: u64 = 64 * 1024 * 1024;

/// Where the application keeps its state.
#[derive(Debug, Clone)]
pub struct Paths {
    /// Machine-wide data root. Read-only for standard users, writable by admins.
    pub data: PathBuf,
    /// Per-user root, always writable (support bundles, preferences mirror).
    pub user_data: PathBuf,
    /// `true` when `data` had to fall back to `user_data\data` because the
    /// machine directory could not be created (REQ-F-093).
    pub degraded: bool,
}

impl Paths {
    pub fn resolve() -> Self {
        let program_data = std::env::var_os("ProgramData")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
        let local_app_data = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Users\Public\AppData\Local"));

        let primary = program_data.join("Vellium").join("Zenith");
        let user_data = local_app_data.join("Vellium").join("Zenith");

        match ensure_dir(&primary) {
            Ok(()) => Self {
                data: primary,
                user_data,
                degraded: false,
            },
            Err(_) => {
                let fallback = user_data.join("data");
                let _ = ensure_dir(&fallback);
                Self {
                    data: fallback,
                    user_data,
                    degraded: true,
                }
            }
        }
    }

    /// Build a layout under a caller-supplied root. Used by tests and by the
    /// portable/CLI mode so nothing depends on the real machine.
    ///
    /// `degraded` is reported, not assumed. This used to call `let _ =
    /// ensure_dir(..)` twice and then hard-code `degraded: false`, so a root
    /// that could not be created (read-only volume, a path under a file, a
    /// denied ACL) produced a layout that claimed health and failed later at
    /// `state.db` open with no explanation of the real cause. `resolve()` has
    /// the same contract: a fallback that also fails keeps `degraded: true`,
    /// which is the truth, and the store-open path reports the actionable
    /// error.
    pub fn for_root(root: impl AsRef<Path>) -> Self {
        let root = root.as_ref().to_path_buf();
        let data = root.join("data");
        let user_data = root.join("user");
        let data_ok = ensure_dir(&data).is_ok();
        let user_ok = ensure_dir(&user_data).is_ok();
        Self {
            data,
            user_data,
            degraded: !(data_ok && user_ok),
        }
    }

    pub fn database(&self) -> PathBuf {
        self.data.join("state.db")
    }

    pub fn hmac_key_file(&self) -> PathBuf {
        self.data.join("hmac.key.dpapi")
    }

    pub fn backups_dir(&self) -> PathBuf {
        self.data.join("backups")
    }

    pub fn hives_dir(&self) -> PathBuf {
        self.data.join("hives")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.data.join("logs")
    }

    pub fn quarantine_dir(&self) -> PathBuf {
        self.data.join("quarantine")
    }

    pub fn support_dir(&self) -> PathBuf {
        self.user_data.join("support")
    }

    pub fn prefs_file(&self) -> PathBuf {
        self.user_data.join("prefs.json")
    }

    /// Directories the product may create. Used by the uninstall test to assert
    /// that nothing outside this list exists (`REQ-F-134`).
    pub fn owned_directories(&self) -> Vec<PathBuf> {
        vec![
            self.data.clone(),
            self.backups_dir(),
            self.hives_dir(),
            self.logs_dir(),
            self.quarantine_dir(),
            self.user_data.clone(),
            self.support_dir(),
        ]
    }

    /// Make sure every owned directory exists, ignoring failures on the
    /// read-only ones a standard user cannot create.
    pub fn ensure_layout(&self) {
        for dir in self.owned_directories() {
            let _ = ensure_dir(&dir);
        }
    }
}

fn ensure_dir(path: &Path) -> std::io::Result<()> {
    if path.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(path)
}

/// Whether enough free space exists for `needed` plus headroom.
pub fn has_space_for(available: u64, needed: u64) -> bool {
    let headroom = (needed * DISK_HEADROOM_PERCENT / 100).max(DISK_HEADROOM_MIN_BYTES);
    available >= needed.saturating_add(headroom)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_is_under_declared_roots() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::for_root(dir.path());
        for owned in paths.owned_directories() {
            assert!(owned.starts_with(dir.path()), "{owned:?}");
        }
        assert!(paths.database().starts_with(&paths.data));
        assert!(paths.support_dir().starts_with(&paths.user_data));
    }

    #[test]
    fn ensure_layout_creates_every_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::for_root(dir.path());
        paths.ensure_layout();
        for owned in paths.owned_directories() {
            assert!(owned.is_dir(), "{owned:?} missing");
        }
    }

    #[test]
    fn disk_headroom_is_enforced() {
        // Needs 100 MB, so the caller must have 100 MB + max(10 MB, 64 MB).
        assert!(!has_space_for(100 * 1024 * 1024, 100 * 1024 * 1024));
        assert!(has_space_for(200 * 1024 * 1024, 100 * 1024 * 1024));
    }

    #[test]
    fn headroom_has_a_floor_for_tiny_archives() {
        // A 1 MB archive still demands the 64 MB floor, so a nearly-full disk is
        // refused rather than filled to zero.
        assert!(!has_space_for(10 * 1024 * 1024, 1024 * 1024));
        assert!(has_space_for(100 * 1024 * 1024, 1024 * 1024));
    }

    #[test]
    fn no_path_escapes_the_root() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::for_root(dir.path());
        for path in [
            paths.database(),
            paths.hmac_key_file(),
            paths.prefs_file(),
            paths.support_dir(),
        ] {
            assert!(path.starts_with(dir.path()), "{path:?}");
            assert!(!path.to_string_lossy().contains(".."));
        }
    }

    #[test]
    fn a_root_that_cannot_be_created_is_reported_as_degraded() {
        // The defect this pins: `for_root` used to swallow both `ensure_dir`
        // errors and return `degraded: false`, so a read-only root looked
        // healthy and failed later at `state.db` with an unrelated message.
        // A regular file where the `data` directory must go makes
        // `create_dir_all` fail on every platform, without needing an ACL.
        let dir = tempfile::tempdir().expect("tempdir");
        let blocker = dir.path().join("data");
        std::fs::write(&blocker, b"not a directory").expect("write blocker");

        let paths = Paths::for_root(dir.path());

        assert!(
            paths.degraded,
            "an uncreatable root must report degraded, not health"
        );
    }

    #[test]
    fn a_writable_root_is_not_reported_as_degraded() {
        // The inverse, so the flag is not simply always true: the ordinary
        // tempdir path must stay healthy or every test would pass vacuously.
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::for_root(dir.path());
        assert!(!paths.degraded);
        assert!(paths.data.is_dir());
        assert!(paths.user_data.is_dir());
    }
}
