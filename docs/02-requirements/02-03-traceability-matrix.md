# 02-03 - Requirements Traceability Matrix

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-TRC-001 |
| Version | 2.0.0 |
| Owner | QA / Architecture |
| Purpose | Prove every requirement is designed, built, and tested |
| Rule | A requirement without a test mapping cannot be marked complete (Gate G3) |
| Closes | DEF-010 (v1.0.0 had no traceability from requirement to test) |

---

## 1. Test layer legend

| Code | Layer | Tooling | Owner |
| :--- | :--- | :--- | :--- |
| `T-UNIT` | Pure logic unit tests | `cargo test`, `vitest` | Eng |
| `T-RUST` | Rust integration / FFI behaviour | `cargo test` + Windows runner | Rust |
| `T-FE` | Frontend logic and component tests | `vitest` + Testing Library | FE |
| `T-CONTRACT` | Manifest/schema/enum parity | custom audit binary + vitest | Architecture |
| `T-WIN` | Real Win32 integration | dedicated Windows VM suite | QA |
| `T-SEC` | Security regression | seeded-secret, tamper, fuzz | Security |
| `T-I18N` | Locale parity, plurals, RTL | validator + snapshot | Localization |
| `T-E2E` | End-to-end app flows | Playwright/WebDriver + Tauri driver | QA |
| `T-CLI` | Headless CLI behaviour | `cargo test --lib cli:: headless::` (17) + VM run | QA |
| `T-PERF` | Performance budgets | instrumented harness | Eng |
| `T-A11Y` | Accessibility | axe + manual NVDA script | Design/QA |
| `T-FAULT` | Fault injection | crash-point harness | QA |

---

## 2. Functional requirements → design → test → WP

