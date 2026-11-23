//! Pipeline events that leave the machine.
//!
//! The webhook used to exist only as `zenith webhook` in the CLI: a user could
//! deliver one synthetic event, but a real action completion, a real failure and
//! a real rollback never reached a receiver. A webhook nobody receives is a
//! checkbox, not an integration, so this module is the seam between the
//! execution pipeline and `zenith_core::webhook`.
//!
//! Three rules shape it:
//!
//! 1. **Never on the command's path.** Delivery does DNS, TLS and up to five
//!    attempts with backoff. The IPC command returns when the action finished,
//!    not when the receiver answered, so a dead endpoint cannot make a button
//!    look hung. Each event runs on its own thread.
//! 2. **Never without consent.** The target comes from the settings document,
//!    which the user authored in Settings > Webhook. Disabled means no thread,
//!    no secret read, no socket.
//! 3. **Never in the settings file.** The signing secret is DPAPI-protected by
//!    `webhook::load_or_create_secret`; a settings export cannot carry it.
//!
//! The settings JSON is read through `serde_json::Value` rather than a mirrored
//! Rust struct: the renderer owns that schema, and a second declaration would
//! drift from it silently. Unknown fields are ignored, and a document that does
//! not parse simply yields "not configured".

use std::time::{Duration, UNIX_EPOCH};

use serde::Deserialize;
use zenith_core::webhook::{self, EventKind, EventPayload, Target};

/// The subset of `IntegrationSettings` this module needs.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationSettings {
    #[serde(default)]
    webhook_enabled: bool,
    #[serde(default)]
    webhook_url: String,
    #[serde(default)]
    webhook_events: Vec<String>,
}

/// What the pipeline knows about a finished run.
#[derive(Debug, Clone)]
pub struct Event {
    pub kind: EventKind,
    pub action_id: String,
    pub snapshot_id: Option<String>,
    pub outcome: Option<String>,
    pub duration_ms: Option<u64>,
    pub error_code: Option<String>,
}

/// Map a renderer-side event name (`completed`, `failed`, `rollback`) onto the
/// wire event. The two vocabularies exist because the settings file is read by a
/// person and the payload by a script; this is the one place they meet.
fn event_name(kind: EventKind) -> &'static str {
    match kind {
        EventKind::ActionCompleted => "completed",
        EventKind::ActionFailed => "failed",
        EventKind::RolledBack => "rollback",
        EventKind::SnapshotRestored => "rollback",
    }
}

/// Read the webhook configuration out of the persisted settings document.
///
/// Returns `None` for a disabled webhook, an empty URL or a document that is
/// absent or unreadable - all four mean "do not send", which is the safe
/// reading. The URL is validated later by `Target::new`, so a typo is reported
/// in the log rather than silently dropped here.
pub fn configured(raw: Option<&str>) -> Option<IntegrationSettings> {
    let raw = raw?;
    let root: serde_json::Value = serde_json::from_str(raw).ok()?;
    let integrations: IntegrationSettings =
        serde_json::from_value(root.get("integrations")?.clone()).ok()?;
    if !integrations.webhook_enabled || integrations.webhook_url.trim().is_empty() {
        return None;
    }
    Some(integrations)
}

/// Decide whether this event is one the user subscribed to.
pub fn subscribed(settings: &IntegrationSettings, kind: EventKind) -> bool {
    let wanted = event_name(kind);
    // An empty list is not "send everything": a user who enabled the webhook but
    // unticked every event has said no to all of them.
    settings.webhook_events.iter().any(|name| name == wanted)
}

/// Send one event on a detached thread.
///
/// Every failure is a log line, never a panic and never a return value: the run
/// it describes has already finished, and its result belongs to the user, not to
/// the receiver.
pub fn spawn(paths: zenith_core::config::Paths, settings: IntegrationSettings, event: Event) {
    if !subscribed(&settings, event.kind) {
        return;
    }
    let url = settings.webhook_url.clone();
    std::thread::spawn(move || {
        deliver(&paths, &url, event);
    });
}

