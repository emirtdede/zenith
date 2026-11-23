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
  ExecutionPhase,
} from "../bridge/types";
import type { Preferences } from "../bridge/adapter";
import { isSupportedLanguage } from "../i18n";
import { parseSettings } from "../settings/model";
import { isValidThemeId } from "../settings/themes";
import type { ThemeId } from "../settings/themes";
import type {
  AppSettings,
  SettingsTabId,
  TrashEntry,
} from "../settings/types";

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

export interface ToastMessage {
  id: string;
  tone: "info" | "success" | "warning" | "error";
  titleKey: string;
  bodyKey?: string;
  params?: Record<string, string | number>;
  /** Screen a click on the toast should open, when it has one. */
  screen?: string;
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

  /**
   * Everything the user can change. The core persists this document verbatim;
   * the four boot-critical prefs above mirror the fields the core also reads on
   * start, and both directions are written by `actions.updateSettings`.
   */
  settings: AppSettings;
  trash: TrashEntry[];
  settingsTab: SettingsTabId;
  /** True when a stored settings document had to be repaired. */
  settingsRepaired: boolean;
  /** Compact rail: icons only, with the labels kept in `aria-label`. */
  sidebarMinimal: boolean;
  locked: boolean;
  showOnboarding: boolean;
  online: boolean;
  toasts: ToastMessage[];

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

/**
 * Older builds stored one of three theme ids. They are not deleted on upgrade:
 * a user who chose `true-black` gets the dark obsidian palette, which is the
 * nearest thing the fourteen-palette system has to it, and `spatial-glass`
 * gets slate. Reading an unknown id falls back to the first palette rather than
 * leaving the window unpainted.
 */
export function resolveThemeId(value: unknown): ThemeId {
  if (typeof value !== "string") {
    return "obsidian";
  }
  if (isValidThemeId(value)) {
    return value;
  }
  if (value === "true-black") {
    return "obsidian";
  }
  if (value === "spatial-glass") {
    return "slate";
  }
  if (value === "off-white") {
    return "obsidian";
  }
  return "obsidian";
}

function legacyMode(value: unknown): "light" | "dark" | null {
  return value === "true-black" ? "dark" : value === "off-white" ? "light" : null;
}

/**
 * Merge the core's four preferences into the stored document.
 *
 * The document is the newer source for everything it covers, but the core also
 * validates these four on write and may hold a value the renderer has not saved
 * yet. Core wins only when the document has no opinion (first run after the
 * fourteen-palette migration), which is exactly when its value is the user's
 * previous choice.
 */
function settingsFromSnapshot(
  snapshot: AppStateSnapshot,
  fallback: AppSettings,
): { settings: AppSettings; trash: TrashEntry[]; repaired: boolean } {
  const parsed = parseSettings(snapshot.settings ?? null);
  const legacy = legacyMode(snapshot.theme);
  const themeId = legacy ? resolveThemeId(snapshot.theme) : parsed.settings.appearance.themeId;
  const settings: AppSettings = {
    ...parsed.settings,
    appearance: {
      ...parsed.settings.appearance,
      themeId,
      mode: legacy ?? parsed.settings.appearance.mode,
      reducedMotion: snapshot.reduceMotion || parsed.settings.appearance.reducedMotion,
    },
    general: {
      ...parsed.settings.general,
      locale: isSupportedLanguage(snapshot.locale)
        ? snapshot.locale
        : parsed.settings.general.locale,
    },
  };
  void fallback;
  return { settings, trash: parsed.trash, repaired: parsed.repaired };
}

/**
 * The document a first run starts from. One call site so `locale`, `theme` and
 * the document itself cannot disagree: detection reads the real `navigator`,
 * which means the operating system language is honoured on first launch instead
 * of a hard-coded "en" that would be overwritten on the next settings write.
 */
export const BOOT_DEFAULTS = parseSettings(null).settings;

export const initialState: State = {
  boot: "loading",
  bootError: null,
  info: null,
  locale: BOOT_DEFAULTS.general.locale,
  theme: BOOT_DEFAULTS.appearance.themeId,
  reduceMotion: BOOT_DEFAULTS.appearance.reducedMotion,
  telemetryEnabled: false,
  actionPrefs: { pinned: [], hidden: [] },
  showHidden: false,
  settings: BOOT_DEFAULTS,
  trash: [],
  settingsTab: "appearance",
  settingsRepaired: false,
  sidebarMinimal: BOOT_DEFAULTS.general.sidebarMinimal,
  locked: false,
  showOnboarding: false,
  online: true,
  toasts: [],
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

let toastSeq = 0;

function nextToastId(): string {
  toastSeq += 1;
  return `toast-${toastSeq}`;
}

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
  | { type: "settings/replaced"; settings: AppSettings; trash: TrashEntry[]; repaired?: boolean }
  | { type: "settings/set"; settings: AppSettings }
  | { type: "settings/section"; section: keyof AppSettings; patch: Record<string, unknown> }
  | { type: "trash/replaced"; trash: TrashEntry[] }
  | { type: "settings/tab"; tab: SettingsTabId }
  | { type: "sidebar/minimal"; minimal: boolean }
  | { type: "lock/set"; locked: boolean }
  | { type: "onboarding/open" }
  | { type: "onboarding/close" }
  | { type: "online/set"; online: boolean }
  | {
      type: "toast/push";
      toast: Omit<ToastMessage, "id">;
    }
  | { type: "toast/dismiss"; id: string }
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

/** Project the settings document onto the fields the shell reads directly. */
function withSettings(state: State, settings: AppSettings): State {
  return {
    ...state,
    settings,
    locale: settings.general.locale,
    theme: settings.appearance.themeId,
    reduceMotion: settings.appearance.reducedMotion,
  };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "boot/failed":
      return { ...state, boot: "failed", bootError: action.error };

    case "boot/timed":
      return { ...state, bootMs: action.bootMs };

    case "boot/ready": {
      const { snapshot } = action;
      const derived = settingsFromSnapshot(snapshot, state.settings);
      const base = withSettings(state, derived.settings);
      return {
        ...base,
        boot: "ready",
        info: action.info,
        telemetryEnabled: snapshot.telemetryEnabled,
        actionPrefs: snapshot.actionPrefs,
        telemetry: snapshot.telemetry,
        phases: snapshot.phases,
        activeActionId: snapshot.activeActionId,
        snapshots: action.snapshots,
        retention: snapshot.retention,
        notices: snapshot.notices,
        sessionUptimeMs: snapshot.sessionUptimeMs,
        trash: derived.trash,
        settingsRepaired: derived.repaired,
        showOnboarding: !derived.settings.onboarding.completed,
        sidebarMinimal: derived.settings.general.sidebarMinimal,
        locked: derived.settings.security.pin !== null,
      };
    }

    case "state/replaced": {
      const derived = settingsFromSnapshot(action.snapshot, state.settings);
      return {
        ...withSettings(state, derived.settings),
        telemetryEnabled: action.snapshot.telemetryEnabled,
        actionPrefs: action.snapshot.actionPrefs,
        telemetry: action.snapshot.telemetry ?? state.telemetry,
        phases: action.snapshot.phases,
        activeActionId: action.snapshot.activeActionId,
        retention: action.snapshot.retention,
        sessionUptimeMs: action.snapshot.sessionUptimeMs,
        notices: action.snapshot.notices,
        trash: derived.trash,
      };
    }

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
      // Only a locale the registry offers may become active; otherwise the UI
      // would switch `document.lang` to a language it cannot render.
      if (!isSupportedLanguage(action.locale)) {
        return state;
      }
      return withSettings(state, {
        ...state.settings,
        general: { ...state.settings.general, locale: action.locale },
      });
    }

    case "prefs/theme":
      return withSettings(state, {
        ...state.settings,
        appearance: { ...state.settings.appearance, themeId: action.theme },
      });

    case "prefs/motion":
      return {
        ...state,
        reduceMotion: action.reduceMotion,
        settings: {
          ...state.settings,
          appearance: { ...state.settings.appearance, reducedMotion: action.reduceMotion },
        },
      };

    case "prefs/telemetry":
      return { ...state, telemetryEnabled: action.telemetryEnabled };

    case "prefs/actionPrefs":
      return { ...state, actionPrefs: action.actionPrefs };

    case "prefs/showHidden":
      return { ...state, showHidden: action.showHidden };

    case "settings/replaced":
      return {
        ...withSettings(state, action.settings),
        trash: action.trash,
        settingsRepaired: action.repaired ?? state.settingsRepaired,
      };

    case "settings/set":
      return withSettings(state, action.settings);

    case "settings/section": {
      const current = state.settings[action.section];
      const merged = {
        ...state.settings,
        [action.section]: { ...(current as Record<string, unknown>), ...action.patch },
      } as AppSettings;
      return withSettings(state, merged);
    }

    case "trash/replaced":
      return { ...state, trash: action.trash };

    case "settings/tab":
      return { ...state, settingsTab: action.tab };

    case "sidebar/minimal":
      return {
        ...state,
        sidebarMinimal: action.minimal,
        settings: {
          ...state.settings,
          general: { ...state.settings.general, sidebarMinimal: action.minimal },
        },
      };

    case "lock/set":
      return { ...state, locked: action.locked };

    case "onboarding/open":
      return { ...state, showOnboarding: true };

    case "onboarding/close":
      return {
        ...state,
        showOnboarding: false,
        settings: {
          ...state.settings,
          onboarding: {
            completed: true,
            completedAtUtc: new Date().toISOString(),
            stepsDone: 6,
          },
        },
      };

    case "online/set":
      return { ...state, online: action.online };

    case "toast/push": {
      const toast: ToastMessage = { ...action.toast, id: nextToastId() };
      // Five is the most that fits above the status bar without covering the
      // content it is reporting on.
      const toasts = [...state.toasts, toast].slice(-5);
      return { ...state, toasts };
    }

    case "toast/dismiss":
      return { ...state, toasts: state.toasts.filter((toast) => toast.id !== action.id) };

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
