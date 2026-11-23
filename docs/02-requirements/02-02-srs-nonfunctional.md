# 02-02 - Software Requirements Specification: Non-Functional

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-SRS-N-001 |
| Version | 2.0.0 |
| Status | Baseline |
| Owner | Architecture + Security |
| Note | Budgets are hard numbers with a measurement method. "Fast" is not a requirement. |
| Closes | No single defect - the budgets `01-01` and `07-01` measure against; the instrument is `src/perf.ts` (DEF-049 closed), the reference-VM p95 is DEF-047 |

---

## 1. Performance

| ID | Requirement | Budget | Measurement | Gate |
| :--- | :--- | :--- | :--- | :--- |
| REQ-N-001 | Cold start to interactive | p95 ≤ 1500 ms | Instrumented `performance.mark` (`src/perf.ts`, shown on the Trust screen); p95 over 10 runs on a reference VM - the run half is DEF-047 | WP-6 |
| REQ-N-002 | Single diagnostic probe | p95 ≤ 2000 ms | Per-probe timing in audit log | WP-4 |
| REQ-N-003 | Full 22-probe diagnosis | p95 ≤ 10 s (parallel where safe) | Aggregate measured | WP-4 |
| REQ-N-004 | UI frame budget during streaming logs | ≥ 55 fps; no long task > 200 ms | DevTools trace under `sfc` simulation | WP-6 |
| REQ-N-005 | Heap ceiling | ≤ 180 MB steady, ≤ 350 MB peak during archiving | 30-min soak with archiving | WP-7 |
| REQ-N-006 | Idle CPU | ≤ 1% average over 60 s idle | Process sampler | WP-7 |
| REQ-N-007 | Installer footprint | ≤ 18 MB compressed | Built artifact size | WP-8 |
| REQ-N-008 | Warm DB read for snapshot list | ≤ 40 ms at 200 rows | Criterion benchmark | WP-3 |
| REQ-N-009 | Snapshot write of 10 MB archive metadata | ≤ 60 ms excluding file I/O | Criterion benchmark | WP-3 |
| REQ-N-010 | Binary size (release, stripped, LTO) | ≤ 9 MB | Artifact check | WP-8 |

**Anti-regression:** any change > 15% in N-001/003/005 fails CI.

---

## 2. Reliability and safety

| ID | Requirement | Acceptance |
| :--- | :--- | :--- |
| REQ-N-011 | Crash-free session rate ≥ 99.5% over a 30-day beta cohort |
| REQ-N-012 | Every long operation is cancellable within 500 ms (see REQ-F-052) |
| REQ-N-013 | Zero data-loss defects at P1 in beta; a lost user file is a release blocker |
| REQ-N-014 | Fault injection at all 12 documented crash points leaves a consistent state (`07-01` §6) |
| REQ-N-015 | Startup is safe after an unclean shutdown: recovery runs before UI is interactive |
| REQ-N-016 | No unbounded growth: snapshot store, audit log, and log file all have enforced caps |
| REQ-N-017 | Memory is not retained per action: 100 consecutive action runs keep RSS within +10% of baseline |
| REQ-N-018 | The app tolerates a missing/corrupt config by regenerating defaults and logging it |
| REQ-N-019 | The app tolerates a corrupt store by quarantining and running read-only, never deleting |
| REQ-N-020 | Single-instance semantics are machine-wide; a second launch focuses the first |

---

## 3. Security

