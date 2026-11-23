import { useEffect, useState } from "react";
import type { Dispatch } from "react";

import { ACTIONS } from "../catalog.generated";
import { useT } from "../i18n";
import type { Action, State } from "../state/store";
import { logText, logTextAll } from "./logText";

/**
 * The console drawer. `05-02` §5: bounded, copyable, honest about gaps.
 *
 * Copy gives feedback: pressing a button that silently does nothing is the same
 * defect as a control with no handler. `console.running` / `console.cancelHint`
 * appear only while an action is actually running, so they cannot be a claim
 * about a state the app is not in.
 */
export function Console({
  state,
  dispatch,
}: {
  state: State;
  dispatch: Dispatch<Action>;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  // The "Copied" label is a promise with a shelf life; it must not stay true.
  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  if (!state.consoleOpen) {
    return null;
  }

  const copy = () => {
    // Same text the list above renders, not the raw technical field: a user who
    // copies a log must get what they read (DEF-116).
    void navigator.clipboard
      ?.writeText(logTextAll(t, state.logs))
      .then(() => setCopied(true));
  };

  const runningId = state.activeActionId;
  const runningDef = runningId ? ACTIONS.find((def) => def.id === runningId) : undefined;

  return (
    <section className="drawer console" aria-label={t("console.title")}>
      <header className="drawer-head">
        <h2>{t("console.title")}</h2>
        <div className="card-actions">
          <button className="btn btn-quiet" type="button" onClick={copy}>
            {copied ? t("console.copied") : t("console.copy")}
          </button>
          <button
            className="btn btn-quiet"
            type="button"
            onClick={() => dispatch({ type: "log/cleared" })}
          >
            {t("console.clear")}
          </button>
          <button
            className="btn btn-quiet"
            type="button"
            onClick={() => dispatch({ type: "console/toggle", open: false })}
          >
            {t("misc.close")}
          </button>
        </div>
      </header>

      {runningDef ? (
        <p className="muted small">
          {t("console.running", { action: t.tKey(`${runningDef.i18nPrefix}.title`) })}
          {" - "}
          {t("console.cancelHint")}
        </p>
      ) : null}

      {state.droppedLogs > 0 ? (
        <p className="muted small">{t("console.dropped", { count: state.droppedLogs })}</p>
      ) : null}

      <ol className="log" aria-live="polite">
        {/*
         * `log-empty`, not a bare `muted` row: `.log li` is a 76 px time column,
         * so the sentence would wrap one word per line in the drawer - the same
         * defect DEF-079 fixed on the Activity screen, still present here because
         * the test only covered one of the two renderers.
         */}
        {state.logs.length === 0 ? (
          <li className="log-empty muted">{t("console.empty")}</li>
        ) : null}
        {state.logs.map((line) => (
          <li key={`${line.seq}-${line.atUtc}`} className={`log-${line.level}`}>
            <span className="mono small">{t.formatTime(line.atUtc)}</span>
            {/* `logText`, not `line.text`: the core emits a `stepKey` and the
                catalogue owns the words (DEF-088). Printing `text` verbatim
                put `steps.dnsFlush: Success` in front of a Turkish user. */}
            <span>{logText(t.tKey, line)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
