/**
 * Small shared controls. Each one exists because the settings surface repeats
 * it: a labelled select, a switch with an explanation, a segmented control, a
 * toast stack, a skeleton and the context menu.
 *
 * Accessibility rules are not optional here and are therefore built in:
 *
 * * a switch is a real `<input type="checkbox">` inside a `<label>`, so Space
 *   toggles it and a screen reader announces the checked state;
 * * the segmented control is a group of radio inputs with a visible ring, not a
 *   row of buttons that lie about their role;
 * * the context menu opens from a right click *and* from Shift+F10 or the Menu
 *   key, moves with the arrow keys, and closes on Escape. A context menu that
 *   only a mouse can open is unusable with a keyboard, which was the state of
 *   the previous build.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useT } from "../i18n";
import type { ToastMessage } from "../state/store";

/* ---------------------------------------------------------- select field */

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
  disabled,
  hideLabel = false,
}: {
  label: string;
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  hint?: string;
  disabled?: boolean;
  /**
   * Keep the label for assistive technology but draw it off screen.
   *
   * The per-event notification matrix already prints the event name in the row,
   * so a visible label above each select repeated "Per-event channels" six
   * times. Hiding the duplicate visually keeps the `htmlFor` association that
   * gives the select its accessible name.
   */
  hideLabel?: boolean;
}) {
  const id = useId();
  return (
    <div className="set-field">
      <label className={`set-label${hideLabel ? " sr-only" : ""}`} htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="set-select"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint ? <p className="set-hint">{hint}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------- toggle row */

export function ToggleRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={`set-row ${disabled ? "is-disabled" : ""}`}>
      <span className="set-row-text">
        <label className="set-row-label" htmlFor={id}>
          {label}
        </label>
        {description ? (
          <span className="set-hint" id={hintId}>
            {description}
          </span>
        ) : null}
      </span>
      <span className="toggle">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={description ? hintId : undefined}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="toggle-track" aria-hidden="true" />
      </span>
    </div>
  );
}

