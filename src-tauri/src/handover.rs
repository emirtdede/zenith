//! Privilege handover (DEF-009 fix, REQ-F-112).
//!
//! The v1.0.0 design let any process start `zenith.exe --resume-queue
//! controlled-reboot`. That is a local privilege-escalation primitive: a
//! standard user could ask the elevated instance to reboot the machine.
//!
//! The fix is a single-use, unforgeable ticket:
//!
//! ```text
//! 1. The unelevated instance writes <data>\handover\<nonce>.json:
//!    { nonce, expiresUnixMs, callerPid, callerSid, queue }
//! 2. It launches itself with `runas`, passing only the nonce and its PID.
//! 3. The elevated instance re-reads the ticket, checks
//!    * the file is inside the ACL-locked machine data directory,
//!    * the nonce matches its argument,
//!    * the expiry has not passed,
//!    * the caller PID is still alive,
//!    * the caller PID's SID equals its own SID,
//!    then deletes the ticket and only then accepts the queue.
//! ```
//!
//! A standard user cannot write into the ticket directory (ACL), cannot read a
//! ticket they did not create, and cannot borrow another user's SID. Replaying
//! a nonce fails because the file is deleted on first use.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use zenith_core::adapters::privilege;
use zenith_core::config::Paths;
use zenith_core::error::{ErrorCode, ZenithError, ZenithResult};
use zenith_core::models::ActionId;

/// How long a ticket stays valid. Long enough to clear a UAC prompt, short
/// enough that a stale ticket is useless.
const TICKET_TTL: Duration = Duration::from_secs(120);

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Ticket {
    nonce: String,
    expires_unix_ms: u128,
    caller_pid: u32,
    caller_sid: String,
    queue: Vec<String>,
}

/// What the elevated instance was asked to resume.
#[derive(Debug, Clone)]
pub struct Resumed {
    pub queue: Vec<ActionId>,
    pub dropped: Vec<String>,
}

/// Write the ticket and start the elevated instance.
///
/// Returns `Ok(())` once the shell reports the launch was accepted. The caller
/// exits immediately afterwards; the elevated instance is the new session.
pub fn launch(paths: &Paths, queue: &[String]) -> ZenithResult<()> {
    if paths.degraded {
        // The ticket directory would live under the per-user fallback, which a
        // standard user *can* write. That removes the whole guarantee, so the
        // honest answer is to refuse rather than to weaken it silently.
        return Err(ZenithError::new(ErrorCode::ElevationHandoverInvalid)
            .with("reason", "machine store unavailable"));
    }

    let caller_sid = privilege::current_sid().ok_or_else(|| {
        ZenithError::new(ErrorCode::ElevationHandoverInvalid)
            .with("reason", "caller sid unavailable")
    })?;
    let nonce = random_hex()?;
    let ticket = Ticket {
        nonce: nonce.clone(),
        expires_unix_ms: now_unix_ms() + TICKET_TTL.as_millis(),
        caller_pid: std::process::id(),
        caller_sid,
        queue: queue.to_vec(),
    };

    let directory = ticket_dir(paths);
    std::fs::create_dir_all(&directory)
        .map_err(|err| ZenithError::io(format!("create {}", directory.display()), &err))?;
    let path = directory.join(format!("{nonce}.json"));
    let text = serde_json::to_vec_pretty(&ticket)
        .map_err(|err| ZenithError::new(ErrorCode::Internal).detail(err.to_string()))?;
    // `create_new` makes the write atomic with respect to a colliding nonce.
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|err| ZenithError::io(format!("create {}", path.display()), &err))?;
    use std::io::Write;
    file.write_all(&text)
        .map_err(|err| ZenithError::io("write ticket", &err))?;
    file.sync_all()
        .map_err(|err| ZenithError::io("sync ticket", &err))?;

    let exe = std::env::current_exe().map_err(|err| ZenithError::io("current_exe", &err))?;
    let parameters = format!(
        "--elevate --handover {} --wait-pid {} --resume-queue {}",
        nonce,
        ticket.caller_pid,
        queue.join(",")
    );

    if let Err(err) = run_as(&exe, &parameters) {
        // A refused UAC prompt must not leave a usable ticket behind.
        let _ = std::fs::remove_file(&path);
        return Err(err);
    }
    Ok(())
}

