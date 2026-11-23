// The binary is built as a *console* subsystem application in every profile.
//
// This is required, not cosmetic. A GUI-subsystem process is not waited on by
// `cmd.exe`, so `zenith.exe --headless --json > out.json` returns before the
// program writes and the file is empty - a broken contract for the exact
// automation `03-04` §8 documents. Console subsystem makes the shell wait and
// redirection work.
//
// The cost is a console window when the GUI starts, so `entry()` detaches from
// the console before the window opens (`adapters::console::detach_for_gui`).
// Launching from an existing console (cmd/PowerShell) keeps that console, which
// is the correct behaviour for a CLI launch.
fn main() {
    std::process::exit(zenith_app::entry());
}
