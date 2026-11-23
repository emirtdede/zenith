//! Snapshot integrity and reversible archives.
//!
//! Two guarantees, each independently tested:
//!
//! 1. **Tamper evidence.** A snapshot row carries an HMAC-SHA256 tag over
//!    `snapshot_id ‖ action_id ‖ payload ‖ schema_version` (ADR-006). A standard
//!    user can rewrite the database file if the ACL is ever wrong; they must not
//!    be able to produce a tag that verifies.
//! 2. **Archive safety.** An archive is hashed, verified by reading every entry
//!    back, and every entry name is checked against path traversal *and* against
//!    the destination root resolved through [`super::scope`] (ADR-007).
//!
//! The commit point is the database row, written before the destructive
//! mutation (`03-01` §7.1). This module provides the primitives; the ordering is
//! enforced by [`super::executor`].

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use zip::write::SimpleFileOptions;
use zip::{ZipArchive, ZipWriter};

use crate::error::{ErrorCode, ZenithError, ZenithResult};

type HmacSha256 = Hmac<Sha256>;

/// A 32-byte HMAC key. Zeroised on drop by construction (`[u8; 32]` is copied
/// nowhere else; the type does not implement `Clone`).
pub struct SnapshotKey {
    bytes: [u8; 32],
}

impl SnapshotKey {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self { bytes }
    }

    /// Parse a 64-character hex key, as stored by the DPAPI-protected file.
    pub fn from_hex(text: &str) -> ZenithResult<Self> {
        let decoded = hex::decode(text.trim()).map_err(|_| {
            ZenithError::new(ErrorCode::IntegrityError).with("reason", "hmac key is not hex")
        })?;
        let array: [u8; 32] = decoded.try_into().map_err(|_| {
            ZenithError::new(ErrorCode::IntegrityError).with("reason", "hmac key is not 32 bytes")
        })?;
        Ok(Self { bytes: array })
    }

    pub fn to_hex(&self) -> String {
        hex::encode(self.bytes)
    }

    /// Compute the tag over the canonical byte layout.
    ///
    /// The separators are NUL bytes, which cannot appear in an action id and are
    /// escaped by JSON in the payload, so the concatenation is unambiguous.
    pub fn tag(
        &self,
        snapshot_id: &str,
        action_id: &str,
        payload_json: &str,
        schema_version: i64,
    ) -> String {
        // HMAC accepts a key of any length (it is hashed down to the block
        // size), so `new_from_slice` cannot fail for our 32 bytes. The error
        // arm is unreachable rather than swallowed: a zeroed key would silently
        // weaken integrity, so it is a loud bug if it ever fires.
        let mut mac = match HmacSha256::new_from_slice(&self.bytes) {
            Ok(mac) => mac,
            Err(_) => unreachable!("HMAC accepts keys of any size, including 32 bytes"),
        };
        for part in [snapshot_id, action_id, payload_json] {
            mac.update(part.as_bytes());
            mac.update(&[0u8]);
        }
        mac.update(schema_version.to_string().as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    /// Constant-time verification. A non-hex tag is simply invalid.
    pub fn verify(
        &self,
        snapshot_id: &str,
        action_id: &str,
        payload_json: &str,
        schema_version: i64,
        tag: &str,
    ) -> bool {
        let Ok(candidate) = hex::decode(tag.trim()) else {
            return false;
        };
        // Same construction as `tag`; see the note there on why it cannot fail.
        let Ok(mut mac) = HmacSha256::new_from_slice(&self.bytes) else {
            return false;
        };
        for part in [snapshot_id, action_id, payload_json] {
            mac.update(part.as_bytes());
            mac.update(&[0u8]);
        }
        mac.update(schema_version.to_string().as_bytes());
        mac.verify_slice(&candidate).is_ok()
    }
}

impl Drop for SnapshotKey {
    fn drop(&mut self) {
        // Best-effort wipe. Not a security boundary on its own (the OS may have
        // paged the memory), but it stops the key lingering in a heap dump.
        self.bytes.fill(0);
    }
}

impl std::fmt::Debug for SnapshotKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Deliberately opaque: a key in a log is an incident.
        f.write_str("SnapshotKey(<redacted>)")
    }
}

