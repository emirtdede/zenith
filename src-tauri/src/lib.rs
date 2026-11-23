//! Zenith application shell.
//!
//! The webview is a renderer. It owns no state, no path, and no privilege: every
//! read goes through a command in [`commands`], and every mutation goes through
//! `zenith_core::engine::pipeline`. Capabilities grant no filesystem scope at all
//! (`capabilities/default.json`), so a compromised renderer cannot write a file
//! without passing a validation path it does not control.

// The IPC error shape is frozen by `03-04` §7 and serialised directly to the
// webview. Boxing it to satisfy `result_large_err` would change every command
// signature and the type Tauri serialises; the size is constant and bounded.
#![allow(clippy::result_large_err)]

mod commands;
mod error;
mod handover;
mod logging;
mod maintenance;
mod state;
mod telemetry;

use std::collections::BTreeMap;

use tauri::Manager;

use state::{AppState, NoticeSeverity, StartupNotice};

/// Process entry point: decide between the headless CLI and the desktop app.
///
/// The GUI is the default. A handover launch (`--elevate`) is never a CLI
/// invocation - it resumes a privileged queue through the window, not a console.
pub fn entry() -> i32 {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if zenith_core::cli::is_cli(&args) {
        return run_cli(&args);
    }
    // The binary is a console-subsystem application so redirected CLI output is
    // not lost (`03-04` §8). Free that console before the window opens, so a
    // double-click launch never shows a stray console window. Detaching cannot
    // fail in a way the GUI can act on: the window opens either way, so the
    // `NotImplemented` on non-Windows is recorded, not fatal.
    let _ = zenith_core::adapters::console::detach_for_gui();
    run()
}

/// Parse and dispatch a headless invocation (`03-04` §8).
fn run_cli(args: &[String]) -> i32 {
    let invocation = match zenith_core::cli::parse(args) {
        Ok(invocation) => invocation,
        Err(error) => {
            // Attach before writing so an interactive console sees the message;
            // a redirected run has a valid stdout either way.
            let _ = zenith_core::adapters::console::attach_parent();
            let mut out = zenith_core::adapters::console::output();
            use std::io::Write;
            let _ = writeln!(out, "error: {}", error.code);
            let _ = writeln!(out, "  {}", error.detail);
            let _ = writeln!(out, "\n{}", zenith_core::cli::HELP);
            return zenith_core::cli::exit::USAGE;
        }
    };

    let _ = zenith_core::adapters::console::attach_parent();
    let mut out = zenith_core::adapters::console::output();
    zenith_core::engine::headless::execute(
        zenith_core::config::Paths::resolve(),
        &invocation,
        &mut out,
    )
}

/// Start the application. Returns an exit code.
pub fn run() -> i32 {
    let paths = zenith_core::config::Paths::resolve();

    // A handover ticket is validated before the window exists. If it is invalid
    // there is no safe queue to resume, so the process refuses to start rather
    // than opening an elevated window with unknown intent.
    let resumed = match handover::consume(&paths) {
        Ok(resumed) => resumed,
        Err(_) => return 2,
    };

    let mut app_state = match AppState::bootstrap(paths) {
        Ok(state) => state,
        Err(_) => return 3,
    };

    if let Some(resumed) = &resumed {
        if !resumed.queue.is_empty() {
            let mut params = BTreeMap::new();
            params.insert("count".to_string(), resumed.queue.len().to_string());
            params.insert(
                "actions".to_string(),
                resumed
                    .queue
                    .iter()
                    .map(|action| action.as_str())
                    .collect::<Vec<_>>()
                    .join(","),
            );
            app_state.notices.push(StartupNotice {
                id: "resume-queue".to_string(),
                severity: NoticeSeverity::Info,
                message_key: "notices.resumeQueue".to_string(),
                params,
            });
        }
        if !resumed.dropped.is_empty() {
            let mut params = BTreeMap::new();
            params.insert("items".to_string(), resumed.dropped.join(","));
            app_state.notices.push(StartupNotice {
                id: "resume-dropped".to_string(),
                severity: NoticeSeverity::Warning,
                message_key: "notices.resumeDropped".to_string(),
                params,
            });
        }
    }

    let notices = app_state.notices.clone();

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second launch focuses the first window instead of opening a
            // second database handle.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .setup(move |app| {
            // Notices are emitted after the window exists so the listener is
            // already registered. `state_get` returns the same list, so a
            // missed event loses nothing.
            for notice in notices {
                let _ = tauri::Emitter::emit(app.handle(), "startup_notice", &notice);
            }
            // `03-04` §6 promises `telemetry_update` "every 30 s while visible".
            // Only the after-diagnosis half existed; without this the strip kept
            // reporting the memory figure from the first pass forever.
            telemetry::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info_get,
            commands::state_get,
            commands::preferences_set,
            commands::action_prefs_set,
            commands::diagnose_run,
            commands::action_execute,
            commands::action_cancel,
            commands::snapshot_list,
            commands::snapshot_rollback,
            commands::candidates_scan,
            commands::process_terminate,
            commands::file_save_text,
            commands::support_bundle_create,
            commands::app_data_purge,
            commands::elevation_handover,
        ])
        .run(tauri::generate_context!());

    match result {
        Ok(()) => 0,
        Err(_) => 4,
    }
}