| REQ | Design reference | Primary test | WP |
| :--- | :--- | :--- | :--- |
| REQ-F-001 | `03-01` §6.2 | T-PERF-01 | WP-6 |
| REQ-F-002 | `03-01` §6.3 | T-E2E-01 | WP-6 |
| REQ-F-003 | `03-05` §5 | T-CONTRACT-01 | WP-1 |
| REQ-F-004 | `03-05` §7 | T-CONTRACT-02 | WP-4 |
| REQ-F-005 | `03-01` §6.5 | T-RUST-12 | WP-4 |
| REQ-F-006 | `03-04` §5.4 | T-E2E-02 | WP-5 |
| REQ-F-007 | `03-03` §5 | T-RUST-05 | WP-3 |
| REQ-F-008 | `04-02` §5 | T-SEC-08 | WP-7 |
| REQ-F-009 | `06-01` §9 | T-FE-03 | WP-2 |
| REQ-F-010 | `03-01` §4 | T-E2E-09 | WP-7 |
| REQ-F-011 | `03-05` §5 | T-WIN-01 | WP-4 |
| REQ-F-012 | `03-05` §5 | T-CONTRACT-03 | WP-1 |
| REQ-F-013 | `03-04` §5.2 | T-SEC-04 | WP-4 |
| REQ-F-014 | `02-02` N-002 | T-PERF-02 | WP-4 |
| REQ-F-015 | `03-05` §5 | T-CONTRACT-04 | WP-1 |
| REQ-F-016 | `03-06` §4 | T-RUST-14 | WP-4 |
| REQ-F-017 | `03-01` §7 | T-UNIT-01 | WP-1 |
| REQ-F-018 | `03-01` §7.3 | T-CONTRACT-05 | WP-1 |
| REQ-F-019 | `03-05` #6 | T-WIN-07 | WP-4 |
| REQ-F-020 | `03-05` §5 | T-CONTRACT-01 | WP-1 |
| REQ-F-021 | `03-03` §5.2 | T-RUST-06 | WP-3 |
| REQ-F-022 | `05-02` §6.3 | T-FE-06 | WP-6 |
| REQ-F-023 | `05-03` §5.3 | T-A11Y-02 | WP-6 |
| REQ-F-024 | `06-01` §5 | T-I18N-04 | WP-2 |
| REQ-F-025 | `03-03` §5.1 | T-FAULT-01 | WP-3 |
| REQ-F-026 | `05-02` §7 | T-E2E-03 | WP-6 |
| REQ-F-027 | `03-05` §5 | T-WIN-08 | WP-4 |
| REQ-F-028 | `03-05` §6 | T-CONTRACT-06 | WP-1 |
| REQ-F-029 | `03-01` §7.2 | T-FE-01 | WP-1 |
| REQ-F-030 | `03-01` §7.2 | T-RUST-03 | WP-3 |
| REQ-F-031 | `03-05` §6 | T-CONTRACT-06 | WP-1 |
| REQ-F-032 | `03-05` §5 | T-E2E-04 | WP-6 |
| REQ-F-033 | `03-04` §6.2 | T-RUST-15 | WP-4 |
| REQ-F-040 | `04-01` §5.2 | T-SEC-01 | WP-3 |
| REQ-F-041 | `03-03` §5.2 | T-RUST-07 | WP-3 |
| REQ-F-042 | `04-01` §5.5 | T-SEC-02 | WP-3 |
| REQ-F-043 | `03-06` §6 | T-RUST-08 | WP-4 |
| REQ-F-044 | `03-03` §5.2 | T-RUST-09 | WP-3 |
| REQ-F-045 | `03-03` §4.3 | T-RUST-05 | WP-3 |
| REQ-F-046 | `05-02` §9 | T-FE-07 | WP-6 |
| REQ-F-047 | `03-03` §6 | T-RUST-16 | WP-3 |
| REQ-F-048 | `03-03` §5.4 | T-FAULT-02 | WP-3 |
| REQ-F-050 | `03-06` §4 | T-RUST-10 | WP-4 |
| REQ-F-051 | `03-06` §4.2 | T-RUST-11 | WP-4 |
| REQ-F-052 | `03-06` §4.3 | T-RUST-11 | WP-4 |
| REQ-F-053 | `03-05` §5 | T-RUST-10 | WP-4 |
| REQ-F-054 | `03-06` §4.4 | T-RUST-01 | WP-4 |
| REQ-F-055 | `03-01` §6.4 | T-FE-05 | WP-5 |
| REQ-F-060 | `03-06` §3 | T-WIN-01 | WP-4 |
| REQ-F-061 | `03-05` #19 | T-WIN-01 | WP-4 |
| REQ-F-062 | `04-01` §5.4 | T-RUST-04 | WP-4 |
| REQ-F-063 | `04-02` §4 | T-SEC-05 | WP-4 |
| REQ-F-064 | `03-06` §3.3 | T-WIN-02 | WP-4 |
| REQ-F-065 | `05-02` §7.3 | T-WIN-03 | WP-4 |
| REQ-F-066 | `03-06` §3.4 | T-RUST-13 | WP-4 |
| REQ-F-067 | `03-04` §7 | T-RUST-13 | WP-4 |
| REQ-F-070 | `03-05` #11/#12 | T-E2E-05 | WP-6 |
| REQ-F-071 | `05-02` §7.4 | T-FE-08 | WP-6 |
| REQ-F-072 | `03-05` #22 | T-WIN-09 | WP-4 |
| REQ-F-073 | `05-02` §8.2 | T-E2E-07 | WP-6 |
| REQ-F-074 | `03-06` §7 | T-WIN-10 | WP-4 |
| REQ-F-075 | `03-05` #15 | T-WIN-04 | WP-4 |
| REQ-F-076 | `03-06` §5 | T-WIN-11 | WP-4 |
| REQ-F-077 | `03-05` #14 | T-WIN-05 | WP-4 |
| REQ-F-078 | `03-05` #16 | T-WIN-06 | WP-4 |
| REQ-F-079 | `04-01` §5.4 | T-SEC-07 | WP-4 |
| REQ-F-080 | `03-05` §8 | T-FE-02 | WP-7 |
| REQ-F-081 | `03-01` §7.2 | T-FE-01 | WP-7 |
| REQ-F-082 | `03-05` §8.3 | T-FE-02 | WP-7 |
| REQ-F-083 | `03-05` §8.2 | T-CONTRACT-07 | WP-7 |
| REQ-F-084 | `03-05` §8.2 | T-FE-02 | WP-7 |
| REQ-F-085 | `03-04` §8 | T-CLI-01 | WP-9 |
| REQ-F-086 | `03-04` §8.2 | T-CLI-02 | WP-9 |
| REQ-F-087 | `03-04` §8.3 | T-CLI-03 | WP-9 |
| REQ-F-088 | `07-02` §5 | T-SEC-06 | WP-9 |
| REQ-F-089 | `03-05` #10 | T-WIN-12 | WP-4 |
| REQ-F-090 | `07-02` §4 | T-FE-15 (`export.test.ts`) | WP-9 |
| REQ-F-091 | `03-04` §7 | T-CONTRACT-08 | WP-4 |
| REQ-F-092 | `03-03` §5.4 | T-FAULT-02 | WP-3 |
| REQ-F-093 | `03-03` §2 | T-RUST-17 | WP-3 |
| REQ-F-094 | `03-03` §4.4 | T-RUST-18 | WP-3 |
| REQ-F-095 | `03-03` §3 | T-RUST-19 | WP-3 |
| REQ-F-096 | `03-03` §6 | T-RUST-16 | WP-3 |
| REQ-F-097 | `04-02` §6 | T-E2E-08 | WP-6 |
| REQ-F-098 | `04-02` §3 | T-SEC-09 | WP-7 |
| REQ-F-100 | `05-02` §4 | T-FE-09 | WP-6 |
| REQ-F-101 | `05-02` §5.2 | T-FE-10 | WP-6 |
| REQ-F-102 | `05-02` §5.3 | T-A11Y-03 | WP-6 |
| REQ-F-103 | `05-02` §4.3 | T-FE-09 | WP-6 |
| REQ-F-104 | `05-02` §4.4 | T-FE-11 | WP-6 |
| REQ-F-105 | `05-03` §6 | T-A11Y-05 | WP-6 |
| REQ-F-106 | `05-01` §3 | T-FE-12 | WP-6 |
| REQ-F-107 | `05-02` §3.2 | T-FE-04 | WP-5 |
| REQ-F-108 | `05-02` §10 | T-FE-13 | WP-6 |
| REQ-F-109 | `05-03` §5.4 | T-A11Y-04 | WP-6 |
| REQ-F-110 | `03-01` §8 | T-FE-04 | WP-5 |
| REQ-F-111 | `03-04` §5.4 | T-E2E-06 | WP-5 |
| REQ-F-112 | `04-01` §5.3 | T-SEC-03 | WP-4 |
| REQ-F-113 | `05-02` §8.3 | T-E2E-06 | WP-6 |
| REQ-F-114 | `03-04` §5.4 | T-E2E-06 | WP-5 |
| REQ-F-120 | `06-01` §6 | T-I18N-01 | WP-2 |
| REQ-F-121 | `06-01` §4 | T-I18N-02 | WP-2 |
| REQ-F-122 | `06-01` §5.3 | T-I18N-03 | WP-2 |
| REQ-F-123 | `05-03` §7 | T-I18N-05 | WP-6 |
| REQ-F-124 | `06-01` §5 | T-I18N-04 | WP-2 |
| REQ-F-125 | `06-01` §5.1 | T-FE-14 | WP-2 |
| REQ-F-126 | `06-01` §8 | T-I18N-06 | WP-2 |
| REQ-F-130 | `04-02` §5 | T-SEC-08 | WP-7 |
| REQ-F-131 | `01-01` §10 | T-E2E-09 | WP-7 |
| REQ-F-132 | `04-02` §3 | T-SEC-09 | WP-7 |
| REQ-F-133 | `05-02` §10 | T-FE-13 | WP-6 |
| REQ-F-134 | `04-02` §6 | T-E2E-08 (`08-02` §8.1 for the measured `/S` half) + `uninstall_hook_targets_the_real_data_roots` for the offer | WP-8 - both halves: "leaves no files outside documented paths" measured; "uninstall offers to delete all data" wired via `installer/hooks.nsh` (DEF-064 closed) |
| REQ-F-135 | `08-02` §7 | T-CONTRACT-10 | WP-8 |
| REQ-F-140 | `07-01` §6 | T-FAULT-01 | WP-7 |
| REQ-F-141 | `03-03` §5.1 | T-FAULT-01 | WP-3 |
| REQ-F-142 | `03-03` §5.5 | T-RUST-20 | WP-3 |
| REQ-F-143 | `03-04` §7 | T-CONTRACT-08 | WP-4 |
| REQ-F-144 | `07-02` §3 | T-RUST-21 | WP-9 |

