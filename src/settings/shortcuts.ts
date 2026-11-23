/**
 * Shortcut catalog, normalization and conflict detection.
 *
 * A shortcut is stored as a canonical string (`Ctrl+Shift+K`), never as a raw
 * `KeyboardEvent`. Two reasons, both learned the hard way in desktop apps:
 *
 * 1. `event.key` is layout-dependent - on a Turkish keyboard the key that
 *    produces `[` is not `BracketLeft`, and a stored `event.key` stops matching
 *    after the user switches layout mid-session;
 * 2. a stored `KeyboardEvent` cannot be compared to another one, so a conflict
 *    check has nothing to compare.
 *
 * Normalisation also makes `ctrl+shift+k`, `Shift+Ctrl+K` and `Ctrl + Shift + K`
 * the same binding, which is what a user typing into a recorder expects.
 */

export interface ShortcutDefinition {
  id: string;
  /** i18n key for the action's name. */
  labelKey: string;
  group: "navigation" | "actions" | "view" | "help";
  defaultKeys: string;
  /** False only for keys the OS or an assistive technology must keep. */
  customizable: boolean;
}

/**
 * The default set.
 *
 * `Escape` is deliberately absent: it must always dismiss a dialog for keyboard
 * users, so it is reserved rather than bindable. Everything else the app
 * listens for is listed here and can be re-bound, which is the difference
 * between "customizable shortcuts" and "customizable except the ones you use".
 */
export const SHORTCUTS: readonly ShortcutDefinition[] = [
  { id: "palette.open", labelKey: "shortcut.palette", group: "navigation", defaultKeys: "Ctrl+K", customizable: true },
  { id: "search.focus", labelKey: "shortcut.search", group: "navigation", defaultKeys: "/", customizable: true },
  { id: "nav.actions", labelKey: "shortcut.navActions", group: "navigation", defaultKeys: "Ctrl+1", customizable: true },
  { id: "nav.snapshots", labelKey: "shortcut.navSnapshots", group: "navigation", defaultKeys: "Ctrl+2", customizable: true },
  { id: "nav.trust", labelKey: "shortcut.navTrust", group: "navigation", defaultKeys: "Ctrl+3", customizable: true },
  { id: "nav.settings", labelKey: "shortcut.navSettings", group: "navigation", defaultKeys: "Ctrl+4", customizable: true },
  { id: "nav.activity", labelKey: "shortcut.navActivity", group: "navigation", defaultKeys: "Ctrl+5", customizable: true },
  { id: "nav.help", labelKey: "shortcut.navHelp", group: "navigation", defaultKeys: "Ctrl+6", customizable: true },
  { id: "sidebar.toggle", labelKey: "shortcut.sidebar", group: "view", defaultKeys: "Ctrl+B", customizable: true },
  { id: "diagnose.start", labelKey: "shortcut.diagnose", group: "actions", defaultKeys: "Ctrl+D", customizable: true },
  { id: "scan.refresh", labelKey: "shortcut.refresh", group: "actions", defaultKeys: "F5", customizable: true },
  // The id avoids the `console.` family prefix: `scripts/lib/key-scan.mjs`
  // treats a quoted `console.*` string as an emitted catalogue key, so an id
  // named `console.toggle` would demand a catalogue entry that no screen shows.
  { id: "view.console", labelKey: "shortcut.console", group: "view", defaultKeys: "Ctrl+`", customizable: true },
  { id: "theme.cycle", labelKey: "shortcut.theme", group: "view", defaultKeys: "Ctrl+Shift+T", customizable: true },
  { id: "zoom.in", labelKey: "shortcut.zoomIn", group: "view", defaultKeys: "Ctrl+=", customizable: true },
  { id: "zoom.out", labelKey: "shortcut.zoomOut", group: "view", defaultKeys: "Ctrl+-", customizable: true },
  { id: "zoom.reset", labelKey: "shortcut.zoomReset", group: "view", defaultKeys: "Ctrl+0", customizable: true },
  { id: "help.open", labelKey: "shortcut.help", group: "help", defaultKeys: "?", customizable: true },
  { id: "welcome.reopen", labelKey: "shortcut.welcome", group: "help", defaultKeys: "Ctrl+Shift+W", customizable: true },
];

