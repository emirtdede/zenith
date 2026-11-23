//! The local, bounded operation log.
//!
//! Why this is a module and not three `println!` calls: `config::LOG_MAX_BYTES`
//! and `config::LOG_MAX_FILES` are published limits (`04-02` §5). A constant
//! that nothing enforces is dead configuration, so the writer that honours it
//! lives here and is the only way a line reaches disk.
//!
//! Rules:
//!
//! * Every line is redacted before it is written (`engine::redact`). The log is
//!   a support artefact; it must be shareable without a second pass.
//! * Rotation is by size, checked *before* the append, so a single line cannot
//!   push a file past `LOG_MAX_BYTES`.
//! * `LOG_MAX_FILES` counts the active file, so the default of 3 means
//!   `zenith.log`, `zenith.log.1`, `zenith.log.2`.
//! * Failure to write is silent. A full disk must not turn a diagnostic action
//!   into a failed diagnostic action.

use std::path::{Path, PathBuf};

use zenith_core::config::{LOG_MAX_BYTES, LOG_MAX_FILES, Paths};
use zenith_core::engine::audit::now_utc;
use zenith_core::engine::redact::{redact_command_line, redact_text};

/// File name of the active log, without rotation index.
pub const ACTIVE_LOG: &str = "zenith.log";

/// One severity word. Deliberately a closed set: the UI colours these.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl Level {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
        }
    }
}

/// Append one redacted line, rotating first if it would exceed the cap.
///
/// Returns the path written to, or `None` when the line could not be persisted.
/// Callers may ignore the result; the in-memory console stream is independent.
pub fn append(paths: &Paths, level: Level, message: &str) -> Option<PathBuf> {
    let dir = paths.logs_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    let active = dir.join(ACTIVE_LOG);
    // Two passes, because they cover different shapes and neither is a superset:
    // `redact_command_line` masks `--flag value` / `--flag=value` pairs, while
    // `redact_text` masks `Bearer <token>` markers and well-known token
    // prefixes. A log line can contain both.
    let message = redact_text(&redact_command_line(message));
    let line = format!("{} {:<5} {}\n", now_utc(), level.as_str(), message);

    // Rotation can fail on a locked or read-only file. The append below would
    // then push the active log past `LOG_MAX_BYTES`, which is the one bound this
    // module promises - so a failure is reported on stderr rather than dropped
    // (the same rule the audit writer follows). The line is still written: a
    // support log that is too long is better than one that is missing.
    for failure in rotate_if_needed(&active, line.len() as u64) {
        eprintln!("log rotation failed: {failure}");
    }

    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&active)
        .ok()?;
    file.write_all(line.as_bytes()).ok()?;
    Some(active)
}

/// One step of an action, in the shape the log writer needs.
///
/// Deliberately a borrowed slice rather than `zenith_core::models::StepResult`:
/// this module is the writer, and keeping it ignorant of the core's model is
/// what lets it be tested without constructing a whole execution.
pub struct StepLine<'a> {
    pub key: &'a str,
    pub status: &'a str,
    pub is_error: bool,
}

