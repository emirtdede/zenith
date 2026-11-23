/**
 * The settings navigation model.
 *
 * Three groups, twelve leaves. A leaf's title key is derived, never stored:
 * `settings.tab.<id>` is both the button's label and the panel heading, so a
 * click can only ever show the thing it named. The previous settings screen had
 * two columns that mixed unrelated controls under headings that named neither,
 * which is how a user ends up changing the theme while looking for telemetry.
 */

import type { MessageKey } from "../i18n";
import type { SettingsGroupId, SettingsTabId } from "./types";

export interface SettingsGroup {
  id: SettingsGroupId;
  labelKey: MessageKey;
  tabs: readonly SettingsTabId[];
}

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: "personalization",
    labelKey: "settings.group.personalization",
    tabs: ["appearance", "accessibility"],
  },
  {
    id: "workspace",
    labelKey: "settings.group.workspace",
    tabs: ["general", "language", "shortcuts", "notifications", "data", "trash"],
  },
  {
    id: "system",
    labelKey: "settings.group.system",
    tabs: ["cli", "webhook", "legal", "about"],
  },
];

export const ALL_TABS: readonly SettingsTabId[] = SETTINGS_GROUPS.flatMap((group) => group.tabs);

export function tabLabelKey(tab: SettingsTabId): MessageKey {
  return `settings.tab.${tab}` as MessageKey;
}

export function groupOf(tab: SettingsTabId): SettingsGroup {
  return SETTINGS_GROUPS.find((group) => group.tabs.includes(tab)) ?? SETTINGS_GROUPS[0]!;
}

export function isSettingsTab(value: unknown): value is SettingsTabId {
  return typeof value === "string" && (ALL_TABS as readonly string[]).includes(value);
}

/** Previous/next in visual order, for Ctrl+PageDown and the arrow keys. */
export function adjacentTab(tab: SettingsTabId, delta: number): SettingsTabId {
  const index = ALL_TABS.indexOf(tab);
  const next = (index + delta + ALL_TABS.length) % ALL_TABS.length;
  return ALL_TABS[next]!;
}
