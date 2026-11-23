# 03-02 - Architecture Decision Records

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-ADR-001 |
| Version | 2.0.0 |
| Owner | Architecture |
| Rule | ADRs are immutable. A changed decision creates a new ADR that supersedes the old one. |
| Closes | No single defect - records the decisions that closed DEF-008, DEF-009, DEF-015, DEF-026, DEF-034, DEF-037, DEF-040 |

Format: **Context → Decision → Consequences → Alternatives rejected**. Status values: Accepted,
Superseded by ADR-nnn, Proposed, Rejected.

---

## ADR-001 - Tauri 2 + React 19, single window

**Status:** Accepted · **Supersedes:** v1.0.0 implicit choice

**Context.** The app is Windows-only but must ship a modern, dense, themeable interface with a
small footprint. Electron would add ~120 MB and a second runtime to harden. A native WinUI app
would slow iteration and fragment the design system.

**Decision.** Tauri 2 (Rust core + WebView2) with React 19 + TypeScript, one window, overlays
only.

**Consequences.** + Small binary, native Rust for Win32, strong typing across IPC. − WebView2
runtime dependency; requires bootstrapper and offline installer. − Rust + TS skill overlap
required.

**Alternatives rejected.** Electron (footprint, attack surface); WinUI 3 (iteration speed, shared
design tokens with no web ecosystem); Flutter (Win32 interop maturity).

---

## ADR-002 - Distributed, machine-checkable authority instead of a `.rules` file

**Status:** Accepted · **Supersedes:** v1.0.0 Section 0 / §2.2

**Context.** v1.0.0 required a single prose `.rules` file as the sole configuration authority. A
prose file cannot fail CI, cannot be verified against code, and drifts within one sprint. It also
created the illusion of control while 55 of ~70 files remained unspecified.

**Decision.** Authority is per-domain (manifest, IPC schema, lockfiles, threat model, token file,
`AGENTS.md`) and every authority is machine-checkable (`00-01` §2).

**Consequences.** + Drift fails CI. + Ownership is explicit. − Requires codegen and lint
investment up front.

**Alternatives rejected.** Keep `.rules` and add a linter over prose (brittle); one giant JSON
schema (unmaintainable, poor reviewability).

---

## ADR-003 - Write-ahead snapshot commit before mutation

**Status:** Accepted · **Supersedes:** v1.0.0 "4-phase" narrative that never wrote non-committed rows

**Context.** v1.0.0 described a four-phase archive but every insert was `COMMITTED`, so
`recover_incomplete_transactions()` was dead code, and a crash between rename and insert left an
orphan ZIP with no owner.

**Decision.** The DB row is the **commit point** and is written *before* the destructive mutation
(`03-01` §7.1). Recovery reconciles rows against files in both directions: missing archive for a
committed row → mark `BROKEN` and block rollback with an explanation; archive with no row →
delete and log.

**Consequences.** + No silent data loss; recovery is meaningful. + Partial mutations are
completable by rollback. − Requires free-disk pre-check and a `BROKEN` state in the model.

**Alternatives rejected.** Commit after mutation (loses the record exactly when needed); two-phase
file rename only (does not survive power loss).

---

## ADR-004 - Four honest reversibility tiers

**Status:** Accepted

**Context.** Users were burned by tools claiming 100% rollback. `controlled-reboot` was labelled
`FullyReversible` in v1.0.0 although it is only *abortable*.

**Decision.** `FullyReversible`, `PartiallyReversible`, `CompensatingRecovery`, `Irreversible`,
plus an orthogonal `abortable: bool` for time-window actions. `can_rollback` is derived, never
stored separately.

**Consequences.** + Truthful UI. + Testable per action. − Some actions feel less impressive
(`rebuild-icon-cache` is `PartiallyReversible`).

**Alternatives rejected.** Percentage confidence (unfalsifiable); two tiers (insufficient
nuance).

---

