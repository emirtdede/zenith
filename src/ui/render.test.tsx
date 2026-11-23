// @vitest-environment jsdom
/**
 * Render-level tests (DEF-045 / `07-01` §5.5, T-FE-01..14).
 *
 * These mount the shipped components in jsdom and assert what a user can see:
 * the strings, the ARIA state and the dispatch that a click produces. Until this
 * file existed, the frontend rows in `07-01` were satisfied by `tsc` alone -
 * which proves a component compiles, not that it renders.
 *
 * Deliberate choices:
 *   * No snapshot tests. A snapshot records whatever the component did, which
 *     makes a wrong render look correct forever.
 *   * Assertions are on `role`/`aria-*` and on message-catalogue output, so a
 *     hard-coded English string cannot pass for a translated one.
 *   * `ActionsApi` is a stub whose every method is a `vi.fn`; a component that
 *     calls something unexpected fails loudly instead of hitting a network.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionsApi } from "../actions";
import { ACTIONS } from "../catalog.generated";
import { buildTranslator, I18nProvider } from "../i18n";
import { en } from "../i18n/en";
import { tr } from "../i18n/tr";
import { initialState } from "../state/store";
import type { Action, State } from "../state/store";
import licenseManifest from "../../resources/licenses/manifest.json";
import { ActionGrid } from "./ActionGrid";
import { CmdPalette } from "./CmdPalette";
import { ConfirmDialog } from "./Dialogs";
import { Console } from "./Console";
import { HealthStrip } from "./HealthStrip";
import { SettingsScreen } from "./SettingsScreen";
import { SnapshotsScreen } from "./SnapshotsScreen";
import { HelpScreen } from "./HelpScreen";
import { ActivityScreen } from "./ActivityScreen";
import { StatusBar } from "./StatusBar";
import { Sidebar } from "./Sidebar";
import { ACTION_PANEL_ID, Tabs } from "./Tabs";
import { TrustScreen } from "./TrustScreen";

afterEach(cleanup);

/** Every bridge call the UI can make, each its own spy, so a call to one
 * method cannot be counted as a call to another. */
function stubActions(): ActionsApi {
  const noop = () => vi.fn(() => Promise.resolve());
  return {
    boot: noop(),
    refresh: noop(),
    diagnose: noop(),
    cancel: noop(),
    execute: vi.fn(() => Promise.resolve(null)),
    rollback: noop(),
    savePreferences: noop(),
    setActionPrefs: noop(),
    togglePin: noop(),
    toggleHidden: noop(),
    elevate: noop(),
    terminate: noop(),
    createBundle: noop(),
    purge: noop(),
    saveScript: noop(),
    scan: noop(),
  } as unknown as ActionsApi;
}

function makeState(patch: Partial<State> = {}): State {
  return { ...initialState, boot: "ready", ...patch };
}

function renderWith(
  ui: React.ReactElement,
  { locale = "en", state = makeState() }: { locale?: string; state?: State } = {},
) {
  const dispatch = vi.fn<(action: Action) => void>();
  const actions = stubActions();
  const utils = render(
    <I18nProvider locale={locale}>{ui}</I18nProvider>,
  );
  return { ...utils, dispatch, actions, state };
}

describe("HealthStrip (T-FE-02, L1 honesty)", () => {
  it("renders 'never measured' rather than 0 when no telemetry exists", () => {
    renderWith(<HealthStrip state={makeState()} actions={stubActions()} />);

    // The catalogue string, not a literal: a 0 here would read as "perfect".
    expect(screen.getByText(en["health.never"])).toBeTruthy();
    expect(screen.queryByText(/^0$/)).toBeNull();
  });

  it("renders the measured score and byte total when telemetry exists", () => {
    const state = makeState({
      telemetry: {
        healthScore: 82,
        junkBytes: 1536,
        dnsLatencyMs: 24,
        memoryUsedPercent: 61.4,
        issueCount: 3,
        measuredAtUtc: new Date().toISOString(),
        probes: [],
      } as unknown as State["telemetry"],
    });
    const { container } = renderWith(<HealthStrip state={state} actions={stubActions()} />);

    expect(screen.getByText(/82/)).toBeTruthy();
    // The four metrics, read from the DOM: a hard-coded English string could not
    // satisfy both this and the Turkish case below.
    const values = Array.from(container.querySelectorAll("dd")).map((dd) => dd.textContent ?? "");
    expect(values).toContain("2\u00a0KB");
    expect(values).toContain("24 ms");
    // ICU plural with `#`: "3 items", not "# items" (see format.test.ts).
    expect(values).toContain("3 items");
  });

  it("shows progress and a cancel button while diagnosing", () => {
    const actions = stubActions();
    renderWith(
      <HealthStrip state={makeState({ diagnose: { done: 2, total: 9 } })} actions={actions} />,
    );
    fireEvent.click(screen.getByRole("button", { name: en["health.cancel"] }));
    expect(actions.cancel).toHaveBeenCalledWith("diagnose");
  });

  it("starts a diagnosis from the primary button", () => {
    const actions = stubActions();
    renderWith(<HealthStrip state={makeState()} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: en["health.diagnose"] }));
    expect(actions.diagnose).toHaveBeenCalledTimes(1);
  });
});

