import { useMemo, useRef, useState } from "react";
import type { Dispatch } from "react";

import type { ActionsApi } from "../actions";
import { ACTIONS } from "../catalog.generated";
import { useT } from "../i18n";
import type { Action, State } from "../state/store";
import { useFocusTrap } from "./useFocusTrap";

interface Command {
  id: string;
  group: string;
  label: string;
  run: () => void;
}

export function CmdPalette({
  state,
  dispatch,
  actions,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  actions: ActionsApi;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  // DEF-086: the palette declares `aria-modal`, so it gets the same containment
  // as the dialogs. One hook, two call sites - not two implementations.
  const dialog = useRef<HTMLDivElement>(null);
  useFocusTrap(dialog);

  const commands = useMemo<Command[]>(() => {
    const close = () => dispatch({ type: "overlay/close" });
    const nav: Command[] = [
      { screen: "actions", label: "palette.nav.all" },
      { screen: "snapshots", label: "palette.nav.snapshots" },
      { screen: "activity", label: "palette.nav.activity" },
      { screen: "trust", label: "palette.nav.trust" },
      { screen: "settings", label: "palette.nav.settings" },
      { screen: "help", label: "palette.nav.help" },
    ].map((item) => ({
      id: `nav:${item.screen}`,
      group: "palette.group.navigate",
      label: t(item.label as Parameters<typeof t>[0]),
      run: () => {
        dispatch({ type: "screen/set", screen: item.screen as State["screen"] });
        close();
      },
    }));

    nav.push(
      {
        id: "nav:diagnose",
        group: "palette.group.action",
        label: t("palette.nav.diagnose"),
        run: () => {
          void actions.diagnose();
          close();
        },
      },
      {
        id: "set:theme",
        group: "palette.group.settings",
        label: t("palette.theme"),
        run: () => {
          const order = ["off-white", "true-black", "spatial-glass"] as const;
          const next = order[(order.indexOf(state.theme) + 1) % order.length] ?? order[0];
          dispatch({ type: "prefs/theme", theme: next });
          void actions.savePreferences({ theme: next });
          close();
        },
      },
      {
        id: "set:motion",
        group: "palette.group.settings",
        label: t("palette.motion"),
        run: () => {
          const reduceMotion = !state.reduceMotion;
          dispatch({ type: "prefs/motion", reduceMotion });
          void actions.savePreferences({ reduceMotion });
          close();
        },
      },
      {
        id: "set:locale",
        group: "palette.group.settings",
        label: t("palette.locale"),
        run: () => {
          const next = state.locale === "tr" ? "en" : "tr";
          dispatch({ type: "prefs/locale", locale: next });
          void actions.savePreferences({ locale: next });
          close();
        },
      },
    );

    const actionCommands = ACTIONS.map((def) => ({
      id: `action:${def.id}`,
      group: "palette.group.action",
      label: t.tKey(`${def.i18nPrefix}.title`),
      run: () => {
        dispatch({
          type: "confirm/open",
          confirm: {
            actionId: def.id,
            definition: def,
            report: state.reports[def.id] ?? null,
          },
        });
      },
    }));

    return [...nav, ...actionCommands];
  }, [actions, dispatch, state.locale, state.reduceMotion, state.reports, state.theme, t]);

  const needle = query.trim().toLocaleLowerCase(state.locale);
  const matches = commands.filter((command) =>
    needle ? command.label.toLocaleLowerCase(state.locale).includes(needle) : true,
  );
  const active = Math.min(cursor, Math.max(0, matches.length - 1));
  /**
   * Ids for the listbox and its active option.
   *
   * The palette declared `role="listbox"` around `role="option"` buttons and
   * never told the listbox which one was current, so a screen reader announced a
   * list of options with no selection and no relationship to the text field
   * (DEF-143). `role="option"` also belongs on the item, not on a `<button>` that
   * is already an interactive control. The pattern that fits a filter field plus
   * a list is a combobox: the input owns the list via `aria-controls` and points
   * at the highlighted row with `aria-activedescendant`, while DOM focus stays in
   * the field the user is typing into.
   */
  const listId = "palette-listbox";
  const optionId = (index: number) => `palette-option-${index}`;

  return (
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          dispatch({ type: "overlay/close" });
        }
      }}
    >
      <div
        ref={dialog}
        className="dialog palette"
        role="dialog"
        aria-modal="true"
        aria-label={t("titlebar.palette")}
        tabIndex={-1}
      >
        <input
          autoFocus
          className="palette-input"
          type="text"
          value={query}
          placeholder={t("palette.placeholder")}
          aria-label={t("palette.placeholder")}
          role="combobox"
          aria-expanded={matches.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={matches.length > 0 ? optionId(active) : undefined}
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setCursor((active + 1) % Math.max(1, matches.length));
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setCursor((active - 1 + matches.length) % Math.max(1, matches.length));
            }
            if (event.key === "Enter") {
              event.preventDefault();
              matches[active]?.run();
            }
          }}
        />
        <ul className="palette-list" role="listbox" id={listId} aria-label={t("titlebar.palette")}>
          {matches.length === 0 ? (
            <li className="muted" role="presentation">
              {t("palette.empty")}
            </li>
          ) : null}
          {matches.map((command, index) => (
            <li
              key={command.id}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              className={`palette-item ${index === active ? "is-active" : ""}`}
              onMouseEnter={() => setCursor(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={command.run}
            >
              <span>{command.label}</span>
              <span className="muted small">{t(command.group as Parameters<typeof t>[0])}</span>
            </li>
          ))}
        </ul>
        <footer className="muted small">
          <kbd>↑</kbd> <kbd>↓</kbd> {t("misc.back")} · <kbd>Enter</kbd> · <kbd>Esc</kbd>
        </footer>
      </div>
    </div>
  );
}