## ADR-005 - Machine-wide store to defeat UAC split-brain

**Status:** Accepted (retains v1.0.0 intent, fixes its ACL)

**Context.** `%LOCALAPPDATA%` resolves to a different profile under over-the-shoulder elevation.
v1.0.0 moved the store to `C:\ProgramData\Vellium\Zenith` but never specified ACLs, so the
directory inherited `Users: Create folders/append`, making the store both incomplete as a fix and
a tampering surface.

**Decision.** Store at `%ProgramData%\Vellium\Zenith`, created by the installer with
`Administrators:(OI)(CI)F` and `SYSTEM:(OI)(CI)F`, `Users:(OI)(CI)RX`. Standard-user sessions
open read-only. If creation fails, fall back to `%LOCALAPPDATA%` with a visible degraded notice.

**Consequences.** + Elevation does not lose state. + Tampering requires admin. − Standard users
cannot write audit entries; their actions are still audited by the elevated owner of the run.

**Alternatives rejected.** Per-user store (split-brain); HKLM-only (no file archives).

---

## ADR-006 - DPAPI-protected HMAC key instead of `MachineGuid`

**Status:** Accepted · **Supersedes:** v1.0.0 `read_machine_hmac_key`

**Context.** v1.0.0 keyed the HMAC with `"ZENITH_HMAC_V1_" + MachineGuid`. `MachineGuid` is
readable by every user, so the tag provided no integrity against a local attacker - the exact
threat it was introduced to stop.

**Decision.** A 32-byte random key is generated at install, protected with `CryptProtectData`
(machine scope) and stored as `hmac.key.dpapi`; unprotect requires SYSTEM/Administrator context.
Tag = HMAC-SHA256 over `snapshot_id | action_id | payload_json | schema_version`.

**Consequences.** + Tamper-evident against standard users. − Key is not portable across machines
(by design); a machine re-image invalidates old snapshots, which must be reported clearly, not
crashed on.

**Alternatives rejected.** MachineGuid (broken); TPM-only (hardware dependency); per-payload
DPAPI (no cross-record chaining).

---

## ADR-007 - Allowlisted rollback scopes

**Status:** Accepted

**Context.** v1.0.0 applied `FilesystemArchive.target_dir` and `RegistryBackup.subkey` straight
from the DB. A standard user who could write the DB could aim an admin rollback at
`C:\Windows\System32` or `HKLM\...\Run`.

**Decision.** Each action declares a scope in the manifest. Rollback resolves the target through
the scope resolver; any path or key outside it aborts the entire rollback with `ScopeViolation`
before writing anything. Registry writes additionally require the exact subkey allowlisted.

**Consequences.** + Removes a privilege-escalation path. − Adding a new action requires declaring
its scope; forgetting is a CI failure, not a runtime surprise.

**Alternatives rejected.** Prompt the user (social-engineering surface); signature per snapshot
(key management burden).

---

## ADR-008 - Job objects for child process trees

**Status:** Accepted · **Supersedes:** v1.0.0 `child.kill()`

**Context.** v1.0.0 claimed `child.kill()` "kills the process tree cleanly". It does not:
`dism.exe`, `winget.exe` and PowerShell leave grandchildren alive.

**Decision.** Every child is created suspended, assigned to a per-action job object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, then resumed. Cancellation and timeout terminate the job.

**Consequences.** + No orphans. + Deterministic cleanup on crash of the parent. − Slightly more
Win32 surface; requires tests that assert grandchild death.

**Alternatives rejected.** `taskkill /T` (racy, locale-dependent output); `CreateProcess` +
manual enumeration (incomplete).

---

## ADR-009 - ICU MessageFormat instead of flat key/value

**Status:** Accepted · **Supersedes:** v1.0.0 `{count}` substitution

**Context.** v1.0.0 stored strings with `{count}` placeholders and validated parity by regex.
That cannot express Russian/Polish/Arabic plural categories, so 73 locales were structurally
incapable of correct grammar.

