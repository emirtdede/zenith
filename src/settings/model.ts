/**
 * Settings: defaults, validation and persistence mapping.
 *
 * The four boot-critical preferences (locale, theme hint, reduced motion,
 * telemetry consent) are owned by the Rust core and reach the UI through
 * `state_get`. Everything else - notification channels, shortcuts, the trash
 * window, the PIN record - is one JSON document that the core stores verbatim
 * in the same preferences file under `settings`. The renderer therefore still
 * owns no storage, and a user who moves to a new Windows profile gets their
 * settings back through the same file the core already maintains.
 *
 * Every value that crosses back in is validated. A stored file is user-writable
 * and may have been edited, truncated by a disk-full or written by a future
 * build; reading it must not be able to put the UI into a state no control can
 * leave.
 */

import { SUPPORTED_LANGUAGES, resolveSystemLanguage } from "../i18n/languages";
import {
  DEFAULT_ACCENT,
  isValidHexColor,
  isValidThemeId,
  normalizeHexColor,
  clampZoomPercent,
} from "./themes";
import { SHORTCUTS, defaultShortcuts, normalizeShortcut } from "./shortcuts";
import type {
  AppSettings,
  AppearanceSettings,
  AppIconId,
  CloseBehavior,
  DataSettings,
  GeneralSettings,
  NotificationChannel,
  NotificationKind,
  NotificationProfileId,
  NotificationSettings,
  OnboardingState,
  SecuritySettings,
  IntegrationSettings,
  WebhookEvent,
  TrashEntry,
  UpdateSettings,
  ClockFormat,
  DateFormatStyle,
} from "./types";
import { SETTINGS_SCHEMA_VERSION } from "./types";

export const APP_ICONS: readonly AppIconId[] = ["match-theme", "mono-dark", "mono-light", "accent"];
export const CLOSE_BEHAVIORS: readonly CloseBehavior[] = ["ask", "tray", "quit"];
export const CLOCK_FORMATS: readonly ClockFormat[] = ["auto", "12h", "24h"];
export const DATE_FORMATS: readonly DateFormatStyle[] = ["auto", "iso", "dmy", "mdy"];

export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  "action-complete",
  "action-failed",
  "diagnosis-ready",
  "snapshot-created",
  "reminder",
  "update-available",
  "system",
];

export const NOTIFICATION_PROFILES: readonly NotificationProfileId[] = [
  "balanced",
  "everything",
  "focus",
  "in-app-only",
];

const PROFILE_MATRIX: Record<NotificationProfileId, Record<NotificationKind, NotificationChannel>> = {
  balanced: {
    "action-complete": "both",
    "action-failed": "both",
    "diagnosis-ready": "in-app",
    "snapshot-created": "in-app",
    reminder: "both",
    "update-available": "in-app",
    system: "in-app",
  },
  everything: {
    "action-complete": "both",
    "action-failed": "both",
    "diagnosis-ready": "both",
    "snapshot-created": "both",
    reminder: "both",
    "update-available": "both",
    system: "both",
  },
  focus: {
    "action-complete": "in-app",
    "action-failed": "both",
    "diagnosis-ready": "none",
    "snapshot-created": "none",
    reminder: "in-app",
    "update-available": "in-app",
    system: "in-app",
  },
  "in-app-only": {
    "action-complete": "in-app",
    "action-failed": "in-app",
    "diagnosis-ready": "in-app",
    "snapshot-created": "in-app",
    reminder: "in-app",
    "update-available": "in-app",
    system: "in-app",
  },
};

export function channelsForProfile(profile: NotificationProfileId): Record<NotificationKind, NotificationChannel> {
  return { ...PROFILE_MATRIX[profile] };
}

/* ---------------------------------------------------------- first run ---- */

/**
 * Detect what the operating system already knows.
 *
 * Three facts are worth inheriting on first run: the language, whether the user
 * asked for a dark theme, and which side the date goes on. Guessing the date
 * order from the locale is what stops a Turkish user from reading `03/04/2026`
 * as April, and reading the media query is what stops a bright window opening
 * at 2 am for someone who has used dark mode for years.
 */
export function detectSystemLanguage(
  candidates?: readonly string[] | null,
): string {
  return resolveSystemLanguage(candidates, "en");
}

export function detectSystemMode(): "light" | "dark" {
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }
  return "light";
}

export function detectDateFormat(locale: string): DateFormatStyle {
  const region = locale.toLowerCase();
  if (region.startsWith("en-us") || region.startsWith("en-ph")) {
    return "mdy";
  }
  if (/^(ja|ko|zh|hu|lt|sv|mn|fa)/.test(region)) {
    return "iso";
  }
  return "dmy";
}

