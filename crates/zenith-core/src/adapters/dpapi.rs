//! Machine-scoped DPAPI wrapping for the snapshot HMAC key (ADR-006).
//!
//! `CryptProtectData` with `CRYPTPROTECT_LOCAL_MACHINE` binds the ciphertext to
//! this Windows installation. Copying `hmac.key.dpapi` to another PC, or
//! reading it from a backup, does not produce a usable key - which is the point:
//! the snapshot HMAC is only useful as tamper evidence if the key is not sitting
//! next to the database in plaintext.
//!
//! The caller owns the plaintext buffer and is responsible for wiping it. This
//! module never caches, logs, or formats a key.

use crate::error::{ErrorCode, ZenithError, ZenithResult};

/// Encrypt `plain` for this machine.
#[cfg(windows)]
pub fn protect(plain: &[u8]) -> ZenithResult<Vec<u8>> {
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_LOCAL_MACHINE, CryptProtectData,
    };
    use windows::core::PCWSTR;

    if plain.is_empty() {
        return Err(ZenithError::new(ErrorCode::Internal).with("reason", "empty key"));
    }
    if plain.len() > u32::MAX as usize {
        return Err(ZenithError::new(ErrorCode::Internal).with("reason", "key too large"));
    }

    let input = CRYPT_INTEGER_BLOB {
        cbData: plain.len() as u32,
        pbData: plain.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();

    // SAFETY: `input` points to `plain`, which outlives the call. `output` is a
    // zeroed out-parameter the API fills; it is freed exactly once below.
    unsafe {
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_LOCAL_MACHINE,
            &mut output,
        )
    }
    .map_err(|err| {
        ZenithError::new(ErrorCode::Internal)
            .with("reason", "CryptProtectData")
            .detail(format!("0x{:08X}", err.code().0))
    })?;

    Ok(take_blob(&mut output))
}

/// Decrypt a blob produced by [`protect`] on this machine.
#[cfg(windows)]
pub fn unprotect(sealed: &[u8]) -> ZenithResult<Vec<u8>> {
    use windows::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CryptUnprotectData};

    if sealed.is_empty() {
        return Err(ZenithError::new(ErrorCode::IntegrityError).with("reason", "empty blob"));
    }
    if sealed.len() > u32::MAX as usize {
        return Err(ZenithError::new(ErrorCode::IntegrityError).with("reason", "blob too large"));
    }

    let input = CRYPT_INTEGER_BLOB {
        cbData: sealed.len() as u32,
        pbData: sealed.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();

    // SAFETY: `input` points to `sealed`; `output` is filled by the API and
    // freed exactly once below.
    unsafe { CryptUnprotectData(&input, None, None, None, None, 0, &mut output) }.map_err(
        |err| {
            ZenithError::new(ErrorCode::IntegrityError)
                .with("reason", "CryptUnprotectData")
                .detail(format!("0x{:08X}", err.code().0))
        },
    )?;

    Ok(take_blob(&mut output))
}

/// Copy an API-allocated blob into a `Vec` and free the original with
/// `LocalFree`, which is the allocator DPAPI documents.
#[cfg(windows)]
fn take_blob(blob: &mut windows::Win32::Security::Cryptography::CRYPT_INTEGER_BLOB) -> Vec<u8> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};

    if blob.pbData.is_null() || blob.cbData == 0 {
        return Vec::new();
    }
    // SAFETY: the API returned `cbData` initialised bytes at `pbData`.
    let bytes = unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize) }.to_vec();
    // SAFETY: the pointer came from DPAPI's allocator and is freed once here.
    unsafe { LocalFree(Some(HLOCAL(blob.pbData.cast()))) };
    blob.pbData = std::ptr::null_mut();
    blob.cbData = 0;
    bytes
}

#[cfg(not(windows))]
pub fn protect(_plain: &[u8]) -> ZenithResult<Vec<u8>> {
    Err(crate::adapters::unsupported("dpapi.protect"))
}

#[cfg(not(windows))]
pub fn unprotect(_sealed: &[u8]) -> ZenithResult<Vec<u8>> {
    Err(crate::adapters::unsupported("dpapi.unprotect"))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn protected_bytes_round_trip() {
        let key = [0x5au8; 32];
        let sealed = protect(&key).expect("protect");
        assert_ne!(sealed, key, "ciphertext must differ from plaintext");
        let opened = unprotect(&sealed).expect("unprotect");
        assert_eq!(opened, key);
    }

    #[test]
    fn corrupted_ciphertext_is_rejected() {
        let key = [7u8; 32];
        let mut sealed = protect(&key).expect("protect");
        let last = sealed.len() - 1;
        sealed[last] ^= 0xff;
        assert!(unprotect(&sealed).is_err());
    }

    #[test]
    fn empty_input_is_refused() {
        assert!(protect(&[]).is_err());
        assert!(unprotect(&[]).is_err());
    }
}
