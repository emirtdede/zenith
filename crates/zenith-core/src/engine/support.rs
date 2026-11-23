//! Support bundle creation (REQ-F-092, 07-02 §5).
//!
//! A support bundle has one job: let an IT department diagnose a failure
//! without learning anything the user did not agree to share. That gives three
//! hard rules, each enforced here rather than promised in prose:
//!
//! 1. **No secrets, ever.** Every string is passed through
//!    [`crate::engine::redact`] and then through path/identity scrubbing.
//!    Snapshot payloads and archives are never included.
//! 2. **Bounded.** At most [`SUPPORT_BUNDLE_MAX_FILES`] entries and
//!    [`SUPPORT_BUNDLE_MAX_BYTES`] uncompressed, so the bundle cannot become a
//!    covert channel for a large file.
//! 3. **Works unelevated.** Everything is written under the per-user data
//!    directory (ADR-024), so a standard user can always file a report.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::config::{self, Paths};
use crate::engine::audit::now_utc;
use crate::engine::db::Store;
use crate::engine::redact;
use crate::error::{ErrorCode, ZenithError, ZenithResult};

/// What the bundle contains, so the UI can list it before the user shares it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportBundle {
    pub path: String,
    pub bytes: u64,
    pub included_files: Vec<String>,
    pub redaction_report: RedactionReport,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactionReport {
    /// Matches replaced by a mask. Counted by the redactor, not estimated.
    pub masked_values: u64,
    pub scrubbed_paths: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BundleManifest<'a> {
    schema_version: i64,
    app_version: &'a str,
    generated_at_utc: String,
    os_build: Option<u32>,
    os_display_version: Option<String>,
    elevated: bool,
    store_mode: &'a str,
    included_files: Vec<String>,
}

