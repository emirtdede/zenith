# 03-04 - IPC Contract (Frontend ↔ Rust Core)

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-IPC-001 |
| Version | 2.1.0 |
| Status | Frozen contract (two additive commands since 2.0.0) |
| Owner | Architecture |
| Closes | DEF-003 (no IPC surface in v1.0.0) |

> **2.1.0 (2026-11-19).** Two commands were added under the compatibility rule in
> §9: `preferences_set` (previously implemented but undocumented, an L3 breach)
> and `action_prefs_set` (per-action pin/hide). No existing name, field or
> semantic changed. `scripts/check-contract.mjs` fails if this table, the Rust
> handler registry and `native.ts` ever disagree again.

---

## 1. Principles

| # | Principle | Enforcement |
| :--- | :--- | :--- |
| P1 | Typed commands only. No command takes a shell string. | Review + schema test |
| P2 | Every payload validated before any engine call. | `ipc::validate`, fail closed |
| P3 | The backend re-checks privilege; the UI check is cosmetic. | REQ-F-079 |
| P4 | Long work returns immediately; progress arrives as events. | ADR-014 |
| P5 | Errors are `{code, messageKey, params, remedyKey, correlationId}`. Never English prose. | ADR-010 |
| P6 | Events carry `v` for schema evolution. | ADR-022 |
| P7 | All commands are idempotent or explicitly named as intent that may fail. | §5 |

Transport: Tauri `invoke` (request/response) + `listen` (events). Channel names are snake_case and
**stable**; renaming requires an IPC MAJOR version bump.

---

## 2. TypeScript surface (authoritative shape)

```ts
export type ActionId =
  | 'clean-temp-cache' | 'empty-recycle-bin' | 'archive-screenshots'
  | 'winget-upgrade-all' | 'windows-update-scan' | 'flush-dns-cache'
  | 'reset-winsock-stack' | 'clear-stuck-proxy-vpn' | 'sync-ntp-time'
  | 'copy-sysadmin-info' | 'dism-restore-health' | 'sfc-system-scan'
  | 'restart-explorer' | 'rebuild-icon-cache' | 'restart-bluetooth'
  | 'reset-print-spooler' | 'reset-gpu-driver' | 'controlled-reboot'
  | 'unlock-dev-ports' | 'close-hung-office' | 'clear-teams-outlook-cache'
  | 'reclaim-wsl-docker-ram';

export type ReversibilityTier =
  | 'fully_reversible' | 'partially_reversible'
  | 'compensating_recovery' | 'irreversible';

export type ExecutionPhase =
  | 'idle' | 'diagnosing' | 'healthy' | 'needs_attention' | 'running'
  | 'success' | 'error' | 'skipped_dependency' | 'cancelled' | 'rolled_back';

export interface IpcError {
  code: string;            // stable, e.g. 'ELEVATION_REQUIRED'
  messageKey: string;      // ICU key, e.g. 'errors.elevationRequired'
  params: Record<string, string | number>;
  remedyKey: string;       // actionable next step key
  correlationId: string;
}
```

Every command resolves with either its success type or rejects with `IpcError`. The bridge
normalises Rust errors into this shape; nothing else is allowed to reach components.

---

## 3. Command catalogue

| # | Command | Mutates | Requires admin | Returns |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `app_info_get` | no | no | `AppInfo` |
| 2 | `state_get` | no | no | `AppState` |
| 3 | `diagnose_run` | no (read-only) | no | `DiagnosticReport[]` |
| 4 | `action_execute` | yes | per action | `ExecutionOutcome` |
| 5 | `action_cancel` | no | no | `CancelResult` |
| 6 | `snapshot_list` | no | no | `SnapshotRecord[]` |
| 7 | `snapshot_rollback` | yes | per action | `RollbackOutcome` |
| 8 | `candidates_scan` | no | no | `Candidates` |
| 9 | `process_terminate` | yes | sometimes | `TerminateSummary` |
| 10 | `file_save_text` | yes (fs) | no | `SavedFile` |
| 11 | `support_bundle_create` | yes (local) | no | `SupportBundle` |
| 12 | `app_data_purge` | yes | no | `PurgeSummary` |
| 13 | `elevation_handover` | n/a | triggers UAC | never returns |
| 14 | `preferences_set` | yes (prefs file) | no | `AppState` |
| 15 | `action_prefs_set` | yes (prefs file) | no | `ActionPrefs` |

