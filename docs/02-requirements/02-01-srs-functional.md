# 02-01 - Software Requirements Specification: Functional

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-SRS-F-001 |
| Version | 2.0.0 |
| Status | Baseline |
| Scope | Zenith 1.0.0 functional behaviour |
| Owner | Architecture |
| Rules | Each requirement is atomic, testable, and owned. Numbering is append-only. |
| Closes | No single defect - atomic requirements are the reference `02-03` maps to tests (DEF-010) |

---

## 1. How to read this document

Each requirement has:

- **ID** - stable forever.
- **Statement** - observable behaviour using RFC 2119 keywords.
- **Acceptance** - the exact condition QA verifies.
- **Trace** - where it lives in design and which test layer covers it.

`MUST` = release blocker. `SHOULD` = defect if missing without a recorded waiver.

Sections: §2 global rules · §3 diagnostics · §4 execution · §5 rollback · §6 long-running
processes · §7 process control · §8 remediation chains · §9 export & headless · §10 persistence
& audit · §11 shell & navigation · §12 elevation · §13 i18n · §14 trust & data · §15 failure
behaviour.

---

## 2. Global behaviour

| ID | Statement | Acceptance | Trace |
| :--- | :--- | :--- | :--- |
| REQ-F-001 | The app MUST start with a usable window in ≤ 1.5 s on a cold launch (measured to first interactive paint) on reference hardware. | Timed cold start ×5, p95 ≤ 1500 ms | NFR-001, T-PERF-01 |
| REQ-F-002 | The app MUST run all diagnostics on first launch without user interaction, read-only. | Fresh profile → all 22 probes run, zero writes | §3, T-E2E-01 |
| REQ-F-003 | The app MUST expose exactly the 22 actions in `03-05` §5, no more, no fewer. | Manifest hash equals binary enum hash | `03-05`, T-CONTRACT-01 |
| REQ-F-004 | Any action not implemented in a build MUST surface as disabled with a reason string, never as a silent no-op. | Feature-flagged build shows disabled + reason | Law L1, T-CONTRACT-02 |
| REQ-F-005 | Concurrent execution MUST be rejected with `ActionAlreadyRunning`, machine-wide, not merely per window. | Two windows → second gets error | §4, T-RUST-12 |
| REQ-F-006 | The UI MUST reflect the true elevation state; a standard-user session MUST NOT show admin actions as ready. | Standard token → admin cards show lock | §12 |
| REQ-F-007 | Every mutation MUST be preceded by a snapshot record or an explicit `snapshot_not_applicable` declaration with justification. | DB grows by exactly one row per mutating action | §10, T-RUST-05 |
| REQ-F-008 | The app MUST never transmit data off-device except the opt-in telemetry of `09-01`, which is disabled by default. | Packet capture during full run: zero egress | `04-02`, T-SEC-08 |
| REQ-F-009 | All user-visible text MUST come from the i18n dictionary; no inline literals in components. | Lint: zero bare strings in JSX | `06-01`, T-FE-03 |
| REQ-F-010 | The app MUST function with no network connection. | Airplane mode full run passes | T-E2E-09 |

---

## 3. Diagnostics

| ID | Statement | Acceptance | Trace |
| :--- | :--- | :--- | :--- |
| REQ-F-011 | Each action MUST implement a probe that returns `DiagnosticReport` with real measurements, not constants. | Probe on two differently-loaded machines returns different values | `03-05` §5 |
| REQ-F-012 | `needs_attention` MUST be derived from the probe's own threshold, documented per action. | Threshold table matches implementation | `03-05` §5 |
| REQ-F-013 | Diagnostic probes MUST be side-effect free: no file writes, no registry writes, no service control. | File/registry diff after diagnoses: empty | T-SEC-04 |
| REQ-F-014 | Each probe MUST complete in ≤ 2 s, or run in a labelled "slow probe" group that streams progress. | p95 per probe ≤ 2000 ms | NFR-002 |
| REQ-F-015 | `DiagnosticReport.reclaimable_bytes` MUST be 0 for actions that reclaim nothing, never a fake estimate. | Contract test over all 22 | `03-05` |
| REQ-F-016 | Diagnostics MUST be cancellable and MUST leave no partial state. | Cancel mid-scan → all probes report `Cancelled` | §6 |
| REQ-F-017 | The health index MUST be computed by the published formula and displayed with its inputs. | Formula output equals displayed score; inputs visible in detail | `03-01` §7 |
| REQ-F-018 | `severity_weight` MUST either affect the score or be removed; dead fields are forbidden. | Field is consumed in scoring | Law L3 |
| REQ-F-019 | Diagnostic latency (`latency_ms`) MUST be measured, not estimated, and MUST include the probe name it measures. | DNS probe reports measured ms | `03-05` #6 |