/* ------------------------------------------------------- segmented radio */

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <fieldset className="set-field set-fieldset">
      <legend className="set-label">{label}</legend>
      <div className="segmented">
        {options.map((option) => (
          <label key={option.value} className="segmented-item">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/* --------------------------------------------------------------- skeleton */

export function Skeleton({
  lines = 3,
  label,
}: {
  lines?: number;
  label?: string;
}) {
  const t = useT();
  return (
    <div className="skeleton-stack" role="status" aria-live="polite" aria-label={label ?? t("skeleton.loading")}>
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} className={`skeleton skeleton-line skeleton-line-${(index % 3) + 1}`} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ toast */

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: ToastMessage;
  onDismiss: (id: string) => void;
}) {
  const t = useT();
  useEffect(() => {
    // Six seconds is long enough to read one sentence; the timer is cleared on
    // unmount so a dismissed toast never calls setState on a gone component.
    const timer = setTimeout(() => onDismiss(toast.id), 6000);
    return () => clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return (
    <div className={`toast toast-${toast.tone}`} role="status">
      <div className="toast-body">
        <strong>{t(toast.titleKey as Parameters<typeof t>[0], toast.params)}</strong>
        {toast.bodyKey ? (
          <p>{t(toast.bodyKey as Parameters<typeof t>[0], toast.params)}</p>
        ) : null}
      </div>
      <button
        type="button"
        className="toast-close"
        aria-label={t("toast.dismiss")}
        onClick={() => onDismiss(toast.id)}
      >
        x
      </button>
    </div>
  );
}

export function ToastHub({
  toasts,
  onDismiss,
}: {
  toasts: readonly ToastMessage[];
  onDismiss: (id: string) => void;
}) {
  const t = useT();
  return (
    <div className="toast-hub" aria-label={t("notify.toast")} aria-live="polite">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------- context menu */

export interface MenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

/** A menu entry is either a command or a rule between two groups. */
export type MenuEntry = MenuItem | { id: string; separator: true };

function isSeparator(entry: MenuEntry): entry is { id: string; separator: true } {
  return "separator" in entry;
}

/**
 * The application context menu.
 *
 * It is rendered inside the shell and listens on the document, because the menu
 * must work everywhere - including on surfaces that have no handler of their
 * own. The point of Shift+F10 support is that a keyboard user can reach the
 * same commands a right click offers; the previous build had a `contextmenu`
 * listener on one grid only, so the menu was mouse-only and screen-local.
 *
 * The first group is the text group. It used to be absent: a text field kept the
 * WebView2 menu and every other surface had no clipboard commands at all, which
 * meant a user could not copy a finding or a correlation id out of the console.
 * The group edits whatever the right click landed on - a selection in a field, a
 * selection in the page, or the whole page - so "Select all" followed by "Copy"
 * works on a screen that has no field in it.
 *
 * `itemsFor` is how a surface adds its own commands: the host passes the element
 * the menu was opened on and the caller answers with the entries that apply to
 * it (pin or unpin, for an action card). Keeping that decision out of the host
 * is what lets the host stay unaware of the domain.
 */
export function ContextMenuHost({
  items,
  itemsFor,
}: {
  items: readonly MenuItem[];
  itemsFor?: (target: HTMLElement | null) => readonly MenuEntry[];
}) {
  const t = useT();
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    target: HTMLElement | null;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const close = useCallback(() => setMenu(null), []);

  useEffect(() => {
    function open(x: number, y: number, target: HTMLElement | null) {
      setMenu({ x, y, target });
    }

    function onContextMenu(event: MouseEvent) {
      // Inside a text field the native menu is still the right answer for IME
      // and spellcheck, but it is not the only answer: the app menu's text group
      // covers the same four commands and keeps the look consistent. Preventing
      // the default here means one menu, not two different ones depending on
      // where the pointer is.
      event.preventDefault();
      open(event.clientX, event.clientY, event.target as HTMLElement | null);
    }
    function onKeyDown(event: KeyboardEvent) {
      const isMenuKey = event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
      if (isMenuKey) {
        const target = (event.target as HTMLElement | null) ?? null;
        const rect = target?.getBoundingClientRect();
        event.preventDefault();
        open(rect ? rect.left + 12 : 24, rect ? rect.top + 12 : 24, target);
        return;
      }
      if (event.key === "Escape") {
        setMenu(null);
      }
    }
    function onPointerDown(event: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenu(null);
      }
    }
    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);

  useEffect(() => {
    if (!menu) {
      return;
    }
    const first = menuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])");
    first?.focus();
  }, [menu]);

  if (!menu) {
    return null;
  }

  /**
   * The four text commands, scoped to whatever the menu was opened on.
   *
   * `execCommand` rather than the async clipboard API on purpose: `readText`
   * needs a permission prompt that a webview cannot show reliably, and the
   * synchronous command acts on the focused element exactly as the native menu
   * did. This is the one place in the renderer where the deprecated API is the
   * correct one.
   */
  const editable = menu.target?.closest<HTMLElement>(
    "input, textarea, [contenteditable='true']",
  ) ?? null;
  const selection = window.getSelection()?.toString() ?? "";
  const text: MenuEntry[] = [
    {
      id: "cut",
      label: t("menu.cut"),
      disabled: editable === null || selection.length === 0,
      onSelect: () => {
        document.execCommand("cut");
      },
    },
    {
      id: "copy",
      label: t("menu.copy"),
      disabled: selection.length === 0,
      onSelect: () => {
        document.execCommand("copy");
      },
    },
    {
      id: "paste",
      label: t("menu.paste"),
      disabled: editable === null,
      onSelect: () => {
        document.execCommand("paste");
      },
    },
    {
      id: "select-all",
      label: t("menu.selectAll"),
      onSelect: () => {
        if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
          editable.select();
          return;
        }
        const region = document.getElementById("main") ?? document.body;
        window.getSelection()?.selectAllChildren(region);
      },
    },
  ];

  const entries: MenuEntry[] = [
    ...text,
    { id: "text-end", separator: true },
    ...(itemsFor?.(menu.target) ?? []),
    ...items,
  ];

  function moveFocus(delta: number) {
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [],
    );
    if (buttons.length === 0) {
      return;
    }
    const active = document.activeElement as HTMLButtonElement | null;
    const index = active ? buttons.indexOf(active) : -1;
    const next = buttons[(index + delta + buttons.length) % buttons.length];
    next?.focus();
  }

  return (
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      aria-label={t("context.hint")}
      style={{
        left: Math.min(menu.x, window.innerWidth - 240),
        top: Math.min(menu.y, window.innerHeight - entries.length * 34 - 12),
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          moveFocus(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          moveFocus(-1);
        } else if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
    >
      {entries.map((entry) =>
        isSeparator(entry) ? (
          <div key={entry.id} className="context-menu-rule" role="separator" />
        ) : (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            className="context-menu-item"
            disabled={entry.disabled}
            onClick={() => {
              close();
              entry.onSelect();
            }}
          >
            {entry.label}
          </button>
        ),
      )}
    </div>
  );
}

/* ------------------------------------------------------------- misc bits */

export function PanelSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="set-section">
      <div className="set-section-head">
        <h4>{title}</h4>
        {description ? <p className="set-hint">{description}</p> : null}
      </div>
      <div className="set-section-body">{children}</div>
    </section>
  );
}

export function Badge({ children }: { children: ReactNode }) {
  // `lang="en"` on a technical badge: it is a product name or a protocol word,
  // and a screen reader should pronounce it in English even inside a Turkish
  // sentence. The rule lives here so no call site can forget it.
  return (
    <span className="badge" lang="en">
      {children}
    </span>
  );
}