---

## 4. Shared models

```ts
export interface AppInfo {
  version: string;                // "1.0.0"
  buildCommit: string;            // short sha, "dev" if unknown
  tauriVersion: string;
  webviewVersion: string | null;     // null when the WebView could not be asked (DEF-128)
  /**
   * `null` when the core could not read the OS version. `0` and `""` used to be
   * sent on failure and the Trust Center printed `" (0)"` - a build number
   * invented from a failed registry read (DEF-127). The screen renders `-`.
   */
  osBuild: number | null;         // 26100
  osDisplayVersion: string | null; // "24H2"
  arch: 'x86_64' | 'aarch64';
  isElevated: boolean;
  signature: { status: 'valid' | 'unsigned' | 'invalid' | 'unknown'; publisher?: string };
  storePath: string;
  storeMode: 'machine' | 'user_fallback';
  simulator: boolean;
}

export interface AppState {
  locale: string;                 // 'tr'
  theme: 'off-white' | 'true-black' | 'spatial-glass';
  reduceMotion: boolean;
  telemetryEnabled: boolean;      // always false unless opted in
  phases: Record<ActionId, ExecutionPhase>;
  activeActionId: ActionId | null;
  lastScanAtUtc: string | null;
  telemetry: SystemTelemetry | null;
  /**
   * `null` when the core could not read the store. "Not measured" is not
   * "empty": the core used to build this with `unwrap_or_default()` /
   * `unwrap_or(0)` and report an unreadable database as a measured zero
   * (DEF-123). The UI renders `-` for `null` and never a fabricated 0.
   */
  retention: { snapshots: number; snapshotBytes: number; auditRows: number } | null;
  actionPrefs: ActionPrefs;        // additive in 2.1.0
  notices: StartupNotice[];
}

export interface ActionPrefs {
  pinned: ActionId[];              // order is the display order
  hidden: ActionId[];              // omitted from the default grid
}

export interface SystemTelemetry {
  healthScore: number;            // 0..100
  junkBytes: number;
  dnsLatencyMs: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  memoryUsedPercent: number | null;
  issueCount: number;             // weighted per severity_weight
  issueIds: ActionId[];
  osBuild: number;
  win10EsuWarning: boolean;
  measuredAtUtc: string;
  breakdown: { junk: number; dns: number; memory: number; issues: number };
}

export interface DiagnosticReport {
  actionId: ActionId;
  needsAttention: boolean;
  severityWeight: 1 | 2 | 3;
  metricKey: string;              // i18n key for the summary
  metricParams: Record<string, string | number>;
  reclaimableBytes: number;
  latencyMs: number | null;
  tier: ReversibilityTier;
  latestSnapshotId: string | null;
  canRollback: boolean;
  measuredAtUtc: string;
}

export interface ExecutionOutcome {
  actionId: ActionId;
  phase: ExecutionPhase;
  success: boolean;
  durationMs: number;
  summaryKey: string;
  summaryParams: Record<string, string | number>;
  beforeKey: string; beforeParams: Record<string, string | number>;
  afterKey: string;  afterParams: Record<string, string | number>;
  snapshotId: string | null;
  tier: ReversibilityTier;
  requiresReboot: boolean;
  abortable: boolean;
  triggerEffect: EffectId | null;
  clipboardKey: string | null;
  correlationId: string;
  steps: StepResult[];
}

export type EffectId = 'gpu-reset-flash' | 'reboot-countdown' | 'explorer-restart';

export interface StepResult {
  stepKey: string;                // 'archive', 'delete', 'restart-service'
  status: 'success' | 'error' | 'skipped';
  errorCode?: string;
  params?: Record<string, string | number>;
}
```