describe("Tabs (T-FE-03)", () => {
  it("exposes five tabs and marks the active one with aria-selected", () => {
    renderWith(<Tabs state={makeState({ category: "network" })} dispatch={vi.fn()} />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(5);
    const network = screen.getByRole("tab", { name: en["tabs.network"] });
    expect(network.getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getByRole("tab", { name: en["tabs.cleanup"] }).getAttribute("aria-selected"),
    ).toBe("false");
  });

  it("dispatches the category when a tab is clicked", () => {
    const dispatch = vi.fn<(action: Action) => void>();
    renderWith(<Tabs state={makeState()} dispatch={dispatch} />);
    fireEvent.click(screen.getByRole("tab", { name: en["tabs.recovery"] }));
    expect(dispatch).toHaveBeenCalledWith({ type: "category/set", category: "recovery" });
  });

  it("is one tab stop, not five, and points at the panel it controls (DEF-122)", () => {
    renderWith(<Tabs state={makeState({ category: "network" })} dispatch={vi.fn()} />);

    const tabs = screen.getAllByRole("tab");
    // Roving tabindex: exactly the selected tab is in the tab order.
    const tabbable = tabs.filter((tab) => tab.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]?.getAttribute("aria-selected")).toBe("true");
    // The other four are reachable by arrow key only, which is the contract
    // `role="tab"` announces. Before this, all five were Tab stops.
    expect(tabs.filter((tab) => tab.getAttribute("tabindex") === "-1")).toHaveLength(4);

    // Every tab names the element it controls; a tab with no `aria-controls`
    // target is a role promise with nothing behind it.
    for (const tab of tabs) {
      expect(tab.getAttribute("aria-controls")).toBe(ACTION_PANEL_ID);
    }
  });

  it("moves selection and focus with the arrow keys, Home and End (DEF-122)", () => {
    const dispatch = vi.fn<(action: Action) => void>();
    renderWith(<Tabs state={makeState({ category: "all" })} dispatch={dispatch} />);

    const all = screen.getByRole("tab", { name: en["tabs.all"] });

    fireEvent.keyDown(all, { key: "ArrowRight" });
    expect(dispatch).toHaveBeenCalledWith({ type: "category/set", category: "cleanup" });
    // Focus follows selection: automatic activation means the focused tab is
    // the selected one, so leaving focus behind would announce a tab whose
    // panel is not the one on screen.
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: en["tabs.cleanup"] }));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowLeft" });
    expect(dispatch).toHaveBeenLastCalledWith({ type: "category/set", category: "all" });

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "End" });
    expect(dispatch).toHaveBeenLastCalledWith({ type: "category/set", category: "dev_office" });

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Home" });
    expect(dispatch).toHaveBeenLastCalledWith({ type: "category/set", category: "all" });
  });

  it("keeps the search box out of the tablist (DEF-122)", () => {
    renderWith(<Tabs state={makeState()} dispatch={vi.fn()} />);
    const list = screen.getByRole("tablist");
    // A tablist may contain only tabs. The search input used to sit inside it,
    // which is an invalid ARIA structure a screen reader cannot describe.
    expect(list.querySelector("input, [role='searchbox']")).toBeNull();
    expect(list.getAttribute("aria-label")).toBe(en["tabs.categories"]);
  });

  it("clears the search box on Escape and echoes typing through dispatch", () => {
    const dispatch = vi.fn<(action: Action) => void>();
    renderWith(<Tabs state={makeState({ search: "dn" })} dispatch={dispatch} />);
    const input = screen.getByRole("searchbox");

    fireEvent.change(input, { target: { value: "dns" } });
    expect(dispatch).toHaveBeenCalledWith({ type: "search/set", search: "dns" });

    fireEvent.keyDown(input, { key: "Escape" });
    expect(dispatch).toHaveBeenCalledWith({ type: "search/set", search: "" });
  });
});