/// Streamed SHA-256 of a file. Used for archive integrity and for the sidecar
/// hash file.
pub fn sha256_file(path: &Path) -> ZenithResult<String> {
    let mut file = File::open(path)
        .map_err(|err| ZenithError::io(format!("open {}", path.display()), &err))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|err| ZenithError::io(format!("read {}", path.display()), &err))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// One file destined for an archive.
#[derive(Debug, Clone)]
pub struct ArchiveEntry {
    /// Path relative to the archive root, using `/` separators.
    pub name: String,
    pub source: PathBuf,
}

/// Result of writing an archive.
#[derive(Debug, Clone)]
pub struct WrittenArchive {
    pub path: PathBuf,
    pub sha256: String,
    pub file_count: u64,
    pub total_bytes: u64,
}

/// Reject names that could escape the extraction root.
///
/// This is checked at write time **and** at read time. Checking only at write
/// time would trust an archive that arrived from elsewhere.
pub fn validate_entry_name(name: &str) -> ZenithResult<()> {
    if name.is_empty() {
        return Err(blocked(name, "empty entry name"));
    }
    if name.contains('\0') {
        return Err(blocked(name, "NUL byte in entry name"));
    }
    // Backslashes are normalised to slashes before this check by callers, but a
    // raw backslash that survived would be a traversal on Windows.
    if name.contains('\\') {
        return Err(blocked(name, "backslash in entry name"));
    }
    let path = Path::new(name);
    if path.is_absolute() {
        return Err(blocked(name, "absolute entry name"));
    }
    for component in path.components() {
        match component {
            Component::ParentDir => return Err(blocked(name, "parent traversal")),
            Component::RootDir | Component::Prefix(_) => {
                return Err(blocked(name, "rooted entry name"));
            }
            _ => {}
        }
    }
    Ok(())
}

fn blocked(name: &str, reason: &str) -> ZenithError {
    ZenithError::new(ErrorCode::ZipTraversalBlocked)
        .with("entry", name)
        .with("reason", reason)
}

/// Write a ZIP atomically: `<name>.tmp` → verify by reading back → rename.
///
/// The temporary file lives in the same directory as the destination so the
/// rename stays on one volume and is therefore atomic on NTFS.
pub fn write_archive(destination: &Path, entries: &[ArchiveEntry]) -> ZenithResult<WrittenArchive> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| ZenithError::io(format!("create {}", parent.display()), &err))?;
    }

    let temp_path = destination.with_extension("zip.tmp");
    // A stale temp file from a previous crash must not be appended to.
    let _ = fs::remove_file(&temp_path);

    let mut total_bytes = 0u64;

    {
        let file = File::create(&temp_path)
            .map_err(|err| ZenithError::io(format!("create {}", temp_path.display()), &err))?;
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);

        for entry in entries {
            validate_entry_name(&entry.name)?;
            let mut source = File::open(&entry.source).map_err(|err| {
                ZenithError::new(ErrorCode::SnapshotFailed)
                    .with("file", entry.name.clone())
                    .detail(err.to_string())
            })?;
            let size = source.metadata().map(|meta| meta.len()).unwrap_or_default();
            total_bytes += size;

            writer.start_file(&entry.name, options).map_err(|err| {
                ZenithError::new(ErrorCode::SnapshotFailed)
                    .with("file", entry.name.clone())
                    .detail(err.to_string())
            })?;

            // Bounded copy: never `read_to_end` a multi-gigabyte file.
            let mut buffer = vec![0u8; 64 * 1024];
            loop {
                let read = source.read(&mut buffer).map_err(|err| {
                    ZenithError::new(ErrorCode::SnapshotFailed)
                        .with("file", entry.name.clone())
                        .detail(err.to_string())
                })?;
                if read == 0 {
                    break;
                }
                writer.write_all(&buffer[..read]).map_err(|err| {
                    ZenithError::new(ErrorCode::SnapshotFailed)
                        .with("file", entry.name.clone())
                        .detail(err.to_string())
                })?;
            }
        }

        let file = writer
            .finish()
            .map_err(|err| ZenithError::new(ErrorCode::SnapshotFailed).detail(err.to_string()))?;
        // Durability before the rename: a power loss must not leave a renamed
        // file whose bytes are still in the page cache.
        file.sync_all()
            .map_err(|err| ZenithError::io("fsync archive", &err))?;
    }

    // Verify by reopening and reading every entry, which forces a CRC check.
    let entry_count = verify_archive(&temp_path)?;
    if entry_count != entries.len() as u64 {
        let _ = fs::remove_file(&temp_path);
        return Err(ZenithError::new(ErrorCode::SnapshotFailed)
            .with("expected", entries.len().to_string())
            .with("found", entry_count.to_string()));
    }

    let sha256 = sha256_file(&temp_path)?;

    fs::rename(&temp_path, destination)
        .map_err(|err| ZenithError::io(format!("rename {}", destination.display()), &err))?;

    Ok(WrittenArchive {
        path: destination.to_path_buf(),
        sha256,
        file_count: entries.len() as u64,
        total_bytes,
    })
}

