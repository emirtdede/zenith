/**
 * The one surface the UI is allowed to call.
 *
 * Two implementations satisfy it - `native.ts` (Tauri) and `simulator.ts`
 * (in-memory) - and every component receives it through context. ADR-012's
 * verification test walks the simulator's import graph and fails if `@tauri-apps`
 * appears, which is what makes "simulation cannot touch the OS" a fact rather
 * than a promise.
 *
 * Note what is *absent*: no filesystem, no shell, no arbitrary invoke. The
 * renderer cannot name a command that is not on this interface.
 */

export type { ActionPrefs, CandidateKind, CancelScope, IpcError } from "./types";

import type {
  ActionId,
  ActionPrefs,
  AppInfo,
  AppStateSnapshot,
  CancelResult,
  CancelScope,
  CandidateKind,
  Candidates,
  DiagnosticReport,
  ExecutionOutcome,
  IpcError,
  LogLine,
  PurgeSummary,
  RollbackOutcome,
  SavedFile,
  SnapshotRecord,
  SupportBundle,
  TerminateSummary,
  ThemeId,
  VerifiedPidTarget,
} from "./types";

export interface DiagnoseRequest {
  actionIds?: ActionId[];
  includeSlow?: boolean;
}

export interface ExecuteRequest {
  actionId: ActionId;
  confirmation?: { acknowledgedTier: string; typedCount?: number };
  options?: { targets?: VerifiedPidTarget[]; ports?: number[] };
}

export interface SaveTextRequest {
  suggestedName: string;
  content: string;
  format: "ps1" | "bat" | "csv" | "json";
}

export interface PurgeRequest {
  scope: "support" | "logs" | "snapshots" | "all";
  confirmToken: string;
  force?: boolean;
}

export interface HandoverRequest {
  resumeQueue: ActionId[];
  nextTheme: ThemeId;
  locale: string;
}

/** Event payloads, exactly as `03-04` §6 defines them. */
export interface EventMap {
  phase_changed: {
    v: 1;
    actionId: ActionId;
    phase: ExecutionOutcome["phase"];
    atUtc: string;
  };
  terminal_log: { v: 1; actionId: ActionId; lines: LogLine[] };
  diagnose_progress: { v: 1; completed: number; total: number; actionId: ActionId };
  telemetry_update: { v: 1; telemetry: AppStateSnapshot["telemetry"] };
  snapshot_changed: {
    v: 1;
    snapshotId: string;
    kind: "created" | "restored" | "broken" | "pruned";
  };
  startup_notice: { v: 1; notice: AppStateSnapshot["notices"][number] };
}

export type EventName = keyof EventMap;

export interface Unlisten {
  (): void;
}

/**
 * The three controls an undecorated window has to draw for itself.
 *
 * The window is `decorations: false` so the app can own its whole surface, the
 * way the desktop tools it is measured against do. That removes the OS title
 * bar - and with it the minimise, maximise and close buttons - so the renderer
 * has to provide them. They live on this interface rather than being called
 * from a component for the same reason every other privileged call does:
 * `native.ts` is the only module allowed to import `@tauri-apps/api`, and the
 * simulator must be able to answer without one (`check:simulator`).
 *
 * `isMaximized` and `onMaximizedChange` are not decoration either: the
 * maximise button has to *look* like a restore button while the window is
 * maximised, and a double click on the drag region changes that state without
 * going through the button at all.
 */
export interface WindowControl {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  /** Fires whenever the OS reports a new maximised state. */
  onMaximizedChange(handler: (maximized: boolean) => void): Promise<Unlisten>;
}

export interface Bridge {
  /** `true` when a native host is answering, `false` for the simulator. */
  readonly native: boolean;
  readonly kind: "native" | "simulator";

  /**
   * Window chrome. A window without decorations has no OS buttons, so these
   * are the app's own. The simulator answers them as no-ops, because a browser
   * tab has no window to minimise.
   */
  readonly windowControl: WindowControl;

  appInfo(): Promise<AppInfo>;
  state(): Promise<AppStateSnapshot>;
  diagnose(request?: DiagnoseRequest): Promise<DiagnosticReport[]>;
  execute(request: ExecuteRequest): Promise<ExecutionOutcome>;
  cancel(scope: CancelScope): Promise<CancelResult>;
  snapshots(limit?: number): Promise<SnapshotRecord[]>;
  rollback(snapshotId: string): Promise<RollbackOutcome>;
  candidates(kind: CandidateKind): Promise<Candidates>;
  terminate(actionId: ActionId, targets: VerifiedPidTarget[]): Promise<TerminateSummary>;
  saveText(request: SaveTextRequest): Promise<SavedFile>;
  supportBundle(note?: string): Promise<SupportBundle>;
  purge(request: PurgeRequest): Promise<PurgeSummary>;
  requestElevation(request: HandoverRequest): Promise<void>;

  /** Settings live outside the IPC contract on purpose: they are UI state. */
  savePreferences(patch: PreferencesPatch): Promise<void>;

  /** Replace the complete per-action pin/hide set (`03-04` §5.15). */
  actionPrefs(prefs: ActionPrefs): Promise<ActionPrefs>;

  on<E extends EventName>(event: E, handler: (payload: EventMap[E]) => void): Promise<Unlisten>;
}

export interface Preferences {
  locale: string;
  theme: ThemeId;
  reduceMotion: boolean;
  telemetryEnabled: boolean;
  /**
   * The extended settings document as JSON. The core stores it verbatim and
   * returns it through `state_get`; it never parses it, because the renderer
   * owns the shape and the core only owns the file. A separate field rather
   * than a new command keeps the contract table unchanged and the write atomic
   * with the four values that must be read during boot.
   */
  settings?: string;
}

/**
 * A partial update to `Preferences`.
 *
 * Mirrors `PreferencesPatch` in `src-tauri/src/commands.rs`, where every field
 * is `Option`. A caller that wants to change the theme must not have to know the
 * current telemetry flag - and must not overwrite it with a value it read three
 * screens ago.
 */
export type PreferencesPatch = Partial<Preferences>;

/** Shape of a rejected call: always an `IpcError`, never a bare string. */
export function isIpcError(value: unknown): value is IpcError {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "messageKey" in value &&
    "correlationId" in value
  );
}

/**
 * Normalise anything a bridge rejects with into an `IpcError`.
 *
 * `native.ts` already converts a panic or a missing command into this shape, so
 * in practice this is a cast. It exists for the callers that catch a value they
 * did not create - boot, every action, and the candidate scan - because
 * `instanceof Error` is **false** for the wire shape, and a catch that falls
 * back to `String(value)` renders `[object Object]` to the user (DEF-107).
 *
 * There is one implementation on purpose: this was copied into `actions.ts`,
 * `App.tsx` and the scan dialog, and the third copy is the one that shipped the
 * bug.
 */
export function asIpcError(error: unknown): IpcError {
  if (isIpcError(error)) {
    return error;
  }
  return {
    code: "INTERNAL",
    messageKey: "errors.internal",
    remedyKey: "remedy.createSupportBundle",
    params: {},
    correlationId: "unavailable",
    detail: error instanceof Error ? error.message : String(error),
  };
}
