//! Argument grammar for the headless CLI (`03-04` §8).
//!
//! Parsing is kept here, away from the OS, for one reason: it is the part that
//! can be wrong in ways a user notices immediately (`--actions` with a typo, an
//! exit code that says "success" for a refusal). Every rule below is unit
//! tested; the dispatch that acts on the result lives in the application crate.
//!
//! Nothing here reads `std::env` or writes to a stream.

use std::path::PathBuf;

use crate::error::{ErrorCode, ZenithError};
use crate::models::ActionId;

/// Exit codes from `03-04` §8. Not an enum on purpose: the shell needs a number.
pub mod exit {
    /// Every requested step succeeded.
    pub const OK: i32 = 0;
    /// Usage or argument error.
    pub const USAGE: i32 = 1;
    /// One or more steps failed.
    pub const FAILED: i32 = 2;
    /// Cancelled or timed out.
    pub const CANCELLED: i32 = 3;
    /// Elevation required and not elevated.
    pub const ELEVATION: i32 = 4;
    /// Refused: a dependency is unmet, or the selection is not allowed.
    pub const REFUSED: i32 = 5;
}

/// A parsed invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// `--headless --actions <csv>`
    Actions {
        actions: Vec<ActionId>,
        dry_run: bool,
        json: bool,
        yes: bool,
        timeout_secs: Option<u64>,
    },
    /// `--headless --diagnose`
    Diagnose { json: bool },
    /// `--headless --rollback <snapshotId>`
    Rollback { snapshot_id: String, json: bool },
    /// `--support-bundle [--out <path>]`
    SupportBundle { out: Option<PathBuf>, json: bool },
    /// `mcp --stdio` - Model Context Protocol server, line-delimited JSON-RPC.
    Mcp { stdio: bool },
    /// `api --port <port>` - loopback-only read-only HTTP API.
    Api { port: u16 },
    /// `webhook --url <url> [--dry-run]` - send one signed test event.
    Webhook {
        url: String,
        dry_run: bool,
        json: bool,
    },
}

/// What the process should do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Invocation {
    Run(Command),
    Help,
    Version,
}

/// A rejected argument list.
///
/// `detail` is technical English for a console operator (never rendered in the
/// UI, which consumes codes via IPC instead). `code` is stable so a script can
/// branch without parsing the sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageError {
    pub code: &'static str,
    pub detail: String,
}

impl UsageError {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

/// True when the argument list asks for the CLI at all.
///
/// The GUI is the default; a bare `zenith.exe`, a double-click, or a handover
/// launch (`--elevate`) must never enter the CLI path.
///
/// Any CLI-shaped flag counts, not just the mode flags. `--actions` without
/// `--headless` must reach the parser and be *refused*, never fall through to
/// the GUI: a user who typed a repair command and got a window would believe
/// nothing happened.
pub fn is_cli(args: &[String]) -> bool {
    if args.iter().any(|arg| arg == "--elevate") {
        return false;
    }
    if let Some(first) = args.first()
        && matches!(first.as_str(), "mcp" | "api" | "webhook")
    {
        return true;
    }
    args.iter().any(|arg| {
        matches!(
            arg.as_str(),
            "--headless"
                | "--support-bundle"
                | "--actions"
                | "--diagnose"
                | "--rollback"
                | "--out"
                | "--dry-run"
                | "--json"
                | "--yes"
                | "--timeout-secs"
                | "--help"
                | "-h"
                | "--version"
                | "-V"
        )
    })
}

/// Parse everything after the executable name.
pub fn parse(args: &[String]) -> Result<Invocation, UsageError> {
    if args.is_empty() {
        return Ok(Invocation::Help);
    }
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        return Ok(Invocation::Help);
    }
    if args.iter().any(|arg| arg == "--version" || arg == "-V") {
        return Ok(Invocation::Version);
    }

    if let Some(first) = args.first() {
        match first.as_str() {
            "mcp" => return parse_mcp(&args[1..]),
            "api" => return parse_api(&args[1..]),
            "webhook" => return parse_webhook(&args[1..]),
            _ => {}
        }
    }

