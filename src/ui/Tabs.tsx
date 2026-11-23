import type { Dispatch } from "react";
import { useRef } from "react";

import { useT } from "../i18n";
import type { Action, State } from "../state/store";

const TABS: { id: State["category"]; label: Parameters<ReturnType<typeof useT>["t"]>[0] }[] = [
  { id: "all", label: "tabs.all" },
  { id: "cleanup", label: "tabs.cleanup" },
  { id: "network", label: "tabs.network" },
  { id: "recovery", label: "tabs.recovery" },
  { id: "dev_office", label: "tabs.devOffice" },
];

/**
 * The id of the element the tabs control. `App.tsx` renders it.
 *
 * It is *not* `main` any more (DEF-161). The page landmark and the tab panel
 * are different roles with different rules: a `tabpanel` must not contain the
 * `tablist` that controls it, and the page heading has to sit inside the
 * landmark so a screen reader arriving at `main` hears what the screen is for.
 * Both are satisfied by making `#main` the landmark and the panel a child of
 * it, with the tablist a sibling of the panel rather than its parent.
 */
export const ACTION_PANEL_ID = "action-panel";

export function Tabs({
  state,
  dispatch,
}: {
  state: State;
  dispatch: Dispatch<Action>;
}) {
  const t = useT();
  const listRef = useRef<HTMLDivElement>(null);

  // Roving tabindex, per the ARIA tabs pattern: exactly one tab is in the tab
  // order and the arrow keys move between the rest. Before DEF-122 all five
  // were tabbable, `aria-controls` named nothing, no `tabpanel` existed and the
  // arrow keys did nothing - `role="tab"` was declared without the behaviour
  // that role promises, and the `tablist` also wrapped the search box, which is
  // not a tab.
  const selectAt = (index: number) => {
    const target = TABS[index];
    if (!target) {
      return;
    }
    dispatch({ type: "category/set", category: target.id });
    // Move focus as well as selection: with automatic activation the focused
    // tab *is* the selected tab, so leaving focus behind would announce one tab
    // and show another's panel.
    listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[index]?.focus();
  };

  return (
    <div className="tabs">
      <div className="tab-list" role="tablist" aria-label={t("tabs.categories")} ref={listRef}>
        {TABS.map((tab, index) => {
          const selected = state.category === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={ACTION_PANEL_ID}
              // Only the selected tab is reachable with Tab; the arrows do the
              // rest. Roving tabindex is what makes a tablist one stop instead
              // of five.
              tabIndex={selected ? 0 : -1}
              className={`tab ${selected ? "is-active" : ""}`}
              onClick={() => dispatch({ type: "category/set", category: tab.id })}
              onKeyDown={(event) => {
                switch (event.key) {
                  case "ArrowRight":
                    event.preventDefault();
                    selectAt((index + 1) % TABS.length);
                    break;
                  case "ArrowLeft":
                    event.preventDefault();
                    selectAt((index - 1 + TABS.length) % TABS.length);
                    break;
                  case "Home":
                    event.preventDefault();
                    selectAt(0);
                    break;
                  case "End":
                    event.preventDefault();
                    selectAt(TABS.length - 1);
                    break;
                  default:
                    break;
                }
              }}
            >
              {t(tab.label)}
            </button>
          );
        })}
      </div>

      <div className="search">
        <label className="sr-only" htmlFor="action-search">
          {t("tabs.search")}
        </label>
        <input
          id="action-search"
          type="search"
          value={state.search}
          placeholder={t("tabs.search.placeholder")}
          onChange={(event) => dispatch({ type: "search/set", search: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              dispatch({ type: "search/set", search: "" });
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              dispatch({ type: "focus/set", index: 0 });
              const first = document.querySelector<HTMLElement>("[data-action-card]");
              first?.focus();
              // Same rule as the grid: focus that is not scrolled into view is
              // not focus a sighted keyboard user can follow (DEF-045).
              first?.scrollIntoView({ block: "nearest" });
            }
          }}
        />
      </div>
    </div>
  );
}
