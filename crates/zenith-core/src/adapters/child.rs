//! Cancellable, time-boxed child processes that die as a tree.
//!
//! Three defects from v1.0.0 are closed here, each with a test:
//!
//! 1. **`child.kill()` did not kill the tree.** `cmd.exe` spawning `powershell.exe`
//!    left the grandchild running and holding file locks. We put the child in a
//!    job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so dropping the job
//!    terminates every descendant (`03-06` §5).
//!
//! 2. **stderr was never drained.** A child writing more than one pipe buffer
//!    (64 KB) blocked forever on a full pipe while we waited on exit. Both
//!    streams are drained by dedicated threads *before* the wait (`03-06` §6).
//!
//! 3. **No timeout and no cancellation.** A hung `dism` froze the UI. Every child
//!    now has a deadline and observes a [`CancelToken`].
//!
//! Output is accumulated with a hard cap and passed through [`redact`] before it
//! leaves this module: a tool can print a token in its error message.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::engine::executor::CancelToken;
use crate::engine::redact::redact_text;
use crate::error::{ErrorCode, ZenithError, ZenithResult};

/// Cap on captured output per stream. Beyond this we keep the head and record
/// that truncation happened, because the tail of a log is not worth an OOM.
pub const OUTPUT_CAP_BYTES: usize = 256 * 1024;

/// Result of a completed child process.
#[derive(Debug, Clone)]
pub struct ChildOutcome {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub timed_out: bool,
    pub cancelled: bool,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

impl ChildOutcome {
    pub fn success(&self) -> bool {
        !self.timed_out && !self.cancelled && self.exit_code == Some(0)
    }

    /// One line for the audit trail: never the full output.
    pub fn summary(&self) -> String {
        match (self.timed_out, self.cancelled, self.exit_code) {
            (true, _, _) => "timeout".to_string(),
            (_, true, _) => "cancelled".to_string(),
            (_, _, Some(code)) => format!("exit {code}"),
            (_, _, None) => "no exit code".to_string(),
        }
    }
}

/// How a child is launched.
#[derive(Debug, Clone)]
pub struct ChildSpec<'a> {
    pub program: &'a str,
    pub args: &'a [&'a str],
    pub timeout: Duration,
    pub working_dir: Option<&'a Path>,
}

