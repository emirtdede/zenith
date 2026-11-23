/**
 * The wire surface of `03-04` §2-§4, transcribed once.
 *
 * Nothing in the UI invents a field. If a screen needs data the contract does
 * not carry, the contract changes first - that rule is what keeps a "diagnostic
 * app" from quietly becoming a spyware app with a snapshot feature.
 */

import type { ActionId } from "../catalog.generated";

export type { ActionId };

export type ReversibilityTier =
  | "fully_reversible"
  | "partially_reversible"
  | "compensating_recovery"
  | "irreversible";

export type Risk = "safe" | "moderate" | "destructive";

export type Category = "cleanup" | "network" | "recovery" | "dev_office";

export type ExecutionPhase =
  | "idle"
  | "diagnosing"
  | "healthy"
  | "needs_attention"
  | "running"
  | "success"
  | "error"
  | "skipped_dependency"
  | "cancelled"
  | "rolled_back";

export type ThemeId = "off-white" | "true-black" | "spatial-glass";

export interface IpcError {
  code: string;
  messageKey: string;
  remedyKey: string;
  params: Record<string, string | number>;
  correlationId: string;
  detail?: string;
}

export interface AppInfo {
  version: string;
  buildCommit: string;
  tauriVersion: string;
  /**
   * The WebView2 version, or `null` when it could not be asked.
   *
   * `null` and not `"unknown"`: the English literal crossed the wire and was
   * printed verbatim, so a Turkish UI said "WebView: unknown" (DEF-128).
   */
  webviewVersion: string | null;
  /**
   * The OS build, or `null` when the core could not read it.
   *
   * `null` and not `0`: `0` was sent when the registry read failed, and the
   * Trust Center printed it as a build number - a version invented from a
   * failed read (DEF-127). The screen renders `-` for `null`.
   */
  osBuild: number | null;
  osDisplayVersion: string | null;
  arch: string;
  isElevated: boolean;
  signature: { status: "valid" | "unsigned" | "invalid" | "unknown"; publisher?: string };
  storePath: string;
  storeMode: "machine" | "user_fallback";
  simulator: boolean;
}

export interface HealthBreakdown {
  junk: number;
  dns: number;
  memory: number;
  issues: number;
}

export interface SystemTelemetry {
  healthScore: number;
  junkBytes: number;
  dnsLatencyMs: number | null;
  memoryUsedMb: number;
  memoryTotalMb: number;
  /**
   * Measured memory use, or `null` when the reading could not be taken.
   *
   * `null` and not `0`: a failed read used to arrive as zero and render as
   * "0 %" - the most reassuring figure on the strip - and the score treated it
   * as a free pass. The DNS field beside it already had the honest shape.
   */
  memoryUsedPercent: number | null;
  issueCount: number;
  issueIds: ActionId[];
  osBuild: number;
  win10EsuWarning: boolean;
  measuredAtUtc: string;
  breakdown: HealthBreakdown;
}

export interface DiagnosticReport {
  actionId: ActionId;
  needsAttention: boolean;
  severityWeight: 1 | 2 | 3;
  metricKey: string;
  metricParams: Record<string, string | number>;
  reclaimableBytes: number;
  latencyMs: number | null;
  tier: ReversibilityTier;
  canRollback: boolean;
  readOnly: boolean;
  measuredAtUtc: string;
}

export type StepStatus = "success" | "error" | "skipped";

export interface StepResult {
  stepKey: string;
  status: StepStatus;
  errorCode?: string | null;
  params: Record<string, string>;
}

export interface ExecutionOutcome {
  actionId: ActionId;
  phase: ExecutionPhase;
  success: boolean;
  durationMs: number;
  summaryKey: string;
  summaryParams: Record<string, string>;
  beforeKey: string;
  beforeParams: Record<string, string>;
  afterKey: string;
  afterParams: Record<string, string>;
  snapshotId: string | null;
  tier: ReversibilityTier;
  requiresReboot: boolean;
  abortable: boolean;
  triggerEffect: string | null;
  correlationId: string;
  steps: StepResult[];
}

export interface StartupNotice {
  id: string;
  severity: "info" | "warning" | "critical";
  messageKey: string;
  params: Record<string, string>;
}

export interface RetentionSummary {
  snapshots: number;
  snapshotBytes: number;
  auditRows: number;
}

/**
 * Presentation preferences for individual actions (`03-04` §5.15).
 *
 * `pinned` sorts first inside its category; `hidden` removes a card from the
 * default grid without removing the action from the product.
 */
export interface ActionPrefs {
  pinned: ActionId[];
  hidden: ActionId[];
}

export interface AppStateSnapshot {
  locale: string;
  theme: ThemeId;
  reduceMotion: boolean;
  telemetryEnabled: boolean;
  actionPrefs: ActionPrefs;
  phases: Partial<Record<ActionId, ExecutionPhase>>;
  activeActionId: ActionId | null;
  lastScanAtUtc: string | null;
  telemetry: SystemTelemetry | null;
  /**
   * `null` when the core could not read the store.
   *
   * "I could not measure it" is not "it is empty" (DEF-123). The core used to
   * build this with `unwrap_or_default()` / `unwrap_or(0)`, so an unreadable
   * database was reported as `0 snapshots (0 B), 0 audit rows` and the `null`
   * branch in `SnapshotsScreen` was unreachable in production.
   */
  retention: RetentionSummary | null;
  notices: StartupNotice[];
  sessionUptimeMs: number;
}