| ID | Requirement | Acceptance |
| :--- | :--- | :--- |
| REQ-N-021 | HMAC key MUST NOT be derivable from data readable by a standard user (`04-01` §5.2) |
| REQ-N-022 | Store directory ACL MUST grant write only to Administrators + SYSTEM |
| REQ-N-023 | Rollback targets MUST be validated against a per-action allowlist |
| REQ-N-024 | Elevation handover MUST be authenticated with a nonce and caller identity check |
| REQ-N-025 | No shell string constructed from user input may reach process spawn; args are passed as a vector |
| REQ-N-026 | Command lines stored or displayed MUST be redacted for secrets (REQ-F-063) |
| REQ-N-027 | All dependencies pass `cargo-deny` (advisories, licences, sources, bans) and `npm audit --production` |
| REQ-N-028 | Release binaries MUST be Authenticode-signed with a timestamp; unsigned builds MUST fail packaging |
| REQ-N-029 | Update manifests MUST be signed and verified before applying; downgrade MUST be refused |
| REQ-N-030 | CSP MUST forbid inline script and remote origins; violations logged in dev |
| REQ-N-031 | No `unwrap()`/`expect()` on paths reachable from user input or OS failure in release code |
| REQ-N-032 | Unsafe blocks MUST be ≤ 8% of Rust LOC, each with a safety comment and a named invariant |
| REQ-N-033 | Secrets MUST never be written to logs; a seeded-secret test enforces it |
| REQ-N-034 | The support bundle MUST be produced without elevation and MUST exclude secrets |

---

## 4. Accessibility (WCAG 2.2 AA mandatory)

| ID | Requirement | Acceptance |
| :--- | :--- | :--- |
| REQ-N-040 | All text meets 4.5:1; large text and UI components meet 3:1 (measured, see `05-03`) |
| REQ-N-041 | Destructive confirmation defaults focus to the safe choice; Enter never triggers destruction |
| REQ-N-042 | Full keyboard operability with visible focus (≥ 3:1 against adjacent colours) |
| REQ-N-043 | Modals trap focus and restore it on close |
| REQ-N-044 | Live regions announce progress and completion at a polite cadence (≤ 1 announcement / 2 s) |
| REQ-N-045 | `prefers-reduced-motion` removes non-essential animation |
| REQ-N-046 | Colour is never the sole channel for status; icon + text + colour |
| REQ-N-047 | Target size ≥ 24×24 CSS px (2.2 AA), 32×32 preferred for primary controls |
| REQ-N-048 | Zoom to 200% without loss of content or function |
| REQ-N-049 | Screen-reader pass on NVDA (Windows): all 6 screens and 5 overlays reachable and named |

---

## 5. Localisation

| ID | Requirement | Acceptance |
| :--- | :--- | :--- |
| REQ-N-050 | Every shipped locale has structural parity with `en`, enforced by `check-locales.mjs` |
| REQ-N-051 | Zero hard-coded user-visible strings |
| REQ-N-052 | ICU plural coverage for every count-bearing string |
| REQ-N-053 | RTL support for `ar`, `he`, `fa`, `ur` via logical properties only |
| REQ-N-054 | String budget: no primary-path label > 34 characters in English (layout safety) |
| REQ-N-055 | Locale bundle load ≤ 30 ms per locale, lazy |
| REQ-N-056 | Fallback chain locale → language → English, with dev-time reporting of misses |

---

## 6. Maintainability and quality

| ID | Requirement | Acceptance |
| :--- | :--- | :--- |
| REQ-N-060 | Line coverage ≥ 80% Rust, ≥ 75% TS on logic modules (UI rendering excluded from the gate) |
| REQ-N-061 | No function > 60 lines in Rust without an exemption comment and reviewer approval |
| REQ-N-062 | `cargo clippy -- -D warnings` and `tsc --noEmit` clean at all times |
| REQ-N-063 | Cyclomatic complexity ≤ 15 per function (measured by `cargo-geiger`-adjacent tooling / eslint) |
| REQ-N-064 | Public API of every module documented with a doc comment |
| REQ-N-065 | Every module has one responsibility, stated at the top of the file |
| REQ-N-066 | Golden-file tests for all generated artifacts (scripts, manifests, i18n skeleton) |
| REQ-N-067 | Build warnings: zero in release profile |

---

## 7. Compatibility

