//! Outbound webhook delivery (`05-02` §9, `04-01` T-29).
//!
//! A webhook is the only path by which Zenith pushes data to a service the user
//! names. Three properties matter more than throughput:
//!
//! 1. **The receiver can prove the event came from Zenith.** Every request
//!    carries `X-Zenith-Signature: t=<unix>,v1=<hex hmac>`, computed over
//!    `<t>.<body>` with the shared secret. The timestamp is inside the signed
//!    material so a captured request cannot be replayed with a fresh time.
//! 2. **The payload says nothing the user did not agree to.** It carries the
//!    action id, the outcome, the duration and an error code. Never a path, a
//!    user name, a machine name, or file content.
//! 3. **A dead endpoint does not stall the application.** Delivery is bounded by
//!    a timeout and by a retry schedule with a hard cap; the caller gets an
//!    outcome, not a panic.
//!
//! The signer and the retry schedule are pure and unit tested. The transport is
//! a trait so the tests never touch a socket, and the Windows implementation
//! uses WinHTTP - the platform client - so the application keeps its policy of
//! adding no TLS stack of its own.

use std::fmt;

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::VERSION;

/// Largest body this sender will produce. A webhook is a summary, not a report.
pub const MAX_BODY_BYTES: usize = 64 * 1024;
/// Per-attempt network timeout.
pub const ATTEMPT_TIMEOUT_MS: u32 = 5_000;
/// Total attempts, including the first.
pub const MAX_ATTEMPTS: u32 = 5;
/// A receiver may be up to five minutes behind; beyond that the timestamp is
/// treated as a replay.
pub const TIMESTAMP_TOLERANCE_SECS: i64 = 300;

/// The events a settings document can subscribe to (`WebhookEvent` in the
/// renderer). The wire names are stable: a receiver switches on them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    ActionCompleted,
    ActionFailed,
    RolledBack,
    SnapshotRestored,
}

impl EventKind {
    pub const ALL: [EventKind; 4] = [
        EventKind::ActionCompleted,
        EventKind::ActionFailed,
        EventKind::RolledBack,
        EventKind::SnapshotRestored,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            EventKind::ActionCompleted => "action.completed",
            EventKind::ActionFailed => "action.failed",
            EventKind::RolledBack => "action.rolled_back",
            EventKind::SnapshotRestored => "snapshot.restored",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == raw)
    }
}

impl fmt::Display for EventKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The signed body. Field names are camelCase because the receiver is usually a
/// script, and `schemaVersion` is the only field whose meaning may change.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPayload {
    pub schema_version: u32,
    pub id: String,
    pub event: String,
    pub occurred_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    pub build: String,
}

impl EventPayload {
    pub fn new(kind: EventKind, id: impl Into<String>, occurred_at: impl Into<String>) -> Self {
        Self {
            schema_version: 1,
            id: id.into(),
            event: kind.as_str().to_string(),
            occurred_at: occurred_at.into(),
            action_id: None,
            snapshot_id: None,
            outcome: None,
            duration_ms: None,
            error_code: None,
            build: VERSION.to_string(),
        }
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>, WebhookError> {
        let bytes = serde_json::to_vec(self).map_err(|_| WebhookError::Encoding)?;
        if bytes.len() > MAX_BODY_BYTES {
            return Err(WebhookError::BodyTooLarge);
        }
        Ok(bytes)
    }
}

/// Why a delivery attempt was refused before or after it left the process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebhookError {
    EmptySecret,
    UrlNotHttps,
    UrlMalformed,
    BodyTooLarge,
    Encoding,
    Rejected(String),
    Transport(String),
    SignatureMismatch,
    TimestampOutsideWindow,
}

