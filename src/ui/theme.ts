/**
 * The theme table, in one place.
 *
 * It used to live twice: `TitleBar` held the cycle order and `SettingsScreen`
 * held a `Record<ThemeId, key>` of the same three ids, so adding a fourth theme
 * meant remembering both - and the settings copy is the one a user reads while
 * the title-bar button cycles past them in a different order. `ThemeId` is a
 * union in `bridge/types.ts`, so `THEME_LABEL` cannot silently miss a theme:
 * a new id fails to compile here until it has a catalogue key.
 */

import type { ThemeId } from "../bridge/types";
import type { MessageKey } from "../i18n";

/** Cycle order for the quick theme button, and the order the settings list shows. */
export const THEMES: readonly { id: ThemeId; label: MessageKey }[] = [
  { id: "off-white", label: "titlebar.theme.offWhite" },
  { id: "true-black", label: "titlebar.theme.trueBlack" },
  { id: "spatial-glass", label: "titlebar.theme.spatialGlass" },
];

export const THEME_LABEL: Record<ThemeId, MessageKey> = {
  "off-white": "titlebar.theme.offWhite",
  "true-black": "titlebar.theme.trueBlack",
  "spatial-glass": "titlebar.theme.spatialGlass",
};

/** The theme after `current`, wrapping. An unknown id starts the cycle at the top. */
export function nextTheme(current: ThemeId): ThemeId {
  const index = THEMES.findIndex((theme) => theme.id === current);
  return THEMES[(index + 1) % THEMES.length]?.id ?? THEMES[0]!.id;
}