---

## 4. Execution

| ID | Statement | Acceptance | Trace |
| :--- | :--- | :--- | :--- |
| REQ-F-020 | Every action MUST declare one of four `ReversibilityTier` values, and the declaration MUST match `03-05` §5 exactly. | Contract test compares table to enum output | `03-05` |
| REQ-F-021 | `FullyReversible` actions MUST capture a pre-state sufficient to restore exactly, verified by a round-trip test. | Restore → state hash equals pre-state | T-RUST-06 |
| REQ-F-022 | `PartiallyReversible` actions MUST enumerate what will NOT be restored, in user language, before execution. | Modal lists non-restored items | `05-02` §6.3 |
| REQ-F-023 | `Irreversible` actions MUST present a confirmation that names the object and count, and MUST NOT focus the destructive button. | Focus lands on Cancel; test asserts | REQ-N-041 |
| REQ-F-024 | Execution MUST return `ExecutionOutcome` including before/after summaries as *message keys with parameters*, not free English. | Outcome contains `summary_key` + params | `06-01` §5 |
| REQ-F-025 | Every mutating action MUST be atomic with respect to its own snapshot: a crash between snapshot commit and mutation MUST leave the system untouched. | Kill process at each phase boundary; state unchanged | `03-03` §5 |
| REQ-F-026 | A failed action MUST report which sub-steps succeeded and which failed. | Partial failure returns step list | `05-02` §7 |
| REQ-F-027 | Actions MUST be idempotent where physically possible; re-running a completed action MUST not error. | Run twice → second reports "already clean" | `03-05` |
| REQ-F-028 | The safe preset MUST contain only actions with `risk = safe`, `safe_batch = true`, tier ≠ irreversible. | Manifest validation fails otherwise | `03-05` §6 |
| REQ-F-029 | The safe preset MUST run steps in dependency order from the DAG. | Order asserted against topological sort | T-FE-01 |
| REQ-F-030 | A dependency failure MUST skip dependents with `SkippedDependency`, never run them blindly. | Simulated DISM failure → SFC skipped | T-RUST-03 |
| REQ-F-031 | Destructive actions MUST be excluded from batch execution entirely, not merely warned. | Batch with reboot → rejected at validation | `03-05` §6 |
| REQ-F-032 | Before/after summaries MUST reflect measured values, e.g. bytes actually freed. | Freed bytes equal disk delta within 1% | T-E2E-04 |
| REQ-F-033 | Every execution MUST emit structured log lines to the terminal stream with level and action id. | ≥ 1 line per step, schema-validated | `03-04` §6.2 |

---

## 5. Snapshot and rollback

