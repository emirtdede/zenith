import type { Dispatch } from "react";

import type { ActionsApi } from "../actions";
import { useT } from "../i18n";
import type { Action, State } from "../state/store";
import { SCREEN_ICON } from "./icons";
import { NAV_ITEMS } from "./nav";
import { nextTheme, THEME_LABEL } from "./theme";

/**
 * The persistent left rail.
 *
 * Why a sidebar at all: the six destinations used to be reachable only from a
 * short strip at the bottom of the window and from the command palette. A user
 * who does not know the palette has to hunt the status bar for "where am I,
 * where can I go", and the answer was in the least prominent element on screen.
 * The rail is the same six destinations as a first-class landmark - the shape
 * every desktop tool this product is compared against uses - while the status
 * bar keeps the measurements it is good at (DEF-145).
 *
 * Accessibility: this is a `<nav>` with a translated `aria-label`, each item is
 * a real `<button>` carrying `aria-current="page"` for the current screen, and
 * the icon is `aria-hidden` because the text label already names the target.
 * The current item is not distinguished by colour alone: `aria-current` and the
 * 600 weight carry it too.
 */
export function Sidebar({
  state,
  dispatch,
  actions,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  actions: ActionsApi;
}) {
  const t = useT();
  const themeLabel = THEME_LABEL[state.theme];

  const minimal = state.sidebarMinimal;

  return (
    <aside className={`app-sidebar ${minimal ? "is-minimal" : ""}`}>
      <div className="sidebar-brand">
        <span className="brand-mark" aria-hidden="true">
          Z
        </span>
        <div className="sidebar-brand-text">
          {/* The product name is the document's one `<h1>`. It used to live in
              the title bar; when the brand moved to the rail (DEF-145) the
              heading moved with it, so the page still has exactly one and every
              screen title stays an `<h2>` under it. */}
          <h1 className="sidebar-product">{t("app.name")}</h1>
          {/* The tagline is the product's one-line promise; it belongs on the
              rail, not in a tooltip, because it is the rule the whole app obeys. */}
          <span className="sidebar-tagline">{t("app.tagline")}</span>
        </div>
      </div>

      {/*
       * The command palette trigger lives on the rail now, directly under the
       * product name. It used to sit in the toolbar, but a user who does not
       * know Ctrl+K looks for "search" near the thing they are browsing from,
       * and the rail is where the destinations are. The shortcut is printed on
       * the control because that is the faster path once it is learned.
       */}
      <div className="sidebar-palette">
        <button
          className="palette-trigger"
          type="button"
          onClick={() => dispatch({ type: "overlay/open", overlay: "palette" })}
          aria-haspopup="dialog"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="10.8" cy="10.8" r="6.6" stroke="currentColor" strokeWidth="1.75" />
            <path d="m15.7 15.7 4.1 4.1" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
          </svg>
          <span>{t("titlebar.palette")}</span>
          <kbd>Ctrl K</kbd>
        </button>
      </div>

      <nav className="sidebar-nav" aria-label={t("nav.title")}>
        {NAV_ITEMS.map((item) => {
          const Icon = SCREEN_ICON[item.screen];
          const active = state.screen === item.screen;
          return (
            <button
              key={item.screen}
              type="button"
              data-nav={item.screen}
              className={`nav-btn ${active ? "is-active" : ""}`}
              aria-current={active ? "page" : undefined}
              // The label is hidden visually in the collapsed rail, and
              // `display: none` removes it from the accessibility tree as well -
              // so the name cannot be left to the visible span. `aria-label` is
              // the translated label, and `title` is the tooltip for a pointer.
              aria-label={t(item.label)}
              title={t(item.label)}
              onClick={() => dispatch({ type: "screen/set", screen: item.screen })}
            >
              <span className="nav-icon" aria-hidden="true">
                <Icon />
              </span>
              <span className="nav-label">{t(item.label)}</span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        {/*
         * The compact rail is a stored preference, not a width breakpoint. A
         * monitor at 900px used to collapse the rail without telling anyone and
         * with no way to undo it; the toggle writes `sidebarMinimal` so the
         * choice survives the next launch.
         */}
        <button
          className="btn btn-quiet sidebar-action"
          type="button"
          aria-pressed={minimal}
          aria-label={minimal ? t("sidebar.expand") : t("sidebar.collapse")}
          title={minimal ? t("sidebar.expand") : t("sidebar.collapse")}
          onClick={() => actions.setSidebarMinimal(!minimal)}
        >
          <span className="nav-icon" aria-hidden="true">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
              <rect x="3.4" y="4.4" width="17.2" height="15.2" rx="2.4" stroke="currentColor" strokeWidth="1.75" />
              <path d="M9.4 4.8v14.4" stroke="currentColor" strokeWidth="1.75" />
            </svg>
          </span>
          <span className="nav-label">
            {minimal ? t("sidebar.full") : t("sidebar.minimal")}
          </span>
        </button>

        <button
          className="btn btn-quiet sidebar-action"
          type="button"
          aria-label={t(themeLabel)}
          title={t(themeLabel)}
          onClick={() => {
            const theme = nextTheme(state.theme);
            // Dispatch for the paint, persist for the next boot. Optimistic like
            // pin/hide: waiting for the `state_get` round-trip made the control
            // look dead (the lesson from SettingsScreen's telemetry toggle).
            dispatch({ type: "prefs/theme", theme });
            void actions.updateSettings("appearance", { themeId: theme });
          }}
        >
          <span className="nav-icon" aria-hidden="true">
            {/* A half-filled circle: the conventional "appearance" mark. */}
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="8.6" stroke="currentColor" strokeWidth="1.75" />
              <path d="M12 3.4a8.6 8.6 0 0 1 0 17.2z" fill="currentColor" />
            </svg>
          </span>
          <span className="nav-label">{t(themeLabel)}</span>
        </button>

        <label className="toggle sidebar-action" title={t("titlebar.reducedMotion")}>
          <input
            type="checkbox"
            aria-label={t("titlebar.reducedMotion")}
            checked={state.reduceMotion}
            onChange={(event) => {
              const reduceMotion = event.target.checked;
              dispatch({ type: "prefs/motion", reduceMotion });
              void actions.savePreferences({ reduceMotion });
            }}
          />
          <span className="nav-label">{t("titlebar.reducedMotion")}</span>
        </label>

        {/*
         * Two real links, not buttons with a click handler: an anchor is what a
         * screen reader announces as a link and what a right click can copy.
         * `rel="noreferrer"` keeps the product page out of the browser referrer
         * log, which matters for a tool people run on a work laptop.
         */}
        <a
          className="btn btn-quiet sidebar-action"
          href="https://github.com/emirtdede/zenith"
          target="_blank"
          rel="noreferrer"
          aria-label={t("github.label")}
          title={t("github.label")}
        >
          <span className="nav-icon" aria-hidden="true">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.95 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.85-2.35 4.7-4.58 4.94.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z" />
            </svg>
          </span>
          <span className="nav-label">GitHub</span>
        </a>
        <a
          className="btn btn-quiet sidebar-action"
          href="https://github.com/sponsors/emirtdede"
          target="_blank"
          rel="noreferrer"
          aria-label={t("sponsor.label")}
          title={t("sponsor.label")}
        >
          <span className="nav-icon" aria-hidden="true">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
              <path
                d="M12 20.2 4.6 12.9a4.9 4.9 0 0 1 7-6.9l.4.4.4-.4a4.9 4.9 0 0 1 7 6.9z"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <span className="nav-label">{t("sponsor.label")}</span>
        </a>
      </div>
    </aside>
  );
}