---

## 3. Non-functional → verification

One row per requirement. A range such as `N-011..020` is not a trace: it names a bucket, and a
requirement inside a bucket can be silently dropped when the bucket is edited. Each row is checked by
`scripts/check-docs.mjs`, which fails when a `REQ-N` defined in `02-02` has no row here and when a row
cites a `REQ-N` that `02-02` does not define.

| REQ-N | Requirement | Acceptance | Test / evidence | WP |
| :--- | :--- | :--- | :--- | :--- |
| REQ-N-001 | Cold start to interactive | p95 ≤ 1500 ms | T-PERF-01..05 | WP-7 |
| REQ-N-002 | Single diagnostic probe | p95 ≤ 2000 ms | T-PERF-01..05 | WP-7 |
| REQ-N-003 | Full 22-probe diagnosis | p95 ≤ 10 s (parallel where safe) | T-PERF-01..05 | WP-7 |
| REQ-N-004 | UI frame budget during streaming logs | ≥ 55 fps; no long task > 200 ms | T-PERF-01..05 | WP-7 |
| REQ-N-005 | Heap ceiling | ≤ 180 MB steady, ≤ 350 MB peak during archiving | T-PERF-01..05 | WP-7 |
| REQ-N-006 | Idle CPU | ≤ 1% average over 60 s idle | T-PERF-01..05 | WP-7 |
| REQ-N-007 | Installer footprint | ≤ 18 MB compressed | T-PERF-01..05 | WP-7 |
| REQ-N-008 | Warm DB read for snapshot list | ≤ 40 ms at 200 rows | T-PERF-01..05 | WP-7 |
| REQ-N-009 | Snapshot write of 10 MB archive metadata | ≤ 60 ms excluding file I/O | T-PERF-01..05 | WP-7 |
| REQ-N-010 | Binary size (release, stripped, LTO) | ≤ 9 MB | T-PERF-01..05 | WP-7 |
| REQ-N-011 | Crash-free session rate ≥ 99.5% over a 30-day beta cohort | - | T-FAULT / soak | WP-7 |
| REQ-N-012 | Every long operation is cancellable within 500 ms (see REQ-F-052) | - | T-FAULT / soak | WP-7 |
| REQ-N-013 | Zero data-loss defects at P1 in beta; a lost user file is a release blocker | - | T-FAULT / soak | WP-7 |
| REQ-N-014 | Fault injection at all 12 documented crash points leaves a consistent state (`07-01` §6) | - | T-FAULT / soak | WP-7 |
| REQ-N-015 | Startup is safe after an unclean shutdown: recovery runs before UI is interactive | - | T-FAULT / soak | WP-7 |
| REQ-N-016 | No unbounded growth: snapshot store, audit log, and log file all have enforced caps | - | T-FAULT / soak | WP-7 |
| REQ-N-017 | Memory is not retained per action: 100 consecutive action runs keep RSS within +10% of baseline | - | T-FAULT / soak | WP-7 |
| REQ-N-018 | The app tolerates a missing/corrupt config by regenerating defaults and logging it | - | T-FAULT / soak | WP-7 |
| REQ-N-019 | The app tolerates a corrupt store by quarantining and running read-only, never deleting | - | T-FAULT / soak | WP-7 |
| REQ-N-020 | Single-instance semantics are machine-wide; a second launch focuses the first | - | T-FAULT / soak | WP-7 |
| REQ-N-021 | HMAC key MUST NOT be derivable from data readable by a standard user (`04-01` §5.2) | - | T-SEC-01..03, 07 | WP-4 |
| REQ-N-022 | Store directory ACL MUST grant write only to Administrators + SYSTEM | - | T-SEC-01..03, 07 | WP-4 |
| REQ-N-023 | Rollback targets MUST be validated against a per-action allowlist | - | T-SEC-01..03, 07 | WP-4 |
| REQ-N-024 | Elevation handover MUST be authenticated with a nonce and caller identity check | - | T-SEC-01..03, 07 | WP-4 |
| REQ-N-025 | No shell string constructed from user input may reach process spawn; args are passed as a vector | - | T-SEC-01..03, 07 | WP-4 |
| REQ-N-026 | Command lines stored or displayed MUST be redacted for secrets (REQ-F-063) | - | T-SEC-05, 08, sign verify | WP-8 |
| REQ-N-027 | All dependencies pass `cargo-deny` (advisories, licences, sources, bans) and `npm audit --production` | - | T-SEC-05, 08, sign verify | WP-8 |
| REQ-N-028 | Release binaries MUST be Authenticode-signed with a timestamp; unsigned builds MUST fail packaging | - | T-SEC-05, 08, sign verify | WP-8 |
| REQ-N-029 | Update manifests MUST be signed and verified before applying; downgrade MUST be refused | - | T-SEC-05, 08, sign verify | WP-8 |
| REQ-N-030 | CSP MUST forbid inline script and remote origins; violations logged in dev | - | T-SEC-05, 08, sign verify | WP-8 |
| REQ-N-031 | No `unwrap()`/`expect()` on paths reachable from user input or OS failure in release code | - | clippy + geiger + T-SEC-06 | WP-4 |
| REQ-N-032 | Unsafe blocks MUST be ≤ 8% of Rust LOC, each with a safety comment and a named invariant | - | clippy + geiger + T-SEC-06 | WP-4 |
| REQ-N-033 | Secrets MUST never be written to logs; a seeded-secret test enforces it | - | clippy + geiger + T-SEC-06 | WP-4 |
| REQ-N-034 | The support bundle MUST be produced without elevation and MUST exclude secrets | - | clippy + geiger + T-SEC-06 | WP-4 |
| REQ-N-040 | All text meets 4.5:1; large text and UI components meet 3:1 (measured, see `05-03`) | - | T-A11Y-01..05 | WP-6 |
| REQ-N-041 | Destructive confirmation defaults focus to the safe choice; Enter never triggers destruction | - | T-A11Y-01..05 | WP-6 |
| REQ-N-042 | Full keyboard operability with visible focus (≥ 3:1 against adjacent colours) | - | T-A11Y-01..05 | WP-6 |
| REQ-N-043 | Modals trap focus and restore it on close | - | T-A11Y-01..05 | WP-6 |
| REQ-N-044 | Live regions announce progress and completion at a polite cadence (≤ 1 announcement / 2 s) | - | T-A11Y-01..05 | WP-6 |
| REQ-N-045 | `prefers-reduced-motion` removes non-essential animation | - | T-A11Y-01..05 | WP-6 |
| REQ-N-046 | Colour is never the sole channel for status; icon + text + colour | - | T-A11Y-01..05 | WP-6 |
| REQ-N-047 | Target size ≥ 24×24 CSS px (2.2 AA), 32×32 preferred for primary controls | - | T-A11Y-01..05 | WP-6 |
| REQ-N-048 | Zoom to 200% without loss of content or function | - | T-A11Y-01..05 | WP-6 |
| REQ-N-049 | Screen-reader pass on NVDA (Windows): all 6 screens and 5 overlays reachable and named | - | T-A11Y-01..05 | WP-6 |
| REQ-N-050 | Every shipped locale has structural parity with `en`, enforced by `check-locales.mjs` | - | T-I18N-01..06 | WP-2 |
| REQ-N-051 | Zero hard-coded user-visible strings | - | T-I18N-01..06 | WP-2 |
| REQ-N-052 | ICU plural coverage for every count-bearing string | - | T-I18N-01..06 | WP-2 |
| REQ-N-053 | RTL support for `ar`, `he`, `fa`, `ur` via logical properties only | - | T-I18N-01..06 | WP-2 |
| REQ-N-054 | String budget: no primary-path label > 34 characters in English (layout safety) | - | T-I18N-01..06 | WP-2 |
| REQ-N-055 | Locale bundle load ≤ 30 ms per locale, lazy | - | T-I18N-01..06 | WP-2 |
| REQ-N-056 | Fallback chain locale → language → English, with dev-time reporting of misses | - | T-I18N-01..06 | WP-2 |
| REQ-N-060 | Line coverage ≥ 80% Rust, ≥ 75% TS on logic modules (UI rendering excluded from the gate) | - | CI quality gate | every WP |
| REQ-N-061 | No function > 60 lines in Rust without an exemption comment and reviewer approval | - | CI quality gate | every WP |
| REQ-N-062 | `cargo clippy -- -D warnings` and `tsc --noEmit` clean at all times | - | CI quality gate | every WP |
| REQ-N-063 | Cyclomatic complexity ≤ 15 per function (measured by `cargo-geiger`-adjacent tooling / eslint) | - | CI quality gate | every WP |
| REQ-N-064 | Public API of every module documented with a doc comment | - | CI quality gate | every WP |
| REQ-N-065 | Every module has one responsibility, stated at the top of the file | - | CI quality gate | every WP |
| REQ-N-066 | Golden-file tests for all generated artifacts (scripts, manifests, i18n skeleton) | - | CI quality gate | every WP |
| REQ-N-067 | Build warnings: zero in release profile | - | CI quality gate | every WP |
| REQ-N-070 | Windows 11 23H2 (22631), 24H2 (26100), 25H2 (26200), 26H2 (26300+) - full support | PASS declared target; T-WIN VM suite open (DEF-047) | VM matrix | WP-8 |
| REQ-N-071 | Windows 10 22H2 (19045) - supported with ESU lifecycle banner | WARN declared, **unverified**; no 22H2 VM run (DEF-047) | VM matrix | WP-8 |
| REQ-N-072 | x64 and ARM64 builds; ARM64 emulation not required | FAIL **x64 only**; ARM64 not built (DEF-058) | VM matrix | WP-8 |
| REQ-N-073 | WebView2 Runtime ≥ 120 assumed; bootstrapper + offline installer bundled | PASS NSIS bootstrapper; pinned in `resources/manifest.json` | VM matrix | WP-8 |
| REQ-N-074 | Display 960×680 minimum, 3840×2160 maximum tested, 100-200% scaling | WARN min window enforced; zoom capture open (DEF-044) | VM matrix | WP-8 |
| REQ-N-075 | High-contrast OS theme respected without breaking the token system | PASS tokens derive from OS theme (`05-01`) | VM matrix | WP-8 |
| REQ-N-076 | No dependency on PowerShell 7; Windows PowerShell 5.1 is the floor for exported scripts | PASS scripts target 5.1 | VM matrix | WP-8 |
| REQ-N-077 | Exported `.bat` must run on cmd.exe 10.0.19045+ | PASS no PS7-only syntax | VM matrix | WP-8 |
| REQ-N-080 | Every run produces a correlation id usable in support | - | T-CLI + support tests | WP-9 |
| REQ-N-081 | Log rotation: 5 MB × 3 files, then oldest dropped | - | T-CLI + support tests | WP-9 |
| REQ-N-082 | Support bundle generation ≤ 5 s and ≤ 5 MB | - | T-CLI + support tests | WP-9 |
| REQ-N-083 | CLI exit codes are stable and documented (`03-04` §8) | - | T-CLI + support tests | WP-9 |
| REQ-N-084 | Crash reports, if enabled, contain no file paths of user documents | - | T-CLI + support tests | WP-9 |
| REQ-N-085 | Telemetry payload must be documented and versioned; unknown fields are rejected server-side | - | T-CLI + support tests | WP-9 |
| REQ-N-086 | Release rollback: a bad version can be superseded within one release cycle (updater channel) | - | T-CLI + support tests | WP-9 |
| REQ-N-090 | `npm ci` + `cargo build --locked` reproduces the same dependency graph hash | - | reproducibility job | WP-8 |
| REQ-N-091 | Build is reproducible modulo timestamps: same inputs → identical binary hash on the same toolchain (verified for two consecutive CI runs) | - | reproducibility job | WP-8 |
| REQ-N-092 | Generated files (enum, types, i18n skeleton) are committed and CI fails on drift | - | reproducibility job | WP-8 |
| REQ-N-093 | All downloaded third-party assets are hash-pinned in `resources/manifest.json` | - | reproducibility job | WP-8 |
| REQ-N-094 | Toolchain versions are pinned: Node by `.nvmrc` + `.node-version`; Rust by `rust-version = "1.90"` (MSRV) in `Cargo.toml`; dependencies by both lockfiles. An exact Rust patch pin is added at release tagging rather than committed (ADR-020). | - | reproducibility job | WP-8 |
| REQ-N-095 | No build step performs network access other than the dependency fetch step | - | reproducibility job | WP-8 |
| REQ-N-100 | Median time to first successful remediation ≤ 90 s for a new user | - | U-1 study + metrics | post-GA |
| REQ-N-101 | Every error screen offers a next step, not just a code | - | U-1 study + metrics | post-GA |
| REQ-N-102 | No modal appears for reversible operations that complete in < 2 s | - | U-1 study + metrics | post-GA |
| REQ-N-103 | Support tickets per 1,000 installs ≤ 8 | - | U-1 study + metrics | post-GA |
| REQ-N-104 | In-app Trust Center answers "what do you store and where" without documentation | - | U-1 study + metrics | post-GA |
| REQ-N-105 | The app never nags: at most one non-blocking notice per session, never for upsell | - | U-1 study + metrics | post-GA |


