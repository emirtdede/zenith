import type { ActionsApi } from "../actions";
import { useNow, useT } from "../i18n";
import { NOT_MEASURED } from "../shared/placeholder";
import type { State } from "../state/store";

/**
 * The only place a system-wide number appears.
 *
 * When no measurement exists the strip says so. It never renders `0` as a
 * health score: "not measured" and "perfect" are different claims.
 */
export function HealthStrip({ state, actions }: { state: State; actions: ActionsApi }) {
  const t = useT();
  // The clock that makes "measured 2 minutes ago" keep telling the truth. It
  // was written for this (`useNow`) and never called, so the strip froze at
  // whatever time it first rendered (DEF-138).
  const now = useNow();
  const telemetry = state.telemetry;
  const running = state.diagnose !== null;

  return (
    <section className="health" aria-label={t("health.title")}>
      <div className="health-score">
        <span className="muted small">{t("health.scoreLabel")}</span>
        <strong className="score">
          {telemetry ? t("health.score", { score: telemetry.healthScore }) : t("health.never")}
        </strong>
        {telemetry ? (
          <span className="muted small">
            {t("health.measuredAt", { time: t.formatRelative(telemetry.measuredAtUtc, now) })}
          </span>
        ) : null}
      </div>

      <dl className="health-metrics">
        <div>
          <dt>{t("health.junk")}</dt>
          <dd>{telemetry ? t.formatBytes(telemetry.junkBytes) : NOT_MEASURED}</dd>
        </div>
        <div>
          <dt>{t("health.dns")}</dt>
          <dd>
            {telemetry?.dnsLatencyMs != null
              ? t("card.latency", { ms: telemetry.dnsLatencyMs })
              : NOT_MEASURED}
          </dd>
        </div>
        <div>
          <dt>{t("health.memory")}</dt>
          <dd>
            {telemetry?.memoryUsedPercent != null
              ? `${Math.round(telemetry.memoryUsedPercent)}%`
              : NOT_MEASURED}
          </dd>
        </div>
        <div>
          <dt>{t("health.issues")}</dt>
          <dd>
            {telemetry ? t("health.issues.value", { count: telemetry.issueCount }) : NOT_MEASURED}
          </dd>
        </div>
      </dl>

      <div className="health-actions">
        {running && state.diagnose ? (
          <>
            <span role="status" className="muted">
              {t("health.diagnosing", { done: state.diagnose.done, total: state.diagnose.total })}
            </span>
            <button
              className="btn btn-quiet"
              type="button"
              onClick={() => void actions.cancel("diagnose")}
            >
              {t("health.cancel")}
            </button>
          </>
        ) : (
          <button className="btn btn-primary" type="button" onClick={() => void actions.diagnose()}>
            {t("health.diagnose")}
          </button>
        )}
      </div>
    </section>
  );
}