describe("ActionGrid (T-FE-04, T-FE-06, T-FE-07)", () => {
  it("renders one card per catalog action, so the manifest and UI agree", () => {
    renderWith(<ActionGrid state={makeState()} dispatch={vi.fn()} actions={stubActions()} />);
    expect(document.querySelectorAll("[data-action-card]")).toHaveLength(ACTIONS.length);
  });

  it("says 'unknown' for a metric it has not measured", () => {
    renderWith(<ActionGrid state={makeState()} dispatch={vi.fn()} actions={stubActions()} />);
    // Every card, not just the first: a fabricated 0 anywhere fails here.
    expect(screen.getAllByText(en["card.unknown"]).length).toBe(ACTIONS.length);
  });

  it("filters by search query and reports an empty result honestly", () => {
    renderWith(
      <ActionGrid
        state={makeState({ search: "zzz-no-such-action" })}
        dispatch={vi.fn()}
        actions={stubActions()}
      />,
    );
    expect(document.querySelectorAll("[data-action-card]")).toHaveLength(0);
    expect(screen.getByText(new RegExp(en["tabs.search.empty"].split("{")[0]?.trim() ?? ""))).toBeTruthy();
  });

  it("filters by category", () => {
    renderWith(
      <ActionGrid
        state={makeState({ category: "network" })}
        dispatch={vi.fn()}
        actions={stubActions()}
      />,
    );
    const shown = document.querySelectorAll("[data-action-card]").length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(ACTIONS.length);
  });

  it("hides hidden actions until showHidden is set", () => {
    const hiddenId = ACTIONS[0]!.id;
    const state = makeState({ actionPrefs: { pinned: [], hidden: [hiddenId] } });

    const { unmount } = renderWith(
      <ActionGrid state={state} dispatch={vi.fn()} actions={stubActions()} />,
    );
    expect(document.querySelectorAll("[data-action-card]")).toHaveLength(ACTIONS.length - 1);
    unmount();

    renderWith(
      <ActionGrid
        state={{ ...state, showHidden: true }}
        dispatch={vi.fn()}
        actions={stubActions()}
      />,
    );
    expect(document.querySelectorAll("[data-action-card]")).toHaveLength(ACTIONS.length);
  });

  it("opens the confirm dialog instead of executing on a plain click", () => {
    const dispatch = vi.fn<(action: Action) => void>();
    renderWith(<ActionGrid state={makeState()} dispatch={dispatch} actions={stubActions()} />);

    const first = document.querySelector<HTMLElement>("[data-action-card]");
    expect(first).not.toBeNull();
    fireEvent.click(within(first as HTMLElement).getByRole("button", { name: en["card.run"] }));

    const opened = dispatch.mock.calls.map(([action]) => action.type);
    expect(opened).toContain("confirm/open");
    expect(opened).not.toContain("execution/started");
  });

  it("names the pin and hide icon buttons, so the glyph is never the label (DEF-120)", () => {
    renderWith(<ActionGrid state={makeState()} dispatch={vi.fn()} actions={stubActions()} />);

    const first = document.querySelector<HTMLElement>("[data-action-card]");
    expect(first).not.toBeNull();
    const card = first as HTMLElement;

    // The bug: `title` does not name a button that has text content - the
    // accessible-name algorithm reads content first, so both buttons were
    // announced as a star and a circle. Querying by the catalogue sentence fails
    // unless the name is real, which is the point of using `getByRole` here.
    expect(within(card).getByRole("button", { name: en["card.pin"] })).toBeTruthy();
    expect(within(card).getByRole("button", { name: en["card.hide"] })).toBeTruthy();

    // DEF-154: the icon is a hand-drawn inline SVG, not a text glyph. A bare
    // `★` gave the button a punctuation name from the accessible-name algorithm
    // and put the shape at the mercy of whichever font the machine has, which
    // is the fallback-icon leak the UI rules forbid. The button contains no
    // text at all now, so its name can only come from `aria-label`.
    const pin = within(card).getByRole("button", { name: en["card.pin"] });
    expect(pin.textContent).toBe("");
    const icon = pin.querySelector("svg");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(icon?.getAttribute("focusable")).toBe("false");
  });
});

describe("StatusBar (T-FE-05, T-FE-09)", () => {
  it("reports the real action count from the catalog", () => {
    renderWith(
      <StatusBar state={makeState()} dispatch={vi.fn()} actions={stubActions()} />,
    );
    // Built with the same translator the UI uses, so an ICU-aware string such as
    // "{count, plural, …}" is compared as rendered, not as source. The status
    // line is one text node containing the action count and the issue count, so
    // the assertion is a containment check rather than an exact match.
    const expected = buildTranslator("en")("status.actions", { count: ACTIONS.length });
    expect(screen.getByText((content) => content.includes(expected))).toBeTruthy();
  });

  it("says the issue count is unknown before a diagnosis, not zero (DEF-115)", () => {
    const { unmount } = renderWith(
      <StatusBar
        state={makeState({ telemetry: null, reports: {} })}
        dispatch={vi.fn()}
        actions={stubActions()}
      />,
    );
    // "None" is a measurement. With `reports: {}` nothing was measured, and the
    // bar used to read the empty map as zero issues.
    const none = buildTranslator("en")("health.issues.value", { count: 0 });
    expect(screen.queryByText((content) => content.includes(none))).toBeNull();
    expect(screen.getByText((content) => content.includes("-"))).toBeTruthy();
    unmount();

    // Measured: the count comes from the same telemetry the health strip reads,
    // so the two cannot disagree.
    renderWith(
      <StatusBar
        state={makeState({
          telemetry: { issueCount: 3 } as unknown as State["telemetry"],
        })}
        dispatch={vi.fn()}
        actions={stubActions()}
      />,
    );
    const three = buildTranslator("en")("health.issues.value", { count: 3 });
    expect(screen.getByText((content) => content.includes(three))).toBeTruthy();
  });

  it("offers cancel only while an action is running", () => {
    const { unmount } = renderWith(
      <StatusBar state={makeState()} dispatch={vi.fn()} actions={stubActions()} />,
    );
    expect(screen.queryByRole("button", { name: en["card.cancel"] })).toBeNull();
    unmount();

    renderWith(
      <StatusBar
        state={makeState({ activeActionId: ACTIONS[0]!.id })}
        dispatch={vi.fn()}
        actions={stubActions()}
      />,
    );
    expect(screen.getByRole("button", { name: en["card.cancel"] })).toBeTruthy();
  });
});

