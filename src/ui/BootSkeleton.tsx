/**
 * The shape of the application before it has data.
 *
 * A centred "Loading" word tells the user nothing and then jumps to a full
 * layout when boot finishes. This renders the shell's own boxes - the rail, the
 * KPI strip, the page head, the card grid - so the only thing that changes on
 * first paint is that the boxes fill with text. The geometry is borrowed from
 * the real classes (`.app-sidebar`, `.sidebar-nav`, `.health`, `.grid`, `.card`);
 * a skeleton that carries its own numbers drifts from the thing it stands in
 * for, which is the reason the token layer defines the shimmer and not the
 * shape.
 *
 * It is deliberately `aria-busy` with one hidden status label rather than a
 * nest of live regions: a screen reader should hear "Loading" once, not once
 * per rectangle.
 */

import { useT } from "../i18n";

function Line({ width }: { width: string }) {
  return <span className="skeleton bs-line" style={{ width }} />;
}

export function BootSkeleton() {
  const t = useT();
  return (
    <div className="shell boot-skeleton" aria-busy="true">
      <aside className="app-sidebar" aria-hidden="true">
        <div className="sidebar-brand">
          <span className="skeleton bs-mark" />
          <div className="sidebar-brand-text">
            <Line width="74px" />
            <Line width="116px" />
          </div>
        </div>
        <div className="sidebar-palette">
          <span className="skeleton bs-trigger" />
        </div>
        <nav className="sidebar-nav">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="nav-btn bs-nav">
              <span className="skeleton bs-icon" />
              <Line width={index % 2 === 0 ? "66%" : "52%"} />
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="nav-btn bs-nav">
            <span className="skeleton bs-icon" />
            <Line width="44%" />
          </div>
          <div className="nav-btn bs-nav">
            <span className="skeleton bs-icon" />
            <Line width="56%" />
          </div>
        </div>
      </aside>

      <div className="workspace">
        <header className="appbar">
          <Line width="160px" />
        </header>

        <section className="health" aria-hidden="true">
          <div className="health-score">
            <Line width="64px" />
            <span className="skeleton bs-score" />
            <Line width="96px" />
          </div>
          <dl className="health-metrics">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index}>
                <Line width="52px" />
                <span className="skeleton bs-kpi" />
                <Line width="40px" />
              </div>
            ))}
          </dl>
        </section>

        <main className="main" id="main" data-screen="actions">
          <div className="page">
            <div className="page-head">
              <span className="skeleton bs-title" />
              <Line width="280px" />
            </div>
            <div className="grid">
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index} className="card">
                  <div className="card-head">
                    <span className="skeleton bs-card-icon" />
                    <Line width="62%" />
                  </div>
                  <Line width="100%" />
                  <Line width="84%" />
                  <div className="card-foot">
                    <Line width="30%" />
                    <Line width="22%" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </main>
      </div>

      <span className="sr-only" role="status" aria-live="polite">
        {t("skeleton.loading")}
      </span>
    </div>
  );
}