| ID | Statement | Acceptance | Trace |
| :--- | :--- | :--- | :--- |
| REQ-F-040 | Snapshots MUST be stored with an HMAC-SHA256 tag over `(snapshot_id, action_id, payload)` using a key not readable by a standard user. | Standard user cannot compute a valid tag | `04-01` §5.2 |
| REQ-F-041 | Rollback MUST verify the tag before applying anything and MUST refuse on mismatch. | Tampered payload → `SnapshotIntegrityError`, no writes | T-RUST-07 |
| REQ-F-042 | Rollback MUST validate every target path against an allowlist rooted at the action's declared scope; violations MUST abort the whole rollback. | Crafted payload with `..\Windows` → abort | T-SEC-02 |
| REQ-F-043 | Archive-based rollback MUST verify the archive SHA-256 before extraction and MUST reject entries escaping the destination. | Zip-slip entry → `ZipTraversalBlocked` | T-RUST-08 |
| REQ-F-044 | Rollback MUST be idempotent and MUST mark the snapshot restored; a second attempt MUST report `AlreadyRestored` rather than re-apply. | Second rollback → info, no writes | T-RUST-09 |
| REQ-F-045 | Rollback MUST record an audit entry with outcome and duration. | Audit row exists with `action=rollback` | §10 |
| REQ-F-046 | Snapshot History MUST show tier, created time, restored state, size on disk, and a plain-language summary. | UI fields present for each row | `05-02` §9 |
| REQ-F-047 | Snapshot retention MUST be bounded by count and bytes with documented defaults, and prune MUST never delete an unrestored snapshot without user consent. | 200 snapshots / 2 GB defaults honoured | `03-03` §6 |
| REQ-F-048 | Orphaned archive files MUST be garbage-collected on startup with a logged reason. | Delete DB row, restart → archive removed | `03-03` §5.4 |

---

## 6. Long-running processes

| ID | Statement | Acceptance | Trace |
| :--- | :--- | :--- | :--- |
| REQ-F-050 | Child processes MUST be spawned in a job object so cancellation terminates the whole tree. | Cancel `dism` → no orphan child remains | T-RUST-10 |
| REQ-F-051 | stdout and stderr MUST both be drained concurrently to avoid pipe deadlock. | 10 MB stderr run completes | T-RUST-11 |
| REQ-F-052 | Cancellation MUST take effect within 500 ms even when the child emits no output. | Cancel during silent phase ≤ 500 ms | T-RUST-11 |
| REQ-F-053 | Every action MUST enforce a per-action timeout from `03-05`, and a timeout MUST kill the tree and return `OperationTimedOut`. | Timeout test with sleep child | T-RUST-10 |
| REQ-F-054 | Output decoding MUST handle UTF-16LE and UTF-8 correctly across arbitrary chunk boundaries, including odd byte splits. | Fuzz 1-byte chunks → identical text | T-RUST-01 |
| REQ-F-055 | Streamed lines MUST be non-blocking for the UI: the command returns immediately and events arrive asynchronously. | UI stays interactive during `sfc` | T-FE-05 |

---

## 7. Process control (ports, hung apps)

| ID | Statement | Acceptance | Trace |
| :--- | :--- | :--- | :--- |
| REQ-F-060 | Port scanning MUST cover TCP listeners in a configurable range (default 3000-9999) using a real OS table query. | Ports match `netstat -ano` for the range | T-WIN-01 |
| REQ-F-061 | Each listener row MUST include PID, process name, start time, memory, and a redacted command line. | Fields populated | `03-05` #19 |
| REQ-F-062 | Termination MUST require `(pid, expected_name, expected_start_time)` to match at kill time, or be refused. | Recycled PID → `PidVerificationFailed` | T-RUST-04 |
| REQ-F-063 | Command-line redaction MUST remove secrets in all common forms: `--flag value`, `--flag=value`, tokens, passwords, connection strings. | Seeded secrets never appear in UI/audit | T-SEC-05 |
| REQ-F-064 | Hung-window detection MUST use the OS responsiveness signal, not heuristics like CPU time. | Hung test app detected; healthy app not | T-WIN-02 |
| REQ-F-065 | Only explicitly selected hung windows MAY be closed; the action MUST never enumerate-then-kill. | Unselected hung window survives | T-WIN-03 |
| REQ-F-066 | Killing a process MUST report per-target outcome; one failure MUST NOT abort the remaining targets. | 1 protected + 2 normal → 2 killed, 1 reported | T-RUST-13 |
| REQ-F-067 | Insufficient privilege MUST be reported as such, not as a generic failure. | Non-elevated protected kill → `AccessDenied` | `03-04` §7 |