    let json = has(args, "--json");
    let support_bundle = has(args, "--support-bundle");
    let headless = has(args, "--headless");
    let wants_actions = has(args, "--actions");
    let wants_diagnose = has(args, "--diagnose");
    let wants_rollback = has(args, "--rollback");

    let modes = [
        support_bundle,
        wants_actions,
        wants_diagnose,
        wants_rollback,
    ]
    .into_iter()
    .filter(|selected| *selected)
    .count();
    if modes == 0 {
        return Err(UsageError::new(
            "USAGE",
            "one of --actions, --diagnose, --rollback or --support-bundle is required",
        ));
    }
    if modes > 1 {
        return Err(UsageError::new(
            "USAGE",
            "--actions, --diagnose, --rollback and --support-bundle are mutually exclusive",
        ));
    }

    if support_bundle {
        // The bundle is a one-shot operation, but it is still a CLI command, so
        // it must not be combined with the mutually exclusive headless modes.
        let out = value(args, "--out")?.map(PathBuf::from);
        return Ok(Invocation::Run(Command::SupportBundle { out, json }));
    }

    // Everything else requires --headless: silently doing repairs because a
    // flag was typed is worse than refusing.
    if !headless {
        return Err(UsageError::new(
            "USAGE",
            "--actions/--diagnose/--rollback require --headless",
        ));
    }

    if wants_actions {
        let raw = value(args, "--actions")?
            .ok_or_else(|| UsageError::new("USAGE", "--actions needs a value"))?;
        let actions = parse_actions(&raw)?;
        let timeout_secs = match value(args, "--timeout-secs")? {
            Some(text) => Some(text.parse::<u64>().map_err(|_| {
                UsageError::new("USAGE", "--timeout-secs must be a positive integer")
            })?),
            None => None,
        };
        if timeout_secs == Some(0) {
            return Err(UsageError::new(
                "USAGE",
                "--timeout-secs must be greater than zero",
            ));
        }
        return Ok(Invocation::Run(Command::Actions {
            actions,
            dry_run: has(args, "--dry-run"),
            json,
            yes: has(args, "--yes"),
            timeout_secs,
        }));
    }

    if wants_diagnose {
        return Ok(Invocation::Run(Command::Diagnose { json }));
    }

    let snapshot_id = value(args, "--rollback")?
        .ok_or_else(|| UsageError::new("USAGE", "--rollback needs a snapshot id"))?;
    if snapshot_id.trim().is_empty() {
        return Err(UsageError::new("USAGE", "--rollback needs a snapshot id"));
    }
    Ok(Invocation::Run(Command::Rollback { snapshot_id, json }))
}

/// `mcp --stdio`. No other flag is accepted: a mode flag that is silently
/// ignored is a mode flag a user believes was honoured.
fn parse_mcp(args: &[String]) -> Result<Invocation, UsageError> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        return Ok(Invocation::Help);
    }
    if !has(args, "--stdio") {
        return Err(UsageError::new("USAGE", "mcp requires --stdio"));
    }
    if let Some(unknown) = args.iter().find(|arg| arg.as_str() != "--stdio") {
        return Err(UsageError::new(
            "USAGE",
            format!("mcp does not accept {unknown}"),
        ));
    }
    Ok(Invocation::Run(Command::Mcp { stdio: true }))
}

/// `api --port <port>`. Loopback only; a port below 1024 is refused because a
/// low port either needs elevation or collides with a system service.
fn parse_api(args: &[String]) -> Result<Invocation, UsageError> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        return Ok(Invocation::Help);
    }
    let raw =
        value(args, "--port")?.ok_or_else(|| UsageError::new("USAGE", "api requires --port"))?;
    let port = raw
        .parse::<u16>()
        .map_err(|_| UsageError::new("USAGE", "--port must be a number"))?;
    if port < 1024 {
        return Err(UsageError::new("USAGE", "--port must be 1024 or higher"));
    }
    if let Some(unknown) = args
        .iter()
        .enumerate()
        .find(|(index, arg)| {
            arg.as_str() != "--port" && !(*index > 0 && args[index - 1] == "--port")
        })
        .map(|(_, arg)| arg)
    {
        return Err(UsageError::new(
            "USAGE",
            format!("api does not accept {unknown}"),
        ));
    }
    Ok(Invocation::Run(Command::Api { port }))
}

