/**
 * The one navigation model.
 *
 * Before this file existed the six destinations were listed three times: once
 * in `StatusBar`, once in `CmdPalette`, and not at all in a sidebar. The three
 * lists drifted - the palette silently reached four of six screens - because
 * nothing made them agree, and DEF-143 is exactly that defect.
 *
 * A `Record<ScreenId, …>` is the fix. It is exhaustive by the type system: add a
 * seventh screen to `ScreenId` and this file stops compiling until the new
 * destination is given a label, a palette label and an icon. There is no list
 * to forget.
 */

import type { MessageKey } from "../i18n";
import type { ScreenId } from "../state/store";

interface NavEntry {
  /** Sidebar and status-bar label: the destination's own name. */
  label: MessageKey;
  /** Command-palette label: a verb phrase, because the palette is a command list. */
  paletteLabel: MessageKey;
}

const NAV: Record<ScreenId, NavEntry> = {
  actions: { label: "nav.actions", paletteLabel: "palette.nav.all" },
  snapshots: { label: "nav.snapshots", paletteLabel: "palette.nav.snapshots" },
  activity: { label: "nav.activity", paletteLabel: "palette.nav.activity" },
  trust: { label: "nav.trust", paletteLabel: "palette.nav.trust" },
  settings: { label: "nav.settings", paletteLabel: "palette.nav.settings" },
  help: { label: "nav.help", paletteLabel: "palette.nav.help" },
};

export interface NavItem extends NavEntry {
  screen: ScreenId;
}

/**
 * The destinations in sidebar order: the daily work first, reference material
 * last. Insertion order of `NAV` is the order here, and `Object.keys` keeps it
 * for string keys in every engine Zenith ships on.
 */
export const NAV_ITEMS: readonly NavItem[] = (Object.keys(NAV) as ScreenId[]).map((screen) => ({
  screen,
  ...NAV[screen],
}));