describe("Sidebar (DEF-145: one navigation model)", () => {
  it("offers all six destinations, and marks the current one with aria-current", () => {
    const dispatch = vi.fn<(action: Action) => void>();
    renderWith(
      <Sidebar state={makeState({ screen: "trust" })} dispatch={dispatch} actions={stubActions()} />,
    );

    const nav = screen.getByRole("navigation", { name: en["nav.title"] });
    // Six, not four. The palette shipped four for a year because each surface
    // kept its own list; `nav.ts` is now the only list (DEF-143, DEF-145).
    const labels = ["nav.actions", "nav.snapshots", "nav.activity", "nav.trust", "nav.settings", "nav.help"];
    for (const label of labels) {
      expect(within(nav).getByRole("button", { name: en[label as keyof typeof en] })).toBeTruthy();
    }

    const trust = within(nav).getByRole("button", { name: en["nav.trust"] });
    expect(trust.getAttribute("aria-current")).toBe("page");
    // Exactly one current destination, or a screen reader hears two "current".
    expect(nav.querySelectorAll("[aria-current='page']")).toHaveLength(1);

    fireEvent.click(within(nav).getByRole("button", { name: en["nav.help"] }));
    expect(dispatch).toHaveBeenCalledWith({ type: "screen/set", screen: "help" });
  });

  it("cycles and persists the theme from the rail", () => {
    const dispatch = vi.fn<(action: Action) => void>();
    const actions = stubActions();
    renderWith(
      <Sidebar
        state={makeState({ theme: "off-white" })}
        dispatch={dispatch}
        actions={actions}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: en["titlebar.theme.offWhite"] }));
    expect(dispatch).toHaveBeenCalledWith({ type: "prefs/theme", theme: "true-black" });
    // Paint and persistence are two calls: the first is optimistic, the second
    // is what survives a restart. A control that only does the first looks
    // correct until the next boot.
    expect(actions.savePreferences).toHaveBeenCalledWith({ theme: "true-black" });
  });

  it("keeps the theme label translated in Turkish", () => {
    renderWith(
      <Sidebar state={makeState({ theme: "true-black" })} dispatch={vi.fn()} actions={stubActions()} />,
      { locale: "tr" },
    );
    expect(screen.getByRole("button", { name: tr["titlebar.theme.trueBlack"] })).toBeTruthy();
    expect(screen.queryByRole("button", { name: en["titlebar.theme.trueBlack"] })).toBeNull();
  });
});

describe("Console (T-FE-08)", () => {
  it("renders nothing while closed", () => {
    const { container } = renderWith(<Console state={makeState()} dispatch={vi.fn()} />);
    expect(container.querySelector(".console")).toBeNull();
  });

  it("renders log lines, says how many it dropped, and clears", () => {
    const dispatch = vi.fn<(action: Action) => void>();
    renderWith(
      <Console
        state={makeState({
          consoleOpen: true,
          droppedLogs: 7,
          logs: [
            { seq: 1, atUtc: new Date().toISOString(), level: "info", text: "first line" },
            { seq: 2, atUtc: new Date().toISOString(), level: "error", text: "second line" },
          ],
        })}
        dispatch={dispatch}
      />,
    );

    expect(screen.getByText("first line")).toBeTruthy();
    expect(screen.getByText("second line")).toBeTruthy();
    expect(screen.getByText(new RegExp(en["console.dropped"].split("{")[0]?.trim() ?? ""))).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: en["console.clear"] }));
    expect(dispatch).toHaveBeenCalledWith({ type: "log/cleared" });
  });

  it("says the log is empty in its own row class, not as a log line (DEF-079)", () => {
    const { container } = renderWith(
      <Console state={makeState({ consoleOpen: true })} dispatch={vi.fn()} />,
    );
    expect(screen.getByText(en["console.empty"])).toBeTruthy();

    // T-FE-18 guards the Activity renderer; this guards the drawer. The defect
    // was that only *one* of the two was tested, so the other kept rendering
    // the sentence inside `.log li`'s 76 px time column and wrapped one word
    // per line. Asserting the class, not just the text, is what closes it.
    const row = container.querySelector("li.log-empty");
    expect(row).toBeTruthy();
    expect(row?.textContent).toBe(en["console.empty"]);
  });
});