| ID | Requirement | State in 1.0.0 |
| :--- | :--- | :--- |
| REQ-N-070 | Windows 11 23H2 (22631), 24H2 (26100), 25H2 (26200), 26H2 (26300+) - full support | PASS declared target; T-WIN VM suite open (DEF-047) |
| REQ-N-071 | Windows 10 22H2 (19045) - supported with ESU lifecycle banner | WARN declared, **unverified**; no 22H2 VM run (DEF-047) |
| REQ-N-072 | x64 and ARM64 builds; ARM64 emulation not required | FAIL **x64 only**; ARM64 not built (DEF-058) |
| REQ-N-073 | WebView2 Runtime ≥ 120 assumed; bootstrapper + offline installer bundled | PASS NSIS bootstrapper; pinned in `resources/manifest.json` |
| REQ-N-074 | Display 960×680 minimum, 3840×2160 maximum tested, 100-200% scaling | WARN min window enforced; zoom capture open (DEF-044) |
| REQ-N-075 | High-contrast OS theme respected without breaking the token system | PASS tokens derive from OS theme (`05-01`) |
| REQ-N-076 | No dependency on PowerShell 7; Windows PowerShell 5.1 is the floor for exported scripts | PASS scripts target 5.1 |
| REQ-N-077 | Exported `.bat` must run on cmd.exe 10.0.19045+ | PASS no PS7-only syntax |

The three WARN/FAIL rows are not rounding errors. REQ-N-071/072 name platforms the 1.0.0 build does not
prove: ARM64 is a different target, and 22H2 needs its own VM image. Both are tracked as DEF-058 and
DEF-047 and gated in `08-02` §8 phase 3. A requirements table that marked them "done" because the
code compiles on one machine would be exactly the overstatement `00-01` L1 forbids.

---

## 8. Operability

| ID | Requirement |
| :--- | :--- |
| REQ-N-080 | Every run produces a correlation id usable in support |
| REQ-N-081 | Log rotation: 5 MB × 3 files, then oldest dropped |
| REQ-N-082 | Support bundle generation ≤ 5 s and ≤ 5 MB |
| REQ-N-083 | CLI exit codes are stable and documented (`03-04` §8) |
| REQ-N-084 | Crash reports, if enabled, contain no file paths of user documents |
| REQ-N-085 | Telemetry payload must be documented and versioned; unknown fields are rejected server-side |
| REQ-N-086 | Release rollback: a bad version can be superseded within one release cycle (updater channel) |

---

## 9. Determinism and reproducibility

| ID | Requirement | Acceptance |
| :--- | :--- | :--- |
| REQ-N-090 | `npm ci` + `cargo build --locked` reproduces the same dependency graph hash |
| REQ-N-091 | Build is reproducible modulo timestamps: same inputs → identical binary hash on the same toolchain (verified for two consecutive CI runs) |
| REQ-N-092 | Generated files (enum, types, i18n skeleton) are committed and CI fails on drift |
| REQ-N-093 | All downloaded third-party assets are hash-pinned in `resources/manifest.json` |
| REQ-N-094 | Toolchain versions are pinned: Node by `.nvmrc` + `.node-version`; Rust by `rust-version = "1.90"` (MSRV) in `Cargo.toml`; dependencies by both lockfiles. An exact Rust patch pin is added at release tagging rather than committed (ADR-020). |
| REQ-N-095 | No build step performs network access other than the dependency fetch step |

---

## 10. Usability and support load

| ID | Requirement |
| :--- | :--- |
| REQ-N-100 | Median time to first successful remediation ≤ 90 s for a new user |
| REQ-N-101 | Every error screen offers a next step, not just a code |
| REQ-N-102 | No modal appears for reversible operations that complete in < 2 s |
| REQ-N-103 | Support tickets per 1,000 installs ≤ 8 |
| REQ-N-104 | In-app Trust Center answers "what do you store and where" without documentation |
| REQ-N-105 | The app never nags: at most one non-blocking notice per session, never for upsell |

---

## 11. Budget allocation summary

| Resource | Ceiling | Owner |
| :--- | :--- | :--- |
| Cold start | 1500 ms | FE |
| Full diagnosis | 10 s | Rust |
| Peak RSS | 350 MB | Rust |
| Installer | 18 MB | DevOps |
| Unsafe Rust share | 8% LOC | Security |
| Binary | 9 MB | DevOps |
| Locale bundle | 30 ms | FE |
| Support bundle | 5 MB / 5 s | Support |

Any request to exceed a ceiling requires an ADR and owner approval.
