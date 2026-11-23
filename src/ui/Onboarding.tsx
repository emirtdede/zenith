/**
 * First run.
 *
 * Four short steps: language, look, what leaves the PC, and a plain statement
 * that the first diagnosis is read-only. It is a modal because there is nothing
 * useful behind it yet; it is skippable because a tour that cannot be dismissed
 * is a hostage situation, and it can be replayed from Settings.
 *
 * The language step is the full 73-language grid, not a short list: a first-run
 * picker that offers twelve languages and a settings picker that offers
 * seventy-three tells the user their language was an afterthought.
 */

import { useMemo, useState } from "react";

import type { ActionsApi } from "../actions";
import { SUPPORTED_LANGUAGES, useT } from "../i18n";
import { COLOR_THEMES } from "../settings/themes";
import type { State } from "../state/store";

const STEPS = ["language", "appearance", "privacy", "done"] as const;

export function Onboarding({ state, actions }: { state: State; actions: ActionsApi }) {
  const t = useT();
  const [step, setStep] = useState(0);
  const [query, setQuery] = useState("");
  const current = state.settings.general.locale;

  const languages = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return SUPPORTED_LANGUAGES;
    }
    return SUPPORTED_LANGUAGES.filter(
      (language) =>
        language.nativeName.toLowerCase().includes(needle) ||
        language.englishName.toLowerCase().includes(needle),
    );
  }, [query]);

  const stage = STEPS[step]!;
  const isLast = step === STEPS.length - 1;

  function finish() {
    void actions.finishOnboarding(false);
  }

  return (
    <div
      className="onboarding"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      <div className="onboarding-card">
        <header className="onboarding-head">
          <div>
            <p className="set-hint">{t("onboarding.step", { current: step + 1, total: STEPS.length })}</p>
            <h2 id="onboarding-title">
              {stage === "language"
                ? t("onboarding.language")
                : stage === "appearance"
                  ? t("onboarding.appearance")
                  : stage === "privacy"
                    ? t("onboarding.privacy")
                    : t("onboarding.done")}
            </h2>
          </div>
          <button type="button" className="btn btn-quiet" onClick={finish}>
            {t("onboarding.skip")}
          </button>
        </header>

        <div className="onboarding-body">
          {stage === "language" ? (
            <>
              <p className="set-hint">{t("onboarding.languageBody")}</p>
              <input
                className="set-input"
                type="search"
                value={query}
                placeholder={t("language.search")}
                aria-label={t("language.search")}
                onChange={(event) => setQuery(event.target.value)}
              />
              <div className="language-grid onboarding-languages" role="listbox" aria-label={t("language.title")}>
                {languages.map((language) => (
                  <button
                    key={language.code}
                    type="button"
                    role="option"
                    aria-selected={current === language.code}
                    className={`language-item ${current === language.code ? "is-active" : ""}`}
                    onClick={() => void actions.updateSettings("general", { locale: language.code })}
                  >
                    <span className="language-name" lang={language.code} dir={language.dir}>
                      {language.nativeName}
                    </span>
                    <span className="language-meta">{language.englishName}</span>
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {stage === "appearance" ? (
            <>
              <p className="set-hint">{t("onboarding.appearanceBody")}</p>
              <div className="palette-grid">
                {COLOR_THEMES.map((palette) => (
                  <button
                    key={palette.id}
                    type="button"
                    className={`palette-card ${state.settings.appearance.themeId === palette.id ? "is-active" : ""}`}
                    aria-pressed={state.settings.appearance.themeId === palette.id}
                    onClick={() => void actions.updateSettings("appearance", { themeId: palette.id })}
                  >
                    <span className="palette-swatch" aria-hidden="true">
                      <span style={{ background: palette.swatch }} />
                      <span style={{ background: palette.light.surface }} />
                      <span style={{ background: palette.dark.surface }} />
                    </span>
                    <span className="palette-name">{t(`theme.${palette.id}` as Parameters<typeof t>[0])}</span>
                  </button>
                ))}
              </div>
              <div className="set-inline">
                {(["system", "light", "dark"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`btn btn-quiet ${state.settings.appearance.mode === mode ? "is-active" : ""}`}
                    aria-pressed={state.settings.appearance.mode === mode}
                    onClick={() => void actions.updateSettings("appearance", { mode })}
                  >
                    {t(`theme.mode.${mode}` as Parameters<typeof t>[0])}
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {stage === "privacy" ? (
            <>
              <h3>{t("onboarding.welcome")}</h3>
              <p>{t("onboarding.welcomeBody")}</p>
              <p className="set-hint">{t("onboarding.privacyBody")}</p>
            </>
          ) : null}

          {stage === "done" ? (
            <>
              <h3>{t("onboarding.done")}</h3>
              <p>{t("onboarding.doneBody")}</p>
              <p className="set-hint">{t("a11y.focusDesc")}</p>
            </>
          ) : null}
        </div>

        <footer className="onboarding-foot">
          <button
            type="button"
            className="btn btn-quiet"
            disabled={step === 0}
            onClick={() => setStep((value) => Math.max(0, value - 1))}
          >
            {t("onboarding.back")}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => (isLast ? finish() : setStep((value) => Math.min(STEPS.length - 1, value + 1)))}
          >
            {isLast ? t("onboarding.finish") : t("onboarding.next")}
          </button>
        </footer>
      </div>
    </div>
  );
}
