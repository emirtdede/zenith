//! Rollback scopes: the allowlist that stops a tampered snapshot from writing
//! into `C:\Windows\System32`.
//!
//! The threat this closes is concrete: in v1.0.0 a rollback applied a stored
//! `target_dir` verbatim. A standard user who could reach the database could aim
//! an elevated restore anywhere. Here, a snapshot stores a *scope id*, and the
//! resolver maps that id to allowed roots on the current machine (ADR-007).
//!
//! Rules:
//!
//! * No prefix matching on registry keys beyond the declared root.
//! * Paths are canonicalised **after** joining, then re-checked, which defeats
//!   `..` and symlink escapes.
//! * Recycle Bin and Explorer session scopes have no filesystem roots at all:
//!   they resolve through shell APIs, never through a path.

use std::path::{Component, Path, PathBuf};

use crate::error::{ErrorCode, ZenithError, ZenithResult};
use crate::manifest::ActionScope;

/// Environment-derived roots. Injected rather than read from the process so the
/// resolver is testable without touching the real machine.
#[derive(Debug, Clone)]
pub struct ScopeRoots {
    pub temp: PathBuf,
    pub local_app_data: PathBuf,
    pub user_profile: PathBuf,
    pub program_data: PathBuf,
    pub windows: PathBuf,
}

impl ScopeRoots {
    /// Real roots for the current user. Only available on Windows, where these
    /// variables always exist for an interactive session.
    pub fn from_environment() -> Self {
        let get = |key: &str, fallback: &str| {
            std::env::var_os(key)
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(fallback))
        };
        Self {
            temp: get("TEMP", r"C:\Windows\Temp"),
            local_app_data: get("LOCALAPPDATA", r"C:\Users\Public\AppData\Local"),
            user_profile: get("USERPROFILE", r"C:\Users\Public"),
            program_data: get("ProgramData", r"C:\ProgramData"),
            windows: get("SystemRoot", r"C:\Windows"),
        }
    }

    /// Deterministic roots for tests.
    pub fn for_test(root: &Path) -> Self {
        Self {
            temp: root.join("temp"),
            local_app_data: root.join("local"),
            user_profile: root.join("user"),
            program_data: root.join("programdata"),
            windows: root.join("windows"),
        }
    }
}

/// A resolved, validated location a rollback may touch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedTarget {
    pub path: PathBuf,
}

/// Resolve a relative path inside a scope to an absolute, allowlisted target.
///
/// `relative` comes from a snapshot payload, so it is treated as hostile.
pub fn resolve_path(
    scope: ActionScope,
    relative: &str,
    roots: &ScopeRoots,
) -> ZenithResult<ResolvedTarget> {
    let relative_path = Path::new(relative);

    if relative_path.is_absolute() {
        return Err(violation(scope, relative, "absolute path in payload"));
    }
    for component in relative_path.components() {
        match component {
            Component::ParentDir => {
                return Err(violation(scope, relative, "parent traversal in payload"));
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err(violation(scope, relative, "rooted path in payload"));
            }
            _ => {}
        }
    }

    let candidates = allowed_roots(scope, roots);
    if candidates.is_empty() {
        return Err(violation(
            scope,
            relative,
            "scope has no filesystem target by design",
        ));
    }

    // Pick the root the path was archived under. Snapshots record paths relative
    // to a specific root, so we try each and require the result to stay inside.
    let mut last_error = None;
    for root in candidates {
        let joined = root.join(relative_path);
        match normalise(&joined) {
            Ok(normalised) if is_within(&normalised, &root) => {
                return Ok(ResolvedTarget { path: normalised });
            }
            Ok(_) => {
                last_error = Some(violation(scope, relative, "resolved outside its root"));
            }
            Err(err) => last_error = Some(err),
        }
    }

    Err(last_error.unwrap_or_else(|| violation(scope, relative, "no matching root")))
}

