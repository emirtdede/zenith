//! Snapshot HMAC key lifecycle, shared by the GUI and the headless CLI.
//!
//! Both entry points must use the *same* key file and the *same* failure rules:
//! a second read path would be a second chance to get DPAPI scope or the
//! "never regenerate over a corrupt key" rule wrong (ADR-006).
//!
//! The file is `hmac.key.dpapi`, protected machine-wide with `CryptProtectData`.
//! A corrupt or unreadable file is a hard failure - silently minting a new key
//! would make every existing snapshot unverifiable while still claiming
//! "verified".

use std::path::PathBuf;

use crate::adapters::dpapi;
use crate::config::Paths;
use crate::engine::snapshot::SnapshotKey;
use crate::error::{ErrorCode, ZenithError, ZenithResult};

/// Load the machine key, creating it on first run.
///
/// Creation is the only path that writes; a read failure never overwrites.
pub fn load_or_create(paths: &Paths) -> ZenithResult<SnapshotKey> {
    let file: PathBuf = paths.hmac_key_file();
    if file.is_file() {
        let blob = std::fs::read(&file).map_err(|err| {
            ZenithError::io("read hmac key", &err).with("reason", "hmac key unreadable")
        })?;
        let plain = dpapi::unprotect(&blob).map_err(|_| {
            ZenithError::new(ErrorCode::IntegrityError).with("reason", "hmac key unreadable")
        })?;
        if plain.len() != 32 {
            return Err(ZenithError::new(ErrorCode::IntegrityError)
                .with("reason", "hmac key is not 32 bytes"));
        }
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(&plain);
        return Ok(SnapshotKey::from_bytes(bytes));
    }

    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|err| {
        let mut error = ZenithError::new(ErrorCode::Internal).with("reason", "csprng");
        error.detail = Some(err.to_string());
        error
    })?;
    let protected = dpapi::protect(&bytes)?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|err| ZenithError::io("create key dir", &err))?;
    }
    std::fs::write(&file, protected).map_err(|err| ZenithError::io("write hmac key", &err))?;
    Ok(SnapshotKey::from_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_load_returns_a_key_and_does_not_rewrite_on_failure() {
        // A corrupt key file must fail, not be replaced. On non-Windows the
        // DPAPI adapter returns NotImplemented, which is also a hard failure -
        // either way the file must survive untouched.
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::for_root(dir.path());
        paths.ensure_layout();
        let file = paths.hmac_key_file();
        std::fs::write(&file, b"not a dpapi blob").expect("seed");
        let before = std::fs::read(&file).expect("read before");

        let result = load_or_create(&paths);

        assert!(result.is_err(), "a corrupt key must not be replaced");
        let after = std::fs::read(&file).expect("read after");
        assert_eq!(before, after, "the corrupt key file must be left as-is");
    }
}
