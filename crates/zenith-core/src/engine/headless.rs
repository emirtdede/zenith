//! Headless command dispatch (`03-04` §8).
//!
//! The grammar lives in [`crate::cli`] so it can be tested without an OS. This
//! module is the other half: it opens the store, runs the selected operation and
//! writes a result. It returns an **exit code** rather than a `Result` because
//! the shell is the consumer and every documented failure is a number, not a
//! string a script must parse.
//!
//! Two rules keep this from becoming a second, weaker execution path:
//!
//! * Repairs still go through `pipeline::run` - the same validation, snapshot and
//!   scope checks the GUI uses. The CLI adds no privileged shortcut.
//! * A flag that was not given never triggers a write. `--dry-run` writes
//!   nothing at all; a selection that was not confirmed is refused.

use std::io::Write;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::adapters::{privilege, probes};
use crate::cli::{Command, Invocation, exit, exit_code_for};
use crate::config::Paths;
use crate::engine::db::Store;
use crate::engine::executor::Confirmation;
use crate::engine::scope::ScopeRoots;
use crate::engine::{dag, keystore, pipeline, support};
use crate::error::ZenithError;
use crate::models::{ActionId, ExecutionOutcome};
use crate::{VERSION, manifest};

/// One step in the JSON envelope.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StepLine {
    action_id: String,
    status: &'static str,
    duration_ms: u64,
    summary_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    snapshot_id: Option<String>,
}

impl StepLine {
    fn from_outcome(outcome: &ExecutionOutcome) -> Self {
        Self {
            action_id: outcome.action_id.as_str().to_string(),
            status: if outcome.success {
                "success"
            } else {
                "failure"
            },
            duration_ms: outcome.duration_ms,
            summary_key: outcome.summary_key.clone(),
            error_code: None,
            snapshot_id: outcome.snapshot_id.clone(),
        }
    }

    fn failed(action: ActionId, error: &ZenithError) -> Self {
        Self {
            action_id: action.as_str().to_string(),
            status: "failure",
            duration_ms: 0,
            summary_key: error.code.message_key().to_string(),
            error_code: Some(error.code.as_str().to_string()),
            snapshot_id: None,
        }
    }
}

/// The `03-04` §8 envelope.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope<'a> {
    schema_version: u32,
    correlation_id: String,
    started_at_utc: String,
    command: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    dry_run: Option<bool>,
    results: &'a [StepLine],
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
}

/// Run one already-parsed invocation and return the process exit code.
///
/// `paths` is injected so the dispatch can be exercised against a temporary
/// root instead of the machine's real state directory.
pub fn execute(paths: Paths, invocation: &Invocation, out: &mut dyn Write) -> i32 {
    match invocation {
        Invocation::Help => {
            let _ = out.write_all(crate::cli::HELP.as_bytes());
            0
        }
        Invocation::Version => {
            let _ = writeln!(out, "zenith {VERSION}");
            0
        }
        Invocation::Run(command) => run_command(paths, command, out),
    }
}

fn run_command(paths: Paths, command: &Command, out: &mut dyn Write) -> i32 {
    // Argument-level refusals come first and touch no disk. A refused selection
    // must not depend on whether the store happens to open - otherwise a broken
    // database would turn "this action cannot run headlessly" into
    // "INTEGRITY_ERROR", and a script would branch on the wrong exit code.
    //
    // The predicate is *irreversible and mutating*, not `risk == Destructive`.
    // `empty-recycle-bin` is `risk: Moderate` yet `tier: Irreversible`: it
    // permanently deletes user files. Gating on risk alone would let a script
    // destroy data with `--yes`, which is precisely the silent-loss failure the
    // tier model exists to prevent (ADR-004, `03-05` §4).
    if let Command::Actions { actions, .. } = command
        && let Some(blocked) = actions.iter().find(|id| {
            let def = manifest::action_by_id(**id);
            def.tier == crate::models::ReversibilityTier::Irreversible && !def.no_mutation
        })
    {
        let error = ZenithError::new(crate::error::ErrorCode::InvalidArgument)
            .with("actionId", blocked.as_str())
            .with(
                "reason",
                "irreversible actions are refused by the headless CLI (REQ-F-084)",
            );
        report_error(out, &error);
        return exit::REFUSED;
    }

    paths.ensure_layout();

    let key = match keystore::load_or_create(&paths) {
        Ok(key) => key,
        Err(error) => {
            report_error(out, &error);
            return exit_code_for(&error);
        }
    };
    let store = match Store::open(&paths, key) {
        Ok((store, _recovery)) => store,
        Err(error) => {
            report_error(out, &error);
            return exit_code_for(&error);
        }
    };
    let elevated = privilege::is_elevated();

    match command {
        Command::Diagnose { json } => diagnose(&paths, *json, out),
        Command::Mcp { .. } => serve_mcp(&paths, out),
        Command::Api { port } => serve_api(&paths, *port, out),
        Command::Webhook { url, dry_run, json } => send_webhook(&paths, url, *dry_run, *json, out),
        Command::Actions {
            actions,
            dry_run,
            json,
            yes,
            timeout_secs,
        } => actions_cmd(
            &store,
            paths,
            actions,
            *dry_run,
            *json,
            *yes,
            *timeout_secs,
            elevated,
            out,
        ),
        Command::Rollback { snapshot_id, json } => {
            rollback(&store, snapshot_id, *json, elevated, out)
        }
        Command::SupportBundle { out: to, json } => {
            support_bundle(&store, &paths, to.as_deref(), *json, elevated, out)
        }
    }
}