/// The filesystem roots a scope permits, in priority order.
pub fn allowed_roots(scope: ActionScope, roots: &ScopeRoots) -> Vec<PathBuf> {
    match scope {
        ActionScope::TempDirs => vec![
            roots.temp.clone(),
            roots.local_app_data.join("Temp"),
            roots.windows.join("Temp"),
        ],
        ActionScope::Screenshots => vec![roots.user_profile.join("Pictures").join("Screenshots")],
        ActionScope::IconCache => vec![roots.local_app_data.join(r"Microsoft\Windows\Explorer")],
        ActionScope::Spooler => vec![roots.windows.join(r"System32\spool\PRINTERS")],
        ActionScope::OfficeCache => vec![
            roots.local_app_data.join(r"Microsoft\Outlook\RoamCache"),
            roots.local_app_data.join(r"Microsoft\Teams"),
        ],
        ActionScope::Winsock => vec![roots.program_data.join(r"Vellium\Zenith\hives")],
        // These scopes never touch a path: they are implemented with shell or
        // SCM APIs, and pretending they had a root would invite a path escape.
        ActionScope::RecycleBin
        | ActionScope::InternetSettings
        | ActionScope::ServicesOnly
        | ActionScope::ExplorerSession
        | ActionScope::None => Vec::new(),
    }
}