**Decision.** Messages are ICU MessageFormat strings, compiled at build time with a validator that
checks argument sets and plural branches per locale.

**Consequences.** + Correct plurals and selects. + Number/date/nested-format support. − Small
runtime format cost (~0.1 ms/string, cached); translators must handle ICU syntax, so the glossary
includes syntax rules.

**Alternatives rejected.** Flat keys + `Intl.PluralRules` at call sites (leaks grammar into
components); per-locale JS functions (unreviewable by translators).

---

## ADR-010 - Backend emits message keys, not prose

**Status:** Accepted

**Context.** v1.0.0 hard-coded English in `ZenithError` and `ExecutionOutcome.summary_message`,
so 73 locales covered labels only. Diagnostics and errors stayed English.

**Decision.** Rust returns `message_key`, typed `params`, and `remedy_key`. The UI resolves them
in the active locale. Logs are English and technical by design (support value), user-facing text
is localised.

**Consequences.** + Whole interface localises. + Error text is testable by key. − Rust must not
invent sentences; new errors require dictionary entries (enforced by `docs:lint`).

**Alternatives rejected.** Ship English in a `message` field and translate on the frontend by
string match (fragile); bundle translations into Rust (rebuild per translation).

---

## ADR-011 - Manifest as single source of truth with codegen

**Status:** Accepted · **Supersedes:** v1.0.0 six-way duplication

**Context.** Action facts lived in six places (Rust enum, TS catalog, 73 locale files, spec table,
script snippets, risk/tier fields). Adding one action meant six coordinated edits and guaranteed
drift. Worse, 44 script snippets were referenced but never defined.

**Decision.** One `actions.manifest.json` (documented in `03-05` §5) generates: Rust `ActionId` +
metadata, TS types + catalog, i18n skeleton with required keys, the docs table, and script
snippet stubs that must be filled - an unfilled stub fails the build.

**Consequences.** + Impossible to drift. + New action is one file change plus one snippet. −
Codegen step in the build; generated files are committed and drift-checked.

**Alternatives rejected.** Manual sync with a test (tests are written after the drift);
macro-only generation in Rust (TS still duplicates).

---

## ADR-012 - Manifest-driven simulator with no native imports

**Status:** Accepted

**Context.** v1.0.0 required a browser "preview simulator" but specified no data or behaviour, and
allowed no way to verify it never touched the OS.

**Decision.** The simulator implements the same TS interface as the native adapter, uses seeded
PRNG and `localStorage`, and is verified by a module-graph test that fails if any native import
appears in its transitive closure.

**Consequences.** + Designers can work in a browser. + Deterministic snapshots in tests. −
Simulator must be maintained alongside the contract (guarded by the shared interface).

**Alternatives rejected.** Mock Tauri internals in the browser (fragile, hides real paths);
no simulator (designer blocked).

---

## ADR-013 - Feature-flagged enterprise surface, off by default

**Status:** Accepted

**Context.** v1.0.0 mentioned a commercial telemetry tier and a `enterprise-telemetry` feature
flag but specified nothing, which in an open-core product is a licensing and privacy hazard.

**Decision.** The feature is specified in `09-01`, disabled by default, absent from Free builds,
and its code is gated so that a Free binary contains no telemetry transport at all (verified by
symbol scan).

**Consequences.** + Clean licensing story. + Privacy claim is verifiable. − Two build variants to
test.

**Alternatives rejected.** Runtime toggle only (ships the capability); separate product fork
(duplication).

---

## ADR-014 - Streamed events instead of polling

**Status:** Accepted

**Context.** v1.0.0 had a `zenith://terminal-log` event mentioned once and no cadence or backpressure
policy.

**Decision.** Progress and logs use Tauri events with batching (≤ 20 lines / 100 ms), a bounded
ring buffer (5,000 lines) in the UI, and monotonic sequence numbers so dropped batches are
detectable.