/// Build a bundle and return where it landed.
///
/// `extra_note` is user text from the report dialog; it is redacted like
/// everything else. Passing an empty string is allowed and common.
pub fn create(
    store: &Store,
    paths: &Paths,
    elevated: bool,
    extra_note: &str,
) -> ZenithResult<SupportBundle> {
    paths.ensure_layout();

    let mut report = RedactionReport::default();
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();

    let os = crate::adapters::system::os_info().ok();
    let manifest = BundleManifest {
        schema_version: crate::SCHEMA_VERSION,
        app_version: crate::VERSION,
        generated_at_utc: now_utc(),
        os_build: os.as_ref().map(|info| info.build),
        os_display_version: os.as_ref().map(|info| info.display_version.clone()),
        elevated,
        store_mode: if paths.degraded {
            "user_fallback"
        } else {
            "machine"
        },
        included_files: Vec::new(),
    };

    // Audit history: metadata only. The params map holds counters and i18n
    // keys, which are safe, but it is still redacted.
    let audit = store.list_audit(200)?;
    let audit_json = serde_json::to_vec_pretty(&audit).unwrap_or_else(|_| b"[]".to_vec());
    entries.push(("audit.json".into(), scrub(&audit_json, &mut report)));

    // Snapshot ledger without payloads or archive paths that name the user.
    let snapshots = store.list_snapshots(200)?;
    let snapshot_rows: Vec<serde_json::Value> = snapshots
        .iter()
        .map(|record| {
            serde_json::json!({
                "snapshotId": record.snapshot_id,
                "actionId": record.action_id.as_str(),
                "createdAtUtc": record.created_at_utc,
                "status": match record.status {
                    crate::models::SnapshotStatus::Committed => "committed",
                    crate::models::SnapshotStatus::Broken => "broken",
                },
                "estBytes": record.est_bytes,
                "isRestored": record.is_restored,
            })
        })
        .collect();
    let snapshot_json =
        serde_json::to_vec_pretty(&snapshot_rows).unwrap_or_else(|_| b"[]".to_vec());
    entries.push(("snapshots.json".into(), scrub(&snapshot_json, &mut report)));

    // Environment: no hostname, no user name, no domain.
    let environment = serde_json::json!({
        "osBuild": os.as_ref().map(|info| info.build),
        "osDisplayVersion": os.as_ref().map(|info| info.display_version.clone()),
        "osProductName": os.as_ref().map(|info| info.product_name.clone()),
        "ubr": os.as_ref().map(|info| info.ubr),
        "arch": std::env::consts::ARCH,
        "schemaVersion": crate::SCHEMA_VERSION,
        "redaction": "identifiers replaced with <user>/<host>",
    });
    entries.push((
        "environment.json".into(),
        scrub(
            &serde_json::to_vec_pretty(&environment).unwrap_or_default(),
            &mut report,
        ),
    ));

    // Application logs, trimmed to the most recent whole lines that fit.
    for (name, bytes) in read_logs(&paths.logs_dir(), &mut report) {
        entries.push((name, bytes));
    }

    // The user's own words. Never required, always redacted.
    let note = extra_note.trim();
    if !note.is_empty() {
        entries.push(("user-note.txt".into(), scrub(note.as_bytes(), &mut report)));
    }

    // Bounds are checked before writing, so a runaway log cannot produce a
    // bundle that violates the contract.
    let total: u64 = entries.iter().map(|(_, bytes)| bytes.len() as u64).sum();
    if total > config::SUPPORT_BUNDLE_MAX_BYTES {
        entries = trim_to_budget(entries, config::SUPPORT_BUNDLE_MAX_BYTES);
    }
    entries.truncate(config::SUPPORT_BUNDLE_MAX_FILES.saturating_sub(1));

    let included_files: Vec<String> = entries.iter().map(|(name, _)| name.clone()).collect();
    let manifest = BundleManifest {
        included_files: included_files.clone(),
        ..manifest
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).unwrap_or_default();
    if manifest_bytes.len() as u64 > config::SUPPORT_BUNDLE_MAX_BYTES / 4 {
        return Err(
            ZenithError::new(ErrorCode::Internal).with("reason", "manifest grew past its budget")
        );
    }
    entries.insert(0, ("manifest.json".into(), manifest_bytes));

    let stamp: String = now_utc()
        .chars()
        .filter(|c| c.is_ascii_digit())
        .take(14)
        .collect();
    let destination = paths
        .support_dir()
        .join(format!("Zenith-Support-{stamp}.zip"));
    let bytes = write_bundle(&destination, &entries)?;

    Ok(SupportBundle {
        path: destination.display().to_string(),
        bytes,
        included_files,
        redaction_report: report,
    })
}

/// Replace credentials and then identifying values. Two passes are deliberate:
/// `redact_text` understands token shapes (Bearer, `--password=`), while the
/// scrubbing pass understands this machine's names.
fn scrub(bytes: &[u8], report: &mut RedactionReport) -> Vec<u8> {
    let text = String::from_utf8_lossy(bytes);
    let redacted = redact::redact_text(&text);
    if redacted != text {
        report.masked_values += count_masks(&redacted);
    }
    let (scrubbed, paths_hit) = scrub_identifiers(&redacted);
    report.scrubbed_paths += paths_hit;
    scrubbed.into_bytes()
}

fn count_masks(text: &str) -> u64 {
    text.matches(redact::MASK).count() as u64
}

/// Replace the current user's profile path, user name, and host name.
///
/// Values shorter than three characters are skipped: replacing a one-letter
/// user name would corrupt every word in the log.
fn scrub_identifiers(text: &str) -> (String, u64) {
    let mut out = text.to_string();
    let mut hits = 0u64;

    let mut replace = |needle: &str, replacement: &str, out: &mut String| {
        if needle.len() < 3 {
            return;
        }
        if out.contains(needle) {
            hits += out.matches(needle).count() as u64;
            *out = out.replace(needle, replacement);
        }
    };

    if let Some(profile) = std::env::var_os("USERPROFILE") {
        let text = profile.to_string_lossy().to_string();
        let forward = text.replace('\\', "/");
        replace(&text, "%USERPROFILE%", &mut out);
        replace(&forward, "%USERPROFILE%", &mut out);
    }
    if let Ok(user) = std::env::var("USERNAME") {
        replace(&user, "<user>", &mut out);
    }
    if let Ok(host) = std::env::var("COMPUTERNAME") {
        replace(&host, "<host>", &mut out);
    }
    (out, hits)
}