function systemCandidates(): readonly string[] {
  if (typeof navigator === "undefined") {
    return [];
  }
  const languages = navigator.languages;
  if (Array.isArray(languages) && languages.length > 0) {
    return languages;
  }
  return navigator.language ? [navigator.language] : [];
}

export function createDefaultSettings(): AppSettings {
  const locale = detectSystemLanguage(systemCandidates());
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    appearance: {
      themeId: "obsidian",
      mode: "system",
      customColor: DEFAULT_ACCENT,
      appIcon: "match-theme",
      zoomPercent: 100,
      highContrast: false,
      reducedMotion: false,
    },
    general: {
      locale,
      closeBehavior: "ask",
      launchAtStartup: false,
      dragDropLocked: true,
      sidebarMinimal: false,
      clockFormat: "auto",
      dateFormat: detectDateFormat(locale),
      confirmDestructive: true,
    },
    notifications: {
      profile: "balanced",
      channels: channelsForProfile("balanced"),
      reminderLeadMinutes: 10,
      sound: false,
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
    },
    security: {
      pin: null,
      lockOnMinimize: false,
      lockTimeoutMinutes: 0,
    },
    data: {
      cloudSyncPath: "",
      autoBackup: false,
      trashRetentionDays: 30,
      exportIncludesLogs: false,
    },
    updates: {
      channel: "github",
      autoCheck: true,
      lastCheckedUtc: null,
      skippedVersion: null,
    },
    integrations: {
      cliInstalled: false,
      mcpEnabled: false,
      webhookEnabled: false,
      webhookUrl: "",
      webhookEvents: ["completed", "failed"],
    },
    shortcuts: defaultShortcuts(),
    onboarding: { completed: false, completedAtUtc: null, stepsDone: 0 },
  };
}

/* -------------------------------------------------------- validation ---- */

const HEX = /^#[0-9a-f]{6}$/;
const HHMM = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

type Json = Record<string, unknown>;

function asObject(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function enumOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function intIn(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return fallback;
  }
  return value;
}

function timeOf(value: unknown, fallback: string): string {
  return typeof value === "string" && HHMM.test(value) ? value : fallback;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : value;
}

export function normalizeAppearance(raw: unknown, base: AppearanceSettings): AppearanceSettings {
  const value = asObject(raw);
  const themeId = typeof value.themeId === "string" && (isValidThemeId(value.themeId) || value.themeId === "custom")
    ? value.themeId
    : base.themeId;
  const custom = normalizeHexColor(str(value.customColor, base.customColor)) ?? DEFAULT_ACCENT;
  return {
    themeId,
    mode: enumOf(value.mode, ["light", "dark", "system"] as const, base.mode),
    customColor: custom,
    appIcon: enumOf(value.appIcon, APP_ICONS, base.appIcon),
    zoomPercent: clampZoomPercent(value.zoomPercent ?? base.zoomPercent),
    highContrast: bool(value.highContrast, base.highContrast),
    reducedMotion: bool(value.reducedMotion, base.reducedMotion),
  };
}

export function normalizeGeneral(raw: unknown, base: GeneralSettings): GeneralSettings {
  const value = asObject(raw);
  const localeRaw = str(value.locale, base.locale);
  const locale = SUPPORTED_LANGUAGES.some((language) => language.code === localeRaw) ? localeRaw : base.locale;
  return {
    locale,
    closeBehavior: enumOf(value.closeBehavior, CLOSE_BEHAVIORS, base.closeBehavior),
    launchAtStartup: bool(value.launchAtStartup, base.launchAtStartup),
    dragDropLocked: bool(value.dragDropLocked, base.dragDropLocked),
    sidebarMinimal: bool(value.sidebarMinimal, base.sidebarMinimal),
    clockFormat: enumOf(value.clockFormat, CLOCK_FORMATS, base.clockFormat),
    dateFormat: enumOf(value.dateFormat, DATE_FORMATS, base.dateFormat),
    confirmDestructive: bool(value.confirmDestructive, base.confirmDestructive),
  };
}

export function normalizeNotifications(
  raw: unknown,
  base: NotificationSettings,
): NotificationSettings {
  const value = asObject(raw);
  const profile = enumOf(value.profile, NOTIFICATION_PROFILES, base.profile);
  const rawChannels = asObject(value.channels);
  const channels = {} as Record<NotificationKind, NotificationChannel>;
  for (const kind of NOTIFICATION_KINDS) {
    channels[kind] = enumOf(
      rawChannels[kind],
      ["in-app", "native", "both", "none"] as const,
      PROFILE_MATRIX[profile][kind],
    );
  }
  return {
    profile,
    channels,
    reminderLeadMinutes: intIn(value.reminderLeadMinutes, 0, 120, base.reminderLeadMinutes),
    sound: bool(value.sound, base.sound),
    quietHoursStart: timeOf(value.quietHoursStart, base.quietHoursStart),
    quietHoursEnd: timeOf(value.quietHoursEnd, base.quietHoursEnd),
  };
}