## 4. Stories → requirements

| Story | Requirements |
| :--- | :--- |
| US-01 | F-001, F-002, F-011..019, F-100 |
| US-02 | F-028..032, F-103, F-104 |
| US-03 | F-020..023, F-103 |
| US-04 | F-040..048, F-046 |
| US-05 | F-050..055, F-016, F-104 |
| US-06 | F-060..067 |
| US-07 | F-070..072 |
| US-08 | F-080..084 |
| US-09 | F-045, F-090, F-046 |
| US-10 | F-062, F-079, F-081..084 |
| US-11 | F-006, F-111..114 |
| US-12 | F-120..126 |
| US-13 | F-088, F-091 |
| US-14 | F-085..087 |
| US-15 | `09-01` §4 |

---

## 5. Coverage assertion (Gate G3)

| Check | Rule | Current |
| :--- | :--- | :--- |
| Every functional REQ has ≥1 test id | 118/118 | PASS 118 |
| Every non-functional REQ has ≥1 verification row | 86/86 | PASS 86 |
| Every matrix row cites a defined requirement | 204/204 | PASS 204 |
| Every test id referenced exists in `07-01` §5 | 100% | PASS |
| Every REQ has a design section | 100% | PASS |
| Every action has all contracts | 22/22 | PASS `03-05` |
| Every command has schema + errors | 15/15 | PASS `03-04` §5 |

Unmapped requirements: **0**.

These five counts are asserted, not asserted-by-hand: `scripts/check-docs.mjs` parses
`02-01`, `02-02` and this file and fails when a requirement has no row, when a row cites an
undefined `REQ`, or when a row's test column is empty. The matrix is therefore a gate output,
not a table someone remembered to update.