fn diagnose(paths: &Paths, json: bool, out: &mut dyn Write) -> i32 {
    let ctx = probes::ProbeContext {
        paths: paths.clone(),
        cancel: Arc::new(crate::engine::executor::CancelToken::new()),
        dns_probe_hosts: vec![("www.msftconnecttest.com", 443)],
    };
    let reports = probes::probe_all(&ctx);

    if json {
        let payload = serde_json::json!({
            "schemaVersion": crate::SCHEMA_VERSION,
            "command": "diagnose",
            "reports": reports,
        });
        write_json(out, &payload);
        return exit::OK;
    }

    for report in &reports {
        let _ = writeln!(
            out,
            "{:<24} {} {}",
            report.action_id.as_str(),
            if report.needs_attention {
                "attention"
            } else {
                "ok"
            },
            report.metric_key
        );
    }
    exit::OK
}

#[allow(clippy::too_many_arguments)]
fn actions_cmd(
    store: &Store,
    paths: Paths,
    selection: &[ActionId],
    dry_run: bool,
    json: bool,
    yes: bool,
    timeout_secs: Option<u64>,
    elevated: bool,
    out: &mut dyn Write,
) -> i32 {
    // The destructive refusal happened in `run_command`, before the store was
    // opened, so this function can assume the selection is runnable (REQ-F-084).
    if dry_run {
        let mut steps = Vec::new();
        for action in selection {
            match pipeline::dry_run(*action, elevated) {
                Ok(tier) => steps.push(StepLine {
                    action_id: action.as_str().to_string(),
                    status: "would_run",
                    duration_ms: 0,
                    summary_key: tier.as_str().to_string(),
                    error_code: None,
                    snapshot_id: None,
                }),
                Err(error) => steps.push(StepLine::failed(*action, &error)),
            }
        }
        emit(out, "actions", Some(true), &steps, json);
        return exit::OK;
    }

    // Dependency order is the same DAG the GUI uses; running `sfc` before `dism`
    // because a CSV said so would be a different product (REQ-F-081).
    let ordered = match dag::topological_order(selection) {
        Ok(ordered) => ordered,
        Err(error) => {
            report_error(out, &error);
            return exit_code_for(&error);
        }
    };

    let roots = ScopeRoots::from_environment();
    let cancel = Arc::new(crate::engine::executor::CancelToken::new());
    let ctx = pipeline::RunContext::new(store, paths, roots, elevated, Arc::clone(&cancel));

    let deadline = timeout_secs.map(|secs| Instant::now() + Duration::from_secs(secs));
    let mut steps = Vec::new();
    let mut code = exit::OK;

    for action in ordered {
        if let Some(deadline) = deadline
            && Instant::now() >= deadline
        {
            report_error(
                out,
                &ZenithError::new(crate::error::ErrorCode::Timeout)
                    .with("reason", "timeout-secs elapsed"),
            );
            code = exit::CANCELLED;
            break;
        }

        // `--yes` is the CLI's acknowledgement. It carries the action's *real*
        // tier so `validate_execution` still refuses a mismatched claim.
        let confirmation = yes.then(|| Confirmation {
            acknowledged_tier: manifest::action_by_id(action).tier,
        });

        match pipeline::run(&ctx, action, confirmation, Vec::new()) {
            Ok(outcome) => {
                if !outcome.success && code == exit::OK {
                    code = exit::FAILED;
                }
                steps.push(StepLine::from_outcome(&outcome));
            }
            Err(error) => {
                let mapped = exit_code_for(&error);
                if code == exit::OK {
                    code = mapped;
                }
                steps.push(StepLine::failed(action, &error));
            }
        }
    }

    emit(out, "actions", None, &steps, json);
    code
}