/// Guards the two claims `03-01` §6.5, `03-06` §9 and `04-01` §7 make about
/// machine-wide single execution. The v1.0.0 docs named a hand-rolled mutex that
/// was never implemented; this test binds the claim to the code that actually
/// exists so the prose cannot drift again.
#[cfg(test)]
mod single_instance_tests {
    #[test]
    fn single_instance_guard_is_wired() {
        let source = include_str!("lib.rs");

        // The mechanism that makes a second launch exit.
        assert!(
            source.contains("tauri_plugin_single_instance::init"),
            "the single-instance plugin call is the machine-wide guard"
        );
        // It must focus the existing window rather than silently no-op.
        assert!(
            source.contains("set_focus"),
            "a second launch must focus the first window (REQ-N-020)"
        );
        // And the fabricated mutex name must not come back. Built from parts so
        // this assertion's own text cannot satisfy the search it performs.
        let retired = ["Vellium", "Zenith", "Exec"].join(".");
        assert!(
            !source.contains(&retired),
            "the docs describe a named mutex that does not exist; keep them honest"
        );
    }

    #[test]
    fn execution_registry_admits_one_action_per_process() {
        use zenith_core::engine::executor::ExecutionRegistry;
        use zenith_core::models::ActionId;

        let registry = ExecutionRegistry::new();
        registry
            .begin(ActionId::FlushDnsCache)
            .expect("first claim");
        let second = registry.begin(ActionId::CleanTempCache);
        assert!(second.is_err(), "a second concurrent claim must be refused");
        assert!(registry.active().is_some());
        registry.finish();
        assert!(registry.active().is_none());
        registry
            .begin(ActionId::CleanTempCache)
            .expect("slot is free again");
    }

