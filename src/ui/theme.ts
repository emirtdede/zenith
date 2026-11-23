/**
 * The theme table, in one place.
 *
 * It used to live twice: `TitleBar` held the cycle order and `SettingsScreen`
 * held a `Record<ThemeId, key>` of the same three ids, so adding a fourth theme
 * meant remembering both. Now the palette table itself lives in
 * `settings/themes.ts` (it must, because the contrast gate reads it from Node),
 * and this module only attaches the catalogue key a user reads. `ThemeId` is
 * derived from that table, so a new palette fails to compile here until it has
 * a label.
 */

import type { ThemeId } from "../settings/themes";
import { COLOR_THEMES } from "../settings/themes";
import type { MessageKey } from "../i18n";

/**
 * Cycle order for the quick theme button, and the order the settings gallery
 * shows. `custom` is deliberately absent: it is a spectrum picker, not a
 * palette you cycle into, and its colour lives in the appearance settings.
 */
export const THEMES: readonly { id: ThemeId; label: MessageKey }[] = COLOR_THEMES.map(
  (palette) => ({
    id: palette.id,
    label: `theme.${palette.id}` as MessageKey,
  }),
);

export const THEME_LABEL = Object.fromEntries(
  THEMES.map((theme) => [theme.id, theme.label]),
) as Record<ThemeId, MessageKey>;

/** The theme after `current`, wrapping. The custom palette starts the cycle. */
export function nextTheme(current: ThemeId): ThemeId {
  const index = THEMES.findIndex((theme) => theme.id === current);
  return THEMES[(index + 1) % THEMES.length]?.id ?? THEMES[0]!.id;
}