---

## 8. Remediation chains and OS integration

| ID | Statement | Acceptance | Trace |
| :--- | :--- | :--- | :--- |
| REQ-F-070 | The Windows repair chain MUST enforce DISM-restore-health before SFC. | Attempting SFC first prompts the chain | `03-05` #11, #12 |
| REQ-F-071 | WSL/Docker reclaim MUST warn that running containers will stop, with the count of detected distros if available. | Warning names consequence | `05-02` §7.4 |
| REQ-F-072 | Memory reclaimed MUST be reported as a measured delta, and MUST be reported as "unknown" if measurement fails. | Delta present or explicitly unknown | `03-05` #22 |
| REQ-F-073 | Reboot scheduling MUST be abortable for the entire countdown window and MUST show a live countdown with the abort control focused. | Abort at 3 s → no reboot | `03-05` #18 |
| REQ-F-074 | Winsock/TCP reset MUST create a restore point and export the relevant hives before changing anything, or refuse to proceed. | Missing checkpoint → abort with reason | `03-05` #7 |
| REQ-F-075 | Service restarts MUST restore the prior start type and running state on rollback. | Stop a running service, roll back → running | T-WIN-04 |
| REQ-F-076 | GPU driver reset MUST use the OS-native reset chord, and MUST confirm the chord was delivered. | Delivery count equals expected | `03-06` §5 |
| REQ-F-077 | Icon-cache rebuild MUST verifiably pause the shell before deleting locked cache files and MUST restore the shell afterwards, even on failure. | Failure path leaves explorer running | T-WIN-05 |
| REQ-F-078 | Print spooler reset MUST archive job files before deleting them and MUST restart the service on both success and failure paths. | Failure path: service running | T-WIN-06 |
| REQ-F-079 | Actions requiring admin MUST be refused client-side *and* server-side; the backend MUST re-check elevation. | Forged request from standard token → `ElevationRequired` | `04-01` §5.4 |

---

## 9. Export, headless, and support

| ID | Statement | Acceptance | Trace |
| :--- | :--- | :--- | :--- |
| REQ-F-080 | Any selection MUST export as a readable `.ps1` and a `.bat` that a human can audit line by line. | Golden-file comparison per action | T-FE-02 |
| REQ-F-081 | Exported scripts MUST be ordered by the same DAG as in-app execution. | Order equals topological sort | T-FE-01 |
| REQ-F-082 | Exported scripts MUST NOT contain the app's snapshot mechanism; they MUST state that no snapshot exists and warn accordingly. | Header contains the warning | T-FE-02 |
| REQ-F-083 | Export MUST include only actions with a verified snippet; a missing snippet MUST fail export, never emit an empty step. | Missing snippet → export error | Law L2 |
| REQ-F-084 | Batch export MUST refuse destructive actions with a clear reason. | Reboot in selection → export blocked | REQ-F-031 |
| REQ-F-085 | The CLI MUST run a selected set headlessly with `--headless --actions` and return documented exit codes. | Exit codes 0/2/3/4 per `03-04` §8 | T-CLI-01 |
| REQ-F-086 | The CLI MUST support `--dry-run` that reports what would change without changing it. | Dry run → zero mutations | T-CLI-02 |
| REQ-F-087 | The CLI MUST support machine-readable JSON output. | `--json` parses as schema | T-CLI-03 |
| REQ-F-088 | A support bundle MUST be producible in one action and MUST contain logs, versions, config hash, and snapshot metadata - never secrets or file contents. | Seeded secret absent from bundle | T-SEC-06 |
| REQ-F-089 | Copy-diagnostic-summary MUST produce structured text with hostname, build, uptime, RAM, adapters, and open issues. | All fields present | `03-05` #10 |
| REQ-F-090 | Audit export MUST be available as CSV and JSON with a stable schema version. | Schema version field present | `07-02` §4 |
| REQ-F-091 | Every user-visible error MUST include a stable error code and a remedy sentence. | Error catalogue covers all variants | `03-04` §7 |
| REQ-F-092 | Startup recovery MUST clean incomplete transactions and report what it cleaned in the log. | Forced crash → next start logs recovery | `03-03` §5.4 |

