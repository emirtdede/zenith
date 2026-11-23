import type { Dispatch } from "react";

import type { ActionsApi } from "../actions";
import type { ThemeId } from "../bridge/types";
import { ACTIONS } from "../catalog.generated";
import { useT } from "../i18n";
import type { Action, State } from "../state/store";

const THEMES: ThemeId[] = ["off-white", "true-black", "spatial-glass"];

/**
 * A theme id is kebab-case and its catalogue key is camelCase, so the mapping
 * lives in one table rather than in a nested ternary at the call site. Measured
 * reason: the previous `theme === "off-white" ? … : theme === "true-black" ? … :
 * "spatialGlass"` expression silently produced `spatialGlass` for *any* third
 * value, so a future theme would have rendered another theme's label instead of
 * failing visibly. A table makes a missing entry a lookup miss, which the
 * catalogue check reports.
 */
const THEME_LABEL: Record<ThemeId, string> = {
  "off-white": "titlebar.theme.offWhite",
  "true-black": "titlebar.theme.trueBlack",
  "spatial-glass": "titlebar.theme.spatialGlass",
};

export function SettingsScreen({
  state,
  dispatch,
  actions,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  actions: ActionsApi;
}) {
  const t = useT();

  return (
    <section className="screen">
      <header className="screen-head">
        <div>
          <h2>{t("palette.group.settings")}</h2>
          <p className="muted">{t("app.tagline")}</p>
        </div>
      </header>

      <div className="two-col">
        <article className="panel">
          <h3>{t("palette.locale")}</h3>
          <label className="field">
            <span>{t("palette.locale")}</span>
            <select
              value={state.locale}
              onChange={(event) => {
                const locale = event.target.value;
                dispatch({ type: "prefs/locale", locale });
                void actions.savePreferences({ locale });
              }}
            >
              <option value="en">English</option>
              <option value="tr">Türkçe</option>
            </select>
          </label>

          <h3>{t("titlebar.theme")}</h3>
          {THEMES.map((theme) => (
            <label key={theme} className="radio">
              <input
                type="radio"
                name="theme"
                value={theme}
                checked={state.theme === theme}
                onChange={() => {
                  dispatch({ type: "prefs/theme", theme });
                  void actions.savePreferences({ theme });
                }}
              />
              <span>{t(THEME_LABEL[theme] as Parameters<typeof t>[0])}</span>
            </label>
          ))}

          {/* Without its own heading these two read as a fourth and fifth theme,
              which is how a user ends up "selecting" telemetry as a colour. */}
          <h3>{t("settings.behaviour")}</h3>

          <label className="toggle">
            <input
              type="checkbox"
              checked={state.reduceMotion}
              onChange={(event) => {
                const reduceMotion = event.target.checked;
                dispatch({ type: "prefs/motion", reduceMotion });
                void actions.savePreferences({ reduceMotion });
              }}
            />
            <span>{t("titlebar.reducedMotion")}</span>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={state.telemetryEnabled}
              onChange={(event) => {
                // The checkbox is controlled by `state.telemetryEnabled`, so
                // persisting alone left it frozen: `savePreferences` waits for a
                // full `state_get` round-trip, and until that resolved the box
                // snapped back to the old value. A control the user clicks that
                // does not move reads as broken even when the write succeeded.
                // Dispatch first (optimistic, like pin/hide), then persist; the
                // `state/replaced` that follows carries the stored value.
                const telemetryEnabled = event.target.checked;
                dispatch({ type: "prefs/telemetry", telemetryEnabled });
                void actions.savePreferences({ telemetryEnabled });
              }}
            />
            <span>{t("trust.telemetry")}</span>
          </label>
        </article>

        <article className="panel">
          <h3>{t("card.hiddenTitle")}</h3>
          <p className="muted">{t("card.hiddenBody")}</p>
          <ul className="manage-list">
            {ACTIONS.map((def) => {
              const hidden = state.actionPrefs.hidden.includes(def.id);
              return (
                <li key={def.id}>
                  <span>{t.tKey(`${def.i18nPrefix}.title`)}</span>
                  <label className="toggle">
                    <input
                      type="checkbox"
                      checked={hidden}
                      onChange={() => void actions.toggleHidden(def.id)}
                    />
                    <span>{t("card.hide")}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </article>
      </div>
    </section>
  );
}