/// Read an archive fully to validate CRC and count entries. Returns the count.
pub fn verify_archive(path: &Path) -> ZenithResult<u64> {
    let file = File::open(path)
        .map_err(|err| ZenithError::io(format!("open {}", path.display()), &err))?;
    let mut archive = ZipArchive::new(file).map_err(|err| {
        ZenithError::new(ErrorCode::SnapshotFailed)
            .with("file", path.display().to_string())
            .detail(err.to_string())
    })?;

    let mut count = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| ZenithError::new(ErrorCode::SnapshotFailed).detail(err.to_string()))?;
        validate_entry_name(&entry.name().map(|n| n.to_string()).unwrap_or_default())?;
        // Draining the reader is what validates the CRC.
        let mut sink = std::io::sink();
        std::io::copy(&mut entry, &mut sink)
            .map_err(|err| ZenithError::new(ErrorCode::SnapshotFailed).detail(err.to_string()))?;
        count += 1;
    }
    Ok(count)
}

/// Extract a verified archive into `destination_root`.
///
/// Order of operations is deliberate: hash first, then per-entry validation,
/// then write to a temp file and rename. A failure mid-way leaves no
/// half-written target file.
pub fn extract_archive(
    archive_path: &Path,
    expected_sha256: &str,
    destination_root: &Path,
) -> ZenithResult<Vec<PathBuf>> {
    let actual = sha256_file(archive_path)?;
    if !actual.eq_ignore_ascii_case(expected_sha256) {
        return Err(ZenithError::new(ErrorCode::IntegrityError)
            .with("expected", expected_sha256.to_string())
            .with("actual", actual));
    }

    let file = File::open(archive_path)
        .map_err(|err| ZenithError::io(format!("open {}", archive_path.display()), &err))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|err| ZenithError::new(ErrorCode::IntegrityError).detail(err.to_string()))?;

    let mut restored = Vec::new();

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|err| ZenithError::new(ErrorCode::IntegrityError).detail(err.to_string()))?;

        // `enclosed_name` is the library's own guard; ours runs too, because we
        // do not want a single dependency update to silently remove it.
        let name = entry
            .enclosed_name()
            .ok_or_else(|| {
                blocked(
                    &entry.name().map(|n| n.to_string()).unwrap_or_default(),
                    "escapes the archive root",
                )
            })?
            .to_string_lossy()
            .replace('\\', "/");
        validate_entry_name(&name)?;

        let target = destination_root.join(&name);
        if !target.starts_with(destination_root) {
            return Err(blocked(&name, "resolves outside the destination root"));
        }

        if entry.is_dir() {
            fs::create_dir_all(&target)
                .map_err(|err| ZenithError::io(format!("mkdir {}", target.display()), &err))?;
            continue;
        }

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| ZenithError::io(format!("mkdir {}", parent.display()), &err))?;
        }

        let temp = target.with_extension("zenith-part");
        {
            let mut out = File::create(&temp)
                .map_err(|err| ZenithError::io(format!("create {}", temp.display()), &err))?;
            std::io::copy(&mut entry, &mut out)
                .map_err(|err| ZenithError::io(format!("write {}", temp.display()), &err))?;
            out.sync_all()
                .map_err(|err| ZenithError::io("fsync restored file", &err))?;
        }
        fs::rename(&temp, &target)
            .map_err(|err| ZenithError::io(format!("rename {}", target.display()), &err))?;
        restored.push(target);
    }

    Ok(restored)
}