export function normalizeSecurity(raw: unknown, base: SecuritySettings): SecuritySettings {
  const value = asObject(raw);
  const pinRaw = value.pin;
  const pin =
    typeof pinRaw === "object" && pinRaw !== null
      ? (() => {
          const record = asObject(pinRaw);
          const kind = enumOf(record.kind, ["pin", "password"] as const, "pin");
          const digitsRaw = typeof record.digits === "number" ? record.digits : NaN;
          const digits: 4 | 6 | 8 | 0 =
            digitsRaw === 4 || digitsRaw === 6 || digitsRaw === 8
              ? digitsRaw
              : kind === "pin"
                ? 4
                : 0;
          const algorithm = enumOf(record.algorithm, ["PBKDF2-SHA256"] as const, "PBKDF2-SHA256");
          const salt = str(record.saltB64, "");
          const hash = str(record.hashB64, "");
          if (!salt || !hash) {
            return null;
          }
          return {
            kind,
            digits,
            algorithm,
            iterations: intIn(record.iterations, 100_000, 2_000_000, 600_000),
            saltB64: salt,
            hashB64: hash,
            createdAtUtc: isoOrNull(record.createdAtUtc) ?? new Date(0).toISOString(),
            failedAttempts: intIn(record.failedAttempts, 0, 5, 0),
            lockedUntilUtc: isoOrNull(record.lockedUntilUtc),
          };
        })()
      : null;
  return {
    pin,
    lockOnMinimize: bool(value.lockOnMinimize, base.lockOnMinimize),
    lockTimeoutMinutes: intIn(value.lockTimeoutMinutes, 0, 120, base.lockTimeoutMinutes),
  };
}

export function normalizeData(raw: unknown, base: DataSettings): DataSettings {
  const value = asObject(raw);
  return {
    cloudSyncPath: str(value.cloudSyncPath, base.cloudSyncPath).slice(0, 512),
    autoBackup: bool(value.autoBackup, base.autoBackup),
    trashRetentionDays: intIn(value.trashRetentionDays, 1, 365, base.trashRetentionDays),
    exportIncludesLogs: bool(value.exportIncludesLogs, base.exportIncludesLogs),
  };
}

export function normalizeUpdates(raw: unknown, base: UpdateSettings): UpdateSettings {
  const value = asObject(raw);
  return {
    channel: enumOf(value.channel, ["github", "store"] as const, base.channel),
    autoCheck: bool(value.autoCheck, base.autoCheck),
    lastCheckedUtc: isoOrNull(value.lastCheckedUtc),
    skippedVersion: typeof value.skippedVersion === "string" ? value.skippedVersion.slice(0, 32) : null,
  };
}

export function normalizeShortcuts(raw: unknown, base: Record<string, string>): Record<string, string> {
  const value = asObject(raw);
  const out: Record<string, string> = {};
  for (const shortcut of SHORTCUTS) {
    const stored = value[shortcut.id];
    const normalized = typeof stored === "string" ? normalizeShortcut(stored) : "";
    out[shortcut.id] = normalized || base[shortcut.id] || shortcut.defaultKeys;
  }
  return out;
}

export function normalizeIntegrations(raw: unknown, base: IntegrationSettings): IntegrationSettings {
  const value = asObject(raw);
  const events = Array.isArray(value.webhookEvents)
    ? (value.webhookEvents.filter(
        (item): item is WebhookEvent =>
          item === "completed" || item === "failed" || item === "rollback",
      ) as WebhookEvent[])
    : base.webhookEvents;
  const url = str(value.webhookUrl, base.webhookUrl).slice(0, 512);
  return {
    cliInstalled: bool(value.cliInstalled, base.cliInstalled),
    mcpEnabled: bool(value.mcpEnabled, base.mcpEnabled),
    webhookEnabled: bool(value.webhookEnabled, base.webhookEnabled) && /^https:\/\/\S+$/.test(url),
    webhookUrl: /^https:\/\/\S+$/.test(url) ? url : "",
    webhookEvents: events,
  };
}

export function normalizeOnboarding(raw: unknown, base: OnboardingState): OnboardingState {
  const value = asObject(raw);
  return {
    completed: bool(value.completed, base.completed),
    completedAtUtc: isoOrNull(value.completedAtUtc) ?? (base.completed ? base.completedAtUtc : null),
    stepsDone: intIn(value.stepsDone, 0, 6, base.stepsDone),
  };
}

