/**
 * The settings model.
 *
 * Everything a user can change that the Rust core does not own lives here: one
 * typed object, one version number, one storage key. The core keeps owning the
 * four values it must know during boot (locale, theme hint, reduced motion,
 * telemetry consent); this model mirrors nothing and duplicates nothing - it is
 * the single source for the other seventy-odd preferences.
 *
 * `schemaVersion` exists so a future shape change can migrate a stored file
 * instead of either resetting it or reading a field that has moved. A settings
 * blob read without a version is the classic way a product loses a user's
 * notification matrix on update.
 */

import type { ThemeId, ThemeMode } from "./themes";

export const SETTINGS_SCHEMA_VERSION = 1;

/* ------------------------------------------------------------ appearance */

export interface AppearanceSettings {
  themeId: ThemeId;
  mode: ThemeMode;
  /** Only meaningful when `themeId` is `custom`; normalised `#rrggbb`. */
  customColor: string;
  /** `match-theme` repaints the window and taskbar icon from the palette. */
  appIcon: AppIconId;
  zoomPercent: number;
  highContrast: boolean;
  reducedMotion: boolean;
}

export type AppIconId = "match-theme" | "mono-dark" | "mono-light" | "accent";

/* --------------------------------------------------------------- general */

export type CloseBehavior = "ask" | "tray" | "quit";
export type ClockFormat = "auto" | "12h" | "24h";
export type DateFormatStyle = "auto" | "iso" | "dmy" | "mdy";

export interface GeneralSettings {
  /** Empty means "follow the operating system on first launch". */
  locale: string;
  closeBehavior: CloseBehavior;
  launchAtStartup: boolean;
  /** True locks drag-and-drop inside the app, so a stray drag cannot move rows. */
  dragDropLocked: boolean;
  /** Compact rail persisted across launches. */
  sidebarMinimal: boolean;
  clockFormat: ClockFormat;
  dateFormat: DateFormatStyle;
  confirmDestructive: boolean;
}

/* --------------------------------------------------------- notifications */

export type NotificationKind =
  | "action-complete"
  | "action-failed"
  | "diagnosis-ready"
  | "snapshot-created"
  | "reminder"
  | "update-available"
  | "system";

export type NotificationChannel = "in-app" | "native" | "both" | "none";

export type NotificationProfileId = "balanced" | "everything" | "focus" | "in-app-only";

export interface NotificationSettings {
  profile: NotificationProfileId;
  channels: Record<NotificationKind, NotificationChannel>;
  /** Minutes before a scheduled action to warn; 0 disables the warning. */
  reminderLeadMinutes: number;
  sound: boolean;
  /** Do-not-disturb window, 24h `HH:MM`. Equal values mean "off". */
  quietHoursStart: string;
  quietHoursEnd: string;
}

/* -------------------------------------------------------------- security */

export interface PinRecord {
  /** `pin` is digits only, `password` is any printable string. */
  kind: "pin" | "password";
  digits: 4 | 6 | 8 | 0;
  algorithm: "PBKDF2-SHA256";
  iterations: number;
  saltB64: string;
  hashB64: string;
  createdAtUtc: string;
  failedAttempts: number;
  lockedUntilUtc: string | null;
}

export interface SecuritySettings {
  pin: PinRecord | null;
  lockOnMinimize: boolean;
  lockTimeoutMinutes: number;
}

/* ------------------------------------------------------------------ data */

export interface DataSettings {
  /** Absolute folder chosen for JSON cloud sync; empty means disabled. */
  cloudSyncPath: string;
  autoBackup: boolean;
  trashRetentionDays: number;
  exportIncludesLogs: boolean;
}

export interface TrashEntry {
  id: string;
  kind: "snapshot" | "history" | "note" | "setting";
  titleKey: string;
  titleParams: Record<string, string | number>;
  deletedAtUtc: string;
  expiresAtUtc: string;
  /** Small, already-redacted payload kept so a restore needs no second file. */
  payload: Record<string, unknown>;
}

/* --------------------------------------------------------------- updates */

export type UpdateChannel = "github" | "store";

export interface UpdateSettings {
  channel: UpdateChannel;
  autoCheck: boolean;
  lastCheckedUtc: string | null;
  skippedVersion: string | null;
}

/* ---------------------------------------------------------- integrations */

export type WebhookEvent = "completed" | "failed" | "rollback";

/**
 * Local integration preferences.
 *
 * The signing secret is deliberately absent: it is DPAPI-protected in the core
 * keystore and never round-trips through this document, which is a plain JSON
 * file a user can read. Keeping the URL and the event selection here means the
 * settings export carries them; it must never carry the secret.
 */
export interface IntegrationSettings {
  cliInstalled: boolean;
  mcpEnabled: boolean;
  webhookEnabled: boolean;
  webhookUrl: string;
  webhookEvents: WebhookEvent[];
}

/* ------------------------------------------------------------ navigation */

/**
 * One leaf tab. The id is the catalogue key suffix: `settings.tab.<id>` is the
 * visible title *and* the panel's `<h3>`, which is what makes "tab title equals
 * tab content" structural rather than a design promise.
 */
export type SettingsTabId =
  | "appearance"
  | "accessibility"
  | "general"
  | "language"
  | "shortcuts"
  | "notifications"
  | "data"
  | "trash"
  | "cli"
  | "webhook"
  | "legal"
  | "about";

export type SettingsGroupId = "personalization" | "workspace" | "system";

/* -------------------------------------------------------------- onboarding */

export interface OnboardingState {
  completed: boolean;
  completedAtUtc: string | null;
  /** Steps the user finished; a partial run resumes instead of restarting. */
  stepsDone: number;
}

/* ------------------------------------------------------------- shortcuts */

export type ShortcutMap = Record<string, string>;

/* ------------------------------------------------------------------ root */

export interface AppSettings {
  schemaVersion: number;
  appearance: AppearanceSettings;
  general: GeneralSettings;
  notifications: NotificationSettings;
  security: SecuritySettings;
  data: DataSettings;
  updates: UpdateSettings;
  integrations: IntegrationSettings;
  shortcuts: ShortcutMap;
  onboarding: OnboardingState;
}

/** What the JSON export writes. Trash is included so a restore is complete. */
export interface SettingsExport {
  application: "zenith";
  schemaVersion: number;
  exportedAtUtc: string;
  appVersion: string;
  settings: AppSettings;
  trash: TrashEntry[];
}
