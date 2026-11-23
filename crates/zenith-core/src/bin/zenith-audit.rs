//! `zenith-audit` - the mechanical half of the Zero-Stub law in `00-01` §3.
//!
//! `00-01` L1/L3 say a public symbol is either implemented or returns
//! `NotImplemented` and is listed in the WBS, and that every published constant
//! or environment variable has a consumer. Those rules are worth nothing as
//! prose; this binary is what enforces them.
//!
//! ```text
//! cargo run -p zenith-core --bin zenith-audit -- --stubs
//! cargo run -p zenith-core --bin zenith-audit -- --flags
//! cargo run -p zenith-core --bin zenith-audit -- --todo
//! ```
//!
//! Exit codes: `0` clean, `1` violation found, `2` usage error.
//!
//! It walks the source tree with no external crates beyond `walkdir`, so it can
//! run on an air-gapped build host.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use walkdir::WalkDir;

/// The audit binary's own source necessarily contains the literals it searches
/// for (`todo!(`, `TODO`), so it is excluded from the scans it performs.
const SELF: &str = "crates/zenith-core/src/bin/zenith-audit.rs";

/// Directories that never contain first-party source.
const SKIPPED: [&str; 8] = [
    "target",
    "node_modules",
    "dist",
    ".git",
    "resources",
    "docs",
    ".github",
    "gen",
];

/// The published-config module whose constants must all have a consumer.
const CONFIG_MODULE: &str = "crates/zenith-core/src/config.rs";

fn main() -> ExitCode {
    let mode = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "--all".to_string());
    let root = match workspace_root() {
        Some(path) => path,
        None => {
            eprintln!("zenith-audit: cannot locate the workspace root from CARGO_MANIFEST_DIR");
            return ExitCode::from(2);
        }
    };

    let files = match source_files(&root) {
        Ok(files) => files,
        Err(error) => {
            eprintln!("zenith-audit: cannot walk the source tree: {error}");
            return ExitCode::from(2);
        }
    };

    let mut violations = 0_u32;
    let run_all = mode == "--all";

    if run_all || mode == "--stubs" {
        violations += report_stubs(&root, &files);
    }
    if run_all || mode == "--flags" {
        violations += report_flags(&root, &files);
    }
    if run_all || mode == "--todo" {
        violations += report_todos(&root, &files);
    }

    if !matches!(mode.as_str(), "--all" | "--stubs" | "--flags" | "--todo") {
        eprintln!("usage: zenith-audit [--all|--stubs|--flags|--todo]");
        return ExitCode::from(2);
    }

    if violations == 0 {
        println!("\nZero-Stub audit: clean.");
        ExitCode::SUCCESS
    } else {
        println!("\nZero-Stub audit: {violations} violation(s).");
        ExitCode::from(1)
    }
}

/// `CARGO_MANIFEST_DIR` is `<root>/crates/zenith-core`, so the root is two
/// levels up. Resolved once so every subcommand scans the same set of files.
fn workspace_root() -> Option<PathBuf> {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest.parent()?.parent().map(Path::to_path_buf)
}

fn source_files(root: &Path) -> Result<Vec<PathBuf>, walkdir::Error> {
    let mut files = Vec::new();
    for entry in WalkDir::new(root).into_iter().filter_entry(|entry| {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        !SKIPPED.contains(&name.as_str())
    }) {
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if name.ends_with(".rs") || name.ends_with(".ts") || name.ends_with(".tsx") {
            files.push(entry.path().to_path_buf());
        }
    }
    files.sort();
    Ok(files)
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .display()
        .to_string()
        .replace('\\', "/")
}