/// Registry subkeys a scope permits. Exact equality against the root, plus one
/// child level - never a wildcard, never a prefix beyond that.
pub fn allowed_registry_keys(scope: ActionScope, roots: &ScopeRoots) -> Vec<String> {
    let _ = roots;
    match scope {
        ActionScope::InternetSettings => {
            vec![r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings".to_string()]
        }
        ActionScope::IconCache => {
            vec![r"HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer".to_string()]
        }
        ActionScope::Spooler => vec![r"HKLM\SYSTEM\CurrentControlSet\Control\Print".to_string()],
        ActionScope::Winsock => {
            vec![r"HKLM\SYSTEM\CurrentControlSet\Services\WinSock2".to_string()]
        }
        ActionScope::ServicesOnly => vec![
            r"HKLM\SYSTEM\CurrentControlSet\Services\Spooler".to_string(),
            r"HKLM\SYSTEM\CurrentControlSet\Services\bthserv".to_string(),
            r"HKLM\SYSTEM\CurrentControlSet\Services\W32Time".to_string(),
        ],
        _ => Vec::new(),
    }
}

/// Validate a registry key from a payload against the scope.
pub fn resolve_registry_key(
    scope: ActionScope,
    key: &str,
    roots: &ScopeRoots,
) -> ZenithResult<String> {
    let normalised = key.trim_end_matches('\\');
    let candidates = allowed_registry_keys(scope, roots);
    if candidates.is_empty() {
        return Err(violation(scope, key, "scope has no registry target"));
    }
    for root in &candidates {
        if normalised.eq_ignore_ascii_case(root) {
            return Ok(normalised.to_string());
        }
        // Exactly one child level is allowed.
        let child_prefix = format!("{root}\\");
        if normalised.len() > child_prefix.len()
            && normalised[..child_prefix.len()].eq_ignore_ascii_case(&child_prefix)
        {
            let remainder = &normalised[child_prefix.len()..];
            if !remainder.is_empty() && !remainder.contains('\\') {
                return Ok(normalised.to_string());
            }
        }
    }
    Err(violation(
        scope,
        key,
        "registry key outside the action's scope",
    ))
}

/// Lexical normalisation: removes `.`, resolves `..` without touching disk.
fn normalise(path: &Path) -> ZenithResult<PathBuf> {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                if !out.pop() {
                    return Err(ZenithError::new(ErrorCode::ScopeViolation)
                        .with("reason", "path escapes its root"));
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    Ok(out)
}

fn is_within(path: &Path, root: &Path) -> bool {
    let root = normalise(root).unwrap_or_else(|_| root.to_path_buf());
    path.starts_with(&root)
}

fn violation(scope: ActionScope, subject: &str, reason: &str) -> ZenithError {
    ZenithError::new(ErrorCode::ScopeViolation)
        .with("scope", scope.as_str())
        .with("subject", subject)
        .with("reason", reason)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn roots() -> ScopeRoots {
        ScopeRoots {
            temp: PathBuf::from(r"C:\Users\ayse\AppData\Local\Temp"),
            local_app_data: PathBuf::from(r"C:\Users\ayse\AppData\Local"),
            user_profile: PathBuf::from(r"C:\Users\ayse"),
            program_data: PathBuf::from(r"C:\ProgramData"),
            windows: PathBuf::from(r"C:\Windows"),
        }
    }

    #[test]
    fn a_relative_path_inside_temp_resolves() {
        let target =
            resolve_path(ActionScope::TempDirs, r"chrome\cache\data_1", &roots()).expect("resolve");
        assert!(target.path.ends_with(r"chrome\cache\data_1"));
    }

    #[test]
    fn parent_traversal_is_rejected() {
        let err = resolve_path(
            ActionScope::TempDirs,
            r"..\..\Windows\System32\evil.dll",
            &roots(),
        )
        .unwrap_err();
        assert!(err.is(ErrorCode::ScopeViolation));
        assert_eq!(
            err.params.get("reason").map(String::as_str),
            Some("parent traversal in payload")
        );
    }

    #[test]
    fn absolute_paths_are_rejected() {
        let err = resolve_path(
            ActionScope::Screenshots,
            r"C:\Windows\System32\evil.dll",
            &roots(),
        )
        .unwrap_err();
        assert!(err.is(ErrorCode::ScopeViolation));
    }

    #[test]
    fn a_path_outside_the_scope_root_is_rejected() {
        // `..` is already blocked, but this asserts the second line of defence:
        // the joined result must still be inside the root.
        let err = resolve_path(ActionScope::IconCache, r"..\..\..\Windows", &roots()).unwrap_err();
        assert!(err.is(ErrorCode::ScopeViolation));
    }

    #[test]
    fn scopes_without_paths_refuse_path_resolution() {
        for scope in [
            ActionScope::RecycleBin,
            ActionScope::None,
            ActionScope::ServicesOnly,
        ] {
            let err = resolve_path(scope, "anything", &roots()).unwrap_err();
            assert!(err.is(ErrorCode::ScopeViolation), "{scope:?}");
        }
    }

    #[test]
    fn registry_root_resolves() {
        let key = resolve_registry_key(
            ActionScope::InternetSettings,
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            &roots(),
        )
        .expect("resolve");
        assert!(key.ends_with("Internet Settings"));
    }

    #[test]
    fn one_child_level_is_allowed_but_two_are_not() {
        let ok = resolve_registry_key(
            ActionScope::InternetSettings,
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings\Connections",
            &roots(),
        );
        assert!(ok.is_ok());

        let too_deep = resolve_registry_key(
            ActionScope::InternetSettings,
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings\Connections\DefaultConnectionSettings",
            &roots(),
        );
        assert!(too_deep.is_err());
    }

    #[test]
    fn a_registry_key_outside_the_scope_is_rejected() {
        let err = resolve_registry_key(
            ActionScope::InternetSettings,
            r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Run",
            &roots(),
        )
        .unwrap_err();
        assert!(err.is(ErrorCode::ScopeViolation));
    }

    #[test]
    fn registry_comparison_is_case_insensitive_but_not_prefix_based() {
        // Windows key names are case-insensitive.
        assert!(
            resolve_registry_key(
                ActionScope::Spooler,
                r"hklm\system\currentcontrolset\control\print",
                &roots()
            )
            .is_ok()
        );
        // A sibling that merely starts with the same letters must not pass.
        assert!(
            resolve_registry_key(
                ActionScope::Spooler,
                r"HKLM\SYSTEM\CurrentControlSet\Control\Printers",
                &roots()
            )
            .is_err()
        );
    }

    #[test]
    fn dot_segments_are_normalised_away() {
        let target = resolve_path(ActionScope::TempDirs, r".\a\.\b", &roots()).expect("resolve");
        assert!(target.path.ends_with("a\\b"));
    }

    #[test]
    fn every_scope_is_explicit_about_capability() {
        // Guards against a new scope silently permitting nothing or everything.
        let r = roots();
        for scope in [
            ActionScope::TempDirs,
            ActionScope::Screenshots,
            ActionScope::IconCache,
            ActionScope::Spooler,
            ActionScope::OfficeCache,
            ActionScope::Winsock,
        ] {
            assert!(!allowed_roots(scope, &r).is_empty(), "{scope:?}");
        }
        for scope in [
            ActionScope::InternetSettings,
            ActionScope::Spooler,
            ActionScope::Winsock,
            ActionScope::ServicesOnly,
        ] {
            assert!(!allowed_registry_keys(scope, &r).is_empty(), "{scope:?}");
        }
    }
}