impl fmt::Display for WebhookError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WebhookError::EmptySecret => f.write_str("WEBHOOK_SECRET_EMPTY"),
            WebhookError::UrlNotHttps => f.write_str("WEBHOOK_URL_NOT_HTTPS"),
            WebhookError::UrlMalformed => f.write_str("WEBHOOK_URL_MALFORMED"),
            WebhookError::BodyTooLarge => f.write_str("WEBHOOK_BODY_TOO_LARGE"),
            WebhookError::Encoding => f.write_str("WEBHOOK_ENCODING"),
            WebhookError::Rejected(status) => write!(f, "WEBHOOK_REJECTED_{status}"),
            WebhookError::Transport(detail) => write!(f, "WEBHOOK_TRANSPORT_{detail}"),
            WebhookError::SignatureMismatch => f.write_str("WEBHOOK_SIGNATURE_MISMATCH"),
            WebhookError::TimestampOutsideWindow => f.write_str("WEBHOOK_TIMESTAMP_STALE"),
        }
    }
}

/// Reject a URL that cannot be signed safely.
///
/// `https` only, except for loopback: the integration test and a user running a
/// receiver on the same machine need `http://127.0.0.1:<port>`, and confining
/// that exception to a literal loopback address keeps the secret off the wire.
pub fn validate_url(url: &str) -> Result<(), WebhookError> {
    let trimmed = url.trim();
    if trimmed != url || url.is_empty() {
        return Err(WebhookError::UrlMalformed);
    }
    if url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(WebhookError::UrlMalformed);
    }
    let Some((scheme, rest)) = url.split_once("://") else {
        return Err(WebhookError::UrlMalformed);
    };
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default()
        .rsplit('@')
        .next()
        .unwrap_or_default();
    if host.is_empty() {
        return Err(WebhookError::UrlMalformed);
    }
    let hostname = host
        .rsplit_once(':')
        .filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit()))
        .map(|(name, _)| name)
        .unwrap_or(host);
    let loopback = matches!(hostname, "127.0.0.1" | "::1" | "[::1]" | "localhost");
    match scheme {
        "https" => Ok(()),
        "http" if loopback => Ok(()),
        "http" => Err(WebhookError::UrlNotHttps),
        _ => Err(WebhookError::UrlMalformed),
    }
}

fn mac(secret: &[u8], timestamp: i64, body: &[u8]) -> Result<Vec<u8>, WebhookError> {
    if secret.is_empty() {
        return Err(WebhookError::EmptySecret);
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).map_err(|_| WebhookError::EmptySecret)?;
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b".");
    mac.update(body);
    Ok(mac.finalize().into_bytes().to_vec())
}

/// `t=<unix>,v1=<hex>` - the header the receiver verifies.
pub fn signature_header(
    secret: &[u8],
    timestamp: i64,
    body: &[u8],
) -> Result<String, WebhookError> {
    let tag = mac(secret, timestamp, body)?;
    Ok(format!("t={timestamp},v1={}", hex::encode(tag)))
}

/// Verify a header the receiver was given. Returns the signed timestamp so the
/// caller can apply its own freshness policy.
pub fn verify_signature(
    secret: &[u8],
    header: &str,
    body: &[u8],
    now: i64,
) -> Result<i64, WebhookError> {
    let mut timestamp = None;
    let mut tag = None;
    for part in header.split(',') {
        if let Some(value) = part.strip_prefix("t=") {
            timestamp = value.parse::<i64>().ok();
        } else if let Some(value) = part.strip_prefix("v1=") {
            tag = hex::decode(value).ok();
        }
    }
    let (Some(timestamp), Some(tag)) = (timestamp, tag) else {
        return Err(WebhookError::SignatureMismatch);
    };
    if (now - timestamp).abs() > TIMESTAMP_TOLERANCE_SECS {
        return Err(WebhookError::TimestampOutsideWindow);
    }
    let expected = mac(secret, timestamp, body)?;
    // `Hmac::verify_slice` is constant time; comparing the two vectors with `==`
    // would leak the position of the first differing byte.
    let mut verifier =
        Hmac::<Sha256>::new_from_slice(secret).map_err(|_| WebhookError::EmptySecret)?;
    verifier.update(timestamp.to_string().as_bytes());
    verifier.update(b".");
    verifier.update(body);
    verifier
        .verify_slice(&expected)
        .map_err(|_| WebhookError::SignatureMismatch)?;
    if expected.len() != tag.len() {
        return Err(WebhookError::SignatureMismatch);
    }
    // Constant-time comparison of the offered tag against the recomputed one.
    let mut diff = 0u8;
    for (a, b) in expected.iter().zip(tag.iter()) {
        diff |= a ^ b;
    }
    if diff != 0 {
        return Err(WebhookError::SignatureMismatch);
    }
    Ok(timestamp)
}