export function normalizeTrash(raw: unknown): TrashEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: TrashEntry[] = [];
  for (const item of raw.slice(0, 200)) {
    const value = asObject(item);
    const id = str(value.id, "");
    const deleted = isoOrNull(value.deletedAtUtc);
    const expires = isoOrNull(value.expiresAtUtc);
    if (!id || !deleted || !expires) {
      continue;
    }
    out.push({
      id,
      kind: enumOf(value.kind, ["snapshot", "history", "note", "setting"] as const, "note"),
      titleKey: str(value.titleKey, "trash.unknown"),
      titleParams: asObject(value.titleParams) as Record<string, string | number>,
      deletedAtUtc: deleted,
      expiresAtUtc: expires,
      payload: asObject(value.payload),
    });
  }
  return out;
}

export interface ParsedSettings {
  settings: AppSettings;
  trash: TrashEntry[];
  /** True when the stored document had to be repaired or ignored. */
  repaired: boolean;
}

/**
 * Read the stored document.
 *
 * A missing document is the first run, not a fault. A malformed one is a fault
 * that must not cost the user their other preferences: each section is
 * normalised independently against the defaults, so a corrupted notification
 * matrix cannot reset a shortcut set that was fine.
 */
export function parseSettings(raw: string | null | undefined): ParsedSettings {
  const defaults = createDefaultSettings();
  if (!raw || !raw.trim()) {
    return { settings: defaults, trash: [], repaired: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { settings: defaults, trash: [], repaired: true };
  }
  const value = asObject(parsed);
  const looksEmpty = Object.keys(value).length === 0;
  const unknownVersion = typeof value.schemaVersion === "number" && value.schemaVersion !== SETTINGS_SCHEMA_VERSION;
  return {
    settings: {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      appearance: normalizeAppearance(value.appearance, defaults.appearance),
      general: normalizeGeneral(value.general, defaults.general),
      notifications: normalizeNotifications(value.notifications, defaults.notifications),
      security: normalizeSecurity(value.security, defaults.security),
      data: normalizeData(value.data, defaults.data),
      updates: normalizeUpdates(value.updates, defaults.updates),
      integrations: normalizeIntegrations(value.integrations, defaults.integrations),
      shortcuts: normalizeShortcuts(value.shortcuts, defaults.shortcuts),
      onboarding: normalizeOnboarding(value.onboarding, defaults.onboarding),
    },
    trash: normalizeTrash(value.trash),
    repaired: looksEmpty || unknownVersion,
  };
}

/** Remove entries whose 30-day (or chosen) window has closed. */
export function pruneTrash(
  entries: readonly TrashEntry[],
  now = Date.now(),
): { kept: TrashEntry[]; removed: number } {
  const kept = entries.filter((entry) => {
    const expires = new Date(entry.expiresAtUtc).getTime();
    return Number.isFinite(expires) && expires > now;
  });
  return { kept, removed: entries.length - kept.length };
}

/** Add an entry to the trash with the retention window the user chose. */
export function trashEntry(
  input: Omit<TrashEntry, "id" | "deletedAtUtc" | "expiresAtUtc">,
  retentionDays: number,
  now = new Date(),
): TrashEntry {
  const expires = new Date(now.getTime() + Math.max(1, retentionDays) * 86_400_000);
  const id = `${input.kind}-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    ...input,
    id,
    deletedAtUtc: now.toISOString(),
    expiresAtUtc: expires.toISOString(),
  };
}

/**
 * Immutable update of one section.
 *
 * A settings screen changes one field at a time; rebuilding the whole document
 * at every keystroke is how a debounced save overwrites a field the user
 * changed in another tab. The updater is typed, so a renamed field is a compile
 * error rather than a silently dropped preference.
 */
export type SectionKey = Exclude<keyof AppSettings, "schemaVersion">;

export function patchSection<K extends SectionKey>(
  settings: AppSettings,
  section: K,
  patch: Partial<AppSettings[K]>,
): AppSettings {
  return { ...settings, [section]: { ...settings[section], ...patch } };
}

/** The JSON the core stores. Trash is inside the same document on purpose: the
 *  export/import path then carries restores as well as settings. */
export function serializeSettings(settings: AppSettings, trash: readonly TrashEntry[]): string {
  return JSON.stringify({ ...settings, trash: trash.slice(0, 200) });
}

export function isValidPinLength(value: number): boolean {
  return value === 4 || value === 6 || value === 8;
}

export function isValidHex(value: string): boolean {
  return isValidHexColor(value) && HEX.test(value.toLowerCase());
}