impl<'a> ChildSpec<'a> {
    pub fn new(program: &'a str, args: &'a [&'a str], timeout: Duration) -> Self {
        Self {
            program,
            args,
            timeout,
            working_dir: None,
        }
    }
}

/// Run a program with no shell involved.
///
/// `program` and `args` come from the manifest, never from user input, so there
/// is no injection surface: we never build a command string.
#[cfg(windows)]
pub fn run(spec: &ChildSpec<'_>, cancel: &Arc<CancelToken>) -> ZenithResult<ChildOutcome> {
    if cancel.is_cancelled() {
        return Err(ZenithError::new(ErrorCode::Cancelled));
    }

    let mut command = Command::new(spec.program);
    command
        .args(spec.args)
        // `.exe` resolution is done by us, not by a shell.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags_default();

    if let Some(dir) = spec.working_dir {
        command.current_dir(dir);
    }

    let started = Instant::now();
    let mut child = command.spawn().map_err(|err| {
        // A missing tool is a capability problem the UI can explain, not an
        // internal error.
        if err.kind() == std::io::ErrorKind::NotFound {
            ZenithError::new(ErrorCode::ToolMissing).with("program", spec.program.to_string())
        } else {
            ZenithError::new(ErrorCode::Internal)
                .with("program", spec.program.to_string())
                .detail(err.to_string())
        }
    })?;

    // Confine the child and everything it spawns to a job we own.
    let job = Arc::new(JobGuard::assign(&child));

    // Make cancellation take effect on the *calling* thread. Without this, the
    // kill waits for this worker's next poll tick and its next time slice: the
    // same code measured 32 ms idle and 411 ms while the rest of the test suite
    // competed for cores, and crossed the 500 ms budget once with nothing wrong
    // in the logic. The guard is dropped before the job below, so a later cancel
    // can never reach a closed handle.
    let hook_job = Arc::clone(&job);
    let hook_guard = cancel.register_hook(Arc::new(move || hook_job.terminate()));

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();

    let stdout_thread = stdout_pipe.map(spawn_reader);
    let stderr_thread = stderr_pipe.map(spawn_reader);

    let mut timed_out = false;
    let mut cancelled = false;

    // Poll rather than blocking in `wait()`: we must notice cancellation and the
    // deadline, and neither is a child exit.
    let status = loop {
        if cancel.is_cancelled() {
            cancelled = true;
            terminate_tree(&mut child, &job);
            let _ = child.wait();
            break None;
        }
        if started.elapsed() >= spec.timeout {
            timed_out = true;
            terminate_tree(&mut child, &job);
            let _ = child.wait();
            break None;
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(err) => {
                terminate_tree(&mut child, &job);
                return Err(ZenithError::new(ErrorCode::Internal)
                    .with("program", spec.program.to_string())
                    .detail(err.to_string()));
            }
        }
    };

    // Unregister before closing the job: the hook holds its own `Arc` to it, and
    // a cancel arriving after this point must find nothing to terminate.
    drop(hook_guard);
    // Close the job *after* the child exited so a lingering grandchild is killed
    // rather than leaked.
    drop(job);

    let (stdout, stdout_truncated) = stdout_thread
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();
    let (stderr, stderr_truncated) = stderr_thread
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default();

    Ok(ChildOutcome {
        exit_code: status.and_then(|status| status.code()),
        stdout: redact_text(&stdout),
        stderr: redact_text(&stderr),
        duration_ms: started.elapsed().as_millis() as u64,
        timed_out,
        cancelled,
        stdout_truncated,
        stderr_truncated,
    })
}

/// Non-Windows guard (`03-06` Rule 0): process spawning here relies on a Win32
/// job object to contain the whole tree. There is no faithful translation, so the
/// path is `NotImplemented` rather than a run with no tree containment.
#[cfg(not(windows))]
pub fn run(_spec: &ChildSpec<'_>, _cancel: &Arc<CancelToken>) -> ZenithResult<ChildOutcome> {
    Err(crate::adapters::unsupported("child.run"))
}

/// Convenience wrapper for the common "run and require success" case.
pub fn run_checked(spec: &ChildSpec<'_>, cancel: &Arc<CancelToken>) -> ZenithResult<ChildOutcome> {
    let outcome = run(spec, cancel)?;
    if outcome.cancelled {
        return Err(ZenithError::new(ErrorCode::Cancelled));
    }
    if outcome.timed_out {
        return Err(ZenithError::new(ErrorCode::Timeout)
            .with("program", spec.program.to_string())
            .with("seconds", spec.timeout.as_secs().to_string()));
    }
    Ok(outcome)
}

/// Drain one pipe on its own thread.
///
/// This is the fix for the 64 KB deadlock: the reader exists before the wait,
/// so the child can always make progress.
#[cfg(windows)]
fn spawn_reader(mut pipe: impl Read + Send + 'static) -> std::thread::JoinHandle<(String, bool)> {
    std::thread::spawn(move || {
        let mut collected = Vec::with_capacity(8 * 1024);
        let mut truncated = false;
        let mut buffer = [0u8; 16 * 1024];

        loop {
            match pipe.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    if collected.len() < OUTPUT_CAP_BYTES {
                        let room = OUTPUT_CAP_BYTES - collected.len();
                        let take = read.min(room);
                        collected.extend_from_slice(&buffer[..take]);
                        if take < read {
                            truncated = true;
                        }
                    } else {
                        // Keep draining so the child is never blocked, but stop
                        // storing. Discarding is the point.
                        truncated = true;
                    }
                }
                Err(_) => break,
            }
        }

        (String::from_utf8_lossy(&collected).to_string(), truncated)
    })
}

#[cfg(windows)]
fn terminate_tree(child: &mut std::process::Child, job: &JobGuard) {
    // Killing the job kills descendants; killing the direct child as well is
    // belt-and-braces for the case where job assignment failed.
    job.terminate();
    let _ = child.kill();
}