---

## 5. Command specifications

### 5.1 `app_info_get`

```ts
invoke('app_info_get') → AppInfo
```

Errors: `INTERNAL` only. Used by Trust Center (REQ-F-108) and the status bar.

### 5.2 `state_get`

```ts
invoke('state_get') → AppState
```

Called once at boot, then maintained by events. Errors: `STORE_QUARANTINED` (still returns state
with `notices`), `INTERNAL`.

### 5.3 `diagnose_run`

```ts
interface DiagnoseRequest {
  actionIds?: ActionId[];   // omit → all 22
  includeSlow?: boolean;    // default true; false excludes DISM check
}
invoke('diagnose_run', { request }) → DiagnosticReport[]
```

| Rule | Detail |
| :--- | :--- |
| Concurrency | ≤ 3 probes in parallel; independent, no shared mutable state |
| Per-probe budget | 2 s (slow probes 10 s with progress events) |
| Side effects | none permitted (REQ-F-013) |
| Cancellation | `action_cancel { scope: 'diagnose' }` |
| Events | `diagnose_progress { completed, total, actionId }` after each probe |

Errors: `INVALID_ARGUMENT` (unknown id), `ALREADY_RUNNING`, `CANCELLED`, `TIMEOUT`.

### 5.4 `action_execute`

```ts
interface ExecuteRequest {
  actionId: ActionId;
  confirmation?: { acknowledgedTier: ReversibilityTier; typedCount?: number };
  options?: {
    targets?: VerifiedPidTarget[];   // unlock-dev-ports / close-hung-office
    ports?: number[];                // custom range for scan-derived execution
  };
}
invoke('action_execute', { request }) → ExecutionOutcome
```

Validation order (all before any mutation):

```text
1 action id known                     else INVALID_ARGUMENT
2 not already running (execution slot) else ALREADY_RUNNING
3 dependency satisfied (only in batch) else DEPENDENCY_NOT_MET
4 admin required → is_elevated()       else ELEVATION_REQUIRED
5 confirmation matches tier            else CONFIRMATION_REQUIRED
6 free disk ≥ snapshot estimate        else INSUFFICIENT_DISK
7 targets non-empty and shape-valid    else INVALID_ARGUMENT
8 scope resolvable for the action      else SCOPE_VIOLATION
```

Returns immediately for streaming actions? No: the promise resolves at completion, while events
stream progress. UI never blocks because the invoke is async (REQ-F-055).

Errors: above plus `CANCELLED`, `TIMEOUT`, `ACCESS_DENIED`, `TOOL_MISSING`, `SNAPSHOT_FAILED`,
`INTEGRITY_ERROR`, `SCOPE_VIOLATION`, `PID_VERIFICATION_FAILED`, `SERVICE_UNAVAILABLE`,
`INTERNAL`.

### 5.5 `action_cancel`

```ts
invoke('action_cancel', { scope: 'diagnose' | 'scan' | ActionId }) → { cancelled: boolean }
```

Behaviour: records the request, then runs the killer registered by the running action - for a child
process that terminates its job object - **on the calling thread**, so the effect does not wait for the
worker's next poll tick. Returns `cancelled: false` with `reason` when nothing was running (not an error -
cancelling twice is harmless).

The three scopes are three independent objects, and the isolation is deliberate:

| `scope` | Stops | Backing state |
| :--- | :--- | :--- |
| `diagnose` | the running diagnosis | `AppState::diagnose_cancel`, one token |
| `scan` | **every** candidate scan in flight | `AppState::scan_cancels`, one fresh token per run |
| `ActionId` | that repair | the executor's per-action token |