/// Delay before attempt `attempt` (1 = first retry). `None` means give up.
pub fn backoff_ms(attempt: u32) -> Option<u64> {
    if attempt == 0 || attempt >= MAX_ATTEMPTS {
        return None;
    }
    let base = 500u64;
    let delay = base.saturating_mul(1u64 << (attempt - 1));
    Some(delay.min(8_000))
}

/// A configured endpoint.
#[derive(Debug, Clone)]
pub struct Target {
    pub url: String,
    pub secret: Vec<u8>,
}

impl Target {
    pub fn new(url: impl Into<String>, secret: impl Into<Vec<u8>>) -> Result<Self, WebhookError> {
        let url = url.into();
        validate_url(&url)?;
        let secret = secret.into();
        if secret.is_empty() {
            return Err(WebhookError::EmptySecret);
        }
        Ok(Self { url, secret })
    }
}

/// Load the per-machine webhook secret, creating it on first use.
///
/// The secret is 32 random bytes protected with DPAPI and kept outside the
/// preferences file, so exporting settings never exports the signing key. A
/// corrupt file is a hard failure: minting a new secret would silently break
/// every receiver's verification while the UI still said "configured".
pub fn load_or_create_secret(paths: &crate::config::Paths) -> Result<Vec<u8>, WebhookError> {
    let file = paths.user_data.join("webhook.secret.dpapi");
    if file.is_file() {
        let blob =
            std::fs::read(&file).map_err(|_| WebhookError::Transport("SECRET_READ".into()))?;
        let plain = crate::adapters::dpapi::unprotect(&blob)
            .map_err(|_| WebhookError::Transport("SECRET_UNPROTECT".into()))?;
        if plain.len() != 32 {
            return Err(WebhookError::Transport("SECRET_SHAPE".into()));
        }
        return Ok(plain);
    }
    let mut bytes = vec![0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| WebhookError::Transport("SECRET_RNG".into()))?;
    let protected = crate::adapters::dpapi::protect(&bytes)
        .map_err(|_| WebhookError::Transport("SECRET_PROTECT".into()))?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| WebhookError::Transport("SECRET_DIR".into()))?;
    }
    std::fs::write(&file, protected).map_err(|_| WebhookError::Transport("SECRET_WRITE".into()))?;
    Ok(bytes)
}

/// The network seam. Implementations must not retry; `deliver` owns the policy.
pub trait Transport {
    fn post(
        &self,
        url: &str,
        headers: &[(String, String)],
        body: &[u8],
        timeout_ms: u32,
    ) -> Result<u16, String>;
}

/// What happened across every attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delivery {
    pub attempts: u32,
    pub status: Option<u16>,
    pub last_error: Option<String>,
}

impl Delivery {
    pub fn succeeded(&self) -> bool {
        self.status
            .is_some_and(|status| (200..300).contains(&status))
    }
}

