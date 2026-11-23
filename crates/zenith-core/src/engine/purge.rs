//! Scoped erasure of everything Zenith wrote (REQ-F-097).
//!
//! The product's promise is that uninstalling or purging leaves nothing
//! behind. This module is the enforceable half of that promise; the uninstall
//! test asserts the other half by walking [`Paths::owned_directories`].
//!
//! Two rules make this safe rather than merely destructive:
//!
//! * The confirm token is checked here, in the core, not only in the UI. A
//!   caller that skips the dialog still cannot purge.
//! * Snapshots are only removed when every one of them is restored, or when the
//!   caller passes `force`. Deleting the only copy of a user's icons, caches or
//!   network settings is not a preference.

use std::path::Path;

use serde::Serialize;

use crate::config::Paths;
use crate::engine::db::Store;
use crate::error::{ErrorCode, ZenithError, ZenithResult};
use crate::models::SnapshotStatus;

/// The one accepted confirmation string. Matches `03-04` §5.12.
pub const CONFIRM_TOKEN: &str = "PURGE";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PurgeScope {
    Support,
    Logs,
    Snapshots,
    All,
}

impl PurgeScope {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "support" => Some(Self::Support),
            "logs" => Some(Self::Logs),
            "snapshots" => Some(Self::Snapshots),
            "all" => Some(Self::All),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeSummary {
    pub scopes: Vec<String>,
    pub deleted_files: u64,
    pub freed_bytes: u64,
    pub snapshots_removed: u64,
    pub quarantined_kept: u64,
    /// Non-fatal problems, i18n-free: the UI maps each key to a sentence.
    pub warnings: Vec<String>,
}

/// Delete the requested scope.
pub fn purge(
    store: &Store,
    paths: &Paths,
    scope: PurgeScope,
    confirm_token: &str,
    force: bool,
) -> ZenithResult<PurgeSummary> {
    if confirm_token != CONFIRM_TOKEN {
        return Err(ZenithError::new(ErrorCode::ConfirmationRequired)
            .with("reason", "purge token mismatch"));
    }

    if scope == PurgeScope::Snapshots || scope == PurgeScope::All {
        ensure_snapshots_removable(store, force)?;
    }

    let mut summary = PurgeSummary {
        scopes: vec![scope_name(scope).to_string()],
        deleted_files: 0,
        freed_bytes: 0,
        snapshots_removed: 0,
        quarantined_kept: 0,
        warnings: Vec::new(),
    };

    match scope {
        PurgeScope::Support => {
            clear_directory(&paths.support_dir(), &mut summary);
        }
        PurgeScope::Logs => {
            clear_directory(&paths.logs_dir(), &mut summary);
        }
        PurgeScope::Snapshots => {
            let (removed, failures) = store.purge_snapshots(force)?;
            summary.snapshots_removed = removed;
            summary.warnings.extend(failures);
            if !force {
                summary.quarantined_kept = count_files(&paths.quarantine_dir());
            }
        }
        PurgeScope::All => {
            let (snapshots, _audit, failures) = store.purge(force)?;
            summary.snapshots_removed = snapshots;
            summary.warnings.extend(failures);
            if !force {
                summary.quarantined_kept = count_files(&paths.quarantine_dir());
            }
            // `Store::purge` already emptied the owned directories it knows
            // about. Recreate the layout so the next launch starts clean, then
            // report what is left.
            paths.ensure_layout();
            for dir in [paths.support_dir(), paths.logs_dir()] {
                clear_directory(&dir, &mut summary);
            }
        }
    }

    Ok(summary)
}

fn scope_name(scope: PurgeScope) -> &'static str {
    match scope {
        PurgeScope::Support => "support",
        PurgeScope::Logs => "logs",
        PurgeScope::Snapshots => "snapshots",
        PurgeScope::All => "all",
    }
}

/// Refuse to delete unrestored snapshots unless the caller insisted.
fn ensure_snapshots_removable(store: &Store, force: bool) -> ZenithResult<()> {
    if force {
        return Ok(());
    }
    let unrestored = store
        .list_snapshots(1000)?
        .into_iter()
        .filter(|row| row.status == SnapshotStatus::Committed && !row.is_restored)
        .count();
    if unrestored > 0 {
        return Err(ZenithError::new(ErrorCode::ConfirmationRequired)
            .with("reason", "unrestored snapshots exist")
            .with("count", unrestored.to_string()));
    }
    Ok(())
}

/// Remove every file directly inside `dir`, keeping the directory itself.
/// Subdirectories are removed whole. Failures are warnings: a locked log file
/// must not abort the rest of the purge.
fn clear_directory(dir: &Path, summary: &mut PurgeSummary) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let removed = if metadata.is_dir() {
            std::fs::remove_dir_all(&path).is_ok()
        } else {
            std::fs::remove_file(&path).is_ok()
        };
        if removed {
            summary.deleted_files += count_files(&path).max(1);
            summary.freed_bytes = summary.freed_bytes.saturating_add(metadata.len());
        } else {
            summary.warnings.push(format!("locked:{}", path.display()));
        }
    }
}

fn count_files(dir: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    for entry in entries.flatten() {
        total += match entry.metadata() {
            Ok(meta) if meta.is_dir() => count_files(&entry.path()),
            Ok(_) => 1,
            Err(_) => 0,
        };
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn purge_requires_the_exact_token() {
        let paths = Paths::for_root(std::env::temp_dir().join("zenith-purge-token-test"));
        let key = crate::engine::snapshot::SnapshotKey::from_bytes([3u8; 32]);
        let (store, _) = Store::open(&paths, key).expect("store");
        assert!(purge(&store, &paths, PurgeScope::Logs, "purge", false).is_err());
        assert!(purge(&store, &paths, PurgeScope::Logs, "", false).is_err());
        let summary = purge(&store, &paths, PurgeScope::Logs, CONFIRM_TOKEN, false).expect("purge");
        assert_eq!(summary.scopes, vec!["logs"]);
    }

    #[test]
    fn every_scope_name_parses_back() {
        for scope in [
            PurgeScope::Support,
            PurgeScope::Logs,
            PurgeScope::Snapshots,
            PurgeScope::All,
        ] {
            assert_eq!(PurgeScope::parse(scope_name(scope)), Some(scope));
        }
        assert_eq!(PurgeScope::parse("everything"), None);
    }
}