`scan` is a registry rather than a single token because a scan is not a singleton. Each run publishes its
own token and a guard that retires exactly that token on every exit path, panic included. A single shared
token reset per run would let a second scan withdraw the first scan's stop - the same defect the
diagnosis/scan split exists to prevent, one level down - and a single slot would strand an older scan while
two overlap. `action_cancel { scope: 'scan' }` clones the live tokens out of the registry before calling
`cancel()`, so a hook that talks to the kernel never runs while the registry mutex is held, and returns
`nothing_running` when the registry is empty. A scan that is already executing checks the token before
dispatch and between printers, jobs, binaries and PIDs, which is what makes "a slow spooler cannot hold the
UI hostage" enforceable rather than aspirational (DEF-108).

The ≤ 500 ms figure of REQ-F-052 is a *measured* bound, not a sleep: `CancelToken::latency_ms()`
reports request → enactment, the runner's test asserts it, and `action_execute` writes it into
the durable log so a cancelled action is visible in a support bundle. An earlier draft of this paragraph said
the command waited 500 ms and then terminated the job itself; it never did either (DEF-103).

### 5.6 `snapshot_list`

```ts
invoke('snapshot_list', { limit?: number }) → SnapshotRecord[]
interface SnapshotRecord {
  snapshotId: string;
  actionId: ActionId;
  createdAtUtc: string;
  tier: ReversibilityTier;
  snapshotType: string;
  isRestored: boolean;
  restoredAtUtc: string | null;
  estBytes: number;
  status: 'committed' | 'broken';
  summaryKey: string;
  summaryParams: Record<string, string | number>;
}
```

### 5.7 `snapshot_rollback`

```ts
invoke('snapshot_rollback', { snapshotId }) → RollbackOutcome
interface RollbackOutcome {
  snapshotId: string;
  success: boolean;
  restoredItems: number;
  skippedItems: number;
  skippedReasons: { itemKey: string; reasonCode: string }[];
  durationMs: number;
  correlationId: string;
}
```

Pre-flight (refuses before writing):

| Check | Failure code |
| :--- | :--- |
| Row exists and `COMMITTED` | `SNAPSHOT_NOT_FOUND` |
| HMAC valid | `INTEGRITY_ERROR` |
| Not already restored | `ALREADY_RESTORED` (info, not error) |
| Scope resolves | `SCOPE_VIOLATION` |
| Archive hash matches (file payloads) | `INTEGRITY_ERROR` |
| Admin if action required it | `ELEVATION_REQUIRED` |

### 5.8 `candidates_scan`

```ts
interface CandidateRequest { kind: 'dev_ports' | 'hung_office' | 'print_jobs' | 'wsl' }
interface Candidates {
  kind: CandidateRequest['kind'];
  scannedAtUtc: string;
  items: PortListener[] | HungWindow[] | PrintJob[] | WslSession[];
}
interface PortListener {
  port: number; protocol: 'TCP' | 'TCP6'; pid: number;
  processName: string; startTimeUnixMs: number;
  commandLineRedacted: string; memoryMb: number; localAddress: string;
  isSelf: boolean;
}
interface HungWindow {
  pid: number; processName: string; startTimeUnixMs: number;
  windowTitleRaw: string; memoryMb: number;
  hungForMs: number;
}
```

`windowTitleRaw` is the caption of the window `IsHungAppWindow` actually flagged, read in the same
enumeration that found it - never the first titled window of the process, which may be a different one.
It can be empty (a document window that has not finished loading); the UI then shows a named placeholder.
`hungForMs` is a **floor**, not a duration: Windows exposes hung-ness as a boolean and never reports how
long a window has been unresponsive, so the value is always `HUNG_WINDOW_FLOOR_MS` (`5000`) and the
catalogue says "at least". It is untrusted document text; the UI renders it as text, never HTML.