#[cfg(windows)]
fn set_creation_flags(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    /// `CREATE_NO_WINDOW`: the console flash is a bug, not a feature.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

/// Small helper so `run` reads linearly.
#[cfg(windows)]
trait CommandFlags {
    fn creation_flags_default(&mut self) -> &mut Self;
}

#[cfg(windows)]
impl CommandFlags for Command {
    fn creation_flags_default(&mut self) -> &mut Self {
        set_creation_flags(self);
        self
    }
}

// ---------------------------------------------------------------------------
// Job objects
// ---------------------------------------------------------------------------

/// A job object handle that kills its members when dropped.
///
/// If job creation fails we degrade to killing the direct child only, and say so
/// loudly in the log rather than pretending the tree was contained.
#[cfg(windows)]
struct JobGuard {
    handle: Option<windows_sys::Win32::Foundation::HANDLE>,
}

// SAFETY: a job-object handle is a process-wide kernel value, not a pointer into
// thread-local state, and every operation used here - `TerminateJobObject` and
// `CloseHandle` - is documented as callable from any thread. The field is
// immutable after construction and is closed exactly once, in `Drop`, which runs
// only when the last `Arc` reference is gone; a concurrent `cancel()` therefore
// terminates a handle that is still open.
#[cfg(windows)]
unsafe impl Send for JobGuard {}

// SAFETY: the same argument as the `Send` impl above, and the reason it holds for
// `Sync` too. Sharing `&JobGuard` across threads exposes only the handle value,
// which is a plain kernel handle, never a Rust reference into mutable memory.
// The two `unsafe impl`s are separate items because `cfg` cannot decorate a pair,
// so each carries its own comment rather than one comment covering both.
#[cfg(windows)]
unsafe impl Sync for JobGuard {}

#[cfg(windows)]
impl JobGuard {
    fn assign(child: &std::process::Child) -> Self {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };

        // SAFETY: a null name and null attributes request an anonymous job; both
        // are documented and neither is dereferenced by us.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Self { handle: None };
        }

        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        // SAFETY: `limits` is a correctly initialised struct of the exact size
        // passed, and `handle` is a live job handle.
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            // SAFETY: `handle` came from a successful `CreateJobObjectW`.
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
            return Self { handle: None };
        }

        // `as_raw_handle` borrows the child, whose handle stays valid until the
        // child is reaped - which happens after this call.
        let process = child.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
        // SAFETY: `handle` is valid and `process` is a live process handle owned
        // by `child`.
        let assigned = unsafe { AssignProcessToJobObject(handle, process) };
        if assigned == 0 {
            // SAFETY: `handle` is valid and unused from here on.
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
            return Self { handle: None };
        }

        Self {
            handle: Some(handle),
        }
    }

    #[cfg(windows)]
    fn terminate(&self) {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        if let Some(handle) = self.handle {
            // SAFETY: `handle` is a live job handle owned by this guard.
            unsafe {
                let _ = TerminateJobObject(handle, 1);
            }
        }
    }
}

