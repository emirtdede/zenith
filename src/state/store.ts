/**
 * The single store.
 *
 * `useReducer` rather than a state library: this app has one screen, one list and
 * five overlays, so a reducer is enough and it makes every transition testable
 * without a renderer. The reducer is pure; all I/O lives in `actions.ts`.
 *
 * Two rules encoded here:
 *
 * * A phase is only ever what the core reports. The reducer never invents
 *   `success` - it applies `phase_changed` and `action_execute` results.
 * * Errors are kept as `IpcError` objects with their correlation id, never as
 *   strings, so the UI can show the reference a support case needs.
 */

import type { ActionDef } from "../catalog.generated";
import type {
  ActionId,
  ActionPrefs,
  AppInfo,
  AppStateSnapshot,
  DiagnosticReport,
  IpcError,
  LogLine,
  SnapshotRecord,
  StartupNotice,
  SystemTelemetry,
  ThemeId,
  ExecutionPhase,
} from "../bridge/types";
import type { Preferences } from "../bridge/adapter";
import { SUPPORTED_LOCALES, negotiateLocale } from "../i18n";

/** Lines kept in the drawer. Matches the documented 5,000-line ring. */
export const LOG_LIMIT = 5_000;

/** Six screens, per `05-02` §3. */
export type ScreenId = "actions" | "snapshots" | "trust" | "settings" | "help" | "activity";

/** Five overlays, per `05-02` §4. Candidate scans use the fifth. */
export type OverlayId = "palette" | "confirm" | "script" | "candidates" | "purge";

export interface ConfirmState {
  actionId: ActionId;
  definition: ActionDef;
  report: DiagnosticReport | null;
}

export interface ScriptState {
  actionId: ActionId;
  format: "ps1" | "bat";
}

export interface State {
  boot: "loading" | "ready" | "failed";
  bootError: IpcError | null;

  info: AppInfo | null;
  locale: string;
  theme: ThemeId;
  reduceMotion: boolean;
  telemetryEnabled: boolean;
  actionPrefs: ActionPrefs;
  /** When true, hidden cards are shown again (session-only, per 05-02 §6). */
  showHidden: boolean;

  telemetry: SystemTelemetry | null;
  reports: Partial<Record<ActionId, DiagnosticReport>>;
  phases: Partial<Record<ActionId, ExecutionPhase>>;
  activeActionId: ActionId | null;

  /** Progress of the current diagnosis, or null when idle. */
  diagnose: { done: number; total: number } | null;

  logs: LogLine[];
  /** Lines the ring buffer dropped, so the drawer can say so. */
  droppedLogs: number;

  snapshots: SnapshotRecord[];
  retention: AppStateSnapshot["retention"] | null;
  sessionUptimeMs: number;
  /**
   * Renderer cold-start measurement in ms (REQ-N-001), or `null` when the User
   * Timing API was unavailable. `null` renders as "unknown", never as `0`.
   */
  bootMs: number | null;

  notices: StartupNotice[];
  dismissNotice: string[];
  error: IpcError | null;

  screen: ScreenId;
  consoleOpen: boolean;
  overlay: OverlayId | null;
  confirm: ConfirmState | null;
  script: ScriptState | null;
  candidateKind: "dev_ports" | "hung_office" | "print_jobs" | "wsl" | null;

  category: "all" | ActionDef["category"];
  search: string;
  focusedIndex: number;
}

export const initialState: State = {
  boot: "loading",
  bootError: null,
  info: null,
  locale: "en",
  theme: "off-white",
  reduceMotion: false,
  telemetryEnabled: false,
  actionPrefs: { pinned: [], hidden: [] },
  showHidden: false,
  telemetry: null,
  reports: {},
  phases: {},
  activeActionId: null,
  diagnose: null,
  logs: [],
  droppedLogs: 0,
  snapshots: [],
  retention: null,
  sessionUptimeMs: 0,
  bootMs: null,
  notices: [],
  dismissNotice: [],
  error: null,
  screen: "actions",
  consoleOpen: false,
  overlay: null,
  confirm: null,
  script: null,
  candidateKind: null,
  category: "all",
  search: "",
  focusedIndex: 0,
};

