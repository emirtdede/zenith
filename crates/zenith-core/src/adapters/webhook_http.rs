//! HTTPS delivery through WinHTTP.
//!
//! WinHTTP is the platform client, so the application adds no TLS stack and no
//! second certificate store: system proxy settings, enterprise roots and TLS
//! inspection keep working. The adapter is deliberately small - build, send,
//! read the status code - and every handle is owned by one guard.

use std::ptr;

use windows::Win32::Networking::WinHttp::{
    WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_FLAG_SECURE, WINHTTP_OPEN_REQUEST_FLAGS,
    WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE, WinHttpCloseHandle, WinHttpConnect,
    WinHttpOpen, WinHttpOpenRequest, WinHttpQueryHeaders, WinHttpReceiveResponse,
    WinHttpSendRequest, WinHttpSetTimeouts, WinHttpWriteData,
};
use windows::core::PCWSTR;

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

struct Handle(*mut core::ffi::c_void);

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: the pointer came from a WinHttp* constructor, has not been
        // closed, and each handle is owned by exactly one `Handle` that is never
        // cloned, so this is the single close.
        unsafe {
            let _ = WinHttpCloseHandle(self.0);
        }
    }
}

/// Split an already validated URL into (host, port, path).
fn split(url: &str) -> Option<(String, u16, String)> {
    let (scheme, rest) = url.split_once("://")?;
    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) => {
            (host.to_string(), port.parse::<u16>().ok()?)
        }
        _ => (
            authority.to_string(),
            if scheme == "https" { 443 } else { 80 },
        ),
    };
    Some((host, port, path.to_string()))
}

/// POST `body` to an absolute, already validated URL and return the status code.
pub fn post(
    url: &str,
    headers: &[(String, String)],
    body: &[u8],
    timeout_ms: u32,
) -> Result<u16, String> {
    let (host, port, path) = split(url).ok_or_else(|| "MALFORMED_URL".to_string())?;
    let secure = url.starts_with("https://");
    let agent = wide("Zenith/1.0");
    let host_w = wide(&host);
    let path_w = wide(&path);
    let verb = wide("POST");
    let header_text = headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect::<String>();
    let header_block = wide(&header_text);

    // SAFETY: `agent` is NUL-terminated and outlives the call; the proxy
    // arguments are null and the access type is the documented default.
    let session = unsafe {
        WinHttpOpen(
            PCWSTR(agent.as_ptr()),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        )
    };
    if session.is_null() {
        return Err("OPEN".to_string());
    }
    let session = Handle(session);
    // SAFETY: `session` is a live WinHTTP session for the duration of this call
    // and the timeout values are plain integers.
    unsafe {
        let _ = WinHttpSetTimeouts(
            session.0,
            timeout_ms as i32,
            timeout_ms as i32,
            timeout_ms as i32,
            timeout_ms as i32,
        );
    }

    // SAFETY: `session` is live, `host_w` is NUL-terminated and outlives the
    // call, and the port was parsed as u16.
    let connection = unsafe { WinHttpConnect(session.0, PCWSTR(host_w.as_ptr()), port, 0) };
    if connection.is_null() {
        return Err("CONNECT".to_string());
    }
    let connection = Handle(connection);

    // SAFETY: `connection` is live and every string argument is NUL-terminated
    // and outlives the call. No accept types are passed.
    let request = unsafe {
        WinHttpOpenRequest(
            connection.0,
            PCWSTR(verb.as_ptr()),
            PCWSTR(path_w.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            ptr::null(),
            if secure {
                WINHTTP_FLAG_SECURE
            } else {
                WINHTTP_OPEN_REQUEST_FLAGS(0)
            },
        )
    };
    if request.is_null() {
        return Err("REQUEST".to_string());
    }
    let request = Handle(request);

    // SAFETY: `request` is live; the header slice is valid for the declared
    // length (the terminator is excluded) and the optional-body pointer is null
    // because the body is written separately.
    unsafe {
        WinHttpSendRequest(
            request.0,
            Some(&header_block[..header_block.len() - 1]),
            None,
            0,
            body.len() as u32,
            0,
        )
    }
    .map_err(|error| format!("SEND_HEADERS_{error}"))?;

    if !body.is_empty() {
        let mut written = 0u32;
        // SAFETY: `request` is live, `body` is a valid slice of exactly
        // `body.len()` bytes, and `written` is a valid out-pointer.
        unsafe {
            WinHttpWriteData(
                request.0,
                Some(body.as_ptr() as *const core::ffi::c_void),
                body.len() as u32,
                &mut written,
            )
        }
        .map_err(|error| format!("SEND_BODY_{error}"))?;
        if written as usize != body.len() {
            return Err("SEND_BODY_SHORT".to_string());
        }
    }

    // SAFETY: `request` is live and the whole body has been written.
    unsafe { WinHttpReceiveResponse(request.0, ptr::null_mut()) }
        .map_err(|error| format!("RECEIVE_{error}"))?;

    let mut status = 0u32;
    let mut length = std::mem::size_of::<u32>() as u32;
    let mut index = 0u32;
    // SAFETY: `status` and `length` are valid out-pointers of the declared size,
    // and the query asks for the numeric status code.
    unsafe {
        WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            Some(&mut status as *mut u32 as *mut core::ffi::c_void),
            &mut length,
            &mut index,
        )
    }
    .map_err(|error| format!("STATUS_{error}"))?;
    Ok(status as u16)
}
