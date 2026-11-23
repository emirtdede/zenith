//! The error shape the webview receives.
//!
//! `03-04` §1 P5 is explicit: the UI never sees English prose from the core.
//! Every rejection is `{code, messageKey, remedyKey, params, correlationId}`
//! and the active locale decides the sentence. `detail` exists for the log and
//! the support bundle; the UI must not render it.

use std::collections::BTreeMap;

use serde::Serialize;
use zenith_core::error::{ErrorCode, ZenithError};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcError {
    pub code: String,
    pub message_key: String,
    pub remedy_key: String,
    pub params: BTreeMap<String, String>,
    pub correlation_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl IpcError {
    pub fn new(code: ErrorCode) -> Self {
        Self {
            code: code.as_str().to_string(),
            message_key: code.message_key().to_string(),
            remedy_key: code.remedy_key().to_string(),
            params: BTreeMap::new(),
            correlation_id: zenith_core::engine::audit::new_correlation_id(),
            detail: None,
        }
    }

    /// A failure inside the Tauri layer itself (state not initialised, command
    /// argument that never reached the core). Still a stable code, never a bare
    /// string.
    pub fn internal(reason: &str) -> Self {
        let mut error = Self::new(ErrorCode::Internal);
        error.params.insert("reason".into(), reason.into());
        error
    }
}

impl From<ZenithError> for IpcError {
    fn from(error: ZenithError) -> Self {
        Self {
            code: error.code.as_str().to_string(),
            message_key: error.code.message_key().to_string(),
            remedy_key: error.code.remedy_key().to_string(),
            params: error.params,
            correlation_id: error.correlation_id,
            detail: error.detail,
        }
    }
}

impl From<std::io::Error> for IpcError {
    fn from(error: std::io::Error) -> Self {
        IpcError::from(ZenithError::io("ipc", &error))
    }
}

pub type IpcResult<T> = Result<T, IpcError>;