fn rollback(
    store: &Store,
    snapshot_id: &str,
    json: bool,
    elevated: bool,
    out: &mut dyn Write,
) -> i32 {
    let roots = ScopeRoots::from_environment();
    match pipeline::rollback(store, &roots, snapshot_id, elevated) {
        Ok(outcome) => {
            let steps = vec![StepLine {
                action_id: "rollback".to_string(),
                status: if outcome.success {
                    "success"
                } else {
                    "failure"
                },
                duration_ms: outcome.duration_ms,
                summary_key: "outcomes.rollback".to_string(),
                error_code: None,
                snapshot_id: Some(outcome.snapshot_id.clone()),
            }];
            let code = if outcome.success {
                exit::OK
            } else {
                exit::FAILED
            };
            emit(out, "rollback", None, &steps, json);
            code
        }
        Err(error) => {
            report_error(out, &error);
            exit_code_for(&error)
        }
    }
}

fn support_bundle(
    store: &Store,
    paths: &Paths,
    destination: Option<&std::path::Path>,
    json: bool,
    elevated: bool,
    out: &mut dyn Write,
) -> i32 {
    let bundle = match support::create(store, paths, elevated, "") {
        Ok(bundle) => bundle,
        Err(error) => {
            report_error(out, &error);
            return exit_code_for(&error);
        }
    };

    // `--out` is a *copy*, not a redirect: `support::create` owns the bundle
    // layout (and its redaction), so the CLI must not grow a second writer.
    let final_path = match destination {
        Some(target) => match std::fs::copy(&bundle.path, target) {
            Ok(_) => target.display().to_string(),
            Err(error) => {
                report_error(out, &ZenithError::io("copy support bundle", &error));
                return exit::FAILED;
            }
        },
        None => bundle.path.clone(),
    };

    if json {
        let payload = serde_json::json!({
            "schemaVersion": crate::SCHEMA_VERSION,
            "command": "support-bundle",
            "path": final_path,
            "bytes": bundle.bytes,
            "includedFiles": bundle.included_files,
            "redactionReport": bundle.redaction_report,
        });
        write_json(out, &payload);
    } else {
        let _ = writeln!(out, "support bundle: {final_path} ({} bytes)", bundle.bytes);
    }
    exit::OK
}

fn emit(out: &mut dyn Write, command: &str, dry_run: Option<bool>, steps: &[StepLine], json: bool) {
    if json {
        let envelope = Envelope {
            schema_version: u32::try_from(crate::SCHEMA_VERSION).unwrap_or(1),
            correlation_id: crate::engine::audit::new_correlation_id(),
            started_at_utc: crate::engine::audit::now_utc(),
            command,
            dry_run,
            results: steps,
            error_code: None,
        };
        write_json(out, &envelope);
    } else {
        if dry_run == Some(true) {
            let _ = writeln!(out, "dry run: no changes were made");
        }
        for step in steps {
            let _ = writeln!(
                out,
                "{:<24} {:<8} {:>6} ms  {}",
                step.action_id, step.status, step.duration_ms, step.summary_key
            );
        }
    }
}

fn write_json(out: &mut dyn Write, value: &impl Serialize) {
    match serde_json::to_string_pretty(value) {
        Ok(text) => {
            let _ = writeln!(out, "{text}");
        }
        Err(_) => {
            let _ = writeln!(out, "{{\"errorCode\":\"INTERNAL\"}}");
        }
    }
}

/// Console rendering of a failure. The code is on its own line so a script can
/// grep it, and the message is the localised key, never a panic string.
fn report_error(out: &mut dyn Write, error: &ZenithError) {
    let _ = writeln!(out, "error: {}", error.code.as_str());
    let _ = writeln!(out, "  message: {}", error.code.message_key());
    if let Some(detail) = &error.detail {
        let _ = writeln!(out, "  detail: {detail}");
    }
}

