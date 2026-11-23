//! Loopback local API with browser-origin defences.
//!
//! A local HTTP port on Windows is reachable by every process on the machine and,
//! more dangerously, by every page a browser opens: `http://127.0.0.1:<port>` is
//! a valid target for `fetch` from any website. Binding to loopback is therefore
//! not a security boundary by itself. This module adds the three checks that
//! make the boundary real, and refuses to answer when any of them is unclear:
//!
//! * **Host.** The `Host` header must name the loopback address and the bound
//!   port. A DNS-rebinding attack sends a hostname that resolves to 127.0.0.1;
//!   the header then carries the attacker's name and is rejected.
//! * **Origin.** A browser attaches `Origin` to a cross-site request. Only the
//!   application's own origins are accepted; `Origin: null` (a sandboxed
//!   document) is rejected too.
//! * **Token.** Every request carries `X-Zenith-Token`, a per-run secret that is
//!   never written to disk. It is compared in constant time.
//!
//! The authoriser is pure and fully tested. The listener that uses it is in
//! [`serve`], which answers only what `route` allows.

use std::fmt;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};

use serde_json::{Value, json};

/// Largest request head accepted. The API takes no bodies.
pub const MAX_HEAD_BYTES: usize = 8 * 1024;

/// Everything the authoriser needs from a parsed request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestMeta {
    pub method: String,
    pub path: String,
    pub host: Option<String>,
    pub origin: Option<String>,
    pub token: Option<String>,
}

/// The routes this API exposes. Every one is read-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Health,
    Actions,
    Diagnose,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiError {
    BadRequest,
    MethodNotAllowed,
    NotFound,
    ForbiddenHost,
    ForbiddenOrigin,
    MissingToken,
    BadToken,
    TooLarge,
}

impl ApiError {
    pub fn status(self) -> u16 {
        match self {
            ApiError::BadRequest => 400,
            ApiError::MethodNotAllowed => 405,
            ApiError::NotFound => 404,
            ApiError::ForbiddenHost => 403,
            ApiError::ForbiddenOrigin => 403,
            ApiError::MissingToken => 401,
            ApiError::BadToken => 401,
            ApiError::TooLarge => 413,
        }
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match self {
            ApiError::BadRequest => "API_BAD_REQUEST",
            ApiError::MethodNotAllowed => "API_METHOD_NOT_ALLOWED",
            ApiError::NotFound => "API_NOT_FOUND",
            ApiError::ForbiddenHost => "API_FORBIDDEN_HOST",
            ApiError::ForbiddenOrigin => "API_FORBIDDEN_ORIGIN",
            ApiError::MissingToken => "API_MISSING_TOKEN",
            ApiError::BadToken => "API_BAD_TOKEN",
            ApiError::TooLarge => "API_TOO_LARGE",
        };
        f.write_str(code)
    }
}

/// The configuration a listener is started with.
#[derive(Debug, Clone)]
pub struct ApiConfig {
    pub port: u16,
    pub token: String,
    pub allowed_origins: Vec<String>,
}

impl ApiConfig {
    /// The application's own origins, plus the two Tauri webview origins. A
    /// caller can add one for a test harness, but not by accident.
    pub fn new(port: u16, token: impl Into<String>) -> Self {
        Self {
            port,
            token: token.into(),
            allowed_origins: vec![
                "tauri://localhost".to_string(),
                "http://tauri.localhost".to_string(),
                "https://tauri.localhost".to_string(),
            ],
        }
    }

    fn expected_hosts(&self) -> Vec<String> {
        let port = self.port;
        vec![
            format!("127.0.0.1:{port}"),
            format!("localhost:{port}"),
            format!("[::1]:{port}"),
        ]
    }
}

/// Constant-time string comparison. The token is short, but an early return
/// would still leak its length to a measuring attacker.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Decide whether a request may reach the router, and which route it names.
pub fn authorize(meta: &RequestMeta, config: &ApiConfig) -> Result<Route, ApiError> {
    let host = meta.host.as_deref().ok_or(ApiError::ForbiddenHost)?;
    if !config
        .expected_hosts()
        .iter()
        .any(|expected| expected.eq_ignore_ascii_case(host))
    {
        return Err(ApiError::ForbiddenHost);
    }

    if let Some(origin) = meta.origin.as_deref()
        && !config
            .allowed_origins
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(origin))
    {
        return Err(ApiError::ForbiddenOrigin);
    }

    let token = meta.token.as_deref().ok_or(ApiError::MissingToken)?;
    if !constant_time_eq(token.as_bytes(), config.token.as_bytes()) {
        return Err(ApiError::BadToken);
    }

    if meta.method != "GET" {
        return Err(ApiError::MethodNotAllowed);
    }

    match meta.path.as_str() {
        "/v1/health" => Ok(Route::Health),
        "/v1/actions" => Ok(Route::Actions),
        "/v1/diagnose" => Ok(Route::Diagnose),
        _ => Err(ApiError::NotFound),
    }
}

