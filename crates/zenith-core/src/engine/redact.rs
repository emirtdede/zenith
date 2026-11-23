//! Secret redaction for anything that leaves the core: logs, audit rows,
//! clipboard text, support bundles and the UI's process list.
//!
//! The design principle is **fail closed**. If a value *looks* like a secret we
//! redact it, because the cost of redacting a harmless string is a slightly less
//! useful log line, while the cost of leaking a token is an incident.
//!
//! Covered shapes (each has a test):
//!
//! * `--flag value` and `--flag=value` for secret-ish flags
//! * `-pVALUE` short flags
//! * `key=value` pairs in connection strings and query strings
//! * URL userinfo (`scheme://user:pass@host`)
//! * `Authorization: Bearer …`
//! * AWS-style and JWT-shaped literals
//! * GitHub/Slack/npm token prefixes
//!
//! Deliberately **not** covered: free-form prose. There is no reliable way to
//! detect a secret in a sentence, which is why the schema never stores prose
//! from the OS in the first place (`04-02` §3).

/// Replacement marker. Stable so tests and logs can grep for it.
pub const MASK: &str = "***";

/// Flag names (normalised, no leading dashes, lowercase) whose following value
/// is treated as a secret.
const SECRET_FLAGS: &[&str] = &[
    "password",
    "passwd",
    "pwd",
    "pass",
    "token",
    "accesstoken",
    "refreshtoken",
    "api-key",
    "apikey",
    "api_key",
    "secret",
    "client-secret",
    "clientsecret",
    "auth",
    "authorization",
    "credential",
    "credentials",
    "sig",
    "signature",
    "session",
    "sessionid",
    "cookie",
    "private-key",
    "privatekey",
    "dsn",
    "connectionstring",
    "connection-string",
];

fn is_secret_flag(raw: &str) -> bool {
    let normalised = raw.trim_start_matches('-').to_ascii_lowercase();
    // Exact match, or the flag ends with one of the secret words
    // (`--db-password`, `--x-api-key`).
    SECRET_FLAGS.iter().any(|flag| {
        normalised == *flag
            || normalised.ends_with(&format!("-{flag}"))
            || normalised.ends_with(&format!("_{flag}"))
    })
}

/// Minimum length before an entropy heuristic is allowed to mask a bare token.
/// Shorter values are usually paths, ports or numbers.
const HIGH_ENTROPY_MIN_LEN: usize = 24;

/// True when a token has no whitespace and mixes enough character classes that
/// treating it as a secret is the safer bet.
fn looks_like_opaque_token(value: &str) -> bool {
    let value = value.trim_matches(|c| c == '"' || c == '\'' || c == ',' || c == ';');
    if value.len() < HIGH_ENTROPY_MIN_LEN || value.contains(char::is_whitespace) {
        return false;
    }
    // A filesystem path or URL is not a secret even when long.
    if value.contains(":\\") || value.contains(":/") {
        return false;
    }
    let has_lower = value.chars().any(|c| c.is_ascii_lowercase());
    let has_upper = value.chars().any(|c| c.is_ascii_uppercase());
    let has_digit = value.chars().any(|c| c.is_ascii_digit());
    // Base64/hex tokens: at least two of three classes plus an unbroken run.
    let run = value
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_' && c != '.')
        .map(str::len)
        .max()
        .unwrap_or(0);
    run >= HIGH_ENTROPY_MIN_LEN
        && u8::from(has_lower) + u8::from(has_upper) + u8::from(has_digit) >= 2
}

/// Well-known token prefixes. These are redacted on sight, whole.
const TOKEN_PREFIXES: &[&str] = &[
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "xoxb-",
    "xoxp-",
    "xoxa-",
    "npm_",
    "sk-",
    "sk_live_",
    "sk_test_",
    "pk_live_",
    "AKIA",
    "ASIA",
    "AIza",
    "glpat-",
];