/// Most recent log files, each capped at 256 KiB and trimmed on a line
/// boundary. Returns `(entry name, bytes)`.
fn read_logs(logs_dir: &Path, report: &mut RedactionReport) -> Vec<(String, Vec<u8>)> {
    const PER_FILE_CAP: u64 = 256 * 1024;
    let Ok(entries) = std::fs::read_dir(logs_dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "log"))
        .collect();
    files.sort();

    let mut out = Vec::new();
    for path in files {
        let Some(name) = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
        else {
            continue;
        };
        let Ok(bytes) = read_tail(&path, PER_FILE_CAP) else {
            continue;
        };
        out.push((format!("logs/{name}"), scrub(&bytes, report)));
    }
    out
}

/// Read at most the last `cap` bytes, starting at a line boundary so the first
/// line is not a fragment.
fn read_tail(path: &Path, cap: u64) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path)?;
    let length = file.metadata()?.len();
    let start = length.saturating_sub(cap);
    if start > 0 {
        file.seek(SeekFrom::Start(start))?;
        let mut probe = [0u8; 1];
        while file.read(&mut probe)? == 1 {
            if probe[0] == b'\n' {
                break;
            }
        }
    } else {
        file.seek(SeekFrom::Start(0))?;
    }
    let mut buffer = Vec::new();
    file.take(cap).read_to_end(&mut buffer)?;
    Ok(buffer)
}

/// Drop whole entries from the end until the bundle fits. Logs are appended
/// last, so this removes the least diagnostic-dense material first.
fn trim_to_budget(mut entries: Vec<(String, Vec<u8>)>, budget: u64) -> Vec<(String, Vec<u8>)> {
    while entries
        .iter()
        .map(|(_, bytes)| bytes.len() as u64)
        .sum::<u64>()
        > budget
    {
        if entries.pop().is_none() {
            break;
        }
    }
    entries
}

