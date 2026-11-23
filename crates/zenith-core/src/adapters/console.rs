//! Console plumbing for the headless CLI (`03-04` §8).
//!
//! The shipped executable is built with `windows_subsystem = "windows"` - correct
//! for a GUI app, fatal for a CLI started from an existing console: the process
//! has no console and `println!` writes into an invalid handle. Attaching to the
//! parent console fixes interactive use; a redirected run (`… > out.json`) needs
//! no attach because the inherited stdout handle is already valid.
//!
//! This lives in `adapters` because it is OS access and the crate allows
//! `unsafe` only here, each block carrying `// SAFETY:` (L1/`03-06`).

use std::io::{self, Write};

use crate::error::ZenithResult;
#[cfg(not(windows))]
use crate::error::{ErrorCode, ZenithError};

/// Attach to the console of the process that launched us.
///
/// `Ok(false)` means there was no parent console (double-click, scheduled task).
/// That is not a failure: a redirected run still writes through stdout.
#[cfg(windows)]
pub fn attach_parent() -> ZenithResult<bool> {
    use windows_sys::Win32::System::Console::{ATTACH_PARENT_PROCESS, AttachConsole};
    // SAFETY: `AttachConsole` takes a DWORD that is either a target process id
    // or the documented `ATTACH_PARENT_PROCESS` sentinel. It allocates nothing
    // we own and returns a BOOL we check; both outcomes (attached, or already
    // has a console / none exists) are handled by the caller.
    let attached = unsafe { AttachConsole(ATTACH_PARENT_PROCESS) };
    Ok(attached != 0)
}

#[cfg(not(windows))]
pub fn attach_parent() -> ZenithResult<bool> {
    Err(ZenithError::new(ErrorCode::NotImplemented).with("feature", "console attach"))
}

/// Detach from any console before the GUI window opens.
///
/// The binary is built as a console-subsystem application so that a redirected
/// CLI run is waited on by `cmd.exe` (`03-04` §8). The price is that a
/// double-click launch allocates a console window; freeing it before the GUI
/// starts keeps the desktop experience identical to a GUI-subsystem build.
///
/// A launch from an existing console (cmd/PowerShell) also detaches, which is
/// harmless: the window belongs to the shell, not to this process.
#[cfg(windows)]
pub fn detach_for_gui() -> ZenithResult<()> {
    use windows_sys::Win32::System::Console::FreeConsole;
    // SAFETY: `FreeConsole` takes no arguments, allocates nothing and cannot
    // invalidate memory we own. It returns a BOOL that carries no information
    // we act on: having no console (already detached) is a valid outcome.
    unsafe {
        FreeConsole();
    }
    Ok(())
}

/// Non-Windows has no Win32 console to detach from.
///
/// It returns `NotImplemented` rather than `()` so it obeys the same rule as
/// every other platform adapter (`03-06` Rule 0): a platform operation either
/// exists or says so. A silent unit return would be an `Ok(())`-shaped fake.
#[cfg(not(windows))]
pub fn detach_for_gui() -> ZenithResult<()> {
    Err(ZenithError::new(ErrorCode::NotImplemented).with("feature", "console detach"))
}

/// A writer for this process's output.
///
/// `CONOUT$` is only correct when stdout is an interactive console: it is what
/// a late `AttachConsole` needs. When stdout is redirected to a file or a pipe
/// (`zenith.exe --headless --diagnose --json > out.json`), opening `CONOUT$`
/// would succeed and steal the bytes to the console, leaving the file empty.
/// So the console handle is used only when stdout is a terminal.
#[cfg(windows)]
pub fn output() -> Box<dyn Write + Send> {
    use std::io::IsTerminal;
    if io::stdout().is_terminal()
        && let Ok(file) = std::fs::OpenOptions::new().write(true).open("CONOUT$")
    {
        return Box::new(file);
    }
    Box::new(io::stdout())
}

#[cfg(not(windows))]
pub fn output() -> Box<dyn Write + Send> {
    Box::new(io::stdout())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attach_reports_platform_support_honestly() {
        // On Windows attach either succeeds or finds no console; it must not
        // panic. Elsewhere it must be an explicit NotImplemented, never Ok.
        if cfg!(windows) {
            assert!(attach_parent().is_ok());
        } else {
            assert!(attach_parent().is_err());
        }
    }

    #[test]
    fn a_writer_is_always_returned() {
        let mut writer = output();
        // Flushing may fail with no console; the contract is "never panics".
        let _ = writer.flush();
    }
}
