/**
 * Notification routing.
 *
 * A notification has two independent questions: whether it should appear at all
 * and which surface it appears on. They are kept apart here so the settings
 * matrix is not decoration - a channel of `none` really suppresses the message,
 * and quiet hours really silence the native surface while leaving the in-app
 * record intact (a user who wakes up should still see what happened).
 *
 * Nothing in this module touches the DOM. The host passes two sinks, which is
 * what makes the policy testable and keeps the toast implementation swappable.
 */

import type {
  NotificationChannel,
  NotificationKind,
  NotificationSettings,
} from "./types";

export interface NotificationPayload {
  kind: NotificationKind;
  titleKey: string;
  bodyKey: string;
  params?: Record<string, string | number>;
  /** A deep link the toast can act on, e.g. `snapshots`. */
  screen?: string;
}

export interface NotificationSinks {
  inApp: (payload: NotificationPayload) => void;
  native: (payload: NotificationPayload) => void;
}

export interface NotificationDecision {
  inApp: boolean;
  native: boolean;
  /** True when only quiet hours removed the native surface. */
  quieted: boolean;
}

function minutesOf(hhmm: string): number {
  const [hours, minutes] = hhmm.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/**
 * Quiet hours are a window that may wrap midnight (`22:00` to `07:00`). Equal
 * endpoints mean off, not "silent all day": that is the only reading under
 * which a user can disable the feature by setting both fields to the same time.
 */
export function inQuietHours(settings: NotificationSettings, at: Date = new Date()): boolean {
  const start = minutesOf(settings.quietHoursStart);
  const end = minutesOf(settings.quietHoursEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) {
    return false;
  }
  const now = at.getHours() * 60 + at.getMinutes();
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export function channelFor(settings: NotificationSettings, kind: NotificationKind): NotificationChannel {
  return settings.channels[kind] ?? "in-app";
}

export function decideNotification(
  settings: NotificationSettings,
  kind: NotificationKind,
  at: Date = new Date(),
): NotificationDecision {
  const channel = channelFor(settings, kind);
  const wantsInApp = channel === "in-app" || channel === "both";
  const wantsNative = channel === "native" || channel === "both";
  const quiet = wantsNative && inQuietHours(settings, at);
  return {
    inApp: wantsInApp,
    native: wantsNative && !quiet,
    quieted: quiet,
  };
}

/**
 * Ask the operating system for permission once.
 *
 * WebView2 exposes the Notification API; a denied permission is not an error
 * the app can undo, so the settings screen shows the native columns as
 * unavailable instead of pretending a toast was delivered. The result is
 * returned so the UI can say which one happened.
 */
export async function ensureNativePermission(): Promise<"granted" | "denied" | "unsupported"> {
  if (typeof window === "undefined" || typeof Notification === "undefined") {
    return "unsupported";
  }
  if (Notification.permission === "granted") {
    return "granted";
  }
  if (Notification.permission === "denied") {
    return "denied";
  }
  try {
    const result = await Notification.requestPermission();
    return result === "granted" ? "granted" : "denied";
  } catch {
    return "unsupported";
  }
}

export function nativeAvailable(): boolean {
  return typeof window !== "undefined" && typeof Notification !== "undefined";
}

export function dispatchNotification(
  settings: NotificationSettings,
  payload: NotificationPayload,
  sinks: NotificationSinks,
  at: Date = new Date(),
): NotificationDecision {
  const decision = decideNotification(settings, payload.kind, at);
  if (decision.inApp) {
    sinks.inApp(payload);
  }
  if (decision.native) {
    sinks.native(payload);
  }
  return decision;
}

/** Badge copy for the profile picker, derived from the matrix, never typed. */
export function profileSummaryKey(profile: string): string {
  return `notify.profile.${profile}.desc`;
}
