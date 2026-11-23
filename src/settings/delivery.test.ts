/**
 * Delivery routing tests.
 *
 * The matrix in Settings is only real if something reads it. These tests exist
 * because for four releases nothing did: `dispatchNotification` had no caller,
 * so choosing "In-app only" changed a checkbox and nothing else, and a native
 * column was described in the UI that no code path could reach.
 */

import { describe, expect, it, vi } from "vitest";

import { deliverNotification } from "./delivery";
import { channelsForProfile } from "./model";
import type { NotificationSettings } from "./types";

function settingsFor(profile: NotificationSettings["profile"]): NotificationSettings {
  return {
    profile,
    channels: channelsForProfile(profile),
    reminderLeadMinutes: 0,
    sound: true,
    quietHoursStart: "22:00",
    quietHoursEnd: "07:00",
  };
}

const payload = {
  kind: "action-complete" as const,
  titleKey: "notify.kind.action-complete",
  bodyKey: "notify.body.actionComplete",
  params: { action: "Clean temporary files" },
};

describe("notification delivery", () => {
  it("refuses to draw anything when the kind is switched off", () => {
    const toast = vi.fn();
    const construct = vi.fn();
    const settings = settingsFor("balanced");
    settings.channels["action-complete"] = "none";

    const decision = deliverNotification(payload, {
      settings,
      locale: "en",
      toast,
      construct,
    });

    expect(toast).not.toHaveBeenCalled();
    expect(construct).not.toHaveBeenCalled();
    expect(decision.inApp).toBe(false);
    expect(decision.native).toBe(false);
  });

  it("draws in-app only and never constructs a native toast", () => {
    const toast = vi.fn();
    const construct = vi.fn();
    const settings = settingsFor("balanced");
    settings.channels["action-complete"] = "in-app";

    const decision = deliverNotification(payload, { settings, locale: "en", toast, construct });

    expect(toast).toHaveBeenCalledTimes(1);
    expect(decision.inApp).toBe(true);
    expect(decision.native).toBe(false);
    // The toast carries the translated action name, not a raw key.
    expect(toast.mock.calls[0]?.[0]).toMatchObject({
      tone: "success",
      titleKey: "notify.kind.action-complete",
      bodyKey: "notify.body.actionComplete",
    });
  });

  it("constructs a native notification with translated text when asked to", () => {
    const toast = vi.fn();
    const construct = vi.fn().mockImplementation(() => ({ close: vi.fn() }));
    const settings = settingsFor("everything");

    const decision = deliverNotification(payload, {
      settings,
      locale: "tr",
      toast,
      construct,
      // Midday: the fixture's quiet-hours window is 22:00 to 07:00, and a test
      // that ran at 00:20 would be asserting against the wrong branch.
      at: new Date(2026, 10, 24, 12, 0, 0),
    });

    expect(decision.native).toBe(true);
    // Turkish is a full catalogue, so the native title is Turkish rather than
    // the English key's value.
    expect(construct).toHaveBeenCalledWith("Eylem tamamland\u0131", expect.anything());
    expect(construct.mock.calls[0]?.[1]).toMatchObject({ tag: "zenith-action-complete" });
  });

  it("keeps the app toast but silences the native one inside quiet hours", () => {
    const toast = vi.fn();
    const construct = vi.fn().mockImplementation(() => ({ close: vi.fn() }));
    const settings = settingsFor("everything");
    const quiet = new Date(2026, 10, 24, 23, 30, 0);

    const decision = deliverNotification(payload, {
      settings,
      locale: "en",
      toast,
      construct,
      at: quiet,
    });

    expect(toast).toHaveBeenCalledTimes(1);
    expect(construct).not.toHaveBeenCalled();
    expect(decision.quieted).toBe(true);
  });

  it("reports a native decision as unsupported rather than as sent when the host cannot show one", () => {
    const toast = vi.fn();
    const settings = settingsFor("everything");

    // No `construct` and no `Notification` in the test environment: the host
    // cannot draw a native toast, which must not be reported as delivered.
    const decision = deliverNotification(payload, {
      settings,
      locale: "en",
      toast,
      at: new Date(2026, 10, 24, 12, 0, 0),
    });

    expect(decision.native).toBe(false);
    expect(decision.unsupported).toBe(true);
    expect(toast).toHaveBeenCalledTimes(1);
  });
});