export interface SnapshotRecord {
  snapshotId: string;
  actionId: ActionId;
  createdAtUtc: string;
  tier: ReversibilityTier;
  snapshotType: string;
  isRestored: boolean;
  restoredAtUtc: string | null;
  estBytes: number;
  status: "committed" | "broken";
  summaryKey: string;
  summaryParams: Record<string, string>;
}

export interface RollbackOutcome {
  snapshotId: string;
  success: boolean;
  restoredItems: number;
  skippedItems: number;
  skippedReasons: { itemKey: string; reasonCode: string }[];
  durationMs: number;
  correlationId: string;
}

export interface PortListener {
  port: number;
  protocol: "TCP" | "TCP6";
  localAddress: string;
  pid: number;
  processName: string;
  startTimeUnixMs: number;
  commandLineRedacted: string;
  memoryMb: number;
  /** True when the listener is this Zenith process (`ports.self`). */
  isSelf: boolean;
}

/**
 * A windowed Office process the OS itself flags as hung.
 *
 * `windowTitleRaw` is document text written by another program. It is rendered
 * with `textContent` only, never as markup, and never used to build a selector.
 * `hungForMs` is a lower bound: Windows does not report a duration, only the
 * fact that the five-second threshold was crossed.
 */
export interface HungWindow {
  pid: number;
  processName: string;
  startTimeUnixMs: number;
  windowTitleRaw: string;
  memoryMb: number;
  hungForMs: number;
}

export interface PrintJob {
  jobId: number;
  printer: string;
  document: string;
  owner: string;
  pages: number;
  submittedAtUtc: string | null;
}

/**
 * `vmMemoryMb` is reported only when exactly one distribution is running. WSL2
 * shares a single utility VM, so splitting its working set across several
 * distros would be an invented figure; the UI shows "-" when it is null.
 */
export interface WslSession {
  distro: string;
  state: string;
  vmMemoryMb: number | null;
}

export type CandidateKind = "dev_ports" | "hung_office" | "print_jobs" | "wsl";

export type CandidateItem = PortListener | HungWindow | PrintJob | WslSession;

export interface Candidates {
  kind: CandidateKind;
  scannedAtUtc: string;
  items: CandidateItem[];
}

export interface VerifiedPidTarget {
  pid: number;
  expectedName: string;
  expectedStartTimeUnixMs: number;
}

export interface TerminateSummary {
  requested: number;
  terminated: number;
  results: {
    pid: number;
    /**
     * `refused_self` is a real outcome, not an error: the target was Zenith's
     * own process, which the core refuses unconditionally (DEF-090, `ports.self`).
     * Listed here so a renderer switch over the union stays exhaustive.
     */
    outcome: "terminated" | "identity_mismatch" | "access_denied" | "gone" | "refused_self";
  }[];
  correlationId: string;
}

export interface SavedFile {
  path: string | null;
  bytes: number;
}

export interface SupportBundle {
  path: string;
  bytes: number;
  includedFiles: string[];
  redactionReport: { maskedValues: number; scrubbedPaths: number };
}

export interface PurgeSummary {
  scopes: string[];
  deletedFiles: number;
  freedBytes: number;
  snapshotsRemoved: number;
  quarantinedKept: number;
  warnings: string[];
}

export interface CancelResult {
  cancelled: boolean;
  reason?: string;
}

/**
 * What `action_cancel` accepts.
 *
 * `diagnose`, `scan` and every `ActionId`. The two non-action scopes are named
 * here because each owns a distinct cancel token in the shell: cancelling a
 * diagnosis must not withdraw a scan's stop request, and neither may cancel a
 * running repair (`state.rs`). Before DEF-108 the union said `"diagnose" |
 * ActionId`, so a scan had no scope to name and borrowed the diagnosis token.
 */
export type CancelScope = "diagnose" | "scan" | ActionId;

export interface LogLine {
  seq: number;
  atUtc: string;
  level: "debug" | "info" | "warn" | "error";
  /** Support-facing technical text. Never rendered when `stepKey` resolves. */
  text: string;
  stepKey?: string;
  /**
   * Values for `stepKey`'s placeholders.
   *
   * Renderer-owned: the core never sets this, because its own lines take their
   * numbers from `params` on `StepResult`. The shell produces a handful of
   * lines of its own (a saved bundle path, an exported audit file) and those
   * need the same treatment as a core step, or a Turkish window shows English
   * (DEF-094).
   */
  params?: Record<string, string | number>;
}

/** Type guard so the UI can narrow `CandidateItem` without casting. */
export function isPortListener(item: CandidateItem): item is PortListener {
  return "port" in item && "localAddress" in item;
}

export function isHungWindow(item: CandidateItem): item is HungWindow {
  return "hungForMs" in item;
}

export function isPrintJob(item: CandidateItem): item is PrintJob {
  return "jobId" in item;
}

export function isWslSession(item: CandidateItem): item is WslSession {
  return "distro" in item;
}