The command is a **read-only** sweep but it is long enough to need a stop: four families, each enumerating
processes, ports, print queues or WSL sessions. It publishes a token through the scan registry described in
§5.5 and checks it before dispatch and between items inside every family, so `action_cancel { scope: 'scan' }`
ends the sweep promptly and the dialog can show a stop button instead of a disabled "Scan again". Nothing on
the machine is mutated either way - a cancelled scan is a stopped look, not a failed operation.

### 5.9 `process_terminate`

```ts
interface TerminateRequest {
  actionId: 'unlock-dev-ports' | 'close-hung-office';
  targets: VerifiedPidTarget[];        // { pid, expectedName, expectedStartTimeUnixMs }
}
interface TerminateSummary {
  requested: number; terminated: number;
  results: {
    pid: number;
    outcome: 'terminated' | 'identity_mismatch' | 'access_denied' | 'gone' | 'refused_self';
  }[];
  correlationId: string;
}
```

Per-target outcome (REQ-F-066). Never all-or-nothing; never kills an unlisted PID.

### 5.10 `file_save_text`

```ts
interface SaveTextRequest { suggestedName: string; content: string; format: 'ps1' | 'bat' | 'csv' | 'json' }
invoke('file_save_text', { request }) → { path: string | null; bytes: number }
```

`path: null` means the user cancelled the dialog - not an error. Content is generated in the
frontend (`scriptGenerator`), validated for size ≤ 2 MB.

### 5.11 `support_bundle_create`

```ts
invoke('support_bundle_create') → { path: string; bytes: number; includedFiles: string[] }
```

Contents and redaction: `07-02` §5. Must work without elevation (ADR-024).

### 5.12 `app_data_purge`

```ts
invoke('app_data_purge', { scope: 'support' | 'logs' | 'snapshots' | 'all', confirmToken: 'PURGE' }) → PurgeSummary
```

`snapshots` requires no unrestored rows, or an explicit `force: true` with a second confirmation.
`all` deletes DB rows, archives, hives, logs, support bundles - but never quarantined forensics
without `force`.

### 5.13 `elevation_handover`

```ts
interface HandoverRequest { resumeQueue: ActionId[]; nextTheme: string; locale: string }
invoke('elevation_handover', { request }) → never resolves
```

**Authentication (fixes DEF-009, REQ-F-112):**

```text
1 Rust generates nonce N (32 bytes), stores { N, expiry: now+120s, callerPid } in memory only
2 launches: zenith.exe --elevate --handover <N> --wait-pid <pid> --resume-queue <csv>
3 elevated instance:
     a verifies the parent PID is alive and its token SID equals the invoking user's SID
     b verifies N matches a single-use record written to a machine-scoped file readable only by
       Administrators+SYSTEM, within the expiry window, then deletes it
     c refuses on mismatch with ELEVATION_HANDOVER_INVALID (no action queue accepted)
4 original process exits after the elevated one signals readiness
```

A standard user cannot inject a queue: they cannot write the nonce record (ACL) and cannot match
the SID check. This closes the v1.0.0 "any process can pass `--resume-queue controlled-reboot`" hole.

### 5.14 `preferences_set`

```ts
interface PreferencesPatch {
  locale?: string;      // must be a shipped catalogue (en, tr)
  theme?: 'off-white' | 'true-black' | 'spatial-glass';
  reduceMotion?: boolean;
  telemetryEnabled?: boolean;
}
invoke('preferences_set', { patch }) → AppState
```

Partial by design: a missing field keeps its stored value. Unknown locales are
`INVALID_ARGUMENT` rather than silently falling back on the next launch. The
command returns the complete state so the renderer never guesses what was
stored. Settings are UI state, but they persist through the core because the
renderer is granted no filesystem capability.

### 5.15 `action_prefs_set`