fn redact_known_prefixes(token: &str) -> Option<String> {
    let trimmed = token.trim_matches(|c: char| c == '"' || c == '\'' || c == ',' || c == ';');
    if TOKEN_PREFIXES
        .iter()
        .any(|prefix| trimmed.starts_with(prefix))
        && trimmed.len() > 8
    {
        return Some(MASK.to_string());
    }
    // JWT: three dot-separated base64url segments, first starting with `eyJ`.
    if trimmed.starts_with("eyJ") && trimmed.matches('.').count() == 2 && trimmed.len() > 30 {
        return Some(MASK.to_string());
    }
    None
}

/// Characters that end one component of a whitespace-free token. Used to find
/// the flag name to the left of an `=` and the value to its right.
const COMPONENT_SEPARATORS: &[char] = &[
    '@', '=', '/', ':', ',', '"', '\'', ';', '&', '?', '(', ')', '<', '>',
];

/// Mask the password/token in a `flag=value` or `key=value` pair, wherever the
/// pair sits inside a larger token.
///
/// `redact_command_line` inspects `key=value` because it already tokenises on
/// whitespace; a *log line* reaches us as one string, so
/// `conn --db-password=Sup3rS3cret` used to sail through untouched. The value is
/// masked up to the next `;`/`&`/`,` so `Password=x;Database=prod` keeps the
/// harmless half.
fn redact_secret_assignments(token: &str) -> Option<String> {
    let chars: Vec<char> = token.chars().collect();
    let mut out = String::with_capacity(token.len());
    let mut index = 0;
    let mut changed = false;

    while index < chars.len() {
        if chars[index] != '=' {
            out.push(chars[index]);
            index += 1;
            continue;
        }

        // Walk backwards over what we have already emitted to recover the flag.
        let flag_start = {
            let mut start = out.len();
            let bytes: Vec<char> = out.chars().collect();
            while start > 0
                && !COMPONENT_SEPARATORS.contains(&bytes[start - 1])
                && bytes[start - 1] != ' '
            {
                start -= 1;
            }
            start
        };
        let flag: String = out.chars().skip(flag_start).collect();

        out.push('=');
        index += 1;

        if is_secret_flag(&flag) {
            out.push_str(MASK);
            changed = true;
            while index < chars.len() && !matches!(chars[index], ';' | '&' | ',') {
                index += 1;
            }
        }
    }

    changed.then_some(out)
}

/// Mask any well-known token or JWT that appears *inside* a larger token.
///
/// `redact_known_prefixes` only fires when the credential is the whole token,
/// which misses the most common real-world shape: a credential embedded in a
/// URL. `https://ghp_…@github.com` reaches here as one whitespace-free token
/// whose secret sits in the middle. Splitting on the characters that can start
/// a new component and re-testing each component closes that gap without
/// masking the surrounding diagnostics.
///
/// Returns `None` when nothing embedded looks like a known credential.
fn redact_embedded_known(token: &str) -> Option<String> {
    const SEPARATORS: &[char] = COMPONENT_SEPARATORS;
    let mut changed = false;
    let mut out = String::with_capacity(token.len());
    let mut segment = String::new();

    let flush = |segment: &mut String, out: &mut String, changed: &mut bool| {
        if segment.is_empty() {
            return;
        }
        match redact_known_prefixes(segment) {
            Some(masked) => {
                out.push_str(&masked);
                *changed = true;
            }
            None => out.push_str(segment),
        }
        segment.clear();
    };

    for ch in token.chars() {
        if SEPARATORS.contains(&ch) {
            flush(&mut segment, &mut out, &mut changed);
            out.push(ch);
        } else {
            segment.push(ch);
        }
    }
    flush(&mut segment, &mut out, &mut changed);

    changed.then_some(out)
}