export const SHORTCUT_IDS: readonly string[] = SHORTCUTS.map((shortcut) => shortcut.id);

export function defaultShortcuts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const shortcut of SHORTCUTS) {
    out[shortcut.id] = shortcut.defaultKeys;
  }
  return out;
}

const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];

const KEY_ALIASES: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  del: "Delete",
  ins: "Insert",
  return: "Enter",
  enter: "Enter",
  space: "Space",
  spacebar: "Space",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  plus: "+",
  minus: "-",
  " ": "Space",
};

function canonicalKey(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const lower = trimmed.toLowerCase();
  const alias = KEY_ALIASES[lower];
  if (alias) {
    return alias;
  }
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) {
    return lower.toUpperCase();
  }
  if (trimmed.length === 1) {
    return trimmed.toUpperCase();
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * Canonicalise a binding. Returns an empty string when nothing usable is left,
 * so a caller can treat "the user pressed only a modifier" as "no binding yet"
 * rather than storing `Ctrl+` and wondering why it never fires.
 */
export function normalizeShortcut(input: string): string {
  const parts = input
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  // A lone "+" as the whole binding is the plus key, not an empty sequence.
  if (input.trim() === "+") {
    return "+";
  }
  const modifiers = new Set<Modifier>();
  let key = "";
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "ctrl" || lower === "control" || lower === "cmdorctrl") {
      modifiers.add("Ctrl");
    } else if (lower === "alt" || lower === "option") {
      modifiers.add("Alt");
    } else if (lower === "shift") {
      modifiers.add("Shift");
    } else if (lower === "meta" || lower === "win" || lower === "super" || lower === "cmd") {
      modifiers.add("Meta");
    } else {
      key = canonicalKey(part);
    }
  }
  if (!key) {
    return "";
  }
  const ordered = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
  return [...ordered, key].join("+");
}

/** Turn a DOM event into the same canonical string a stored binding uses. */
export function shortcutFromEvent(event: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  code?: string;
}): string {
  const raw = event.key;
  if (!raw || raw === "Control" || raw === "Alt" || raw === "Shift" || raw === "Meta") {
    return "";
  }
  // A digit row key with Shift is a punctuation character on most layouts; the
  // physical `code` is the only honest source for `Ctrl+1`.
  const isDigitRow = typeof event.code === "string" && /^Digit[0-9]$/.test(event.code);
  const key = isDigitRow ? (event.code as string).slice(5) : raw;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");
  parts.push(key);
  return normalizeShortcut(parts.join("+"));
}

export interface ShortcutConflict {
  id: string;
  otherId: string;
  keys: string;
}

/** Every binding that is used twice. Later duplicate wins in `resolve`, so the
 *  UI must show both parties rather than silently preferring one. */
export function findConflicts(bindings: Record<string, string>): ShortcutConflict[] {
  const seen = new Map<string, string>();
  const conflicts: ShortcutConflict[] = [];
  for (const [id, raw] of Object.entries(bindings)) {
    const keys = normalizeShortcut(raw);
    if (!keys) {
      continue;
    }
    const existing = seen.get(keys);
    if (existing) {
      conflicts.push({ id, otherId: existing, keys });
    } else {
      seen.set(keys, id);
    }
  }
  return conflicts;
}

/** The action bound to a key event, if any. */
export function resolveShortcut(
  bindings: Record<string, string>,
  keys: string,
): string | null {
  const wanted = normalizeShortcut(keys);
  if (!wanted) {
    return null;
  }
  for (const [id, raw] of Object.entries(bindings)) {
    if (normalizeShortcut(raw) === wanted) {
      return id;
    }
  }
  return null;
}

/** Human-readable form for a key cap; `Ctrl+K` stays `Ctrl+K`. */
export function formatShortcut(raw: string): string {
  const normalized = normalizeShortcut(raw);
  return normalized || raw;
}
