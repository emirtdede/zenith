import type { ActionsApi } from "../actions";
import { ACTIONS } from "../catalog.generated";
import { useNow, useT } from "../i18n";
import type { State } from "../state/store";
import { NOT_MEASURED } from "../shared/placeholder";

export function SnapshotsScreen({ state, actions }: { state: State; actions: ActionsApi }) {
  const t = useT();
  // "Restored 3 minutes ago" must age while the screen is open (DEF-138).
  const now = useNow();

  return (
    <section className="screen">
      <header className="screen-head">
        <div>
          <h2>{t("snapshots.title")}</h2>
          <p className="muted">{t("snapshots.subtitle")}</p>
        </div>
        <div className="screen-tools">
          {/*
           * `retention` is `null` until boot completes, and the boot gate above
           * this screen renders "Loading…" until then - but the type is nullable
           * and `?? 0` would encode "not measured" as the measurement zero. The
           * pill claims "3 snapshots (2 KB), 9 audit rows"; a zero would be a
           * confident claim about a store nobody read (DEF-116).
           */}
          {state.retention ? (
            <span className="pill">
              {t("trust.retention.value", {
                snapshots: state.retention.snapshots,
                bytes: t.formatBytes(state.retention.snapshotBytes),
                rows: state.retention.auditRows,
              })}
            </span>
          ) : (
            <span className="pill muted" title={t("health.never")}>
              {NOT_MEASURED}
            </span>
          )}
          <div className="card-actions">
            <button
              className="btn btn-quiet"
              type="button"
              onClick={() => void actions.exportAudit("csv")}
            >
              {t("snapshots.exportCsv")}
            </button>
            <button
              className="btn btn-quiet"
              type="button"
              onClick={() => void actions.exportAudit("json")}
            >
              {t("snapshots.exportJson")}
            </button>
          </div>
        </div>
      </header>

      {state.snapshots.length === 0 ? (
        <p className="empty">{t("snapshots.empty")}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{t("card.report")}</th>
              <th scope="col">{t("snapshots.created")}</th>
              <th scope="col">{t("snapshots.size")}</th>
              <th scope="col">{t("snapshots.tier")}</th>
              {/* Named, not a bare `<th scope="col" />`. A empty header over the
                  Undo button is announced as "column 5" with no name - the same
                  defect DEF-112 fixed in the candidate table, still present
                  here because only one table was checked (DEF-116). */}
              <th scope="col">{t("snapshots.column.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {state.snapshots.map((row) => {
              const def = ACTIONS.find((entry) => entry.id === row.actionId);
              return (
                <tr key={row.snapshotId}>
                  <td>
                    {def ? t.tKey(`${def.i18nPrefix}.title`) : row.actionId}
                    <div className="mono small muted">{row.snapshotId}</div>
                  </td>
                  <td>{t.formatDate(row.createdAtUtc)}</td>
                  <td>{t.formatBytes(row.estBytes)}</td>
                  <td>{t(`tier.${row.tier}`)}</td>
                  <td>
                    {row.status === "broken" ? (
                      <span className="badge is-bad">{t("snapshots.broken")}</span>
                    ) : row.isRestored ? (
                      <span className="muted small">
                        {t("snapshots.restored", { time: t.formatRelative(row.restoredAtUtc, now) })}
                      </span>
                    ) : (
                      <button
                        className="btn"
                        type="button"
                        onClick={() => void actions.rollback(row.snapshotId)}
                      >
                        {t("snapshots.undo")}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