#[cfg(windows)]
impl Drop for JobGuard {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            // SAFETY: `handle` is owned by this guard and is closed exactly once.
            unsafe {
                let _ = windows_sys::Win32::Foundation::CloseHandle(handle);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token() -> Arc<CancelToken> {
        Arc::new(CancelToken::new())
    }

    #[test]
    fn a_successful_command_reports_stdout_and_zero() {
        let spec = ChildSpec::new("cmd.exe", &["/c", "echo hello"], Duration::from_secs(10));
        let outcome = run(&spec, &token()).expect("run");
        assert!(outcome.success());
        assert_eq!(outcome.exit_code, Some(0));
        assert!(outcome.stdout.contains("hello"), "{:?}", outcome.stdout);
    }

    #[test]
    fn a_non_zero_exit_is_reported_not_hidden() {
        let spec = ChildSpec::new("cmd.exe", &["/c", "exit 3"], Duration::from_secs(10));
        let outcome = run(&spec, &token()).expect("run");
        assert_eq!(outcome.exit_code, Some(3));
        assert!(!outcome.success());
    }

    #[test]
    fn a_missing_tool_is_tool_missing() {
        let spec = ChildSpec::new(
            "definitely-not-installed-zenith.exe",
            &[],
            Duration::from_secs(5),
        );
        let err = run(&spec, &token()).unwrap_err();
        assert!(err.is(ErrorCode::ToolMissing));
    }

    #[test]
    fn stderr_is_drained_so_a_large_error_does_not_deadlock() {
        // 200 KB of stderr is more than three pipe buffers. Without a drainer
        // this test hangs; that is the regression it guards. The timeout is a
        // harness bound, not a throughput claim: on a machine running the whole
        // MCP/tooling stack (234 `cmd.exe` processes were live here) the same
        // 4,000 lines took 14.8 s instead of 5.3 s. 30 s turned a pass into a
        // coin flip; a missing drainer still hangs forever and still fails.
        let spec = ChildSpec::new(
            "cmd.exe",
            &[
                "/c",
                "for /L %i in (1,1,4000) do @echo 0123456789012345678901234567890123456789 1>&2",
            ],
            Duration::from_secs(120),
        );
        let outcome = run(&spec, &token()).expect("run");
        assert!(!outcome.timed_out, "the child deadlocked on a full pipe");
        assert!(outcome.stderr.len() > 1000, "stderr was not captured");
    }

    #[test]
    fn output_is_truncated_at_the_cap_but_the_child_still_exits() {
        // ~820 KB of stdout against a 256 KiB cap: the point is that the cap
        // stops *accumulation* without stopping *draining*, so the child never
        // blocks on a full pipe. Same reasoning as above for the harness bound.
        let spec = ChildSpec::new(
            "cmd.exe",
            &[
                "/c",
                "for /L %i in (1,1,20000) do @echo 0123456789012345678901234567890123456789",
            ],
            Duration::from_secs(180),
        );
        let outcome = run(&spec, &token()).expect("run");
        assert!(!outcome.timed_out, "the child blocked on a full pipe");
        assert!(outcome.stdout_truncated, "expected truncation at the cap");
        assert!(outcome.stdout.len() <= OUTPUT_CAP_BYTES);
        assert!(
            !outcome.stdout.is_empty(),
            "the head of the output must survive"
        );
    }

    #[test]
    fn a_timeout_kills_the_child_and_reports_it() {
        let spec = ChildSpec::new(
            "cmd.exe",
            &["/c", "ping 127.0.0.1 -n 30 > nul"],
            Duration::from_millis(400),
        );
        let started = Instant::now();
        let outcome = run(&spec, &token()).expect("run");
        assert!(outcome.timed_out);
        assert!(!outcome.success());
        // It returned on the deadline, not after the ping finished.
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn cancellation_stops_a_running_child() {
        let cancel = token();
        let spec = ChildSpec::new(
            "cmd.exe",
            &["/c", "ping 127.0.0.1 -n 30 > nul"],
            Duration::from_secs(60),
        );
        let flag = Arc::clone(&cancel);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            flag.cancel();
        });
        let outcome = run(&spec, &cancel).expect("run");
        assert!(outcome.cancelled);
        assert!(!outcome.timed_out);
    }