/// The MCP and API surfaces share one read-only host so the two cannot drift
/// into different answers about the same machine.
struct ReadOnlyHost {
    paths: Paths,
}

fn probe_reports(paths: &Paths) -> Result<serde_json::Value, String> {
    let ctx = probes::ProbeContext {
        paths: paths.clone(),
        cancel: Arc::new(crate::engine::executor::CancelToken::new()),
        dns_probe_hosts: vec![("www.msftconnecttest.com", 443)],
    };
    let reports = probes::probe_all(&ctx);
    serde_json::to_value(&reports).map_err(|error| error.to_string())
}

fn action_catalogue() -> Vec<crate::mcp::ToolAction> {
    crate::manifest::ACTIONS
        .iter()
        .map(|def| crate::mcp::ToolAction {
            id: def.id.as_str(),
            name_key: format!("{}.name", def.i18n_prefix),
            risk: def.risk.as_str(),
            tier: def.tier.as_str(),
        })
        .collect()
}

impl crate::mcp::ToolHost for ReadOnlyHost {
    fn list_actions(&self) -> Vec<crate::mcp::ToolAction> {
        action_catalogue()
    }

    fn diagnose(&self) -> Result<serde_json::Value, String> {
        probe_reports(&self.paths)
    }
}

impl crate::api::ApiHandler for ReadOnlyHost {
    fn actions(&self) -> serde_json::Value {
        let actions: Vec<serde_json::Value> = action_catalogue()
            .into_iter()
            .map(|action| {
                serde_json::json!({
                    "id": action.id,
                    "nameKey": action.name_key,
                    "risk": action.risk,
                    "tier": action.tier,
                })
            })
            .collect();
        serde_json::Value::Array(actions)
    }

    fn diagnose(&self) -> Result<serde_json::Value, String> {
        probe_reports(&self.paths)
    }
}

fn serve_mcp(paths: &Paths, out: &mut dyn Write) -> i32 {
    let host = ReadOnlyHost {
        paths: paths.clone(),
    };
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    match crate::mcp::serve_stdio(&host, &mut input, out) {
        Ok(_) => exit::OK,
        Err(error) => {
            let _ = writeln!(out, "mcp: {error}");
            exit::FAILED
        }
    }
}

fn serve_api(paths: &Paths, port: u16, out: &mut dyn Write) -> i32 {
    let mut token_bytes = [0u8; 32];
    if getrandom::fill(&mut token_bytes).is_err() {
        let _ = writeln!(out, "api: csprng unavailable");
        return exit::FAILED;
    }
    let token = hex::encode(token_bytes);
    // The listener is bound here rather than inside the server loop, so the
    // printed port is the port that is actually open when `--port 0` is used by
    // a test harness.
    let listener = match std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)) {
        Ok(listener) => listener,
        Err(error) => {
            let _ = writeln!(out, "api: cannot bind 127.0.0.1:{port}: {error}");
            return exit::FAILED;
        }
    };
    let Ok(address) = listener.local_addr() else {
        let _ = writeln!(out, "api: cannot read the bound address");
        return exit::FAILED;
    };
    let config = crate::api::ApiConfig::new(address.port(), token.clone());
    let _ = writeln!(
        out,
        "zenith api listening on http://127.0.0.1:{} (read-only, loopback only)",
        address.port()
    );
    let _ = writeln!(out, "token: {token}");
    let _ = out.flush();
    let host = ReadOnlyHost {
        paths: paths.clone(),
    };
    match crate::api::serve(listener, config, &host, None) {
        Ok(_) => exit::OK,
        Err(error) => {
            let _ = writeln!(out, "api: {error}");
            exit::FAILED
        }
    }
}