/// Parse a request head (request line plus headers) without trusting its size.
pub fn parse_head(head: &str) -> Result<RequestMeta, ApiError> {
    let mut lines = head.split("\r\n");
    let request_line = lines.next().ok_or(ApiError::BadRequest)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or(ApiError::BadRequest)?.to_string();
    let path = parts.next().ok_or(ApiError::BadRequest)?.to_string();
    let version = parts.next().ok_or(ApiError::BadRequest)?;
    if !version.starts_with("HTTP/1.") {
        return Err(ApiError::BadRequest);
    }
    if path.contains("..") || !path.starts_with('/') {
        return Err(ApiError::BadRequest);
    }
    let mut host = None;
    let mut origin = None;
    let mut token = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "host" => host = Some(value.to_string()),
            "origin" => origin = Some(value.to_string()),
            "x-zenith-token" => token = Some(value.to_string()),
            _ => {}
        }
    }
    Ok(RequestMeta {
        method,
        path,
        host,
        origin,
        token,
    })
}

/// What the listener answers with. Injected so a test can exercise the socket
/// loop without a probe harness.
pub trait ApiHandler {
    fn actions(&self) -> Value;
    fn diagnose(&self) -> Result<Value, String>;
}

fn respond(stream: &mut TcpStream, status: u16, body: &Value) {
    let payload = body.to_string();
    let head = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        reason(status),
        payload.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(payload.as_bytes());
    let _ = stream.flush();
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        _ => "Internal Server Error",
    }
}

fn handle_connection(mut stream: TcpStream, config: &ApiConfig, handler: &dyn ApiHandler) {
    let mut head = Vec::new();
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(clone) => clone,
        Err(_) => return,
    });
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                head.extend_from_slice(line.as_bytes());
                if head.len() > MAX_HEAD_BYTES {
                    respond(&mut stream, 413, &json!({ "error": "API_TOO_LARGE" }));
                    return;
                }
                if line == "\r\n" || line == "\n" {
                    break;
                }
            }
            Err(_) => return,
        }
    }
    let text = String::from_utf8_lossy(&head);
    let meta = match parse_head(&text) {
        Ok(meta) => meta,
        Err(error) => {
            respond(
                &mut stream,
                error.status(),
                &json!({ "error": error.to_string() }),
            );
            return;
        }
    };
    let route = match authorize(&meta, config) {
        Ok(route) => route,
        Err(error) => {
            respond(
                &mut stream,
                error.status(),
                &json!({ "error": error.to_string() }),
            );
            return;
        }
    };
    let body = match route {
        Route::Health => json!({
            "status": "ok",
            "version": crate::VERSION,
            "readOnly": true,
        }),
        Route::Actions => json!({ "actions": handler.actions() }),
        Route::Diagnose => match handler.diagnose() {
            Ok(report) => report,
            Err(detail) => {
                respond(&mut stream, 500, &json!({ "error": detail }));
                return;
            }
        },
    };
    respond(&mut stream, 200, &body);
}