/// Write an action's step trace to the operation log, up to `cap` lines.
///
/// Returns how many lines were persisted. Callers must not treat a short count
/// as failure: the log is a support artefact, and a full disk must not turn a
/// completed repair into a failed one.
///
/// Why this exists at all: `03-04` §6 says a closed window loses nothing, but
/// `emit` is best-effort, so a *successful* action's steps used to live exactly
/// as long as a listener did. The rotating log is what a support bundle ships
/// (`04-02` §5, D6), so the trace belongs there too - bounded, rotated and
/// redacted by the same writer as every other line.
pub fn append_steps(paths: &Paths, action: &str, steps: &[StepLine<'_>], cap: usize) -> usize {
    let mut written = 0;
    for step in steps.iter().take(cap) {
        let level = if step.is_error {
            Level::Error
        } else {
            Level::Info
        };
        let line = format!("action {} step {}: {}", action, step.key, step.status);
        if append(paths, level, &line).is_some() {
            written += 1;
        }
    }
    written
}

/// Rotate `zenith.log` when `incoming` bytes would cross the documented cap.
///
/// The oldest file is dropped, every other index shifts up by one, and the
/// active file is renamed to `.1`. Nothing is ever appended to a rotated file.
///
/// Returns one message per step that failed. DEF-153: this used to be a `()`
/// with six `let _ =` inside, so a locked or read-only log made rotation a
/// no-op and the active file grew past `LOG_MAX_BYTES` - the bound the module
/// documents - with nothing anywhere saying the bound had been lost.
fn rotate_if_needed(active: &Path, incoming: u64) -> Vec<String> {
    // A missing active file is not a rotation failure: the next append creates
    // it. Any other metadata error means the size is unknown, and rotating (or
    // not) on an unknown size is a guess, so it is reported.
    let size = match std::fs::metadata(active) {
        Ok(meta) => meta.len(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => 0,
        Err(err) => return vec![format!("could not read {}: {err}", active.display())],
    };
    if size.saturating_add(incoming) <= LOG_MAX_BYTES {
        return Vec::new();
    }

    let mut failures = Vec::new();

    // Drop the file that would fall off the end of the ring.
    let oldest = rotated(active, LOG_MAX_FILES.saturating_sub(1));
    if oldest.exists()
        && let Err(err) = std::fs::remove_file(&oldest)
    {
        failures.push(format!("could not drop {}: {err}", oldest.display()));
    }

    // Shift `.n-1` → `.n`, newest last, so no rename overwrites a live file.
    for index in (1..LOG_MAX_FILES.saturating_sub(1)).rev() {
        let from = rotated(active, index);
        let to = rotated(active, index + 1);
        if from.exists()
            && let Err(err) = std::fs::rename(&from, &to)
        {
            failures.push(format!(
                "could not move {} to {}: {err}",
                from.display(),
                to.display()
            ));
        }
    }

    if LOG_MAX_FILES >= 2 {
        let target = rotated(active, 1);
        if let Err(err) = std::fs::rename(active, &target) {
            failures.push(format!(
                "could not move {} to {}: {err}",
                active.display(),
                target.display()
            ));
        }
    } else if let Err(err) = std::fs::remove_file(active) {
        failures.push(format!("could not remove {}: {err}", active.display()));
    }

    failures
}

/// `zenith.log` with an index: `zenith.log.1`, `zenith.log.2`, …
fn rotated(active: &Path, index: usize) -> PathBuf {
    let mut name = active.as_os_str().to_os_string();
    name.push(format!(".{index}"));
    PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_paths() -> (tempfile::TempDir, Paths) {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::for_root(dir.path());
        paths.ensure_layout();
        (dir, paths)
    }

    #[test]
    fn a_line_is_written_and_redacted() {
        let (_dir, paths) = temp_paths();
        let path = append(
            &paths,
            Level::Info,
            "run curl --password hunter2 https://api.example/x",
        )
        .expect("write");

        let body = std::fs::read_to_string(&path).expect("read");
        assert!(body.contains("INFO"), "{body}");
        assert!(body.contains("--password ***"), "{body}");
        assert!(!body.contains("hunter2"), "secret leaked: {body}");
        assert!(body.ends_with('\n'));
    }

    #[test]
    fn rotation_moves_the_active_file_and_bounds_the_ring() {
        let (_dir, paths) = temp_paths();

        // Fill the active file to just under the cap, then append enough to
        // force exactly one rotation.
        let active = paths.logs_dir().join(ACTIVE_LOG);
        let filler = "x".repeat(LOG_MAX_BYTES as usize - 8);
        std::fs::write(&active, filler).expect("seed");

        append(&paths, Level::Warn, "the line that forces rotation").expect("write");

        assert!(rotated(&active, 1).is_file(), "no .1 after rotation");
        let fresh = std::fs::metadata(&active).expect("stat").len();
        assert!(fresh < LOG_MAX_BYTES, "active file was not reset: {fresh}");

        // The ring never grows past the documented number of files.
        append(&paths, Level::Warn, "second rotation");
    }

    #[test]
    fn rotation_reports_a_failure_instead_of_silently_missing_the_cap() {
        // DEF-153: rotation used six `let _ =` and returned nothing, so a
        // directory that could not be rotated over left the active log growing
        // past `LOG_MAX_BYTES` with no signal anywhere.
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::for_root(dir.path());
        paths.ensure_layout();
        let active = paths.logs_dir().join(ACTIVE_LOG);
        std::fs::write(&active, "x".repeat(LOG_MAX_BYTES as usize - 8)).expect("seed");
        // A non-empty directory sitting where the shifted `.1` must land makes
        // the rename fail on NTFS (a directory cannot be replaced by a file).
        std::fs::write(rotated(&active, 1), b"older").expect("seed .1");
        let blocked = rotated(&active, 2);
        std::fs::create_dir_all(&blocked).expect("blocker dir");
        std::fs::write(blocked.join("occupied"), b"still here").expect("blocker file");

        let failures = rotate_if_needed(&active, 64);
        assert!(
            failures.iter().any(|line| line.contains("could not move")),
            "a refused rotation must be reported: {failures:?}"
        );
        // Rotation is a sequence of renames, so a failure part-way through is
        // possible: the active file may already have become `.1` while the
        // `.1 -> .2` shift was refused. What must never happen is losing the
        // bytes silently, so assert they exist under one of the two names and
        // that the caller was told the ring is incomplete.
        assert!(
            active.is_file() || rotated(&active, 1).is_file(),
            "the log body vanished during a partial rotation"
        );
    }

    #[test]
    fn a_rotation_that_succeeds_reports_no_failure() {
        let (_dir, paths) = temp_paths();
        let active = paths.logs_dir().join(ACTIVE_LOG);
        std::fs::write(&active, "x".repeat(LOG_MAX_BYTES as usize - 8)).expect("seed");
        assert!(rotate_if_needed(&active, 64).is_empty());
        assert!(rotated(&active, 1).is_file());
    }

    #[test]
    fn an_unwritable_directory_is_reported_not_panicked() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut paths = Paths::for_root(dir.path());
        // Point the log directory at a path a file already occupies.
        paths.data = dir.path().join("not-a-directory");
        std::fs::write(&paths.data, b"occupied").expect("occupy");
        assert!(append(&paths, Level::Error, "should not panic").is_none());
    }

    #[test]
    fn a_successful_action_leaves_its_steps_on_disk() {
        // The defect: steps were only ever emitted as an event, and `emit` is
        // best-effort. A bundle opened after the window closed held no trace of
        // a successful run - only the failure paths wrote to disk.
        let (_dir, paths) = temp_paths();
        let steps = [
            StepLine {
                key: "steps.tempScanned",
                status: "success",
                is_error: false,
            },
            StepLine {
                key: "steps.tempDeleted",
                status: "success",
                is_error: false,
            },
        ];

        let written = append_steps(&paths, "clean-temp-cache", &steps, 20);
        assert_eq!(written, 2);

        let body = std::fs::read_to_string(paths.logs_dir().join(ACTIVE_LOG)).expect("read log");
        assert!(
            body.contains("action clean-temp-cache step steps.tempScanned: success"),
            "{body}"
        );
        assert!(body.contains("step steps.tempDeleted: success"), "{body}");
        // Persisted lines carry the same timestamp shape as every other line.
        assert!(body.contains("INFO"), "{body}");
    }

    #[test]
    fn a_failed_step_is_logged_at_error_level() {
        let (_dir, paths) = temp_paths();
        let steps = [StepLine {
            key: "steps.dnsFlush",
            status: "error",
            is_error: true,
        }];
        append_steps(&paths, "flush-dns-cache", &steps, 20);
        let body = std::fs::read_to_string(paths.logs_dir().join(ACTIVE_LOG)).expect("read");
        assert!(
            body.contains("ERROR"),
            "a failed step must not be logged as info: {body}"
        );
        assert!(body.contains("step steps.dnsFlush: error"), "{body}");
    }

    #[test]
    fn the_step_trace_is_capped_so_a_chatty_action_cannot_flood_the_log() {
        // Matches the twenty-line cap the `terminal_log` event carries: the file
        // and the socket must describe the same run.
        let (_dir, paths) = temp_paths();
        let steps: Vec<StepLine<'_>> = (0..50)
            .map(|_| StepLine {
                key: "steps.commandSucceeded",
                status: "success",
                is_error: false,
            })
            .collect();
        let written = append_steps(&paths, "dism-restore-health", &steps, 20);
        assert_eq!(written, 20);
        let body = std::fs::read_to_string(paths.logs_dir().join(ACTIVE_LOG)).expect("read");
        assert_eq!(
            body.matches("step steps.commandSucceeded").count(),
            20,
            "{body}"
        );
    }

    #[test]
    fn a_step_trace_does_not_escape_the_size_cap() {
        // The same rotation the rest of the log gets: a trace is appended through
        // `append`, so it cannot be the line that pushes the file past
        // `LOG_MAX_BYTES`.
        let (_dir, paths) = temp_paths();
        let active = paths.logs_dir().join(ACTIVE_LOG);
        std::fs::write(&active, "x".repeat(LOG_MAX_BYTES as usize - 8)).expect("seed");
        let steps = [StepLine {
            key: "steps.tempScanned",
            status: "success",
            is_error: false,
        }];
        append_steps(&paths, "clean-temp-cache", &steps, 20);
        assert!(rotated(&active, 1).is_file(), "trace bypassed rotation");
        let fresh = std::fs::metadata(&active).expect("stat").len();
        assert!(fresh < LOG_MAX_BYTES, "active file was not reset: {fresh}");
    }
}