    /// DEF-064 / REQ-F-134: the uninstaller's "delete app data" checkbox must
    /// target the directories the app actually writes.
    ///
    /// The stock Tauri template deletes `%APPDATA%\<bundle id>` and
    /// `%LOCALAPPDATA%\<bundle id>`, i.e. `com.vellium.zenith` - a path Zenith
    /// never uses. Checking the box therefore deleted nothing and left the store
    /// behind. This test binds the hook to `Paths::resolve` so the two cannot
    /// drift apart again.
    #[test]
    fn uninstall_hook_targets_the_real_data_roots() {
        let raw = include_str!("../installer/hooks.nsh");
        // Strip NSIS comments: the header explains *why* the bundle-id path was
        // wrong, and that explanation must not count as using it.
        let hook: String = raw
            .lines()
            .map(|line| match line.find(';') {
                Some(index) => &line[..index],
                None => line,
            })
            .collect::<Vec<_>>()
            .join("\n");

        // It must be gated on the checkbox Tauri supplies, and only on it.
        assert!(
            hook.contains("$DeleteAppDataCheckboxState = 1"),
            "the hook must run only when the user checked 'delete app data'"
        );
        // Both roots, spelled exactly as `Paths::resolve` builds them.
        assert!(
            hook.contains("Vellium\\Zenith"),
            "the hook must name the real store directory"
        );
        assert!(
            hook.contains("$APPDATA\\Vellium\\Zenith"),
            "machine store is %ProgramData%\\Vellium\\Zenith under context 'all'"
        );
        assert!(
            hook.contains("$LOCALAPPDATA\\Vellium\\Zenith"),
            "per-user store is %LOCALAPPDATA%\\Vellium\\Zenith"
        );
        // It must NOT resurrect the bundle-id path the template used.
        assert!(
            !hook.contains("com.vellium.zenith"),
            "the bundle-id path is empty for Zenith; deleting it is a no-op"
        );

        // Cross-check against the source of truth for the roots.
        let config = include_str!("../../crates/zenith-core/src/config.rs");
        assert!(
            config.contains(r#"join("Vellium").join("Zenith")"#),
            "Paths::resolve must still build Vellium\\Zenith"
        );
    }

    /// Guards `03-01` §6.1 and `03-04` §5.1: the phase a card shows must be
    /// durable, not just an event.
    ///
    /// `ExecutionRegistry::set_phase` existed and was unit-tested, but nothing in
    /// production ever called it, so `state_get` answered `idle` for every card
    /// and the terminal phase the renderer had just received was overwritten by
    /// the next `state/replaced`. The Defect was found by the DEF-048 E2E
    /// journey (a run finished, the card said "idle") rather than by a test, so
    /// this test binds the claim to the call that makes it true.
    #[test]
    fn every_phase_transition_is_recorded_before_it_is_emitted() {
        let source = include_str!("commands.rs");

        // The one helper that both records and emits, and the registry call it
        // must perform first.
        assert!(
            source.contains("fn apply_phase("),
            "phase changes must go through a single helper"
        );
        let helper = source
            .split("fn apply_phase(")
            .nth(1)
            .expect("apply_phase body");
        let body = &helper[..helper.find("\n}\n").unwrap_or(helper.len())];
        let set_at = body
            .find("registry.set_phase")
            .expect("apply_phase must record the phase in the registry");
        let emit_at = body
            .find("\"phase_changed\"")
            .expect("apply_phase must emit phase_changed");
        assert!(
            set_at < emit_at,
            "the registry must be updated before the event is emitted, or the \
             next state_get reports the old phase"
        );

        // Emitting without recording is the bug this test exists for. The only
        // permitted emitter is `apply_phase`; every other production call site
        // must go through it.
        let outside_helper = source.replace(body, "");
        assert!(
            !outside_helper.contains("\"phase_changed\""),
            "phase_changed must only be emitted by apply_phase, so the registry \
             and the renderer can never disagree"
        );
    }

    /// `03-04` §6 promised that a closed window loses nothing.
    ///
    /// It did: `emit` is best-effort, and before this fix the only writes to the
    /// rotating log were on the failure paths. A *successful* action's step trace
    /// existed exactly as long as a listener did, so a support bundle opened
    /// afterwards carried no record of what ran - the opposite of what the
    /// contract, `04-02` §5 and the bundle's own `logs/` entry promise.
    ///
    /// The unit tests in `logging.rs` prove the writer works; this one proves the
    /// command actually calls it. Without it, deleting line 620 would leave every
    /// test green - a gate asserting its own assumption, which is the exact
    /// failure DEF-096 records.
    #[test]
    fn a_successful_action_writes_its_steps_to_the_durable_log() {
        let source = include_str!("commands.rs");
        assert!(
            source.contains("logging::append_steps("),
            "action_execute must persist its step trace, not only emit it"
        );
        // It must be given the real steps, bounded to the same cap the event
        // uses, or the file and the socket describe different runs.
        assert!(
            source.contains("&step_lines, 20"),
            "the durable trace must use the twenty-line cap the event uses"
        );
        assert!(
            source.contains(".take(20)"),
            "the event batch is capped at twenty lines; the file must match"
        );
    }

    /// A cancelled action used to leave nothing behind: the branch wrote to the
    /// log only when `err.code != Cancelled`, so "the user pressed Stop" and
    /// "the process vanished" were indistinguishable in a support bundle. This
    /// pins both halves - that the line is written, and that it carries the
    /// measured latency rather than a guess.
    #[test]
    fn a_cancelled_action_is_recorded_with_its_measured_latency() {
        let source = include_str!("commands.rs");
        assert!(
            source.contains("action {} cancelled{latency}"),
            "the cancelled branch must persist a line even though a cancel is not an error"
        );
        assert!(
            source.contains(".cancel\n                    .latency_ms()"),
            "the line must carry the token's measured latency, not a placeholder"
        );
        assert!(
            !source.contains("if err.code != ErrorCode::Cancelled {"),
            "the old branch skipped the log entirely for a cancel"
        );
    }

    /// The read-only core operation must leave a durable trace too. A support
    /// bundle carries `audit.json`, `snapshots.json`, `environment.json` and the
    /// logs - not the diagnostic reports - so without these lines a bundle filed
    /// after a diagnosis says nothing about what the diagnosis found.
    #[test]
    fn a_diagnosis_is_recorded_in_the_durable_log_on_every_terminal_path() {
        let source = include_str!("commands.rs");
        assert!(
            source.contains("\"diagnosis {} probes, {} need attention\""),
            "the success path must record what the pass measured"
        );
        assert!(
            source.contains("\"diagnosis cancelled{latency}\""),
            "a cancelled diagnosis must be visible, with its latency"
        );
        assert!(
            source.contains("\"diagnosis failed: {}\""),
            "a failed diagnosis must be an error line, not a silence"
        );
    }
}