/// `webhook --url <url> [--dry-run] [--json]`.
fn parse_webhook(args: &[String]) -> Result<Invocation, UsageError> {
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        return Ok(Invocation::Help);
    }
    let url =
        value(args, "--url")?.ok_or_else(|| UsageError::new("USAGE", "webhook requires --url"))?;
    if let Err(error) = crate::webhook::validate_url(&url) {
        return Err(UsageError::new(
            "USAGE",
            format!("--url is not acceptable: {error}"),
        ));
    }
    if let Some(unknown) = args.iter().find(|arg| {
        !matches!(arg.as_str(), "--url" | "--dry-run" | "--json") && !arg.contains("://")
    }) {
        return Err(UsageError::new(
            "USAGE",
            format!("webhook does not accept {unknown}"),
        ));
    }
    Ok(Invocation::Run(Command::Webhook {
        url,
        dry_run: has(args, "--dry-run"),
        json: has(args, "--json"),
    }))
}

/// `--flag` presence, exact match (no `--flag=value` alias to keep the surface
/// small and unambiguous).
fn has(args: &[String], flag: &str) -> bool {
    args.iter().any(|arg| arg == flag)
}

/// `--flag value`, refusing a value that looks like another flag.
fn value(args: &[String], flag: &str) -> Result<Option<String>, UsageError> {
    let Some(index) = args.iter().position(|arg| arg == flag) else {
        return Ok(None);
    };
    let Some(next) = args.get(index + 1) else {
        return Err(UsageError::new("USAGE", format!("{flag} needs a value")));
    };
    if next.starts_with("--") {
        return Err(UsageError::new("USAGE", format!("{flag} needs a value")));
    }
    Ok(Some(next.clone()))
}

/// A comma-separated list of action ids, de-duplicated in caller order.
fn parse_actions(raw: &str) -> Result<Vec<ActionId>, UsageError> {
    let mut actions = Vec::new();
    let mut unknown = Vec::new();
    for item in raw.split(',') {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        match ActionId::parse(item) {
            Some(id) => {
                if !actions.contains(&id) {
                    actions.push(id);
                }
            }
            None => unknown.push(item.to_string()),
        }
    }
    if !unknown.is_empty() {
        return Err(UsageError::new(
            "USAGE",
            format!("unknown action id(s): {}", unknown.join(", ")),
        ));
    }
    if actions.is_empty() {
        return Err(UsageError::new("USAGE", "--actions is empty"));
    }
    Ok(actions)
}

/// Map a core failure to the documented exit code.
pub fn exit_code_for(error: &ZenithError) -> i32 {
    match error.code {
        ErrorCode::InvalidArgument => exit::USAGE,
        ErrorCode::ElevationRequired | ErrorCode::ElevationHandoverInvalid => exit::ELEVATION,
        ErrorCode::DependencyNotMet | ErrorCode::ConfirmationRequired => exit::REFUSED,
        ErrorCode::Cancelled | ErrorCode::Timeout => exit::CANCELLED,
        _ => exit::FAILED,
    }
}

/// The help text, kept beside the grammar so the two cannot drift.
pub const HELP: &str = "\
Zenith - Windows diagnostics and repair