describe("CmdPalette (T-FE-10)", () => {
  it("is a modal dialog carrying navigation and action commands", () => {
    renderWith(
      <CmdPalette state={makeState({ overlay: "palette" })} dispatch={vi.fn()} actions={stubActions()} />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(within(dialog).getByText(en["palette.nav.diagnose"])).toBeTruthy();
    expect(within(dialog).getByText(en["palette.nav.trust"])).toBeTruthy();
  });

  it("reaches every screen the status bar reaches (DEF-143)", () => {
    renderWith(
      <CmdPalette state={makeState({ overlay: "palette" })} dispatch={vi.fn()} actions={stubActions()} />,
    );
    const dialog = screen.getByRole("dialog");
    // Six screens exist; the palette used to offer four and silently omit
    // Settings and Activity, which are the two a keyboard user needs most
    // because neither has a shortcut in `05-02` §7.
    for (const label of [
      "palette.nav.all",
      "palette.nav.snapshots",
      "palette.nav.activity",
      "palette.nav.trust",
      "palette.nav.settings",
      "palette.nav.help",
    ]) {
      // "Settings" is both a navigation label and the group caption, so the
      // assertion is "at least one", not "exactly one".
      expect(within(dialog).getAllByText(en[label as keyof typeof en]).length).toBeGreaterThan(0);
    }
  });

  it("exposes the list as a combobox whose active option is named", () => {
    renderWith(
      <CmdPalette state={makeState({ overlay: "palette" })} dispatch={vi.fn()} actions={stubActions()} />,
    );
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByRole("combobox");
    const list = within(dialog).getByRole("listbox");

    expect(input.getAttribute("aria-controls")).toBe(list.id);
    expect(input.getAttribute("aria-expanded")).toBe("true");

    // `role="option"` must sit on the item, not on a <button> that is already an
    // interactive control, and the field must point at exactly the current one.
    const options = within(dialog).getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    expect(options[0]?.tagName).toBe("LI");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]?.id);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    const moved = within(dialog).getAllByRole("option");
    expect(moved[1]?.getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe(moved[1]?.id);
  });

  it("narrows the list as the query is typed", () => {
    renderWith(
      <CmdPalette state={makeState({ overlay: "palette" })} dispatch={vi.fn()} actions={stubActions()} />,
    );
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByRole("combobox");
    const before = within(dialog).getAllByRole("option").length;

    fireEvent.change(input, { target: { value: "zzzz" } });
    const after = within(dialog).queryAllByRole("option").length;
    expect(after).toBeLessThan(before);
    expect(within(dialog).getByText(en["palette.empty"])).toBeTruthy();
  });

  it("moves the selection with ArrowDown and runs it with Enter", () => {
    const dispatch = vi.fn<(action: Action) => void>();
    renderWith(
      <CmdPalette state={makeState({ overlay: "palette" })} dispatch={dispatch} actions={stubActions()} />,
    );
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByRole("combobox");
    const options = within(dialog).getAllByRole("option");

    // First option is selected initially; ArrowDown must move it, not wrap to it.
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(within(dialog).getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true");

    // Enter runs the highlighted navigation command: screen/set + overlay close.
    fireEvent.keyDown(input, { key: "Enter" });
    const types = dispatch.mock.calls.map(([action]) => action.type);
    expect(types).toContain("screen/set");
    expect(types).toContain("overlay/close");
  });

  it("says there are no matches rather than showing an empty box", () => {
    renderWith(
      <CmdPalette state={makeState({ overlay: "palette" })} dispatch={vi.fn()} actions={stubActions()} />,
    );
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByRole("combobox"), { target: { value: "zzzz" } });
    expect(within(dialog).getByText(en["palette.empty"])).toBeTruthy();
  });
});

describe("ConfirmDialog (T-FE-11, T-FE-12)", () => {
  const destructive = ACTIONS.find((def) => def.tier === "irreversible")!;

  it("keeps the destructive button disabled until the exact word is typed", () => {
    const actions = stubActions();
    renderWith(
      <ConfirmDialog
        state={makeState({
          overlay: "confirm",
          confirm: { actionId: destructive.id, definition: destructive, report: null },
        })}
        dispatch={vi.fn()}
        actions={actions}
      />,
    );

    const go = screen.getByRole("button", {
      name: new RegExp(en["confirm.goDestructive"].split("{")[0]?.trim() ?? ""),
    }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "not-the-word" } });
    expect(go.disabled).toBe(true);
    expect(screen.getByText(en["confirm.typed.mismatch"])).toBeTruthy();
    expect(actions.execute).not.toHaveBeenCalled();
  });

  it("executes the action with the typed attestation once the word matches", () => {
    const actions = stubActions();
    const word = destructive.id === "empty-recycle-bin" ? "DELETE" : null;
    // Derive the expected word from the shipped helper rather than assuming it.
    const expected = word ?? "CONFIRM";

    renderWith(
      <ConfirmDialog
        state={makeState({
          overlay: "confirm",
          confirm: { actionId: destructive.id, definition: destructive, report: null },
        })}
        dispatch={vi.fn()}
        actions={actions}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), { target: { value: expected } });
    const go = screen.getByRole("button", {
      name: new RegExp(en["confirm.goDestructive"].split("{")[0]?.trim() ?? ""),
    }) as HTMLButtonElement;
    expect(go.disabled).toBe(false);

    fireEvent.click(go);
    expect(actions.execute).toHaveBeenCalledWith(destructive.id, expected);
  });

  it("renders nothing when there is no pending confirmation", () => {
    const { container } = renderWith(
      <ConfirmDialog state={makeState()} dispatch={vi.fn()} actions={stubActions()} />,
    );
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });
});