/// Send one event. Retries only on transport errors and 5xx; a 4xx is the
/// receiver saying "not this", and repeating it is noise.
pub fn deliver(
    transport: &dyn Transport,
    target: &Target,
    payload: &EventPayload,
    timestamp: i64,
    sleep: &mut dyn FnMut(u64),
) -> Delivery {
    let body = match payload.to_bytes() {
        Ok(body) => body,
        Err(error) => {
            return Delivery {
                attempts: 0,
                status: None,
                last_error: Some(error.to_string()),
            };
        }
    };
    let signature = match signature_header(&target.secret, timestamp, &body) {
        Ok(signature) => signature,
        Err(error) => {
            return Delivery {
                attempts: 0,
                status: None,
                last_error: Some(error.to_string()),
            };
        }
    };
    let headers = vec![
        ("Content-Type".to_string(), "application/json".to_string()),
        ("User-Agent".to_string(), format!("Zenith/{VERSION}")),
        ("X-Zenith-Event".to_string(), payload.event.clone()),
        ("X-Zenith-Signature".to_string(), signature),
    ];

    let mut attempts = 0u32;
    let mut last_error;
    loop {
        attempts += 1;
        match transport.post(&target.url, &headers, &body, ATTEMPT_TIMEOUT_MS) {
            Ok(status) if (200..300).contains(&status) => {
                return Delivery {
                    attempts,
                    status: Some(status),
                    last_error: None,
                };
            }
            Ok(status) if (400..500).contains(&status) => {
                return Delivery {
                    attempts,
                    status: Some(status),
                    last_error: Some(format!("receiver answered {status}")),
                };
            }
            Ok(status) => {
                last_error = Some(format!("receiver answered {status}"));
            }
            Err(detail) => {
                last_error = Some(detail);
            }
        }
        match backoff_ms(attempts) {
            Some(delay) => sleep(delay),
            None => {
                return Delivery {
                    attempts,
                    status: None,
                    last_error,
                };
            }
        }
    }
}

/// Windows delivery through the platform HTTP client (WinHTTP).
///
/// WinHTTP is used instead of a bundled TLS stack so the application adds no
/// network dependency and no second certificate store: system proxy settings,
/// system roots and enterprise TLS inspection all keep working.
/// Windows delivery through the platform HTTP client (WinHTTP).
///
/// The FFI lives in [`crate::adapters::webhook_http`] because `unsafe` is
/// confined to the adapter layer; this type is the seam the retry policy talks
/// to.
#[cfg(windows)]
pub struct WinHttpTransport;

