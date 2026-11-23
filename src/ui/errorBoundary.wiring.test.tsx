// @vitest-environment jsdom
/**
 * Boundary *wiring* (DEF-085, T-FE-20).
 *
 * `errorBoundary.test.tsx` proves the component works. This file proves the
 * product mounts it: the real `App` is rendered, with one screen mocked to
 * throw on render, and the assertions are about *scope* -
 *
 *   * the failure appears inside `#main`, so it cost one screen, not the window;
 *   * the shell around it (title bar, health strip, console, status bar) still
 *     renders, because those live outside `#main`;
 *   * the retry control is reachable.
 *
 * DEF-083 is the reason this file exists at all: a component can be written,
 * tested in isolation, and still never be mounted. Only rendering the shipped
 * `App` can tell the difference.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Replace the default screen with one that throws. The mock is declared before
// importing `App` so the module graph picks it up.
vi.mock("./ActionGrid", () => ({
  ActionGrid: () => {
    throw new Error("grid exploded on purpose");
  },
}));

import { App } from "../App";
import { en } from "../i18n/en";
import { tr } from "../i18n/tr";
import { ACTION_PANEL_ID } from "./Tabs";

afterEach(cleanup);

beforeEach(() => {
  // React prints the caught error and its stack; correct in production, noise
  // here. The console call itself is asserted in the unit suite.
  vi.spyOn(console, "error").mockImplementation(() => {});

  // jsdom has no MediaQueryList, and `App` reads `prefers-reduced-motion` to
  // decide whether to honour the OS motion setting. Without this stub the *shell*
  // throws before #main exists - a harness gap, not a product defect, but one
  // that would make this test assert the wrong boundary. `matches: false` is the
  // no-preference path, i.e. the common desktop case.
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

describe("the boundary is mounted around the screens (T-FE-20)", () => {
  it("contains a screen throw inside #main and leaves the shell rendered", async () => {
    const { container } = render(<App />);

    // Boot is asynchronous (the simulator resolves appInfo), so the shell only
    // exists once boot settles. Waiting for #main is waiting for the real thing.
    await waitFor(
      () => {
        expect(container.querySelector('#main[data-screen="actions"]')).toBeTruthy();
      },
      { timeout: 5000 },
    );

    await waitFor(() => {
      expect(container.querySelector("[data-render-failure]")).toBeTruthy();
    });

    const main = container.querySelector('#main[data-screen="actions"]') as HTMLElement;
    const failure = container.querySelector("[data-render-failure]") as HTMLElement;

    // Scope: the recovery panel is *inside* the screen region, not replacing it.
    expect(main.contains(failure)).toBe(true);

    // The simulator seeds `locale: "tr"` (`simulator.ts` preferences), so the
    // real App negotiates Turkish - asserting the English string here would test
    // my assumption, not the product. Assert the catalogue entry for the locale
    // the app actually chose, and that it is *not* the English one.
    expect(failure.textContent).toContain(tr["misc.render.title"]);
    expect(failure.textContent).not.toContain(en["misc.render.title"]);
    expect(failure.textContent).toContain("grid exploded on purpose");

    // The shell survived: these are siblings of #main and must still be present.
    expect(container.querySelector(".shell")).toBeTruthy();
    // The top strip is `.appbar` since the window became undecorated (DEF-161):
    // it is the one row that replaces the OS title bar, so a screen failure
    // above `#main` must not take the window's own controls with it.
    expect(container.querySelector(".appbar")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: tr["win.close"] }),
    ).toBeTruthy();

    // Retry is offered rather than a dead screen - in the active locale.
    expect(screen.getByRole("button", { name: tr["misc.retry"] })).toBeTruthy();
  });

  it("mounts a real tabpanel that the tabs control (DEF-122)", async () => {
    const { container } = render(<App />);

    await waitFor(
      () => {
        expect(container.querySelector('[role="tabpanel"]')).toBeTruthy();
      },
      { timeout: 5000 },
    );

    // `role="tab"` promises a controlled panel. The shipped App must render the
    // other half of that relation, or the role is a claim with nothing behind
    // it: `aria-controls` pointed at an id no element carried. Since DEF-161 the
    // panel is `#action-panel`, a child of the `#main` landmark, because a
    // tabpanel must not contain the tablist that controls it and the page
    // heading has to sit inside the landmark.
    const panel = container.querySelector('[role="tabpanel"]') as HTMLElement;
    expect(panel.id).toBe(ACTION_PANEL_ID);
    expect(panel.getAttribute("aria-labelledby")).toMatch(/^tab-/);
    expect(container.querySelector(`#${panel.getAttribute("aria-labelledby")}`)).toBeTruthy();

    // The landmark is still `#main` (the skip-link target) and it *contains*
    // the panel and the page heading, which the old shape did not.
    const main = container.querySelector("main#main") as HTMLElement;
    expect(main).toBeTruthy();
    expect(main.contains(panel)).toBe(true);
    expect(main.querySelector("h2")).toBeTruthy();
    // And the tablist is not inside the panel: that is the ARIA rule the shape
    // change exists to satisfy.
    expect(panel.querySelector('[role="tablist"]')).toBeNull();

    const tabs = screen.getAllByRole("tab");
    expect(tabs.length).toBeGreaterThan(0);
    for (const tab of tabs) {
      expect(tab.getAttribute("aria-controls")).toBe(panel.id);
      // And the panel names the selected tab, not a stale one.
      if (tab.getAttribute("aria-selected") === "true") {
        expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
      }
    }
  });
});