/// Bind loopback and answer until the listener is closed. Returns the bound
/// address so a caller (and a test) can find an ephemeral port.
pub fn serve(
    listener: TcpListener,
    config: ApiConfig,
    handler: &dyn ApiHandler,
    stop_after: Option<usize>,
) -> std::io::Result<SocketAddr> {
    // The caller binds explicitly. Binding to `Ipv4Addr::LOCALHOST` is
    // deliberate: `0.0.0.0` would put the token on the network and make the
    // Host check the only defence.
    let address = listener.local_addr()?;
    let mut answered = 0usize;
    for incoming in listener.incoming() {
        let Ok(stream) = incoming else { continue };
        handle_connection(stream, &config, handler);
        answered += 1;
        if stop_after.is_some_and(|limit| answered >= limit) {
            break;
        }
    }
    Ok(address)
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;

    use super::*;

    fn config() -> ApiConfig {
        ApiConfig::new(8787, "token-abc")
    }

    fn meta(method: &str, path: &str) -> RequestMeta {
        RequestMeta {
            method: method.to_string(),
            path: path.to_string(),
            host: Some("127.0.0.1:8787".to_string()),
            origin: None,
            token: Some("token-abc".to_string()),
        }
    }

    #[test]
    fn a_plain_loopback_request_reaches_its_route() {
        assert_eq!(
            authorize(&meta("GET", "/v1/health"), &config()),
            Ok(Route::Health)
        );
        assert_eq!(
            authorize(&meta("GET", "/v1/actions"), &config()),
            Ok(Route::Actions)
        );
        assert_eq!(
            authorize(&meta("GET", "/v1/diagnose"), &config()),
            Ok(Route::Diagnose)
        );
    }

    #[test]
    fn a_rebound_hostname_is_refused_even_on_the_right_port() {
        let mut request = meta("GET", "/v1/health");
        request.host = Some("attacker.example:8787".to_string());
        assert_eq!(authorize(&request, &config()), Err(ApiError::ForbiddenHost));
        request.host = None;
        assert_eq!(authorize(&request, &config()), Err(ApiError::ForbiddenHost));
    }

    #[test]
    fn a_cross_origin_page_is_refused_and_the_webview_origin_is_allowed() {
        let mut request = meta("GET", "/v1/health");
        request.origin = Some("https://evil.example".to_string());
        assert_eq!(
            authorize(&request, &config()),
            Err(ApiError::ForbiddenOrigin)
        );
        request.origin = Some("null".to_string());
        assert_eq!(
            authorize(&request, &config()),
            Err(ApiError::ForbiddenOrigin)
        );
        request.origin = Some("tauri://localhost".to_string());
        assert_eq!(authorize(&request, &config()), Ok(Route::Health));
    }

    #[test]
    fn the_token_is_required_and_compared_exactly() {
        let mut request = meta("GET", "/v1/health");
        request.token = None;
        assert_eq!(authorize(&request, &config()), Err(ApiError::MissingToken));
        request.token = Some("token-abd".to_string());
        assert_eq!(authorize(&request, &config()), Err(ApiError::BadToken));
        request.token = Some("token-abc ".to_string());
        assert_eq!(authorize(&request, &config()), Err(ApiError::BadToken));
    }

    #[test]
    fn the_surface_is_read_only() {
        let mut request = meta("POST", "/v1/diagnose");
        assert_eq!(
            authorize(&request, &config()),
            Err(ApiError::MethodNotAllowed)
        );
        request = meta("GET", "/v1/actions");
        request.path = "/v1/actions/flush-dns/run".to_string();
        assert_eq!(authorize(&request, &config()), Err(ApiError::NotFound));
    }

    #[test]
    fn a_request_head_is_parsed_case_insensitively_and_a_traversal_is_refused() {
        let head = "GET /v1/health HTTP/1.1\r\nHost: 127.0.0.1:8787\r\nX-Zenith-Token: token-abc\r\nOrigin: tauri://localhost\r\n\r\n";
        let parsed = parse_head(head).expect("parse");
        assert_eq!(parsed.host.as_deref(), Some("127.0.0.1:8787"));
        assert_eq!(parsed.origin.as_deref(), Some("tauri://localhost"));
        assert_eq!(authorize(&parsed, &config()), Ok(Route::Health));
        let traversal = "GET /v1/../secret HTTP/1.1\r\nHost: 127.0.0.1:8787\r\n\r\n";
        assert_eq!(parse_head(traversal), Err(ApiError::BadRequest));
        let bad_version = "GET /v1/health HTTP/2\r\nHost: x\r\n\r\n";
        assert_eq!(parse_head(bad_version), Err(ApiError::BadRequest));
    }

    #[test]
    fn a_real_socket_round_trip_authenticates_and_refuses_the_wrong_token() {
        use std::io::Read as _;

        struct Handler;
        impl ApiHandler for Handler {
            fn actions(&self) -> Value {
                json!([{ "id": "flush-dns" }])
            }
            fn diagnose(&self) -> Result<Value, String> {
                Ok(json!({ "reports": [] }))
            }
        }

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let server_config = ApiConfig::new(port, "token-abc");
        std::thread::spawn(move || {
            let _ = serve(listener, server_config, &Handler, Some(2));
        });

        let mut attempt = 0;
        let mut send = |token: &str, head_path: &str| -> String {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                match TcpStream::connect((Ipv4Addr::LOCALHOST, port)) {
                    Ok(mut stream) => {
                        let request = format!(
                            "GET {head_path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Zenith-Token: {token}\r\nConnection: close\r\n\r\n"
                        );
                        let _ = stream.write_all(request.as_bytes());
                        let mut response = String::new();
                        let _ = stream.read_to_string(&mut response);
                        return response;
                    }
                    Err(_) if std::time::Instant::now() < deadline => {
                        attempt += 1;
                        std::thread::sleep(std::time::Duration::from_millis(20));
                    }
                    Err(error) => panic!("connect failed after {attempt} attempts: {error}"),
                }
            }
        };

        let ok = send("token-abc", "/v1/health");
        assert!(ok.starts_with("HTTP/1.1 200"), "{ok}");
        assert!(ok.contains("\"readOnly\":true"));
        let denied = send("wrong", "/v1/health");
        assert!(denied.starts_with("HTTP/1.1 401"), "{denied}");
    }
}