/// Write the bundle atomically: `.tmp` then rename, so a crash never leaves a
/// half-zip that looks shareable.
fn write_bundle(destination: &Path, entries: &[(String, Vec<u8>)]) -> ZenithResult<u64> {
    let temporary = destination.with_extension("zip.tmp");
    let file = std::fs::File::create(&temporary)
        .map_err(|err| ZenithError::io(format!("create {}", temporary.display()), &err))?;
    let mut writer = ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o600);

    for (name, bytes) in entries {
        // Entry names are built by this module, but the archive writer is a
        // trust boundary and re-checks anyway.
        crate::engine::snapshot::validate_entry_name(name)?;
        writer
            .start_file(name.clone(), options)
            .map_err(|err| ZenithError::new(ErrorCode::Internal).detail(err.to_string()))?;
        writer
            .write_all(bytes)
            .map_err(|err| ZenithError::io(format!("write {name}"), &err))?;
    }

    writer
        .finish()
        .map_err(|err| ZenithError::new(ErrorCode::Internal).detail(err.to_string()))?;
    std::fs::rename(&temporary, destination).map_err(|err| {
        let _ = std::fs::remove_file(&temporary);
        ZenithError::io(format!("rename {}", destination.display()), &err)
    })?;

    let bytes = std::fs::metadata(destination)
        .map(|meta| meta.len())
        .unwrap_or(0);
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifier_scrubbing_replaces_identity_but_not_short_names() {
        let profile = std::env::var("USERPROFILE").unwrap_or_default();
        let text = format!("path={profile}\\AppData and more");
        let (scrubbed, hits) = scrub_identifiers(&text);
        if profile.len() >= 3 {
            assert!(!scrubbed.contains(&profile), "{scrubbed}");
            assert!(scrubbed.contains("%USERPROFILE%"));
            assert!(hits >= 1);
        }
    }

    #[test]
    fn redaction_happens_before_identifier_scrubbing() {
        let mut report = RedactionReport::default();
        let out = scrub(b"Authorization: Bearer abcdef123456", &mut report);
        let text = String::from_utf8(out).expect("utf8");
        assert!(!text.contains("abcdef123456"), "{text}");
        assert!(report.masked_values >= 1);
    }

    /// DEF-053: the unit tests prove the redactor works on a string; this one
    /// proves the *shipped path* works - a real credential written into a real
    /// log file, a real zip on disk, read back and searched. A masking bug that
    /// only appears when entries flow through `read_logs` → `scrub` → zip would
    /// slip past a string-level test.
    #[test]
    fn seeded_secrets_do_not_survive_into_the_written_bundle() {
        use crate::engine::snapshot::SnapshotKey;
        use std::io::Read;

        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::for_root(dir.path());
        paths.ensure_layout();
        let (store, _report) =
            Store::open(&paths, SnapshotKey::from_bytes([9u8; 32])).expect("open store");

        // Three different redaction mechanisms, so a gap in any one shows up:
        // a well-known prefix, an `Authorization:` header, and a `key=value`
        // secret flag.
        let github = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
        let bearer = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
        let password = "Sup3rS3cret-Pa55word";
        let log_body = format!(
            "2026-11-20T10:00:00Z INFO push started\n\
             2026-11-20T10:00:01Z DEBUG remote=https://{github}@github.com/x/y\n\
             2026-11-20T10:00:02Z TRACE Authorization: Bearer {bearer}\n\
             2026-11-20T10:00:03Z DEBUG conn --db-password={password}\n\
             2026-11-20T10:00:04Z INFO done\n"
        );
        std::fs::write(paths.logs_dir().join("zenith.log"), log_body.as_bytes()).expect("seed log");

        // The user note takes the same path and must be redacted too.
        let note = format!("token leaked: {github}");
        let bundle = create(&store, &paths, false, &note).expect("create bundle");

        assert!(bundle.bytes > 0);
        assert!(
            bundle.redaction_report.masked_values >= 3,
            "expected at least three masks, got {}",
            bundle.redaction_report.masked_values
        );

        let file = std::fs::File::open(&bundle.path).expect("open bundle");
        let mut archive = zip::ZipArchive::new(file).expect("read zip");
        let mut names = Vec::new();
        let mut all_text = String::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).expect("entry");
            names.push(entry.name().expect("entry name").to_string());
            let mut text = String::new();
            entry.read_to_string(&mut text).expect("utf8 entry");
            all_text.push_str(&text);
        }

        // The log really did make it into the bundle; otherwise the assertions
        // below would pass trivially on an empty archive.
        assert!(
            names.iter().any(|name| name == "logs/zenith.log"),
            "log missing from bundle: {names:?}"
        );
        assert!(names.iter().any(|name| name == "user-note.txt"));
        assert!(all_text.contains("push started"), "log body missing");

        for secret in [github, bearer, password] {
            assert!(
                !all_text.contains(secret),
                "secret survived into the bundle: {secret}"
            );
        }
        assert!(
            !all_text.contains("Sup3rS3cret"),
            "partial password survived into the bundle"
        );
        // Masking must not have destroyed the surrounding diagnostic value.
        assert!(all_text.contains("push started"));
        assert!(all_text.contains("github.com"));

        let _ = std::fs::remove_file(&bundle.path);
    }

    #[test]
    fn trimming_drops_whole_entries_until_the_budget_is_met() {
        let entries = vec![
            ("a".to_string(), vec![0u8; 100]),
            ("b".to_string(), vec![0u8; 100]),
            ("c".to_string(), vec![0u8; 100]),
        ];
        let trimmed = trim_to_budget(entries, 150);
        assert_eq!(trimmed.len(), 1);
        assert_eq!(trimmed[0].0, "a");
    }
}
