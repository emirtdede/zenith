//! Execution engine: deterministic, testable logic with the OS kept at arm's length.
//!
//! Every module here is pure or near-pure so it can be tested without a Windows
//! VM. The only impure module is [`db`], which is still deterministic given a
//! database file.

pub mod audit;
pub mod dag;
pub mod db;
pub mod executor;
pub mod headless;
pub mod health;
pub mod keystore;
pub mod pipeline;
pub mod purge;
pub mod redact;
pub mod retention;
pub mod scope;
pub mod snapshot;
pub mod support;