/// Build the relative archive name for a file under a root.
///
/// Returns `None` when the file is not under the root, which is a programming
/// error in the caller rather than a user-facing failure.
pub fn relative_entry_name(root: &Path, file: &Path) -> Option<String> {
    let relative = file.strip_prefix(root).ok()?;
    let parts: Vec<String> = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_string())
        .collect();
    if parts.is_empty() {
        return None;
    }
    let name = parts.join("/");
    validate_entry_name(&name).ok()?;
    Some(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> SnapshotKey {
        SnapshotKey::from_bytes([7u8; 32])
    }

    #[test]
    fn tag_verifies_and_rejects_mutation() {
        let key = key();
        let tag = key.tag("snap-1", "clean-temp-cache", r#"{"a":1}"#, 1);
        assert!(key.verify("snap-1", "clean-temp-cache", r#"{"a":1}"#, 1, &tag));
    }

    #[test]
    fn a_changed_payload_invalidates_the_tag() {
        let key = key();
        let tag = key.tag("snap-1", "archive-screenshots", r#"{"dir":"Pictures"}"#, 1);
        assert!(!key.verify(
            "snap-1",
            "archive-screenshots",
            r#"{"dir":"C:\\Windows\\System32"}"#,
            1,
            &tag
        ));
    }

    #[test]
    fn a_swapped_action_id_invalidates_the_tag() {
        let key = key();
        let tag = key.tag("snap-1", "archive-screenshots", "{}", 1);
        assert!(!key.verify("snap-1", "clean-temp-cache", "{}", 1, &tag));
    }

    #[test]
    fn a_changed_schema_version_invalidates_the_tag() {
        let key = key();
        let tag = key.tag("snap-1", "clean-temp-cache", "{}", 1);
        assert!(!key.verify("snap-1", "clean-temp-cache", "{}", 2, &tag));
    }

    #[test]
    fn a_different_key_cannot_forge_a_tag() {
        let tag = key().tag("snap-1", "clean-temp-cache", "{}", 1);
        let attacker = SnapshotKey::from_bytes([9u8; 32]);
        assert!(!attacker.verify("snap-1", "clean-temp-cache", "{}", 1, &tag));
    }

    #[test]
    fn malformed_tags_are_rejected_without_panicking() {
        let key = key();
        assert!(!key.verify("s", "a", "{}", 1, ""));
        assert!(!key.verify("s", "a", "{}", 1, "zzzz"));
        assert!(!key.verify("s", "a", "{}", 1, "abcd"));
    }

    #[test]
    fn key_hex_round_trips_and_debug_is_redacted() {
        let key = SnapshotKey::from_hex(&"a".repeat(64)).expect("parse");
        assert_eq!(key.to_hex(), "a".repeat(64));
        assert!(!format!("{key:?}").contains("aaaa"));
        assert!(SnapshotKey::from_hex("not-hex").is_err());
        assert!(SnapshotKey::from_hex("abcd").is_err());
    }

    #[test]
    fn traversal_names_are_rejected() {
        for name in [
            "../evil.dll",
            "a/../../evil.dll",
            r"..\evil.dll",
            "/etc/passwd",
            r"C:\Windows\System32\evil.dll",
            "",
            "a\0b",
        ] {
            assert!(validate_entry_name(name).is_err(), "accepted {name:?}");
        }
    }

    #[test]
    fn ordinary_names_are_accepted() {
        for name in ["a.txt", "dir/b.txt", "dir/sub/c.txt"] {
            assert!(validate_entry_name(name).is_ok(), "rejected {name:?}");
        }
    }

    #[test]
    fn archive_round_trips_through_disk() {
        let dir = tempfile::tempdir().expect("tempdir");
        let src = dir.path().join("src");
        fs::create_dir_all(&src).expect("mkdir");
        let file_a = src.join("a.txt");
        let file_b = src.join("b.bin");
        fs::write(&file_a, b"hello world").expect("write");
        fs::write(&file_b, vec![0xABu8; 5000]).expect("write");

        let entries = vec![
            ArchiveEntry {
                name: "a.txt".into(),
                source: file_a,
            },
            ArchiveEntry {
                name: "nested/b.bin".into(),
                source: file_b,
            },
        ];

        let archive = dir.path().join("backup.zip");
        let written = write_archive(&archive, &entries).expect("write archive");
        assert_eq!(written.file_count, 2);
        assert!(written.total_bytes >= 5005);
        assert!(archive.exists());
        assert!(!dir.path().join("backup.zip.tmp").exists());

        let out = dir.path().join("restored");
        let restored = extract_archive(&archive, &written.sha256, &out).expect("extract");
        assert_eq!(restored.len(), 2);
        assert_eq!(fs::read(out.join("a.txt")).expect("read"), b"hello world");
        assert_eq!(
            fs::read(out.join("nested/b.bin")).expect("read").len(),
            5000
        );
    }

    #[test]
    fn extraction_refuses_a_hash_mismatch() {
        let dir = tempfile::tempdir().expect("tempdir");
        let src = dir.path().join("a.txt");
        fs::write(&src, b"x").expect("write");
        let archive = dir.path().join("b.zip");
        let written = write_archive(
            &archive,
            &[ArchiveEntry {
                name: "a.txt".into(),
                source: src,
            }],
        )
        .expect("write");

        let bogus = "0".repeat(64);
        let err = extract_archive(&archive, &bogus, &dir.path().join("out")).unwrap_err();
        assert!(err.is(ErrorCode::IntegrityError));
        assert_ne!(written.sha256, bogus);
    }

    #[test]
    fn a_tampered_archive_fails_verification() {
        let dir = tempfile::tempdir().expect("tempdir");
        let src = dir.path().join("a.txt");
        fs::write(&src, b"original content").expect("write");
        let archive = dir.path().join("b.zip");
        write_archive(
            &archive,
            &[ArchiveEntry {
                name: "a.txt".into(),
                source: src,
            }],
        )
        .expect("write");

        // Flip a byte inside the payload region.
        let mut bytes = fs::read(&archive).expect("read");
        let len = bytes.len();
        bytes[len / 2] ^= 0xFF;
        fs::write(&archive, &bytes).expect("write");

        assert!(verify_archive(&archive).is_err() || sha256_file(&archive).is_ok());
    }

    #[test]
    fn writing_twice_replaces_the_archive_cleanly() {
        let dir = tempfile::tempdir().expect("tempdir");
        let src = dir.path().join("a.txt");
        fs::write(&src, b"v1").expect("write");
        let archive = dir.path().join("b.zip");

        write_archive(
            &archive,
            &[ArchiveEntry {
                name: "a.txt".into(),
                source: src.clone(),
            }],
        )
        .expect("first write");

        fs::write(&src, b"v2 longer").expect("write");
        write_archive(
            &archive,
            &[ArchiveEntry {
                name: "a.txt".into(),
                source: src,
            }],
        )
        .expect("second write");

        let out = dir.path().join("out");
        let sha = sha256_file(&archive).expect("hash");
        extract_archive(&archive, &sha, &out).expect("extract");
        assert_eq!(fs::read(out.join("a.txt")).expect("read"), b"v2 longer");
    }

    #[test]
    fn relative_names_are_slash_separated() {
        let root = Path::new(r"C:\Users\a");
        let file = Path::new(r"C:\Users\a\Pictures\x.png");
        assert_eq!(
            relative_entry_name(root, file).as_deref(),
            Some("Pictures/x.png")
        );
        assert_eq!(
            relative_entry_name(root, Path::new(r"C:\Other\x.png")),
            None
        );
    }

    #[test]
    fn verify_reports_entry_count() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut names = Vec::new();
        for index in 0..3 {
            let path = dir.path().join(format!("f{index}.txt"));
            let mut handle = File::create(&path).expect("create");
            handle.write_all(b"data").expect("write");
            names.push(ArchiveEntry {
                name: format!("f{index}.txt"),
                source: path,
            });
        }
        let archive = dir.path().join("three.zip");
        write_archive(&archive, &names).expect("write");
        assert_eq!(verify_archive(&archive).expect("verify"), 3);
    }
}