**Consequences.** + Fluent UI under `dism` output. + Timeout is enforced in the core, not the UI.
− Event schema versioning required.

**Alternatives rejected.** Polling (latency, waste); invoke-per-line (IPC thrash).

---

## ADR-015 - Destructive actions excluded from batch by construction

**Status:** Accepted

**Context.** v1.0.0 marked `empty-recycle-bin` "excluded from Safe Batch" in prose only; the batch
validator had no such rule.

**Decision.** Batch eligibility is a manifest predicate: `risk == safe && safe_batch == true &&
tier != irreversible && abortable_or_nonblocking`. Validation is generated from the manifest and
also applied to script export.

**Consequences.** + Cannot ship a batch that reboots a fleet. − Some legitimate power-user batch
desires are refused (accepted: safety over convenience).

**Alternatives rejected.** Runtime confirmation per destructive step (training users to click
through).

---

## ADR-016 - No cloud backend in v1

**Status:** Accepted

**Context.** Crash aggregation and usage analytics are normally server-backed, which conflicts
with the "works offline, no account" differentiator and increases privacy obligations.

**Decision.** v1 has only two network touchpoints: update manifest download and opt-in fleet
telemetry. Crashes produce a local support bundle; the user chooses to share it.

**Consequences.** + Privacy and trust story is simple. + No backend ops. − Weaker crash visibility;
mitigated by KPI instrumentation and opt-in telemetry.

**Alternatives rejected.** Anonymous crash upload by default (trust damage); Sentry-style SaaS
(data processor obligations).

---

## ADR-017 - `sysinfo` for process enumeration, Win32 for identity

**Status:** Accepted

**Context.** `sysinfo` is convenient for names and memory but its `start_time()` semantics are
platform-specific and were relied on in v1.0.0 for TOCTOU without validation.

**Decision.** Use `sysinfo` for display data; obtain the authoritative creation time from
`GetProcessTimes` (FILETIME → Unix ms) for any identity comparison. Store as `start_time_unix_ms`
in a `u64` and compare exactly.

**Consequences.** + Correct TOCTOU guard. + Removes the ambiguous field name that masked a bug. −
One extra FFI call per candidate process (bounded: only selected targets).

**Alternatives rejected.** Trust `sysinfo` (unversioned semantics); WMI (slow, locale issues).

---

## ADR-018 - Windows 10 22H2 supported with lifecycle banner, not silently dropped

**Status:** Accepted

**Context.** Mainstream support ended 2025-10-14. Denying install is hostile; ignoring ESU status
is dishonest.

**Decision.** Install and run on 19045; detect ESU enrolment via the documented registry signal;
show a non-dismissible informational banner when not enrolled. No functional degradation.

**Consequences.** + Honest, keeps existing users. − Extra copy and one probe.

**Alternatives rejected.** Hard block (support burden, bad will); silence (misleading).

---

## ADR-019 - Explicit `NotImplemented` instead of `todo!()`

**Status:** Accepted · **Supersedes:** v1.0.0 Zero-Stub prose

**Context.** Banning `todo!()` without completing contracts produced invented behaviour, which is
worse than a labelled gap.

**Decision.** `ZenithError::NotImplemented { feature }`, surfaced as a disabled control with a
reason, and required to match the WBS open-WP list (`00-01` §3, Law L1).

**Consequences.** + Honest builds at any commit. + Release gate is mechanical. − Requires the
audit binary.

**Alternatives rejected.** Feature flags only (hidden paths); compile-time `cfg` matrix explosion.

---

## ADR-020 - Reproducible builds with pinned toolchain

**Status:** Accepted

**Context.** v1.0.0 pinned dependency versions but omitted lockfiles, MSRV, and toolchain files,
so "deterministic" was unachievable. Tauri 2.12.x requires Rust 1.90 and edition 2024, which v1.0.0
violated by using edition 2021 with Tauri 2.2.