export type Action =
  | { type: "boot/failed"; error: IpcError }
  | {
      type: "boot/ready";
      info: AppInfo;
      snapshot: AppStateSnapshot;
      snapshots: SnapshotRecord[];
    }
  | { type: "boot/timed"; bootMs: number | null }
  | { type: "state/replaced"; snapshot: AppStateSnapshot }
  | { type: "diagnose/started"; total: number }
  | { type: "diagnose/progress"; done: number; total: number }
  | { type: "diagnose/finished" }
  | { type: "diagnose/reports"; reports: DiagnosticReport[] }
  | { type: "phase/changed"; actionId: ActionId; phase: ExecutionPhase }
  | { type: "telemetry/updated"; telemetry: SystemTelemetry | null }
  | { type: "log/appended"; lines: LogLine[] }
  | { type: "log/cleared" }
  | { type: "snapshots/replaced"; snapshots: SnapshotRecord[] }
  | { type: "snapshot/changed" }
  | { type: "notice/received"; notice: StartupNotice }
  | { type: "notice/dismissed"; id: string }
  | { type: "error/raised"; error: IpcError }
  | { type: "error/cleared" }
  | { type: "prefs/locale"; locale: string }
  | { type: "prefs/theme"; theme: ThemeId }
  | { type: "prefs/motion"; reduceMotion: boolean }
  | { type: "prefs/telemetry"; telemetryEnabled: boolean }
  | { type: "prefs/actionPrefs"; actionPrefs: ActionPrefs }
  | { type: "prefs/showHidden"; showHidden: boolean }
  | { type: "screen/set"; screen: ScreenId }
  | { type: "console/toggle"; open?: boolean }
  | { type: "overlay/open"; overlay: OverlayId }
  | { type: "overlay/close" }
  | { type: "confirm/open"; confirm: ConfirmState }
  | { type: "confirm/closed"; accepted: ActionId | null }
  | { type: "script/open"; script: ScriptState }
  | { type: "candidates/open"; kind: State["candidateKind"] }
  | { type: "category/set"; category: State["category"] }
  | { type: "search/set"; search: string }
  | { type: "focus/set"; index: number }
  | { type: "focus/move"; delta: number; count: number };

