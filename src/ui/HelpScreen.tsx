import { useT } from "../i18n";

const SHORTCUTS: { keys: string; label: Parameters<ReturnType<typeof useT>["t"]>[0] }[] = [
  { keys: "Ctrl K", label: "help.k.palette" },
  { keys: "Ctrl D", label: "help.k.diagnose" },
  { keys: "/", label: "help.k.search" },
  { keys: "`", label: "help.k.console" },
  { keys: "?", label: "help.about" },
  { keys: "Esc", label: "help.k.escape" },
  { keys: "← → ↑ ↓", label: "help.k.cards" },
  { keys: "Enter", label: "help.k.run" },
];

export function HelpScreen() {
  const t = useT();

  return (
    <section className="screen">
      <header className="screen-head">
        <div>
          <h2>{t("help.title")}</h2>
          <p className="muted">{t("help.subtitle")}</p>
        </div>
      </header>

      <article className="panel">
        <h3>{t("help.shortcuts")}</h3>
        <dl className="shortcuts">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys}>
              <dt>
                <kbd>{shortcut.keys}</kbd>
              </dt>
              <dd>{t(shortcut.label)}</dd>
            </div>
          ))}
        </dl>
      </article>

      <article className="panel">
        <h3>{t("help.about")}</h3>
        <p>{t("help.about.body")}</p>
        <p className="muted small">{t("app.tagline")}</p>
      </article>
    </section>
  );
}