```ts
interface ActionPrefs {
  pinned: ActionId[];
  hidden: ActionId[];
}
invoke('action_prefs_set', { prefs }) → ActionPrefs
```

The request is the **complete** set, not a patch, because both lists are small
and order is meaningful. Rules, all enforced before writing:

| Rule | Failure |
| :--- | :--- |
| Every id is one of the 22 manifest ids | deserialization → `INVALID_ARGUMENT` |
| Duplicates collapse in caller order | none (normalised) |
| An id may not be both pinned and hidden | `INVALID_ARGUMENT` with `field=actionPrefs` |

Pinned ids sort first inside their category; hidden ids are filtered from the
default grid but remain reachable through the "show hidden" toggle and the
command palette. The command writes the shared preferences file through the same
serialiser as `preferences_set`, so a crash cannot leave a half-written file.

---

## 6. Events

All payloads carry `v: 1`. Listeners must ignore unknown fields.

| Event | Payload | Cadence |
| :--- | :--- | :--- |
| `phase_changed` | `{ v, actionId, phase, atUtc }` | on transition |
| `terminal_log` | `{ v, actionId, lines: LogLine[] }` | batched ≤ 20 lines / 100 ms |
| `diagnose_progress` | `{ v, completed, total, actionId }` | after each probe |
| `telemetry_update` | `{ v, telemetry }` | after diagnosis, and every 30 s while visible |
| `snapshot_changed` | `{ v, snapshotId, kind: 'created' \| 'restored' \| 'broken' \| 'pruned' }` | on change |
| `startup_notice` | `{ v, notice }` | at boot |

```ts
interface LogLine {
  seq: number;                 // monotonic per action; gaps = dropped batch
  atUtc: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  text: string;                // English technical text (support value), already redacted
  stepKey?: string;
}
```

Bounded UI buffer: 5,000 lines with a "dropped N lines" marker (`LOG_LIMIT`, `src/state/store.ts`).
Events are best-effort: `emit` returns `Ok(())` even when no window is listening, so the renderer's
buffer is a convenience, not the record of what ran. Durability is the rotating operation log
(`04-02` §5): `action_execute` writes each step of every action - success or failure - through
`logging::append_steps`, capped at the same 20 lines the event carries, redacted and rotated by the
one writer that honours `LOG_MAX_BYTES` / `LOG_MAX_FILES`. A support bundle therefore contains the
step trace even if the window was closed the whole time. There is no in-core line queue: an earlier
draft of this contract promised one, and nothing ever implemented it (DEF-099).

---

## 7. Error catalogue

`code` is stable; `messageKey`/`remedyKey` are i18n keys resolved in the active locale.

