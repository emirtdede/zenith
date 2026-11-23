import type { Dispatch } from "react";

import { type ActionsApi, requiresTargets } from "../actions";
import type { ActionId, DiagnosticReport } from "../bridge/types";
import { ACTIONS, type ActionDef } from "../catalog.generated";
import { useT } from "../i18n";
import type { Action, State } from "../state/store";
import { HideIcon, PinIcon, ShowIcon, UnpinIcon } from "./icons";

function phaseClass(phase: string): string {
  switch (phase) {
    case "running":
    case "diagnosing":
      return "is-running";
    case "success":
    case "healthy":
      return "is-ok";
    case "error":
      return "is-bad";
    case "needs_attention":
      return "is-warn";
    default:
      return "";
  }
}

export function ActionGrid({
  state,
  dispatch,
  actions,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  actions: ActionsApi;
}) {
  const t = useT();
  const query = state.search.trim().toLocaleLowerCase(state.locale);

  const matches = (def: ActionDef) => {
    if (state.category !== "all" && def.category !== state.category) {
      return false;
    }
    if (state.actionPrefs.hidden.includes(def.id) && !state.showHidden) {
      return false;
    }
    if (!query) {
      return true;
    }
    const title = t.tKey(`${def.i18nPrefix}.title`);
    const description = t.tKey(`${def.i18nPrefix}.desc`);
    return `${title} ${description} ${def.id}`.toLocaleLowerCase(state.locale).includes(query);
  };

  const visible = ACTIONS.filter(matches).sort((left, right) => {
    const pinLeft = state.actionPrefs.pinned.indexOf(left.id);
    const pinRight = state.actionPrefs.pinned.indexOf(right.id);
    if (pinLeft !== -1 || pinRight !== -1) {
      if (pinLeft === -1) return 1;
      if (pinRight === -1) return -1;
      return pinLeft - pinRight;
    }
    return left.order - right.order;
  });

  if (visible.length === 0) {
    return <p className="empty">{t("tabs.search.empty", { query: state.search })}</p>;
  }

  return (
    <>
      <div className="grid">
        {visible.map((def, index) => (
          <ActionCard
            key={def.id}
            def={def}
            state={state}
            dispatch={dispatch}
            actions={actions}
            index={index}
          />
        ))}
      </div>
      {state.actionPrefs.hidden.length > 0 ? (
        <label className="toggle show-hidden">
          <input
            type="checkbox"
            checked={state.showHidden}
            onChange={(event) =>
              dispatch({ type: "prefs/showHidden", showHidden: event.target.checked })
            }
          />
          <span>{t("card.showHidden", { count: state.actionPrefs.hidden.length })}</span>
        </label>
      ) : null}
    </>
  );
}