/// Redact a full command line.
///
/// This is the function the process adapter calls before storing or displaying
/// anything, and the one the redaction tests drive.
pub fn redact_command_line(input: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let tokens: Vec<&str> = split_command_line(input);
    let mut index = 0;

    while index < tokens.len() {
        let token = tokens[index];

        // `--flag=value`
        if let Some((flag, value)) = token.split_once('=') {
            if flag.starts_with('-') && is_secret_flag(flag) {
                out.push(format!("{flag}={MASK}"));
                index += 1;
                continue;
            }
            // `--connection "Server=x;Password=y"` is handled by the value pass.
            if flag.starts_with('-') {
                out.push(format!("{flag}={}", redact_value(value)));
                index += 1;
                continue;
            }
            // Bare `key=value`
            if is_secret_flag(flag) {
                out.push(format!("{flag}={MASK}"));
                index += 1;
                continue;
            }
            out.push(redact_value(token));
            index += 1;
            continue;
        }

        // `--flag value`
        if is_secret_flag(token) {
            out.push(token.to_string());
            if let Some(next) = tokens.get(index + 1)
                && !next.starts_with('-')
            {
                out.push(MASK.to_string());
                index += 2;
                continue;
            }
            index += 1;
            continue;
        }

        // `-pVALUE` - only the canonical short flags we know.
        if let Some(rest) = token.strip_prefix("-p")
            && !rest.is_empty()
            && !rest.starts_with('-')
        {
            out.push(format!("-p{MASK}"));
            index += 1;
            continue;
        }

        out.push(redact_value(token));
        index += 1;
    }

    join_command_line(&out)
}