/// Read and consume the ticket named on the command line.
///
/// Returns `None` when the process was not started as a handover, which is the
/// normal path for a user double-clicking the app.
pub fn consume(paths: &Paths) -> ZenithResult<Option<Resumed>> {
    let args: Vec<String> = std::env::args().collect();
    if !args.iter().any(|arg| arg == "--elevate") {
        return Ok(None);
    }

    let nonce = value_of(&args, "--handover").ok_or_else(invalid)?;
    let wait_pid: u32 = value_of(&args, "--wait-pid")
        .and_then(|text| text.parse().ok())
        .ok_or_else(invalid)?;
    let claimed: Vec<String> = value_of(&args, "--resume-queue")
        .map(|text| {
            text.split(',')
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let path = ticket_dir(paths).join(format!("{nonce}.json"));
    let text = std::fs::read(&path).map_err(|_| invalid_with("ticket missing"))?;
    let ticket: Ticket =
        serde_json::from_slice(&text).map_err(|_| invalid_with("ticket corrupt"))?;

    // Single use: delete before validating the content, so a failed check
    // cannot be retried with a modified ticket in place.
    let _ = std::fs::remove_file(&path);

    if ticket.nonce != nonce {
        return Err(invalid_with("nonce mismatch"));
    }
    if now_unix_ms() > ticket.expires_unix_ms {
        return Err(invalid_with("ticket expired"));
    }
    if ticket.caller_pid != wait_pid {
        return Err(invalid_with("caller pid mismatch"));
    }
    if zenith_core::adapters::process::identify(wait_pid).is_err() {
        return Err(invalid_with("caller not running"));
    }

    let caller_sid =
        privilege::sid_for_pid(wait_pid).ok_or_else(|| invalid_with("caller sid unavailable"))?;
    let own_sid = privilege::current_sid().ok_or_else(|| invalid_with("own sid unavailable"))?;
    if caller_sid != ticket.caller_sid || caller_sid != own_sid {
        return Err(invalid_with("sid mismatch"));
    }

    // The queue comes from the ticket, never from the command line: the command
    // line is visible to any process that can read the process list.
    let mut dropped = Vec::new();
    let mut queue = Vec::new();
    for item in &ticket.queue {
        match ActionId::parse(item) {
            Some(action) => queue.push(action),
            None => dropped.push(item.clone()),
        }
    }
    // Anything the caller claims that the ticket does not contain is a forged
    // attempt; refuse rather than silently ignore.
    if claimed.iter().any(|item| !ticket.queue.contains(item)) {
        return Err(invalid_with("queue mismatch"));
    }

    Ok(Some(Resumed { queue, dropped }))
}

fn invalid() -> ZenithError {
    ZenithError::new(ErrorCode::ElevationHandoverInvalid)
}

fn invalid_with(reason: &str) -> ZenithError {
    invalid().with("reason", reason)
}

fn ticket_dir(paths: &Paths) -> PathBuf {
    paths.data.join("handover")
}

fn value_of(args: &[String], flag: &str) -> Option<String> {
    let index = args.iter().position(|arg| arg == flag)?;
    args.get(index + 1).cloned()
}

fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or(0)
}

fn random_hex() -> ZenithResult<String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|err| ZenithError::new(ErrorCode::Internal).detail(err.to_string()))?;
    Ok(hex::encode(bytes))
}

/// `ShellExecuteW(…, "runas", …)`. Returns an error when the shell reports a
/// value `<= 32`, which is the documented failure range.
#[cfg(windows)]
fn run_as(exe: &Path, parameters: &str) -> ZenithResult<()> {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let operation = wide("runas");
    let file = wide(&exe.display().to_string());
    let params = wide(parameters);
    let directory = wide(&exe.parent().unwrap_or(Path::new(".")).display().to_string());

    // SAFETY: every string is a live NUL-terminated buffer for the call, and no
    // pointer is retained by the shell.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            operation.as_ptr(),
            file.as_ptr(),
            params.as_ptr(),
            directory.as_ptr(),
            SW_SHOWNORMAL,
        )
    } as isize;

    if result <= 32 {
        return Err(ZenithError::new(ErrorCode::ElevationHandoverInvalid)
            .with("reason", "shell refused elevation")
            .detail(format!("ShellExecuteW returned {result}")));
    }
    Ok(())
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

#[cfg(not(windows))]
fn run_as(_exe: &Path, _parameters: &str) -> ZenithResult<()> {
    Err(zenith_core::adapters::unsupported("handover.run_as"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_are_read_positionally() {
        let args: Vec<String> = [
            "z.exe",
            "--elevate",
            "--handover",
            "abc",
            "--wait-pid",
            "42",
        ]
        .iter()
        .map(|value| value.to_string())
        .collect();
        assert_eq!(value_of(&args, "--handover"), Some("abc".to_string()));
        assert_eq!(value_of(&args, "--wait-pid"), Some("42".to_string()));
        assert_eq!(value_of(&args, "--resume-queue"), None);
    }

    #[test]
    fn a_non_handover_process_is_not_an_error() {
        // Tests never run with `--elevate`, so this documents the normal path.
        let paths = Paths::for_root(std::env::temp_dir().join("zenith-handover-test"));
        let consumed = consume(&paths).expect("consume");
        assert!(consumed.is_none());
    }

    #[test]
    fn random_nonces_are_32_bytes_and_unique() {
        let a = random_hex().expect("nonce");
        let b = random_hex().expect("nonce");
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }
}