    /// DEF-052 / REQ-F-052: cancelling during a *silent* child must take effect
    /// within 500 ms. The previous tests proved the flag was honoured; this one
    /// measures it. A child registers a kill hook, so `cancel()` terminates the
    /// job on the calling thread and the measured gap is the product's, not the
    /// scheduler's.
    ///
    /// The `ping -n 30` child emits nothing for ~30 s, which is exactly the case
    /// REQ-F-052 names: a cancel cannot rely on reading output to notice.
    ///
    /// The assertion reads the token's `latency_ms()` - request → enactment -
    /// rather than timing `run`'s return. The first version did the latter and
    /// measured the kernel: under a loaded machine (240 tests, many spawning
    /// `cmd.exe`, beside 234 live tooling processes) the same logic that
    /// responded in 32 ms measured 411 ms and once crossed the budget. The
    /// end-to-end return gets its own generous liveness bound.
    #[test]
    fn cancellation_lands_within_the_500ms_budget_on_a_silent_child() {
        const BUDGET: Duration = Duration::from_millis(500);
        // Not a contract: proof the call returns at all, and fails fast if the
        // job object is ever removed and the child is allowed to run to 30 s.
        const LIVENESS: Duration = Duration::from_secs(5);

        let cancel = token();
        let spec = ChildSpec::new(
            "cmd.exe",
            &["/c", "ping 127.0.0.1 -n 30 > nul"],
            Duration::from_secs(60),
        );

        // Let `run` spawn and enter its poll loop before we cancel.
        let flag = Arc::clone(&cancel);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(250));
            flag.cancel();
        });

        let returned_at = Instant::now();
        let outcome = run(&spec, &cancel).expect("run");
        let end_to_end = returned_at.elapsed();

        assert!(outcome.cancelled, "the run must report cancellation");
        assert!(!outcome.timed_out, "a cancel is not a timeout");

        let latency = cancel
            .latency_ms()
            .expect("a cancelled run must report how long it took to notice");
        assert!(
            latency < BUDGET.as_millis() as u64,
            "cancel took {latency} ms to be enacted, budget is {} ms",
            BUDGET.as_millis()
        );
        assert!(
            end_to_end < LIVENESS,
            "run took {end_to_end:?} to return after cancel; the job object is not terminating the tree"
        );
        // The reported duration is the whole run, so it must be at least the
        // cancel latency; a zero would mean the clock was never read.
        assert!(outcome.duration_ms >= 250, "{}", outcome.duration_ms);
    }

    #[test]
    fn a_token_remembers_when_the_request_arrived_and_forgets_it_on_reset() {
        let cancel = token();
        assert!(
            cancel.requested_at().is_none(),
            "a fresh token has no request time"
        );
        cancel.cancel();
        let first = cancel
            .requested_at()
            .expect("cancel must record the instant");
        assert!(cancel.is_cancelled());

        // Cancelling twice must not move the clock: the budget is measured from
        // the user's first press, and a second press cannot extend it.
        std::thread::sleep(Duration::from_millis(10));
        cancel.cancel();
        assert_eq!(cancel.requested_at(), Some(first), "the instant is fixed");

        cancel.reset();
        assert!(!cancel.is_cancelled());
        assert!(
            cancel.requested_at().is_none(),
            "reset must clear the instant, or the next run inherits the last one's clock"
        );
    }

    #[test]
    fn an_already_cancelled_token_never_spawns() {
        let cancel = token();
        cancel.cancel();
        let spec = ChildSpec::new(
            "cmd.exe",
            &["/c", "echo should-not-run"],
            Duration::from_secs(5),
        );
        let err = run(&spec, &cancel).unwrap_err();
        assert!(err.is(ErrorCode::Cancelled));
    }

    #[test]
    fn secrets_in_tool_output_are_redacted() {
        let spec = ChildSpec::new(
            "cmd.exe",
            &["/c", "echo token=ghp_16C7e42F292c6912E7710c838347Ae178B4a"],
            Duration::from_secs(10),
        );
        let outcome = run(&spec, &token()).expect("run");
        assert!(
            !outcome
                .stdout
                .contains("ghp_16C7e42F292c6912E7710c838347Ae178B4a")
        );
        assert!(outcome.stdout.contains("***"));
    }

    #[test]
    fn run_checked_maps_timeout_to_the_timeout_code() {
        let spec = ChildSpec::new(
            "cmd.exe",
            &["/c", "ping 127.0.0.1 -n 30 > nul"],
            Duration::from_millis(300),
        );
        let err = run_checked(&spec, &token()).unwrap_err();
        assert!(err.is(ErrorCode::Timeout));
    }

    #[test]
    fn run_checked_returns_output_on_success() {
        let spec = ChildSpec::new("cmd.exe", &["/c", "echo ok"], Duration::from_secs(10));
        let outcome = run_checked(&spec, &token()).expect("checked");
        assert!(outcome.stdout.contains("ok"));
    }
}