---

## 10. Persistence and audit

| ID | Statement | Acceptance | Trace |
| :--- | :--- | :--- | :--- |
| REQ-F-093 | State MUST be stored machine-wide so elevation does not change the data the user sees. | Standard run + elevated run share rows | `03-03` §2 |
| REQ-F-094 | The store MUST be crash-safe: WAL, integrity check on open, and a documented behaviour on corruption (refuse + quarantine + report, never silently delete). | Corrupt DB → quarantine file, app runs read-only | `03-03` §4 |
| REQ-F-095 | Schema MUST be versioned with forward-only migrations applied transactionally. | v1 DB migrates to v2 in one transaction | `03-03` §3 |
| REQ-F-096 | Audit log MUST be append-only from the app's perspective and bounded with documented pruning. | Prune keeps newest N, order preserved | `03-03` §6 |
| REQ-F-097 | Stored data MUST be removable by the user in one action, with a preview of what will be deleted. | "Delete all Zenith data" empties store | `04-02` §6 |
| REQ-F-098 | The app MUST NOT store command lines, environment variables, or file contents beyond the documented classes. | Schema review + grep for prohibited columns | `04-02` §3 |

---

## 11. Shell, navigation, interface

| ID | Statement | Acceptance | Trace |
| :--- | :--- | :--- | :--- |
| REQ-F-100 | The main window MUST present health strip, category tabs, action grid, and status bar at all times. | Screenshot diff at 4 widths | `05-02` §4 |
| REQ-F-101 | Search MUST filter actions by title, description, and technical impact, with keyboard-only operation. | Type "port" → unlock-dev-ports first | `05-02` §5.2 |
| REQ-F-102 | The command palette MUST open with one shortcut from anywhere and MUST NOT trap focus when dismissed. | Esc restores prior focus | `05-03` §5 |
| REQ-F-103 | Every action card MUST expose tier, risk, admin need, and current phase without hover. | Field presence test | `05-02` §4.3 |
| REQ-F-104 | Long operations MUST show progress in the card and in a collapsible console, both cancellable. | Both controls cancel | `05-02` §4.4 |
| REQ-F-105 | The app MUST render correctly at 960×680 minimum and 100-200% OS scaling. | Layout test matrix | `05-03` §6 |
| REQ-F-106 | Theme MUST switch among off-white, true-black, and spatial-glass without restart, persisting the choice. | Reload keeps theme | `05-01` §3 |
| REQ-F-107 | The app MUST display `SIMULATION MODE - NO OS CHANGES` whenever the native host is absent, in a non-dismissible badge. | Browser build shows badge | REQ-F-110 |
| REQ-F-108 | A Trust Center screen MUST show version, signature status, storage locations, telemetry state, and data deletion. | All five present | `05-02` §10 |
| REQ-F-109 | Modal dialogs MUST trap focus, close on Esc, and return focus to the invoking control. | Keyboard test per modal | `05-03` §5 |
| REQ-F-110 | Simulation mode MUST simulate diagnose/execute/cancel/rollback deterministically with seeded data, and MUST never touch the OS. | Simulator has zero native imports | T-FE-04 |

---

## 12. Elevation

| ID | Statement | Acceptance | Trace |
| :--- | :--- | :--- | :--- |
| REQ-F-111 | The app MUST detect admin actions before execution and offer a single re-launch that preserves the selection. | Selection survives relaunch | `03-04` §5.4 |
| REQ-F-112 | Elevation handover MUST authenticate the relaunch request so another process cannot inject an action queue. | Forged `--resume-queue` rejected | T-SEC-03, `04-01` §5.3 |
| REQ-F-113 | Declining UAC MUST return the user to a working app with an explanation, never a dead window. | Decline → app usable | `05-02` §8 |
| REQ-F-114 | The elevated instance MUST become the single owner of execution; the original MUST exit after handover. | Only one executing process | T-E2E-06 |