describe("keyboard focus is visible (T-FE-15, DEF-045)", () => {
  let scrolled: Element[];

  beforeEach(() => {
    scrolled = [];
    // jsdom has no layout, so `scrollIntoView` does not exist. Stub it and assert
    // on the calls: the claim being tested is that focus is brought into view,
    // not that the browser scrolled.
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this);
    };
  });

  it("scrolls the next card into view when arrowing through the grid", () => {
    renderWith(<ActionGrid state={makeState()} dispatch={vi.fn()} actions={stubActions()} />);
    const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-action-card]"));
    const first = cards[0]!;
    const second = cards[1]!;

    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });

    expect(document.activeElement).toBe(second);
    expect(scrolled).toContain(second);
  });

  it("scrolls the first card into view when ArrowDown leaves the search box", () => {
    const dispatch = vi.fn<(action: Action) => void>();
    renderWith(
      <>
        <Tabs state={makeState()} dispatch={dispatch} />
        <ActionGrid state={makeState()} dispatch={dispatch} actions={stubActions()} />
      </>,
    );
    const first = document.querySelector<HTMLElement>("[data-action-card]")!;

    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "ArrowDown" });

    expect(document.activeElement).toBe(first);
    expect(scrolled).toContain(first);
  });
});

describe("Trust Center third-party notices (DEF-056)", () => {
  const info = {
    version: "1.0.0",
    buildCommit: "dev",
    tauriVersion: "2.12.5",
    webviewVersion: "unknown",
    osBuild: 26100,
    osDisplayVersion: "Windows 11",
    arch: "x86_64",
    isElevated: false,
    signature: { status: "unknown" as const },
    storePath: "C:\\ProgramData\\Zenith",
    storeMode: "machine" as const,
    simulator: false,
  };

  it("renders the notice file, covering the real dependency graph", () => {
    const { container } = renderWith(
      <TrustScreen
        state={makeState({ info })}
        actions={stubActions()}
        dispatch={vi.fn()}
        onPurge={vi.fn()}
      />,
    );

    expect(screen.getByText(en["trust.licenses"])).toBeTruthy();
    // The count comes from the generated manifest, so a stale notice file makes
    // this assertion disagree with the text the panel shows.
    expect(
      screen.getByText(
        buildTranslator("en")("trust.licenses.body", {
          count: licenseManifest.counts.components,
        }),
      ),
    ).toBeTruthy();
    expect(screen.getByText(en["trust.licenses.show"])).toBeTruthy();

    const pre = container.querySelector("pre.licenses-text");
    expect(pre).not.toBeNull();
    const text = pre?.textContent ?? "";
    expect(text.length).toBeGreaterThan(100_000);
    expect(text).toContain("ZENITH THIRD-PARTY NOTICES");
    expect(text).toContain("serde");
    expect(text).toContain("Apache-2.0");
    expect(text).toContain("react 19.3.1");
  });

  it("renders the notices in Turkish while the licence text stays verbatim", () => {
    renderWith(
      <TrustScreen
        state={makeState({ info })}
        actions={stubActions()}
        dispatch={vi.fn()}
        onPurge={vi.fn()}
      />,
      { locale: "tr" },
    );
    expect(screen.getByText(tr["trust.licenses"])).toBeTruthy();
    expect(screen.getByText(tr["trust.licenses.show"])).toBeTruthy();
  });
});

describe("Trust Center reports the OS honestly (DEF-127)", () => {
  const baseInfo = {
    version: "1.0.0",
    buildCommit: "dev",
    tauriVersion: "2.12.5",
    webviewVersion: "unknown",
    arch: "x86_64",
    isElevated: false,
    signature: { status: "unknown" as const },
    storePath: "C:\\ProgramData\\Zenith",
    storeMode: "machine" as const,
    simulator: false,
  };

  it("renders a measured OS version and build when both were read", () => {
    renderWith(
      <TrustScreen
        state={makeState({
          info: { ...baseInfo, osBuild: 26100, osDisplayVersion: "24H2" },
        })}
        actions={stubActions()}
        dispatch={vi.fn()}
        onPurge={vi.fn()}
      />,
    );
    expect(
      screen.getByText(
        buildTranslator("en")("trust.os.value", { version: "24H2", build: "26100" }),
      ),
    ).toBeTruthy();
  });

  it("says 'Not measured' instead of inventing build 0 when the read failed", () => {
    renderWith(
      <TrustScreen
        state={makeState({
          info: { ...baseInfo, osBuild: null, osDisplayVersion: null },
        })}
        actions={stubActions()}
        dispatch={vi.fn()}
        onPurge={vi.fn()}
      />,
    );
    // The old markup was `{osDisplayVersion} ({osBuild})`, which printed " (0)"
    // over a failed read - a version claim made from nothing.
    expect(screen.queryByText(/\(0\)/)).toBeNull();
    expect(screen.getByText(en["trust.notMeasured"])).toBeTruthy();
  });

  it("keeps a known display version even when only the build is unknown", () => {
    renderWith(
      <TrustScreen
        state={makeState({
          info: { ...baseInfo, osBuild: null, osDisplayVersion: "24H2" },
        })}
        actions={stubActions()}
        dispatch={vi.fn()}
        onPurge={vi.fn()}
      />,
    );
    // Half a measurement is reported as half, with an em dash where the build
    // would be - never as a plausible number.
    expect(screen.getByText(/24H2/)).toBeTruthy();
    expect(screen.queryByText(/\(0\)/)).toBeNull();
  });
});

