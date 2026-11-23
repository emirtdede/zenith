/**
 * The bridge between notification policy and the two surfaces that show one.
 *
 * `src/settings/notifications.ts` decides *whether* a message is allowed and on
 * which surface. This module is the only place that knows how to draw it, so the
 * policy stays testable without a DOM and the delivery path is a single function
 * both the pipeline events and the Settings "send a test" button go through.
 *
 * Two rules that used to be broken:
 *
 * 1. **The matrix was decorative.** Every in-app toast was dispatched straight
 *    into the store, and `dispatchNotification` had no caller at all, so a user
 *    who chose "In-app only" still got native toasts and a user who chose
 *    "none" for a kind still saw it. One entry point fixes that.
 * 2. **A native toast was never shown.** `ensureNativePermission` existed and
 *    the settings screen read `Notification.permission`, but nothing ever
 *    constructed a `Notification`, so the native columns described a surface
 *    the product did not have.
 */

import { buildTranslator } from "../i18n";
import type { ThemeId } from "../settings/themes";
import {
  dispatchNotification,
  ensureNativePermission,
  nativeAvailable,
} from "./notifications";
import type { NotificationPayload, NotificationSinks } from "./notifications";
import type { NotificationKind, NotificationSettings } from "./types";

/** The toast the store can show, built from a payload. */
export interface ToastLike {
  tone: "info" | "success" | "warning" | "error";
  titleKey: string;
  bodyKey?: string;
  params?: Record<string, string | number>;
  screen?: string;
}

export interface DeliverOptions {
  settings: NotificationSettings;
  locale: string;
  /** Push an in-app toast into the store. */
  toast: (toast: ToastLike) => void;
  /** Theme for the native toast icon background; absent on unsupported hosts. */
  theme?: ThemeId;
  /** Injectable for tests; defaults to the browser constructor. */
  construct?: (title: string, options: NotificationOptions) => Notification;
  at?: Date;
}

function toneFor(kind: NotificationKind): ToastLike["tone"] {
  switch (kind) {
    case "action-failed":
      return "error";
    case "action-complete":
    case "snapshot-created":
      return "success";
    case "reminder":
      return "warning";
    default:
      return "info";
  }
}

/**
 * The native surface, or `null` when the host cannot draw one.
 *
 * `null` rather than a no-op sink on purpose: when the platform says no, the
 * caller must not claim it sent anything.
 */
function nativeSink(
  locale: string,
  construct?: (title: string, options: NotificationOptions) => Notification,
): ((payload: NotificationPayload) => void) | null {
  if (!construct && !nativeAvailable()) {
    return null;
  }
  const build = construct ?? ((title, options) => new Notification(title, options));
  return (item) => {
    // The title and body are translated here rather than at the call site so a
    // native toast never shows a raw key when the caller passed one through.
    const t = buildTranslator(locale);
    try {
      const notification = build(t(item.titleKey as Parameters<typeof t>[0], item.params), {
        body: t(item.bodyKey as Parameters<typeof t>[0], item.params),
        silent: false,
        tag: `zenith-${item.kind}`,
      });
      // Clicking the toast brings the window forward through the same deep link
      // an in-app toast uses. There is no window handle here, so the renderer
      // sets `location.hash`; the shell listens for it.
      notification.onclick = () => {
        if (item.screen) {
          window.location.hash = `#${item.screen}`;
        }
        window.focus();
        notification.close();
      };
    } catch {
      // A denied permission throws at construction time on some WebView2
      // builds. The in-app toast has already been drawn, so a failure here is
      // not worth propagating; the outcome is visible to the user either way.
    }
  };
}

/**
 * Route one notification through the user's policy.
 *
 * Returns the decision so a caller can report what actually happened - the
 * Settings test button uses it to say "shown in the app only" instead of
 * claiming a native toast that quiet hours suppressed.
 */
export function deliverNotification(
  payload: NotificationPayload,
  options: DeliverOptions,
) {
  const native = nativeSink(options.locale, options.construct);
  const sinks: NotificationSinks = {
    inApp: (item) => {
      options.toast({
        tone: toneFor(item.kind),
        titleKey: item.titleKey,
        bodyKey: item.bodyKey,
        params: item.params,
        screen: item.screen,
      });
    },
    native: native ?? (() => undefined),
  };

  const decision = dispatchNotification(options.settings, payload, sinks, options.at);
  // A `native` decision on a host without the API is not a delivery: report it
  // as unavailable rather than as sent, which is what the settings screen shows.
  return {
    ...decision,
    native: decision.native && native !== null,
    unsupported: decision.native && native === null,
  };
}

/** Ask for native permission, then say what the platform answered. */
export async function requestNativeNotifications(): Promise<
  "granted" | "denied" | "unsupported"
> {
  return ensureNativePermission();
}