fn send_webhook(paths: &Paths, url: &str, dry_run: bool, json: bool, out: &mut dyn Write) -> i32 {
    let secret = match std::env::var("ZENITH_WEBHOOK_SECRET") {
        Ok(value) if !value.is_empty() => value.into_bytes(),
        _ => match crate::webhook::load_or_create_secret(paths) {
            Ok(secret) => secret,
            Err(error) => {
                let _ = writeln!(out, "webhook: {error}");
                return exit::FAILED;
            }
        },
    };
    let target = match crate::webhook::Target::new(url, secret) {
        Ok(target) => target,
        Err(error) => {
            let _ = writeln!(out, "webhook: {error}");
            return exit::USAGE;
        }
    };
    let now = time::OffsetDateTime::now_utc();
    let mut payload = crate::webhook::EventPayload::new(
        crate::webhook::EventKind::ActionCompleted,
        format!("test-{}", uuid::Uuid::new_v4()),
        now.format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_default(),
    );
    payload.outcome = Some("test".to_string());
    let body = match payload.to_bytes() {
        Ok(body) => body,
        Err(error) => {
            let _ = writeln!(out, "webhook: {error}");
            return exit::FAILED;
        }
    };
    let signature =
        match crate::webhook::signature_header(&target.secret, now.unix_timestamp(), &body) {
            Ok(signature) => signature,
            Err(error) => {
                let _ = writeln!(out, "webhook: {error}");
                return exit::FAILED;
            }
        };

    if dry_run {
        if json {
            write_json(
                out,
                &serde_json::json!({
                    "schemaVersion": 1,
                    "command": "webhook",
                    "dryRun": true,
                    "url": target.url,
                    "signature": signature,
                    "body": payload,
                }),
            );
        } else {
            let _ = writeln!(out, "dry run: no request sent");
            let _ = writeln!(out, "X-Zenith-Signature: {signature}");
        }
        return exit::OK;
    }

    #[cfg(windows)]
    {
        let transport = crate::webhook::WinHttpTransport;
        let mut sleep = |ms: u64| std::thread::sleep(Duration::from_millis(ms));
        let delivery = crate::webhook::deliver(
            &transport,
            &target,
            &payload,
            now.unix_timestamp(),
            &mut sleep,
        );
        if json {
            write_json(
                out,
                &serde_json::json!({
                    "schemaVersion": 1,
                    "command": "webhook",
                    "attempts": delivery.attempts,
                    "status": delivery.status,
                    "error": delivery.last_error,
                    "signature": signature,
                }),
            );
        } else if delivery.succeeded() {
            let _ = writeln!(out, "delivered in {} attempt(s)", delivery.attempts);
        } else {
            let _ = writeln!(
                out,
                "delivery failed after {} attempt(s): {}",
                delivery.attempts,
                delivery.last_error.as_deref().unwrap_or("unknown error")
            );
        }
        if delivery.succeeded() {
            exit::OK
        } else {
            exit::FAILED
        }
    }

    #[cfg(not(windows))]
    {
        let _ = signature;
        let _ = writeln!(out, "webhook: delivery uses WinHTTP and is Windows-only");
        exit::FAILED
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Command, Invocation};

    fn temp_paths() -> (tempfile::TempDir, Paths) {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::for_root(dir.path());
        (dir, paths)
    }

    #[test]
    fn help_and_version_do_not_touch_the_store() {
        let (_dir, paths) = temp_paths();
        let mut buffer: Vec<u8> = Vec::new();
        assert_eq!(execute(paths.clone(), &Invocation::Help, &mut buffer), 0);
        assert!(String::from_utf8_lossy(&buffer).contains("USAGE"));

        let mut buffer: Vec<u8> = Vec::new();
        assert_eq!(execute(paths, &Invocation::Version, &mut buffer), 0);
        assert!(String::from_utf8_lossy(&buffer).contains(VERSION));
    }

    #[test]
    fn a_destructive_selection_is_refused_before_any_write() {
        let (_dir, paths) = temp_paths();
        let command = Command::Actions {
            actions: vec![ActionId::EmptyRecycleBin],
            dry_run: false,
            json: false,
            yes: true,
            timeout_secs: None,
        };
        let mut buffer: Vec<u8> = Vec::new();
        let code = execute(paths, &Invocation::Run(command), &mut buffer);
        assert_eq!(code, exit::REFUSED);
        assert!(String::from_utf8_lossy(&buffer).contains("INVALID_ARGUMENT"));
    }

    #[test]
    fn a_dry_run_reports_without_mutating() {
        let (_dir, paths) = temp_paths();
        let command = Command::Actions {
            actions: vec![ActionId::FlushDnsCache],
            dry_run: true,
            json: true,
            yes: false,
            timeout_secs: None,
        };
        let mut buffer: Vec<u8> = Vec::new();
        let code = execute(paths, &Invocation::Run(command), &mut buffer);
        assert_eq!(code, exit::OK);
        let text = String::from_utf8_lossy(&buffer);
        assert!(text.contains("\"dryRun\": true"), "{text}");
        assert!(text.contains("flush-dns-cache"), "{text}");
    }
}