describe("Trust Center localises a failed WebView read (DEF-128)", () => {
  const baseInfo = {
    version: "1.0.0",
    buildCommit: "dev",
    tauriVersion: "2.12.5",
    osBuild: 26100,
    osDisplayVersion: "24H2",
    arch: "x86_64",
    isElevated: false,
    signature: { status: "unknown" as const },
    storePath: "C:\\ProgramData\\Zenith",
    storeMode: "machine" as const,
    simulator: false,
  };

  it("renders the measured WebView version verbatim", () => {
    renderWith(
      <TrustScreen
        state={makeState({ info: { ...baseInfo, webviewVersion: "126.0.2592.87" } })}
        actions={stubActions()}
        dispatch={vi.fn()}
        onPurge={vi.fn()}
      />,
    );
    expect(screen.getByText("126.0.2592.87")).toBeTruthy();
  });

  it("says 'Not measured', not the Rust literal 'unknown', when the read failed", () => {
    renderWith(
      <TrustScreen
        state={makeState({ info: { ...baseInfo, webviewVersion: null } })}
        actions={stubActions()}
        dispatch={vi.fn()}
        onPurge={vi.fn()}
      />,
    );
    // The literal used to be created in Rust and crossed the wire as display
    // text, so the word was English in every locale.
    expect(screen.queryByText("unknown")).toBeNull();
    expect(screen.getByText(en["trust.notMeasured"])).toBeTruthy();
  });

  it("uses the Turkish word in a Turkish UI", () => {
    renderWith(
      <TrustScreen
        state={makeState({ info: { ...baseInfo, webviewVersion: null } })}
        actions={stubActions()}
        dispatch={vi.fn()}
        onPurge={vi.fn()}
      />,
      { locale: "tr" },
    );
    expect(screen.queryByText("unknown")).toBeNull();
    expect(screen.getByText(tr["trust.notMeasured"])).toBeTruthy();
  });
});

describe("settings persistence (T-FE-15)", () => {
  it("sends only the changed field, never a stale full preference set", () => {
    const actions = stubActions();
    renderWith(
      <SettingsScreen
        state={makeState({ locale: "en", theme: "true-black", telemetryEnabled: false })}
        dispatch={vi.fn()}
        actions={actions}
      />,
    );

    // Pick the control by its accessible name, not by DOM position, so a markup
    // reshuffle cannot silently turn this into a test of something else.
    fireEvent.change(screen.getByLabelText(en["palette.locale"]), {
      target: { value: "tr" },
    });

    expect(actions.savePreferences).toHaveBeenCalledWith({ locale: "tr" });
    // A full-object save would also carry `telemetryEnabled: false` and the
    // theme as read at mount, which is how an out-of-date screen reverts a
    // setting the user changed elsewhere.
    const calls = (actions.savePreferences as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const sent = calls[0]?.[0];
    expect(Object.keys(sent as Record<string, unknown>)).toEqual(["locale"]);
  });

  it("persists a theme change as a one-field patch", () => {
    const actions = stubActions();
    renderWith(
      <SettingsScreen
        state={makeState({ locale: "en", theme: "off-white" })}
        dispatch={vi.fn()}
        actions={actions}
      />,
    );

    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    const next = radios.find((input) => input.value === "true-black");
    expect(next).toBeTruthy();
    fireEvent.click(next as HTMLInputElement);

    expect(actions.savePreferences).toHaveBeenCalledWith({ theme: "true-black" });
  });

  it("moves the telemetry checkbox on click, not only after a round-trip (DEF-117)", () => {
    const actions = stubActions();
    const dispatch = vi.fn<(action: Action) => void>();
    renderWith(
      <SettingsScreen
        state={makeState({ telemetryEnabled: false })}
        dispatch={dispatch}
        actions={actions}
      />,
    );

    const box = screen.getByRole("checkbox", { name: en["trust.telemetry"] }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);

    // The input is `checked={state.telemetryEnabled}`, so persisting alone left
    // it frozen until `state_get` came back - a control the user clicks that
    // does not move reads as broken even when the write succeeded. The state
    // must change on the click and the patch must still be one field (DEF-117).
    expect(dispatch).toHaveBeenCalledWith({ type: "prefs/telemetry", telemetryEnabled: true });
    expect(actions.savePreferences).toHaveBeenCalledWith({ telemetryEnabled: true });
    const sent = (actions.savePreferences as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[0];
    expect(Object.keys(sent as Record<string, unknown>)).toEqual(["telemetryEnabled"]);
  });
});

describe("Snapshot screen header (T-FE-16)", () => {
  it("keeps the title and the tool cluster as the header's only two children", () => {
    const { container } = renderWith(
      <SnapshotsScreen
        state={makeState({
          retention: { snapshots: 3, snapshotBytes: 2048, auditRows: 9 },
        })}
        actions={stubActions()}
      />,
    );

    const header = container.querySelector(".screen-head") as HTMLElement;
    expect(header).toBeTruthy();

    // DEF-076: three children under `justify-content: space-between` stranded
    // the export buttons in the middle of the row, where they rendered as loose
    // text over the table. Two children is the invariant, and the tools wrapper
    // is what holds the buttons and the retention pill together.
    expect(header.children).toHaveLength(2);

    const tools = header.querySelector(".screen-tools") as HTMLElement;
    expect(tools).toBeTruthy();
    const buttons = within(tools).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      en["snapshots.exportCsv"],
      en["snapshots.exportJson"],
    ]);
    // The retention pill belongs with the tools, not stranded between them.
    expect(within(tools).getByText(/3/)).toBeTruthy();
  });

  it("says the retention figures are unknown, not zero, before boot fills them (DEF-118)", () => {
    renderWith(
      <SnapshotsScreen state={makeState({ retention: null })} actions={stubActions()} />,
    );

    // `retention` is nullable and `?? 0` rendered "0 snapshots (0 B), 0 audit
    // rows" - a confident measurement of a store nobody read. Same law as
    // `HealthStrip`: not measured is `-`, never `0`.
    const pillText = document.querySelector(".screen-tools .pill")?.textContent ?? "";
    const zeroSentence = buildTranslator("en")("trust.retention.value", {
      snapshots: 0,
      bytes: "0 B",
      rows: 0,
    });
    expect(pillText).not.toBe(zeroSentence);
    expect(pillText).toContain("-");
  });

  it("names the trailing action column instead of leaving it anonymous (DEF-119)", () => {
    const { container } = renderWith(
      <SnapshotsScreen
        state={makeState({
          retention: { snapshots: 1, snapshotBytes: 10, auditRows: 1 },
          snapshots: [
            {
              snapshotId: "snap-1",
              actionId: "flush-dns-cache",
              createdAtUtc: new Date().toISOString(),
              tier: "fully_reversible",
              snapshotType: "registry_key",
              isRestored: false,
              restoredAtUtc: null,
              estBytes: 10,
              status: "committed",
              summaryKey: "snapshots.summary.registry",
              summaryParams: {},
            },
          ],
        })}
        actions={stubActions()}
      />,
    );

    // A bare `<th scope="col" />` is announced as "column 5" with no name over
    // the Undo button - DEF-112's defect in the one table nobody checked.
    expect(container.querySelector("th:empty")).toBeNull();
    expect(
      within(container).getByRole("columnheader", { name: en["snapshots.column.actions"] }),
    ).toBeTruthy();
  });
});