---

## 13. Localisation

| ID | Statement | Acceptance | Trace |
| :--- | :--- | :--- | :--- |
| REQ-F-120 | Every shipped locale MUST have schema parity and placeholder parity with the source catalogue. 1.0.0 ships `en` + `tr`; a locale is "shipped" only when it has a named native reviewer (`06-01` §8). | Validator passes for each shipped locale | `06-01` §6 |
| REQ-F-121 | Locale files MUST support ICU plurals and selects for counts, sizes, and durations. | Plural forms verified for ru/pl/ar | T-I18N-02 |
| REQ-F-122 | Numbers, dates, and byte sizes MUST be formatted with locale-aware formatters, not manual concatenation. | `de` uses `1.234,5 MB` style | T-I18N-03 |
| REQ-F-123 | RTL locales MUST switch document direction and mirror layout without clipped controls. | `ar` screenshot diff, no overflow | `05-03` §7 |
| REQ-F-124 | Backend-originated messages MUST be keys with parameters, resolved in the UI locale. | Turkish UI shows Turkish outcome | T-I18N-04 |
| REQ-F-125 | Locale MUST be selectable in-app, persisted, and default to OS locale when supported. | OS `de-DE` → `de` | `06-01` §5 |
| REQ-F-126 | A missing key MUST fall back to English and MUST be reported in development, never show a raw key to a user. | Missing key test in dev fails build | `06-01` §8 |

---

## 14. Trust, privacy, and data

| ID | Statement | Acceptance | Trace |
| :--- | :--- | :--- | :--- |
| REQ-F-130 | Telemetry MUST be off by default and MUST require affirmative opt-in with a plain-language description. | Fresh install: no egress | `04-02` §5 |
| REQ-F-131 | The app MUST NOT require an account for any core function. | Full run with no account | KPI-11 |
| REQ-F-132 | Clipboard writes MUST NOT exceed the documented diagnostic summary and MUST be user-initiated. | Only on action | `04-02` §3 |
| REQ-F-133 | The app MUST publish its storage paths and allow opening each in Explorer. | Buttons open correct paths | `05-02` §10 |
| REQ-F-134 | Uninstall MUST offer to delete all Zenith data and MUST leave no files outside documented paths. | Post-uninstall filesystem diff | `04-02` §6 |
| REQ-F-135 | Licence and third-party notices MUST be viewable offline in-app. | Trust Center notices panel; `check:licenses` gate | `08-02` §7 |

---

## 15. Failure behaviour

| ID | Statement | Acceptance | Trace |
| :--- | :--- | :--- | :--- |
| REQ-F-140 | No failure path may leave a service stopped, an archive half-written, or a lock held. | Fault injection at 12 points | `07-01` §6 |
| REQ-F-141 | A crash MUST NOT lose an unrestored snapshot record. | Crash after commit → row present | REQ-F-025 |
| REQ-F-142 | The app MUST refuse to run destructive actions when free disk space is below the snapshot requirement, with a clear reason. | Low disk → refused with numbers | `03-03` §5.5 |
| REQ-F-143 | All errors MUST map to a documented code and a user remedy. | Error catalogue completeness test | `03-04` §7 |
| REQ-F-144 | Unknown errors MUST be logged with a correlation id shown to the user for support. | Correlation id present in toast | `07-02` §3 |

---

## 16. Requirement count and coverage

| Section | Count |
| :--- | ---: |
| Global | 10 |
| Diagnostics | 9 |
| Execution | 14 |
| Snapshot/rollback | 9 |
| Long-running processes | 6 |
| Process control | 8 |
| Chains/OS integration | 10 |
| Export/headless/support | 13 |
| Persistence/audit | 6 |
| Shell/UI | 11 |
| Elevation | 4 |
| Localisation | 7 |
| Trust/privacy | 6 |
| Failure behaviour | 5 |
| **Total functional** | **118** |

Every requirement is mapped in `02-03-traceability-matrix.md`.