**Decision.** `Cargo.toml` declares `rust-version = "1.90"` (the Tauri 2.12.5 floor) and edition
2024; `.node-version` pins 24.22.3; `Cargo.lock` and `package-lock.json` are committed and builds
use `cargo build --locked` / `npm ci`. A `rust-toolchain.toml` pinning the exact patch release is
added at release tagging rather than committed permanently: a forced channel pin makes every
developer machine download a second toolchain on first `cargo` invocation, and on an air-gapped
build host without that toolchain pre-installed it fails before the build starts.

**Verified-on, not assumed.** The 1.0.0 evidence in this repository was produced with
`rustc 1.100.0` (≥ MSRV) and `node v26.13.1`; `08-01` §3 states this explicitly. MSRV conformance is
a forward guarantee (the code compiles on 1.90), not a claim that 1.90 was the compiler used.

**Consequences.** + Verifiable determinism without a forced download. + SBOM accuracy. − Toolchain
bumps are explicit PRs. − The exact patch compiler for a release is recorded at tag time, not in the
tree.

**Alternatives rejected.** Floating "latest" (unreproducible); vendoring everything into git
(repo bloat).

---

## ADR-021 - Retention with consent, not silent deletion

**Status:** Accepted

**Context.** v1.0.0 pruned audit logs but never snapshots or archives, so a cleanup tool could fill
a disk; the obvious fix (delete old snapshots) can destroy the user's only rollback.

**Decision.** Defaults: audit 5,000 rows; snapshots 200 rows / 2 GB, whichever hits first. Prune
never removes unrestored rows without an explicit confirmation, and always reports reclaimed
space.

**Consequences.** + Bounded disk. + No silent loss of rollback. − Occasional user prompt.

**Alternatives rejected.** Unlimited (disk risk); time-based only (a busy week can exceed size).

---

## ADR-022 - Event schema versioning

**Status:** Accepted

**Context.** Streaming events between Rust and TS need a compatibility story once updates ship
independently of the webview bundle.

**Decision.** Every event payload carries `v` (integer). Additive fields are allowed within a
major version; removals/renames bump it. Frontend ignores unknown fields and logs unknown
versions in dev.

**Consequences.** + Safe evolution. − Slight payload overhead.

**Alternatives rejected.** No versioning (breaks on any update).

---

## ADR-023 - Two-tier locale strategy (complete + community)

**Status:** Accepted

**Context.** 73 machine-authored locales cannot all be verified by native speakers before 1.0.
Claiming 73 "supported" locales without a QA path is a truthfulness problem (and the %15
identical-string heuristic in v1.0.0 both missed real failures and flagged legitimate identical
terms).

**Decision.** Tier A (12 locales: tr, en, de, fr, es, it, pt-BR, ru, ja, zh-CN, ar, hi) are
**release-gated**: native review, plural verification, RTL check. Tier B (61) ship with
machine-authored translations plus glossary, marked `meta.translated: machine`, and fall back to
English per missing key. The UI shows a subtle "translation" note for Tier B only when a fallback
occurs.

**Consequences.** + Honest claim, incremental quality. + No user sees an empty string. − Tier B
quality varies.

**Alternatives rejected.** Ship 73 as equal (dishonest); ship 12 only (loses reach).

---

## ADR-024 - Support bundle without elevation

**Status:** Accepted

**Context.** Standard users must be able to produce support artifacts, but logs may live in a
machine-wide directory they can read but not write.

**Decision.** The bundle is written to `%LOCALAPPDATA%\Vellium\Zenith\support` by the standard-user
process, reading machine-wide logs read-only. Secrets are scrubbed by a shared redactor before
writing.

**Consequences.** + Support works for everyone. − Two log locations to reason about (documented).

**Alternatives rejected.** Require elevation (blocks most users); put logs per-user (split-brain
again).