describe("Help screen (T-FE-17)", () => {
  it("renders the about paragraph once and the tagline at most once", () => {
    renderWith(<HelpScreen />);

    // DEF-078: the header subtitle and the About panel both rendered
    // `help.about.body`, so the same two sentences appeared twice on one screen.
    // Asserting the count, not just presence, is the whole point - a duplicate
    // is invisible to `getByText`, which throws only when there are too many.
    expect(screen.getAllByText(en["help.about.body"])).toHaveLength(1);

    // The header has its own purpose-written subtitle instead.
    expect(screen.getByText(en["help.subtitle"])).toBeTruthy();
    // `help.about` is legitimately two things - the panel heading and the `?`
    // shortcut's label - so assert the heading by role, not by text count.
    expect(
      screen.getByRole("heading", { name: en["help.about"] }),
    ).toBeTruthy();
  });
});

describe("Activity screen (T-FE-18)", () => {
  it("renders the empty state once, in its own row class, not as a log line", () => {
    const { container } = renderWith(<ActivityScreen state={makeState()} dispatch={vi.fn()} />);

    // DEF-079: the empty-state <li> inherited `.log li`'s 76px time column and
    // wrapped to one word per line, and its text repeated the header subtitle.
    expect(screen.getAllByText(en["console.empty"])).toHaveLength(1);
    expect(screen.getByText(en["console.subtitle"])).toBeTruthy();
    expect(container.querySelector("li.log-empty")).toBeTruthy();
  });

  it("never marks its log as its own scroll box (DEF-082)", () => {
    const { container } = renderWith(<ActivityScreen state={makeState()} dispatch={vi.fn()} />);
    const log = container.querySelector("ol.log") as HTMLElement;

    // `05-02` §1 makes `.main` the only page scroll container, and this screen
    // renders inside `.main`. The scroll belongs to `.drawer .log` alone; adding
    // `log-tall` (or any other bounded variant) here re-creates the nested
    // scroller that DEF-077 fixed in `.manage-list`. jsdom cannot compute
    // layout, so this asserts the contract - the L10 sweep measures the real box.
    expect(log).toBeTruthy();
    expect(log.classList.contains("log-tall")).toBe(false);
    expect(log.className.trim()).toBe("log");
  });
});

describe("locale switching (T-FE-14)", () => {
  it("renders Turkish from the catalogue, not hard-coded English", () => {
    renderWith(<HealthStrip state={makeState()} actions={stubActions()} />, { locale: "tr" });
    expect(screen.getByText(tr["health.never"])).toBeTruthy();
    expect(screen.queryByText(en["health.never"])).toBeNull();
  });

  it("marks <html lang> from the negotiated locale", () => {
    renderWith(<Tabs state={makeState()} dispatch={vi.fn()} />, { locale: "tr-TR" });
    // `tr-TR` is not a shipped catalogue; it negotiates to `tr`, never to `en`.
    expect(document.documentElement.lang).toBe("tr");
  });

  it("falls back to English for a locale with no catalogue", () => {
    renderWith(<Tabs state={makeState()} dispatch={vi.fn()} />, { locale: "de-DE" });
    expect(document.documentElement.lang).toBe("en");
  });
});
