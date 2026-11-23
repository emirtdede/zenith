import { useEffect, useState } from "react";
import type { Dispatch } from "react";

import { useT } from "../i18n";
import type { Action, State } from "../state/store";
import { logText, logTextAll } from "./logText";

/** The sixth screen: the full-height activity log. */
export function ActivityScreen({
  state,
  dispatch,
}: {
  state: State;
  dispatch: Dispatch<Action>;
}) {
  const t = useT();
  // Same confirmation the drawer gives. Before this the Activity screen's Copy
  // button wrote to the clipboard and changed nothing on screen, so a user who
  // clicked it could not tell a successful copy from a dead button - the exact
  // "control with no feedback" defect DEF-089 fixed in the drawer (DEF-116).
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 2_000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <section className="screen">
      <header className="screen-head">
        <div>
          <h2>{t("console.title")}</h2>
          <p className="muted">{t("console.subtitle")}</p>
        </div>
        <div className="card-actions">
          <button
            className="btn btn-quiet"
            type="button"
            onClick={() => {
              // Copy what the list shows, not the raw `text` field - the same
              // defect as the drawer's Copy button (DEF-116).
              void navigator.clipboard
                ?.writeText(logTextAll(t, state.logs))
                .then(() => setCopied(true));
            }}
          >
            {copied ? t("console.copied") : t("console.copy")}
          </button>
          <button
            className="btn btn-quiet"
            type="button"
            onClick={() => dispatch({ type: "log/cleared" })}
          >
            {t("console.clear")}
          </button>
        </div>
      </header>

      {state.droppedLogs > 0 ? (
        <p className="muted small">{t("console.dropped", { count: state.droppedLogs })}</p>
      ) : null}

      {/*
       * No `log-tall`/`max-height` here. `05-02` §1 makes `.main` the only page
       * scroll container; the Activity screen renders inside `.main`, so a
       * bounded log here was a nested scroller (trap the wheel, hide rows
       * behind a second scrollbar at 320 CSS px). The list grows, the page
       * scrolls once.
       */}
      <ol className="log">
        {state.logs.length === 0 ? (
          <li className="log-empty muted">{t("console.empty")}</li>
        ) : null}
        {state.logs.map((line) => (
          <li key={`${line.seq}-${line.atUtc}`} className={`log-${line.level}`}>
            <span className="mono small">{t.formatTime(line.atUtc)}</span>
            {/* Same rule as the drawer: localize `stepKey`, fall back to the
                redacted technical `text` (DEF-088). */}
            <span>{logText(t.tKey, line)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