/// Redact a single value that may embed secrets (URL userinfo, query params).
pub fn redact_value(value: &str) -> String {
    let mut value = value.to_string();

    // URL userinfo: scheme://user:pass@host
    if let Some(scheme_end) = value.find("://") {
        let after = scheme_end + 3;
        if let Some(at) = value[after..].find('@') {
            let at = after + at;
            let authority = &value[after..at];
            if authority.contains(':') {
                let replaced = format!("{}{}@{}{}", &value[..after], MASK, "", &value[at + 1..]);
                value = replaced;
            }
        }
    }

    // Bearer tokens in headers.
    if let Some(pos) = value.to_ascii_lowercase().find("bearer ") {
        let start = pos + "bearer ".len();
        let end = value[start..]
            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'')
            .map(|offset| start + offset)
            .unwrap_or(value.len());
        value.replace_range(start..end, MASK);
    }

    // Query-string style secret parameters: Password=..., token=...
    let mut rebuilt = String::with_capacity(value.len());
    for chunk in value.split(['&', ';']) {
        if !rebuilt.is_empty() {
            rebuilt.push('&');
        }
        match chunk.split_once('=') {
            Some((key, _)) if is_secret_flag(key) => rebuilt.push_str(&format!("{key}={MASK}")),
            _ => rebuilt.push_str(chunk),
        }
    }

    if let Some(masked) = redact_known_prefixes(&rebuilt) {
        return masked;
    }

    if let Some(masked) = redact_embedded_known(&rebuilt) {
        return masked;
    }

    if looks_like_opaque_token(&rebuilt) {
        return rebuilt
            .split(|c: char| c.is_whitespace())
            .map(|part| {
                if looks_like_opaque_token(part) {
                    MASK
                } else {
                    part
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
    }

    rebuilt
}

/// Scrub free text (a log line, a summary) of tokens we can recognise.
///
/// Three passes, in order of confidence:
///
/// 1. A token preceded by `Bearer` or `Authorization:` is always masked, even
///    when it is short - a 20-character token is still a credential.
/// 2. Well-known token prefixes (`ghp_`, `AKIA`, `eyJ…` JWTs) are masked whole.
/// 3. Anything else that looks like a high-entropy opaque token is masked.
///
/// Masking *replaces* the token; it never appends a marker next to it, which is
/// the bug that let `Authorization: Bearer *** <secret>` leak the secret.
pub fn redact_text(input: &str) -> String {
    let mut result = String::with_capacity(input.len());
    let mut token = String::new();
    // Set by the token before the current one, so it must be read before it is
    // overwritten.
    let mut mask_current = false;

    let emit = |result: &mut String, token: &str, mask: bool| {
        if mask {
            result.push_str(MASK);
        } else if let Some(masked) = redact_known_prefixes(token) {
            result.push_str(&masked);
        } else if let Some(masked) = redact_secret_assignments(token) {
            // The replacement may still carry a URL-embedded token after the
            // assignment was masked, so run the embedded pass over it too.
            result.push_str(&redact_embedded_known(&masked).unwrap_or(masked));
        } else if let Some(masked) = redact_embedded_known(token) {
            result.push_str(&masked);
        } else if looks_like_opaque_token(token) {
            result.push_str(MASK);
        } else {
            result.push_str(token);
        }
    };

    for ch in input.chars() {
        if ch.is_whitespace() {
            if !token.is_empty() {
                emit(&mut result, &token, mask_current);
                mask_current = is_bearer_marker(&token);
                token.clear();
            }
            result.push(ch);
        } else {
            token.push(ch);
        }
    }
    if !token.is_empty() {
        emit(&mut result, &token, mask_current);
    }

    result
}

/// `Bearer`, `Bearer:` or `Authorization:` - the token that follows is a secret.
fn is_bearer_marker(token: &str) -> bool {
    let trimmed = token.trim_end_matches(':');
    trimmed.eq_ignore_ascii_case("bearer") || trimmed.eq_ignore_ascii_case("authorization")
}

/// Windows-correct tokenisation: keeps quoted runs together so
/// `--message "hello world"` is two tokens, not three.
fn split_command_line(input: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let bytes = input.as_bytes();
    let mut start: Option<usize> = None;
    let mut in_quotes: Option<u8> = None;

    for (index, byte) in bytes.iter().copied().enumerate() {
        match in_quotes {
            Some(quote) => {
                if byte == quote {
                    in_quotes = None;
                }
            }
            None => {
                if byte == b'"' || byte == b'\'' {
                    in_quotes = Some(byte);
                    start.get_or_insert(index);
                } else if byte == b' ' || byte == b'\t' {
                    if let Some(begin) = start.take() {
                        tokens.push(&input[begin..index]);
                    }
                } else {
                    start.get_or_insert(index);
                }
            }
        }
    }
    if let Some(begin) = start {
        tokens.push(&input[begin..]);
    }
    tokens
}

/// Re-quote any token that contains a space so the rebuilt line stays parseable.
fn join_command_line(tokens: &[String]) -> String {
    tokens
        .iter()
        .map(|token| {
            if token.contains(' ') && !token.starts_with('"') {
                format!("\"{token}\"")
            } else {
                token.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_absent(haystack: &str, secret: &str) {
        assert!(
            !haystack.contains(secret),
            "secret {secret:?} leaked in {haystack:?}"
        );
    }

    #[test]
    fn long_flag_with_space_value() {
        let line = "node server.js --password hunter2 --port 3000";
        let out = redact_command_line(line);
        assert_absent(&out, "hunter2");
        assert!(out.contains("--port 3000"), "{out}");
    }

    #[test]
    fn long_flag_with_equals_value() {
        let out = redact_command_line("app.exe --api-key=abcd1234efgh");
        assert_absent(&out, "abcd1234efgh");
        assert!(out.contains("--api-key=***"));
    }

    #[test]
    fn short_flag_value() {
        let out = redact_command_line("mysql.exe -pS3cr3tP@ss db");
        assert_absent(&out, "S3cr3tP@ss");
        assert!(out.contains("-p***"));
    }

    #[test]
    fn connection_string() {
        let out = redact_command_line(
            "sqlcmd.exe --connection \"Server=db;User Id=sa;Password=Pa$$w0rd;Database=prod\"",
        );
        assert_absent(&out, "Pa$$w0rd");
        assert!(out.contains("Server=db"), "{out}");
    }

    #[test]
    fn url_userinfo() {
        let out = redact_command_line("git.exe clone https://alice:tok3n@github.com/x/y.git");
        assert_absent(&out, "tok3n");
    }

    #[test]
    fn bearer_header() {
        let out = redact_text("Authorization: Bearer abcDEF123456ghiJKL");
        assert_absent(&out, "abcDEF123456ghiJKL");
    }

    #[test]
    fn github_token_prefix() {
        let out = redact_command_line("node index.js --x ghp_16C7e42F292c6912E7710c838347Ae178B4a");
        assert_absent(&out, "ghp_16C7e42F292c6912E7710c838347Ae178B4a");
    }

    #[test]
    fn aws_key_prefix() {
        let out = redact_text("using AKIAIOSFODNN7EXAMPLE for upload");
        assert_absent(&out, "AKIAIOSFODNN7EXAMPLE");
    }

    #[test]
    fn jwt_literal() {
        let jwt =
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let out = redact_text(&format!("token={jwt}"));
        assert_absent(&out, "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    }

    #[test]
    fn ordinary_paths_and_ports_survive() {
        let line = r#"node C:\Users\deniz\app\server.js --port 3000 --host 127.0.0.1"#;
        let out = redact_command_line(line);
        assert!(out.contains(r"C:\Users\deniz\app\server.js"), "{out}");
        assert!(out.contains("3000"));
        assert!(out.contains("127.0.0.1"));
    }

    #[test]
    fn quoted_arguments_stay_together() {
        let out = redact_command_line(r#"app.exe --title "My Project" --password xyz"#);
        assert!(out.contains("\"My Project\""), "{out}");
        assert_absent(&out, "xyz");
    }

    #[test]
    fn empty_input_is_safe() {
        assert_eq!(redact_command_line(""), "");
        assert_eq!(redact_text(""), "");
    }

    #[test]
    fn redaction_is_idempotent() {
        let once = redact_command_line("app.exe --token=abcdef123 --port 80");
        let twice = redact_command_line(&once);
        assert_eq!(once, twice);
    }

    #[test]
    fn hyphenated_flag_names_are_recognised() {
        for flag in ["--db-password", "--x-api-key", "--client-secret"] {
            let out = redact_command_line(&format!("tool.exe {flag} supersecretvalue"));
            assert_absent(&out, "supersecretvalue");
        }
    }

    /// DEF-053: a credential in URL userinfo was masked only when a password was
    /// present (`user:pass@`). A bare token as the userinfo (`ghp_…@host`) is
    /// the shape GitHub, npm and Azure DevOps actually use, and it survived.
    #[test]
    fn known_token_in_url_userinfo_is_masked() {
        for secret in [
            "https://ghp_0123456789abcdefghijklmnopqrstuvwxyz@github.com/x/y.git",
            "remote=https://ghp_0123456789abcdefghijklmnopqrstuvwxyz@github.com/x/y",
        ] {
            let out = redact_text(secret);
            assert_absent(&out, "ghp_0123456789abcdefghijklmnopqrstuvwxyz");
            // The host must survive: masking is not allowed to destroy the line.
            assert!(out.contains("github.com"), "{out}");
        }
    }

    /// A token that *is* the whole value is masked whole, prefix included. The
    /// trailing path is part of the credential's location, so losing it is the
    /// correct, fail-closed outcome.
    #[test]
    fn whole_value_token_is_masked_entirely() {
        let out = redact_text("npm_abcdefghijklmnopqrstuvwxyz0123456789");
        assert_eq!(out, MASK);
    }

    /// DEF-053: `redact_text` handled `Bearer` but not `--flag=value`, so a log
    /// line carrying an assignment leaked. Command lines were fine; log lines
    /// were not, and logs are what the support bundle ships.
    #[test]
    fn secret_assignment_inside_a_log_line_is_masked() {
        let out = redact_text("DEBUG conn --db-password=Sup3rS3cret-Pa55word;host=db1");
        assert_absent(&out, "Sup3rS3cret");
        assert!(out.contains("host=db1"), "{out}");
        let out = redact_text("connect Password=hunter2&user=sa");
        assert_absent(&out, "hunter2");
        assert!(out.contains("user=sa"), "{out}");
    }

    #[test]
    fn embedded_mask_keeps_the_surrounding_text() {
        let out = redact_value("https://ghp_0123456789abcdefghijklmnopqrstuvwxyz@github.com");
        assert!(!out.contains("ghp_0123456789"));
        assert!(out.contains("github.com"));
    }
}