USAGE:
  zenith.exe                                   open the desktop app
  zenith.exe --headless --diagnose [--json]
  zenith.exe --headless --actions <csv> [--dry-run] [--json] [--yes] [--timeout-secs N]
  zenith.exe --headless --rollback <snapshotId> [--json]
  zenith.exe --support-bundle [--out <path>] [--json]
  zenith.exe mcp --stdio                        Model Context Protocol, JSON-RPC 2.0 over stdio
  zenith.exe api --port <port>                  read-only HTTP API on 127.0.0.1
  zenith.exe webhook --url <url> [--dry-run] [--json]
                                                send one HMAC-SHA256 signed test event

EXIT CODES:
  0  all requested steps succeeded
  1  usage or argument error
  2  one or more steps failed
  3  cancelled or timed out
  4  elevation required and not elevated
  5  refused (dependency unmet or selection not allowed)
";

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(line: &str) -> Vec<String> {
        line.split_whitespace().map(str::to_string).collect()
    }

    #[test]
    fn the_gui_is_the_default() {
        assert!(!is_cli(&[]));
        assert!(!is_cli(&argv("--elevate --handover abc --wait-pid 12")));
        assert!(is_cli(&argv("--headless --diagnose")));
        assert!(is_cli(&argv("--support-bundle")));
    }

    #[test]
    fn a_handover_launch_is_never_treated_as_cli() {
        // Even if a handover carries a CLI-looking flag, the ticket path wins:
        // resuming an elevated queue through a console would bypass the UI.
        assert!(!is_cli(&argv("--elevate --headless --diagnose")));
    }

    #[test]
    fn a_mode_flag_without_headless_still_reaches_the_parser() {
        // Regression: `--actions` alone once fell through to the GUI, so a user
        // who typed a repair command got a window and believed nothing happened.
        // It must route to the parser, which refuses with a usage error.
        assert!(is_cli(&argv("--actions flush-dns-cache")));
        assert!(is_cli(&argv("--diagnose")));
        assert!(is_cli(&argv("--rollback abc")));
        assert!(parse(&argv("--actions flush-dns-cache")).is_err());
    }

    #[test]
    fn diagnose_parses_with_json() {
        let parsed = parse(&argv("--headless --diagnose --json")).expect("parse");
        assert_eq!(parsed, Invocation::Run(Command::Diagnose { json: true }));
    }

    #[test]
    fn actions_parse_order_preserved_and_deduplicated() {
        let parsed = parse(&argv(
            "--headless --actions flush-dns-cache,clean-temp-cache,flush-dns-cache",
        ))
        .expect("parse");
        let Invocation::Run(Command::Actions { actions, .. }) = parsed else {
            panic!("expected actions");
        };
        assert_eq!(
            actions,
            vec![ActionId::FlushDnsCache, ActionId::CleanTempCache]
        );
    }

    #[test]
    fn an_unknown_action_is_a_usage_error_that_names_it() {
        let error = parse(&argv("--headless --actions not-an-action")).expect_err("must fail");
        assert_eq!(error.code, "USAGE");
        assert!(error.detail.contains("not-an-action"));
    }

    #[test]
    fn actions_without_headless_is_refused() {
        // Typing --actions alone must never begin a repair.
        let error = parse(&argv("--actions flush-dns-cache")).expect_err("must fail");
        assert_eq!(error.code, "USAGE");
        assert!(error.detail.contains("--headless"));
    }

    #[test]
    fn mutually_exclusive_modes_are_rejected() {
        let error = parse(&argv("--headless --diagnose --rollback abc")).expect_err("must fail");
        assert_eq!(error.code, "USAGE");
    }

    #[test]
    fn a_timeout_of_zero_is_rejected_and_a_real_one_is_kept() {
        assert!(
            parse(&argv(
                "--headless --actions flush-dns-cache --timeout-secs 0"
            ))
            .is_err()
        );
        let parsed = parse(&argv(
            "--headless --actions flush-dns-cache --timeout-secs 30",
        ))
        .expect("parse");
        let Invocation::Run(Command::Actions { timeout_secs, .. }) = parsed else {
            panic!("expected actions");
        };
        assert_eq!(timeout_secs, Some(30));
    }

    #[test]
    fn a_flag_swallowing_the_next_flag_is_a_usage_error() {
        let error = parse(&argv("--headless --actions --json")).expect_err("must fail");
        assert_eq!(error.code, "USAGE");
    }

    #[test]
    fn rollback_requires_an_id() {
        assert!(parse(&argv("--headless --rollback")).is_err());
    }

    #[test]
    fn support_bundle_accepts_an_output_path() {
        let parsed = parse(&argv("--support-bundle --out C:\\tmp\\b.zip")).expect("parse");
        let Invocation::Run(Command::SupportBundle { out, json }) = parsed else {
            panic!("expected support bundle");
        };
        assert_eq!(out.as_deref(), Some(std::path::Path::new("C:\\tmp\\b.zip")));
        assert!(!json);
    }

    #[test]
    fn help_and_version_short_circuit() {
        assert_eq!(parse(&argv("--help")).expect("help"), Invocation::Help);
        assert_eq!(parse(&argv("-h")).expect("help"), Invocation::Help);
        assert_eq!(
            parse(&argv("--version")).expect("version"),
            Invocation::Version
        );
        assert_eq!(parse(&[]).expect("empty"), Invocation::Help);
    }

    #[test]
    fn exit_codes_match_the_documented_table() {
        use crate::error::ErrorCode;
        let cases = [
            (ErrorCode::InvalidArgument, exit::USAGE),
            (ErrorCode::ElevationRequired, exit::ELEVATION),
            (ErrorCode::DependencyNotMet, exit::REFUSED),
            (ErrorCode::Cancelled, exit::CANCELLED),
            (ErrorCode::Timeout, exit::CANCELLED),
            (ErrorCode::AccessDenied, exit::FAILED),
            (ErrorCode::IntegrityError, exit::FAILED),
        ];
        for (code, expected) in cases {
            assert_eq!(exit_code_for(&ZenithError::new(code)), expected, "{code:?}");
        }
    }

    #[test]
    fn the_help_text_names_every_exit_code() {
        for line in ["  0  ", "  1  ", "  2  ", "  3  ", "  4  ", "  5  "] {
            assert!(HELP.contains(line), "help is missing {line:?}");
        }
    }
}

