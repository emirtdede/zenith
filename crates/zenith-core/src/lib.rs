//! # zenith-core
//!
//! The trusted core of Zenith. Every privileged operation in the product passes
//! through this crate; the webview never touches the operating system directly.
//!
//! ## Layering
//!
//! ```text
//! ipc  ──►  engine  ──►  adapters  ──►  Windows
//!  │           │
//!  └── models ─┘
//! ```
//!
//! * [`models`] - shared types, generated from the action manifest.
//! * [`manifest`] - the single source of truth for the 22 actions (ADR-011).
//! * [`engine`] - pure and near-pure logic: DAG ordering, health scoring,
//!   redaction, snapshot integrity, retention, execution state machine, storage.
//! * [`adapters`] - the only place `unsafe` is permitted (`03-06`), each with a
//!   named invariant and a documented failure mode.
//! * [`error`] - one error type, stable codes, i18n keys, never English prose.
//!
//! ## Safety posture
//!
//! `unsafe_code` is denied crate-wide and re-enabled only for the
//! [`adapters`] module, via one explicit `#[allow(unsafe_code)]` on its `pub mod`
//! declaration. Every unsafe block carries a `// SAFETY:` comment naming the
//! invariant it relies on. Earlier this paragraph said the exemption was scoped
//! to `adapters::win32`; that module holds the Win32 error-code constants and no
//! `unsafe` at all, so the sentence described a boundary that did not exist.
//!
//! ## Honesty posture
//!
//! A capability that is absent from a build returns [`error::ZenithError::not_implemented`]
//! and surfaces in the UI as a disabled control with a reason. It never pretends
//! to have succeeded - the rule that v1.0.0 broke with `#[cfg(not(windows))] { Ok(()) }`.

#![forbid(unsafe_op_in_unsafe_fn)]
#![deny(unsafe_code)]
#![deny(clippy::undocumented_unsafe_blocks)]
// Tests assert rather than propagate: `expect`/`unwrap` in a `#[test]` is the
// intended failure mechanism, not an error-handling shortcut. Production paths
// keep the crate-level `warn` from `Cargo.toml` and must not use them.
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

// The single exemption, scoped to the layer that talks to Windows. Everything
// above this line is safe Rust by construction (U1 in `03-06`).
#[allow(unsafe_code)]
pub mod adapters;
pub mod api;

pub mod catalog_ts;
pub mod cli;
pub mod config;
pub mod engine;
pub mod error;
pub mod i18n;
pub mod manifest;
pub mod mcp;
pub mod models;
pub mod webhook;

pub use error::{ErrorCode, ZenithError, ZenithResult};
pub use manifest::{ACTIONS, ActionDef, ActionScope, Category, CommandSpec, action_by_id};
pub use models::{
    ActionId, DiagnosticReport, ExecutionOutcome, ExecutionPhase, ReversibilityTier, Risk,
    StepResult, SystemTelemetry,
};

/// Crate-wide schema version for anything persisted by this build.
///
/// Bumping this requires a migration in [`engine::db`] and a note in
/// `docs/03-architecture/03-03-data-model-db.md` §7.
pub const SCHEMA_VERSION: i64 = 1;

/// Product version, injected at build time by `build.rs`.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