fn deliver(paths: &zenith_core::config::Paths, url: &str, event: Event) {
    let secret = match webhook::load_or_create_secret(paths) {
        Ok(secret) => secret,
        Err(error) => {
            crate::logging::append(
                paths,
                crate::logging::Level::Error,
                &format!("webhook {}: secret unavailable: {error}", event.kind),
            );
            return;
        }
    };
    let target = match Target::new(url, secret) {
        Ok(target) => target,
        Err(error) => {
            crate::logging::append(
                paths,
                crate::logging::Level::Warn,
                &format!("webhook {}: unusable url: {error}", event.kind),
            );
            return;
        }
    };

    let now = zenith_core::engine::audit::now_utc();
    let mut payload = EventPayload::new(
        event.kind,
        zenith_core::engine::audit::new_correlation_id(),
        now,
    );
    payload.action_id = Some(event.action_id);
    payload.snapshot_id = event.snapshot_id;
    payload.outcome = event.outcome;
    payload.duration_ms = event.duration_ms;
    payload.error_code = event.error_code;

    #[cfg(windows)]
    {
        let transport = webhook::WinHttpTransport;
        // The pipeline thread has already returned; sleeping on this one costs
        // the receiver's retries, nothing else.
        let mut sleep = |ms: u64| std::thread::sleep(Duration::from_millis(ms));
        let timestamp = UNIX_EPOCH
            .elapsed()
            .map(|value| value.as_secs() as i64)
            .unwrap_or(0);
        let delivery = webhook::deliver(&transport, &target, &payload, timestamp, &mut sleep);
        if delivery.succeeded() {
            crate::logging::append(
                paths,
                crate::logging::Level::Info,
                &format!(
                    "webhook {} delivered in {} attempt(s)",
                    event.kind, delivery.attempts
                ),
            );
        } else {
            crate::logging::append(
                paths,
                crate::logging::Level::Warn,
                &format!(
                    "webhook {} failed after {} attempt(s): {}",
                    event.kind,
                    delivery.attempts,
                    delivery.last_error.as_deref().unwrap_or("unknown error")
                ),
            );
        }
    }

    #[cfg(not(windows))]
    {
        let _ = (&target, &payload);
        crate::logging::append(
            paths,
            crate::logging::Level::Warn,
            "webhook delivery uses WinHTTP and is Windows-only",
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENABLED: &str = r#"{
        "integrations": {
            "cliInstalled": true,
            "mcpEnabled": false,
            "webhookEnabled": true,
            "webhookUrl": "https://example.com/hook",
            "webhookEvents": ["failed", "rollback"]
        }
    }"#;

    #[test]
    fn reads_an_enabled_webhook() {
        let settings = configured(Some(ENABLED)).expect("configured");
        assert_eq!(settings.webhook_url, "https://example.com/hook");
        assert!(subscribed(&settings, EventKind::ActionFailed));
        assert!(subscribed(&settings, EventKind::RolledBack));
        assert!(!subscribed(&settings, EventKind::ActionCompleted));
    }

    #[test]
    fn a_disabled_webhook_is_not_configured() {
        let disabled = ENABLED.replace("\"webhookEnabled\": true", "\"webhookEnabled\": false");
        assert!(configured(Some(&disabled)).is_none());
    }

    #[test]
    fn an_empty_url_or_unreadable_document_is_not_configured() {
        let empty = ENABLED.replace("https://example.com/hook", "");
        assert!(configured(Some(&empty)).is_none());
        assert!(configured(Some("not json")).is_none());
        assert!(configured(None).is_none());
        // A settings document that predates integrations must not send.
        assert!(configured(Some(r#"{"general":{}}"#)).is_none());
    }

    #[test]
    fn an_empty_event_list_subscribes_to_nothing() {
        let none = ENABLED.replace(r#"["failed", "rollback"]"#, "[]");
        let settings = configured(Some(&none)).expect("configured");
        for kind in EventKind::ALL {
            assert!(!subscribed(&settings, kind), "{kind} must stay unsent");
        }
    }
}