#[cfg(test)]
mod subcommand_tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn mcp_requires_stdio_and_nothing_else() {
        assert_eq!(
            parse(&args(&["mcp", "--stdio"])),
            Ok(Invocation::Run(Command::Mcp { stdio: true }))
        );
        assert!(parse(&args(&["mcp"])).is_err());
        assert!(parse(&args(&["mcp", "--stdio", "--json"])).is_err());
        assert!(is_cli(&args(&["mcp", "--stdio"])));
    }

    #[test]
    fn api_takes_a_high_port_only() {
        assert_eq!(
            parse(&args(&["api", "--port", "8787"])),
            Ok(Invocation::Run(Command::Api { port: 8787 }))
        );
        assert!(parse(&args(&["api", "--port", "80"])).is_err());
        assert!(parse(&args(&["api"])).is_err());
        assert!(parse(&args(&["api", "--port", "not-a-port"])).is_err());
        assert!(is_cli(&args(&["api", "--port", "8787"])));
    }

    #[test]
    fn webhook_refuses_a_url_that_would_put_the_secret_on_the_wire() {
        let https = parse(&args(&["webhook", "--url", "https://example.com/hook"]));
        assert_eq!(
            https,
            Ok(Invocation::Run(Command::Webhook {
                url: "https://example.com/hook".to_string(),
                dry_run: false,
                json: false,
            }))
        );
        assert!(parse(&args(&["webhook", "--url", "http://example.com/hook"])).is_err());
        assert!(parse(&args(&["webhook"])).is_err());
        assert!(is_cli(&args(&[
            "webhook",
            "--url",
            "https://example.com/hook"
        ])));
    }

    #[test]
    fn a_gui_launch_and_a_handover_stay_out_of_the_cli() {
        assert!(!is_cli(&[]));
        assert!(!is_cli(&args(&["--elevate", "--stdin"])));
    }
}