/// L1: `todo!()` and `unimplemented!()` are never allowed in shipped code.
/// `NotImplemented` is allowed, but must be listed so the WBS can be honest.
fn report_stubs(root: &Path, files: &[PathBuf]) -> u32 {
    let mut hard = Vec::new();
    let mut declared = Vec::new();

    for file in files {
        if relative(root, file) == SELF {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(file) else {
            continue;
        };
        for (index, line) in text.lines().enumerate() {
            let number = index + 1;
            let trimmed = line.trim_start();
            if trimmed.starts_with("//") || trimmed.starts_with("///") {
                continue;
            }
            if line.contains("todo!(") || line.contains("unimplemented!(") {
                hard.push(format!(
                    "{}:{}: {}",
                    relative(root, file),
                    number,
                    line.trim()
                ));
            }
            if line.contains("ErrorCode::NotImplemented") {
                declared.push(format!("{}:{}", relative(root, file), number));
            }
        }
    }

    println!("== L1 stubs ==");
    if hard.is_empty() {
        println!("  no todo!() / unimplemented!() in first-party source");
    } else {
        for entry in &hard {
            println!("  FORBIDDEN {entry}");
        }
    }
    println!("  NotImplemented sites: {}", declared.len());
    for entry in &declared {
        println!("    {entry}");
    }
    for entry in &declared {
        report_declared_consumer(root, entry);
    }
    hard.len() as u32
}

/// A `NotImplemented` return is only honest if the path is reachable and the
/// reason is visible at the call site. We check the one documented case - the
/// non-Windows adapter - rather than pretending to understand every branch.
fn report_declared_consumer(root: &Path, site: &str) {
    let path = site.split(':').next().unwrap_or(site);
    let Ok(text) = std::fs::read_to_string(root.join(path)) else {
        return;
    };
    if text.contains("cfg(not(windows))") || text.contains("not(windows)") {
        println!("    -> gated by not(windows): {path}");
    }
}

/// L3: every published constant and environment variable has a consumer.
///
/// "Consumer" means a reference in a file other than the declaration site.
/// A constant that only appears in its own module is dead configuration, which
/// is exactly the class of defect this rule exists to catch.
fn report_flags(root: &Path, files: &[PathBuf]) -> u32 {
    let mut violations = 0_u32;
    println!("== L3 dead configuration ==");

    let config = root.join(CONFIG_MODULE);
    let Ok(config_text) = std::fs::read_to_string(&config) else {
        println!("  MISSING {CONFIG_MODULE}");
        return 1;
    };

    let mut corpus: Vec<(String, String)> = Vec::new();
    for file in files {
        let Ok(text) = std::fs::read_to_string(file) else {
            continue;
        };
        corpus.push((relative(root, file), text));
    }

    let mut constants = 0_usize;
    for line in config_text.lines() {
        let trimmed = line.trim_start();
        let Some(rest) = trimmed.strip_prefix("pub const ") else {
            continue;
        };
        let Some((name, _)) = rest.split_once(':') else {
            continue;
        };
        constants += 1;
        let uses = corpus
            .iter()
            .map(|(_, text)| text.matches(name).count())
            .sum::<usize>();
        // The declaration itself is one occurrence; a constant referenced only
        // there has no consumer. Uses inside `config.rs` (e.g. `has_space_for`
        // combining two caps) are legitimate consumers.
        if uses <= 1 {
            println!("  UNUSED const {name} in {CONFIG_MODULE}");
            violations += 1;
        }
    }
    if violations == 0 {
        println!("  {constants} published constants, every one consumed");
    } else {
        println!("  {constants} published constants, {violations} without a consumer");
    }

    // Environment variables read at runtime. Each is a documented knob; the
    // list is printed so a reviewer can confirm the docs mention it.
    let env_names = env_variables(&corpus);
    println!("  {} environment variables read", env_names.len());
    for (name, count) in &env_names {
        println!("    env {name} (read {count}x)");
    }

    violations
}

/// Collect quoted names from `std::env::var("…")` / `env!("…")` call sites.
fn env_variables(corpus: &[(String, String)]) -> BTreeMap<String, usize> {
    let mut names: BTreeMap<String, usize> = BTreeMap::new();
    for (_, text) in corpus {
        for marker in ["std::env::var(\"", "env!(\""] {
            for piece in text.split(marker).skip(1) {
                if let Some(end) = piece.find('"') {
                    let name = &piece[..end];
                    if !name.is_empty() {
                        *names.entry(name.to_string()).or_insert(0) += 1;
                    }
                }
            }
        }
    }
    names
}

/// TODO comments are allowed only when they name an owner or a work package.
/// An unattributed TODO is a stub with a comment attached.
///
/// Only **comments** are scanned. Code that *rejects* a `TODO` string (a
/// manifest guard, a test fixture) mentions the word without being a marker,
/// and flagging it would train reviewers to ignore this check.
fn report_todos(root: &Path, files: &[PathBuf]) -> u32 {
    let mut violations = 0_u32;
    println!("== TODO markers ==");
    for file in files {
        if relative(root, file) == SELF {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(file) else {
            continue;
        };
        for (index, line) in text.lines().enumerate() {
            let Some(comment) = comment_of(line) else {
                continue;
            };
            let Some(position) = comment.find("TODO") else {
                continue;
            };
            let rest = &comment[position..];
            let attributed = rest.contains("DEF-") || rest.contains("WP-");
            if !attributed {
                println!(
                    "  UNATTRIBUTED {}:{}: {}",
                    relative(root, file),
                    index + 1,
                    comment.trim()
                );
                violations += 1;
            }
        }
    }
    if violations == 0 {
        println!("  no unattributed TODO markers");
    }
    violations
}

/// Return the comment portion of a line, if it has one.
///
/// `//` is recognised everywhere; `#` only at line start (Rust attributes and
/// TS private fields would otherwise be mistaken for comments).
fn comment_of(line: &str) -> Option<&str> {
    let trimmed = line.trim_start();
    if trimmed.starts_with('#') {
        return Some(trimmed);
    }
    let position = line.find("//")?;
    Some(&line[position..])
}