function ActionCard({
  def,
  state,
  dispatch,
  actions,
  index,
}: {
  def: ActionDef;
  state: State;
  dispatch: Dispatch<Action>;
  actions: ActionsApi;
  index: number;
}) {
  const t = useT();
  const report: DiagnosticReport | undefined = state.reports[def.id];
  const phase = state.phases[def.id] ?? "idle";
  const busy = phase === "running" || phase === "diagnosing";
  const pinned = state.actionPrefs.pinned.includes(def.id);
  const hidden = state.actionPrefs.hidden.includes(def.id);
  const snapshot = state.snapshots.find(
    (row) => row.actionId === def.id && !row.isRestored && row.status === "committed",
  );

  const run = () => {
    const kind = requiresTargets(def.id);
    if (kind) {
      dispatch({ type: "candidates/open", kind });
      return;
    }
    dispatch({
      type: "confirm/open",
      confirm: { actionId: def.id, definition: def, report: report ?? null },
    });
  };

  const focusCard = (delta: number) => {
    const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-action-card]"));
    const next = cards[index + delta];
    if (!next) {
      return;
    }
    next.focus();
    // Keyboard focus must be *visible*: arrowing to a card below the fold has to
    // scroll it in, or a keyboard user is typing into a card they cannot see
    // (DEF-045). `block: "nearest"` avoids a jump when it is already visible.
    next.scrollIntoView({ block: "nearest" });
  };

  return (
    <article
      className={`card ${phaseClass(phase)}`}
      data-action-card
      data-action-id={def.id}
      tabIndex={0}
      aria-label={t.tKey(`${def.i18nPrefix}.title`)}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          focusCard(1);
        }
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          focusCard(-1);
        }
        if (event.key === "Enter" && !busy) {
          event.preventDefault();
          run();
        }
      }}
    >
      <header className="card-head">
        <h3 className="card-title">{t.tKey(`${def.i18nPrefix}.title`)}</h3>
        <div className="card-tools">
          {/*
           * `aria-label` is not decoration. `title` does not name a button that
           * has text content: the accessible-name algorithm tries content first
           * and only falls back to `title` when content is empty, so these two
           * buttons were once announced as a star and a circle glyph - measured
           * with `computeAccessibleName`, which is the same algorithm
           * `title`-only markup cannot beat. Three documents claimed the opposite
           * (DEF-120). The icon is an inline SVG (DEF-154), so the button has no
           * text content and the label is the only possible name.
           */}
          <button
            type="button"
            className={`icon-btn ${pinned ? "is-active" : ""}`}
            aria-pressed={pinned}
            aria-label={pinned ? t("card.unpin") : t("card.pin")}
            title={pinned ? t("card.unpin") : t("card.pin")}
            onClick={() => void actions.togglePin(def.id)}
          >
            {pinned ? <UnpinIcon /> : <PinIcon />}
          </button>
          <button
            type="button"
            className={`icon-btn ${hidden ? "is-active" : ""}`}
            aria-pressed={hidden}
            aria-label={hidden ? t("card.unhide") : t("card.hide")}
            title={hidden ? t("card.unhide") : t("card.hide")}
            onClick={() => void actions.toggleHidden(def.id)}
          >
            {hidden ? <ShowIcon /> : <HideIcon />}
          </button>
        </div>
      </header>

      <p className="card-desc">{t.tKey(`${def.i18nPrefix}.desc`)}</p>

      <p className={`card-metric ${report?.needsAttention ? "is-warn" : ""}`}>
        {report
          ? t.tKey(report.metricKey, report.metricParams)
          : t("card.unknown")}
      </p>

      <div className="card-badges">
        <span className={`badge risk-${def.risk}`}>{t(`risk.${def.risk}`)}</span>
        <span className="badge">{t(`tier.${def.tier}`)}</span>
        {def.requiresAdmin ? <span className="badge">{t("card.requiresAdmin")}</span> : null}
        {def.readOnly ? <span className="badge">{t("card.readOnly")}</span> : null}
        {/* The manifest declares which actions accept a cancel; the card must
            say so, or "Can be stopped" exists only in the catalogue. */}
        {def.abortable ? <span className="badge">{t("card.abortable")}</span> : null}
        {def.id === "reset-winsock-stack" ? (
          <span className="badge">{t("card.requiresReboot")}</span>
        ) : null}
      </div>

      <footer className="card-foot">
        <span className={`status ${phaseClass(phase)}`}>{t(`status.${phase}`)}</span>
        <div className="card-actions">
          <button
            className="btn btn-quiet"
            type="button"
            onClick={() => dispatch({ type: "script/open", script: { actionId: def.id, format: "ps1" } })}
          >
            {t("card.report")}
          </button>
          {snapshot ? (
            <button
              className="btn btn-quiet"
              type="button"
              data-card-rollback
              onClick={() => void actions.rollback(snapshot.snapshotId)}
            >
              {t("card.rollback")}
            </button>
          ) : null}
          {busy ? (
            <button
              className="btn"
              type="button"
              onClick={() => void actions.cancel(def.id as ActionId)}
            >
              {t("card.cancel")}
            </button>
          ) : (
            <button className="btn btn-primary" type="button" data-card-run onClick={run}>
              {def.requiresAdmin && !state.info?.isElevated ? t("card.runAsAdmin") : t("card.run")}
            </button>
          )}
        </div>
      </footer>
    </article>
  );
}