/** Append to the ring buffer and count what fell off the front. */
function appendLogs(existing: LogLine[], incoming: LogLine[]): {
  logs: LogLine[];
  dropped: number;
} {
  // Sequence numbers are monotonic per action. A gap means the core batched and
  // the UI was slow, which is worth surfacing rather than hiding.
  const combined = [...existing, ...incoming];
  if (combined.length <= LOG_LIMIT) {
    return { logs: combined, dropped: 0 };
  }
  const overflow = combined.length - LOG_LIMIT;
  return { logs: combined.slice(overflow), dropped: overflow };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "boot/failed":
      return { ...state, boot: "failed", bootError: action.error };

    case "boot/timed":
      return { ...state, bootMs: action.bootMs };

    case "boot/ready": {
      const { snapshot } = action;
      return {
        ...state,
        boot: "ready",
        info: action.info,
        locale: negotiateLocale(snapshot.locale),
        theme: snapshot.theme,
        reduceMotion: snapshot.reduceMotion,
        telemetryEnabled: snapshot.telemetryEnabled,
        actionPrefs: snapshot.actionPrefs,
        telemetry: snapshot.telemetry,
        phases: snapshot.phases,
        activeActionId: snapshot.activeActionId,
        snapshots: action.snapshots,
        retention: snapshot.retention,
        notices: snapshot.notices,
        sessionUptimeMs: snapshot.sessionUptimeMs,
      };
    }

    case "state/replaced":
      return {
        ...state,
        locale: negotiateLocale(action.snapshot.locale),
        theme: action.snapshot.theme,
        reduceMotion: action.snapshot.reduceMotion,
        telemetryEnabled: action.snapshot.telemetryEnabled,
        actionPrefs: action.snapshot.actionPrefs,
        telemetry: action.snapshot.telemetry ?? state.telemetry,
        phases: action.snapshot.phases,
        activeActionId: action.snapshot.activeActionId,
        retention: action.snapshot.retention,
        sessionUptimeMs: action.snapshot.sessionUptimeMs,
        notices: action.snapshot.notices,
      };

    case "diagnose/started":
      return {
        ...state,
        diagnose: { done: 0, total: action.total },
        // Optimistic phase is deliberately *not* set here: `diagnosing` arrives
        // through `phase_changed` from the core, so the two never disagree.
      };

    case "diagnose/progress":
      return {
        ...state,
        diagnose: { done: action.done, total: action.total },
      };

    case "diagnose/finished":
      return { ...state, diagnose: null };

    case "diagnose/reports": {
      const reports = { ...state.reports };
      for (const report of action.reports) {
        reports[report.actionId] = report;
      }
      return { ...state, reports };
    }

    case "phase/changed":
      return {
        ...state,
        phases: { ...state.phases, [action.actionId]: action.phase },
        activeActionId:
          action.phase === "running" || action.phase === "diagnosing"
            ? action.actionId
            : state.activeActionId === action.actionId
              ? null
              : state.activeActionId,
      };

    case "telemetry/updated":
      return { ...state, telemetry: action.telemetry };

    case "log/appended": {
      const { logs, dropped } = appendLogs(state.logs, action.lines);
      return { ...state, logs, droppedLogs: state.droppedLogs + dropped };
    }

    case "log/cleared":
      return { ...state, logs: [], droppedLogs: 0 };

    case "snapshots/replaced":
      return { ...state, snapshots: action.snapshots };

    case "snapshot/changed":
      // The payload names the snapshot; the list is re-fetched by the caller
      // because a prune event removes rows this reducer cannot reconstruct.
      return state;

    case "notice/received":
      if (state.notices.some((notice) => notice.id === action.notice.id)) {
        return state;
      }
      return { ...state, notices: [...state.notices, action.notice] };

    case "notice/dismissed":
      return { ...state, dismissNotice: [...state.dismissNotice, action.id] };

    case "error/raised":
      return { ...state, error: action.error };

    case "error/cleared":
      return { ...state, error: null };

    case "prefs/locale": {
      // Only a locale with a catalogue may become active; otherwise the UI
      // would switch `document.lang` to a language it cannot render.
      if (!SUPPORTED_LOCALES.includes(action.locale)) {
        return state;
      }
      return { ...state, locale: action.locale };
    }

    case "prefs/theme":
      return { ...state, theme: action.theme };

    case "prefs/motion":
      return { ...state, reduceMotion: action.reduceMotion };

    case "prefs/telemetry":
      return { ...state, telemetryEnabled: action.telemetryEnabled };

    case "prefs/actionPrefs":
      return { ...state, actionPrefs: action.actionPrefs };

    case "prefs/showHidden":
      return { ...state, showHidden: action.showHidden };

    case "screen/set":
      return { ...state, screen: action.screen, overlay: null };

    case "console/toggle":
      return { ...state, consoleOpen: action.open ?? !state.consoleOpen };

    case "overlay/open":
      return { ...state, overlay: action.overlay };

    case "overlay/close":
      return { ...state, overlay: null, confirm: null, script: null, candidateKind: null };

    case "candidates/open":
      return {
        ...state,
        overlay: "candidates",
        candidateKind: action.kind,
      };

    case "confirm/open":
      return { ...state, confirm: action.confirm, overlay: "confirm" };

    case "confirm/closed":
      return { ...state, confirm: null, overlay: null };

    case "script/open":
      return { ...state, script: action.script, overlay: "script" };

    case "category/set":
      return { ...state, category: action.category, focusedIndex: 0 };

    case "search/set":
      return { ...state, search: action.search, focusedIndex: 0 };

    case "focus/set":
      return { ...state, focusedIndex: Math.max(0, action.index) };

    case "focus/move": {
      if (action.count <= 0) {
        return state;
      }
      const next = (state.focusedIndex + action.delta + action.count) % action.count;
      return { ...state, focusedIndex: next };
    }

    default:
      return state;
  }
}

/** Preferences derived from state, for the `preferences_set` call. */
export function preferencesOf(state: State): Preferences {
  return {
    locale: state.locale,
    theme: state.theme,
    reduceMotion: state.reduceMotion,
    telemetryEnabled: state.telemetryEnabled,
  };
}

/** Notices the user has not dismissed yet. */
export function visibleNotices(state: State): StartupNotice[] {
  return state.notices.filter((notice) => !state.dismissNotice.includes(notice.id));
}