| Code | HTTP-like class | messageKey | remedyKey | Typical cause |
| :--- | :--- | :--- | :--- | :--- |
| `INVALID_ARGUMENT` | validation | `errors.invalidArgument` | `remedy.checkSelection` | unknown action id, bad range |
| `ALREADY_RUNNING` | user | `errors.alreadyRunning` | `remedy.waitOrCancel` | second execution |
| `ELEVATION_REQUIRED` | user | `errors.elevationRequired` | `remedy.restartAsAdmin` | standard token |
| `ELEVATION_HANDOVER_INVALID` | security | `errors.handoverInvalid` | `remedy.restartManually` | forged/expired nonce |
| `CONFIRMATION_REQUIRED` | user | `errors.confirmationRequired` | `remedy.confirmAction` | missing tier ack |
| `ACCESS_DENIED` | environment | `errors.accessDenied` | `remedy.closeHandlesOrElevate` | locked file / protected process |
| `INSUFFICIENT_DISK` | user | `errors.insufficientDisk` | `remedy.freeSpace` | snapshot cannot fit |
| `DEPENDENCY_NOT_MET` | validation | `errors.dependencyNotMet` | `remedy.runPrerequisite` | SFC before DISM |
| `SCOPE_VIOLATION` | security | `errors.scopeViolation` | `remedy.reportBug` | rollback target outside allowlist |
| `INTEGRITY_ERROR` | integrity | `errors.integrity` | `remedy.createSupportBundle` | HMAC/hash mismatch |
| `ZIP_TRAVERSAL_BLOCKED` | integrity | `errors.zipTraversal` | `remedy.reportBug` | malicious entry |
| `SNAPSHOT_NOT_FOUND` | user | `errors.snapshotNotFound` | `remedy.refreshList` | pruned/deleted |
| `ALREADY_RESTORED` | info | `errors.alreadyRestored` | `remedy.none` | idempotent rollback |
| `SNAPSHOT_FAILED` | environment | `errors.snapshotFailed` | `remedy.freeSpaceOrRetry` | write/verify failure |
| `PID_VERIFICATION_FAILED` | security | `errors.pidVerification` | `remedy.rescan` | recycled PID |
| `PROCESS_GONE` | info | `errors.processGone` | `remedy.rescan` | exited before kill |
| `SERVICE_UNAVAILABLE` | environment | `errors.serviceUnavailable` | `remedy.checkService` | SCM failure |
| `TOOL_MISSING` | environment | `errors.toolMissing` | `remedy.installTool` | winget/sfc absent |
| `TIMEOUT` | environment | `errors.timeout` | `remedy.retryOrCancel` | per-action budget |
| `CANCELLED` | info | `errors.cancelled` | `remedy.none` | user cancel |
| `STORE_QUARANTINED` | environment | `errors.storeQuarantined` | `remedy.openTrustCenter` | corrupt DB |
| `SCHEMA_MIGRATION_FAILED` | environment | `errors.migrationFailed` | `remedy.createSupportBundle` | migration error |
| `DATABASE_BUSY` | environment | `errors.databaseBusy` | `remedy.retry` | lock contention |
| `NOT_IMPLEMENTED` | build | `errors.notImplemented` | `remedy.updateApp` | feature absent |
| `INTERNAL` | internal | `errors.internal` | `remedy.createSupportBundle` | unexpected |

Every one of these keys must exist in `en.json` and in all Tier A locales (`06-01` §6), verified
by the validator.

---

## 8. Headless CLI contract

Implemented. The grammar is `crates/zenith-core/src/cli.rs` (pure, unit-tested); dispatch is
`crates/zenith-core/src/engine/headless.rs`; the binary chooses between CLI and GUI in
`src-tauri/src/lib.rs::entry`.

```text
zenith.exe --headless --actions <csv> [--dry-run] [--json] [--yes] [--timeout-secs N]
zenith.exe --headless --diagnose [--json]
zenith.exe --headless --rollback <snapshot_id> [--json]
zenith.exe --support-bundle [--out <path>] [--json]
zenith.exe --help | --version
```

A bare `zenith.exe` opens the GUI. A handover launch (`--elevate --handover …`) is never treated
as a CLI invocation - resuming an elevated queue through a console would bypass the window's
confirmation path.

| Exit code | Meaning | Rust constant |
| :--- | :--- | :--- |
| 0 | all requested steps succeeded | `cli::exit::OK` |
| 1 | usage / argument error | `cli::exit::USAGE` |
| 2 | one or more steps failed (details in output) | `cli::exit::FAILED` |
| 3 | cancelled or timed out | `cli::exit::CANCELLED` |
| 4 | elevation required and not elevated | `cli::exit::ELEVATION` |
| 5 | refused (dependency unmet, or the selection is not runnable headlessly) | `cli::exit::REFUSED` |

`--json` output shape (`engine::headless::Envelope`):

```json
{ "schemaVersion": 1, "correlationId": "…", "startedAtUtc": "…", "command": "actions", "results": [
  { "actionId": "flush-dns-cache", "status": "success", "durationMs": 812,
    "summaryKey": "outcomes.dnsFlushed", "snapshotId": "…" } ] }
```

