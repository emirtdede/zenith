import type { Dispatch } from "react";

import type { ActionsApi } from "../actions";
import { ACTIONS } from "../catalog.generated";
import { useNow, useT } from "../i18n";
import type { Action, State } from "../state/store";
import { NOT_MEASURED } from "../shared/placeholder";

/**
 * The bottom measurement strip.
 *
 * It used to carry the six destinations as well. When the shell gained a
 * sidebar (DEF-145) that became two navigations for the same six places, so the
 * duplicate was removed: the rail owns "where can I go", this bar owns "what do
 * we know". What is left is all measurement or console - the action count, the
 * issue count, last-scan age, and the console toggle - and each of them reads
 * from the one source that owns it.
 */
export function StatusBar({
  state,
  dispatch,
  actions,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  actions: ActionsApi;
}) {
  const t = useT();
  // The relative "last scan" line is kept honest by the same ticking clock the
  // health strip uses (DEF-139).
  const now = useNow();
  // One source for one claim. The health strip renders `telemetry.issueCount`
  // and the status bar used to derive its own count by filtering `reports` - so
  // the same sentence could report two numbers, and before any diagnosis ran it
  // reported `None`: `reports` is empty because nothing was measured, and an
  // empty map was read as "zero issues". "Not measured" and "no problems" are
  // different claims, and this project's own rule is that the first must never
  // be rendered as the second (DEF-115).
  const issues = state.telemetry ? state.telemetry.issueCount : null;

  return (
    <footer className="statusbar">
      <div className="statusbar-left">
        <button
          className={`btn btn-quiet ${state.consoleOpen ? "is-active" : ""}`}
          type="button"
          aria-expanded={state.consoleOpen}
          onClick={() => dispatch({ type: "console/toggle" })}
        >
          {t("status.console")} <kbd>`</kbd>
        </button>
        <span className="muted small">
          {t("status.actions", { count: ACTIONS.length })} ·{" "}
          {issues == null ? NOT_MEASURED : t("health.issues.value", { count: issues })}
        </span>
        {state.telemetry ? (
          <span className="muted small">
            {t("status.lastScan", { time: t.formatRelative(state.telemetry.measuredAtUtc, now) })}
          </span>
        ) : null}
      </div>

      <div className="statusbar-nav">
        {state.activeActionId ? (
          <button
            className="btn"
            type="button"
            onClick={() => void actions.cancel(state.activeActionId as NonNullable<State["activeActionId"]>)}
          >
            {t("card.cancel")}
          </button>
        ) : null}
      </div>
    </footer>
  );
}