#[cfg(windows)]
impl Transport for WinHttpTransport {
    fn post(
        &self,
        url: &str,
        headers: &[(String, String)],
        body: &[u8],
        timeout_ms: u32,
    ) -> Result<u16, String> {
        crate::adapters::webhook_http::post(url, headers, body, timeout_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Seen = Vec<(String, Vec<(String, String)>, usize)>;

    struct Fake {
        answers: Vec<Result<u16, String>>,
        seen: std::cell::RefCell<Seen>,
    }

    impl Fake {
        fn new(answers: Vec<Result<u16, String>>) -> Self {
            Self {
                answers,
                seen: std::cell::RefCell::new(Vec::new()),
            }
        }
    }

    impl Transport for Fake {
        fn post(
            &self,
            url: &str,
            headers: &[(String, String)],
            body: &[u8],
            _timeout_ms: u32,
        ) -> Result<u16, String> {
            self.seen
                .borrow_mut()
                .push((url.to_string(), headers.to_vec(), body.len()));
            self.answers
                .get(self.seen.borrow().len() - 1)
                .cloned()
                .unwrap_or(Err("NO_ANSWER".to_string()))
        }
    }

    fn payload() -> EventPayload {
        let mut payload =
            EventPayload::new(EventKind::ActionCompleted, "evt-1", "2026-11-23T10:00:00Z");
        payload.action_id = Some("flush-dns".to_string());
        payload.outcome = Some("success".to_string());
        payload.duration_ms = Some(120);
        payload
    }

    #[test]
    fn header_round_trips_and_rejects_a_tampered_body() {
        let secret = b"correct horse battery staple";
        let body = payload().to_bytes().expect("serialise");
        let header = signature_header(secret, 1_000, &body).expect("sign");
        assert_eq!(
            verify_signature(secret, &header, &body, 1_010).expect("verify"),
            1_000
        );
        let mut tampered = body.clone();
        tampered[1] ^= 0x01;
        assert_eq!(
            verify_signature(secret, &header, &tampered, 1_010),
            Err(WebhookError::SignatureMismatch)
        );
    }

    #[test]
    fn a_stale_timestamp_is_refused_even_with_a_valid_tag() {
        let secret = b"s3cret";
        let body = b"{}";
        let header = signature_header(secret, 1_000, body).expect("sign");
        assert_eq!(
            verify_signature(secret, &header, body, 1_000 + TIMESTAMP_TOLERANCE_SECS + 1),
            Err(WebhookError::TimestampOutsideWindow)
        );
    }

    #[test]
    fn an_empty_secret_cannot_sign_or_verify() {
        assert_eq!(
            signature_header(b"", 1, b"{}"),
            Err(WebhookError::EmptySecret)
        );
        assert_eq!(
            verify_signature(b"", "t=1,v1=00", b"{}", 1),
            Err(WebhookError::EmptySecret)
        );
    }

    #[test]
    fn only_https_or_loopback_http_is_accepted() {
        assert_eq!(validate_url("https://example.com/hook"), Ok(()));
        assert_eq!(validate_url("http://127.0.0.1:8787/hook"), Ok(()));
        assert_eq!(validate_url("http://localhost:8787/hook"), Ok(()));
        assert_eq!(
            validate_url("http://example.com/hook"),
            Err(WebhookError::UrlNotHttps)
        );
        assert_eq!(
            validate_url("ftp://example.com/hook"),
            Err(WebhookError::UrlMalformed)
        );
        assert_eq!(validate_url("https://"), Err(WebhookError::UrlMalformed));
        assert_eq!(
            validate_url("https://example.com/a b"),
            Err(WebhookError::UrlMalformed)
        );
    }

    #[test]
    fn userinfo_is_stripped_before_the_loopback_test_so_a_secret_cannot_ride_along() {
        // `http://evil@127.0.0.1/` would otherwise read as loopback and send the
        // payload over plain HTTP to whatever the string actually resolves to.
        assert_eq!(validate_url("http://user:pw@127.0.0.1:8787/hook"), Ok(()));
    }

    #[test]
    fn a_two_hundred_ends_the_retry_loop_on_the_first_attempt() {
        let transport = Fake::new(vec![Ok(204)]);
        let target = Target::new("https://example.com/hook", "k").expect("target");
        let mut delays = Vec::new();
        let delivery = deliver(&transport, &target, &payload(), 10, &mut |ms| {
            delays.push(ms)
        });
        assert!(delivery.succeeded());
        assert_eq!(delivery.attempts, 1);
        assert!(delays.is_empty());
        let seen = transport.seen.borrow();
        assert_eq!(seen[0].0, "https://example.com/hook");
        assert!(
            seen[0]
                .1
                .iter()
                .any(|(name, _)| name == "X-Zenith-Signature")
        );
    }

    #[test]
    fn a_five_hundred_retries_with_backoff_then_stops() {
        let transport = Fake::new(vec![
            Ok(500),
            Ok(503),
            Err("TIMEOUT".into()),
            Ok(502),
            Ok(500),
        ]);
        let target = Target::new("https://example.com/hook", "k").expect("target");
        let mut delays = Vec::new();
        let delivery = deliver(&transport, &target, &payload(), 10, &mut |ms| {
            delays.push(ms)
        });
        assert!(!delivery.succeeded());
        assert_eq!(delivery.attempts, MAX_ATTEMPTS);
        assert_eq!(delays, vec![500, 1_000, 2_000, 4_000]);
    }

    #[test]
    fn a_four_hundred_is_not_retried() {
        let transport = Fake::new(vec![Ok(400), Ok(200)]);
        let target = Target::new("https://example.com/hook", "k").expect("target");
        let delivery = deliver(&transport, &target, &payload(), 10, &mut |_| {});
        assert_eq!(delivery.attempts, 1);
        assert_eq!(delivery.status, Some(400));
    }

    #[test]
    fn the_payload_carries_no_path_and_no_identity() {
        let mut item = payload();
        item.action_id = Some("flush-dns".to_string());
        let text = String::from_utf8(item.to_bytes().expect("bytes")).expect("utf8");
        for forbidden in ["C:\\", "Users\\", "hostname", "username", "token"] {
            assert!(
                !text.contains(forbidden),
                "payload leaked {forbidden}: {text}"
            );
        }
        assert!(text.contains("\"schemaVersion\":1"));
        assert!(text.contains("action.completed"));
    }
}