`--dry-run` performs validation only, writes nothing, and exits 0 with `"dryRun": true`.

### 8.1 Refusal rule (REQ-F-084)

A selection containing an **irreversible, mutating** action is refused with exit 5 *before the
store is opened*, so the refusal cannot be masked by an unrelated database error.

The predicate is `tier == irreversible && !no_mutation`, not `risk == destructive`.
`empty-recycle-bin` is `risk: moderate` yet `tier: irreversible` - it permanently deletes user
files. Gating on risk alone would let a script destroy data with `--yes`, which is exactly the
silent-loss failure the tier model exists to prevent (ADR-004, `03-05` §4). `controlled-reboot`
(`risk: destructive`) is refused for the same reason plus its own.

### 8.2 Execution path

Repairs run through `pipeline::run` - the same privilege, confirmation, scope, snapshot and
free-space checks the GUI uses. The CLI adds no privileged shortcut. Actions are ordered by the
same DAG (`dag::topological_order`), so `sfc` cannot be run before `dism` because a CSV said so
(REQ-F-081). `--yes` supplies `Confirmation { acknowledged_tier: <the action's real tier> }`, so
`validate_execution` still refuses a mismatched claim.

### 8.3 Console behaviour

The binary is built as a **console-subsystem** application (`src-tauri/src/main.rs`), not
`windows_subsystem = "windows"`. This is required by the contract: `cmd.exe` does not wait for a
GUI-subsystem process, so `zenith.exe --headless --json > out.json` returned before the program wrote
and the file stayed empty - measured, not assumed (`13` bytes of `--version` output became `0`).
Console subsystem makes the shell wait and redirection work.

The cost of a console subsystem is a console window on a double-click launch, so `entry()` calls
`adapters::console::detach_for_gui()` (`FreeConsole`) before the window opens. A launch from an
existing console keeps that console and attaches through `attach_parent()` writing to `CONOUT$`;
a redirected or piped run inherits a valid stdout handle and needs neither.
`attach_parent` and `detach_for_gui` are the only `unsafe` blocks outside the Win32 adapters, and each
carries `// SAFETY:`.

### 8.4 Test coverage

`cargo test -p zenith-core --lib cli:: headless::` → 18 tests: grammar (modes, aliases, empty
values, unknown ids, dedup, timeout bounds, exit-code mapping, handover exclusion, CLI-shaped flags
without `--headless` still reaching the parser) and dispatch (help/version touch no store,
irreversible selection refused with 5 before any disk access, dry run reports without mutating).

---

## 9. Compatibility rules

| Change | Allowed in patch | Requires MAJOR |
| :--- | :--- | :--- |
| Add optional request field | PASS | |
| Add response field | PASS (clients ignore unknown) | |
| Add new command | PASS | |
| Add event `v: 2` | PASS (both versions emitted during migration) | |
| Rename command/event | | PASS |
| Change semantics of an existing field | | PASS |
| Remove field | | PASS |

The frontend declares the IPC version it expects in `AppInfo`; a mismatch shows a "please update"
screen rather than undefined behaviour.

---

## 10. Contract tests (Gate G5)

| Test | Asserts |
| :--- | :--- |
| T-CONTRACT-08 | Every command in this document exists in the Rust handler registry, and vice versa - executed by `node scripts/check-contract.mjs` |
| T-CONTRACT-08 | Every error code has `messageKey` + `remedyKey` in `en.json` |
| T-CONTRACT-09 | Every event payload validates against its JSON Schema |
| T-SEC-03 | Forged handover nonce rejected |
| T-SEC-07 | Standard-token `action_execute` on an admin action returns `ELEVATION_REQUIRED` |

Contract freeze: this document is the merge gate for WP-4 (backend) and WP-5 (frontend), which may
proceed in parallel. Neither side may rename anything here without an IPC MAJOR bump in §9.
