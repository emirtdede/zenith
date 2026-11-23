// @vitest-environment jsdom
/**
 * Render-failure boundary (DEF-085, T-FE-19).
 *
 * Three things are asserted, and the third is the one that matters:
 *   1. A throwing child produces the recovery screen instead of nothing.
 *   2. The message names the fault (so a support ticket can quote it) and the
 *      retry re-renders the child.
 *   3. `resetKey` clears a caught fault - that is the per-screen recovery path.
 *
 * The wiring test lives in `errorBoundary.wiring.test.tsx`: it mounts the real
 * `App` with a screen mocked to throw, because a boundary that is never mounted
 * protects nothing (the lesson of DEF-083).
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "../i18n";
import { en } from "../i18n/en";
import { tr } from "../i18n/tr";
import { ErrorBoundary } from "./ErrorBoundary";
import type { BoundaryCopy } from "./ErrorBoundary";

afterEach(cleanup);

beforeEach(() => {
  // React logs every caught error; that is correct in production and noise
  // here. Silenced per-test rather than globally so a genuine warning in
  // another suite still surfaces.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const copyEn: BoundaryCopy = {
  title: en["misc.render.title"],
  body: en["misc.render.body"],
  retry: en["misc.retry"],
  detailLabel: en["misc.render.detail"],
  hint: en["misc.render.hint"],
};

function Boom({ armed }: { armed: boolean }) {
  if (armed) {
    throw new Error("card exploded");
  }
  return <p>recovered content</p>;
}

function mount(children: React.ReactNode, copy: BoundaryCopy = copyEn, resetKey?: string) {
  return render(
    <I18nProvider locale="en">
      <ErrorBoundary copy={copy} {...(resetKey === undefined ? {} : { resetKey })}>
        {children}
      </ErrorBoundary>
    </I18nProvider>,
  );
}

describe("render boundary (T-FE-19, DEF-085)", () => {
  it("shows the recovery screen instead of a blank window when a child throws", () => {
    mount(<Boom armed />);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(en["misc.render.title"])).toBeTruthy();
    expect(screen.getByText(en["misc.render.body"])).toBeTruthy();
  });

  it("names the fault and the support command, so a ticket can quote both", () => {
    mount(<Boom armed />);

    // The error text is what a user pastes into a support bundle.
    expect(screen.getByText(/card exploded/)).toBeTruthy();
    // `--support-bundle` is a real CLI flag (`crates/zenith-core/src/cli.rs`),
    // not invented copy - a recovery screen that names a fake command is worse
    // than one that names nothing.
    expect(screen.getByText(/--support-bundle/)).toBeTruthy();
  });

  it("retry clears the fault and renders the child again", () => {
    // A child that throws once, then succeeds. `armed` is read from a mutable
    // cell so the retry re-render sees the new value, not a captured one.
    let armed = true;
    function Flaky() {
      if (armed) {
        throw new Error("first render fails");
      }
      return <p>recovered content</p>;
    }

    mount(<Flaky />);
    expect(screen.getByRole("alert")).toBeTruthy();

    armed = false;
    fireEvent.click(screen.getByRole("button", { name: en["misc.retry"] }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("recovered content")).toBeTruthy();
  });

  it("a changed resetKey clears a caught fault, which is the per-screen recovery path", () => {
    // Mimics switching tabs: the screen component is replaced and the key moves,
    // so the boundary must not keep showing the dead screen's error.
    const { rerender } = mount(<Boom armed />, copyEn, "trust");
    expect(screen.getByRole("alert")).toBeTruthy();

    rerender(
      <I18nProvider locale="en">
        <ErrorBoundary copy={copyEn} resetKey="help">
          <Boom armed={false} />
        </ErrorBoundary>
      </I18nProvider>,
    );

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("recovered content")).toBeTruthy();
  });

  it("renders its copy from the active catalogue, not hard-coded English", () => {
    const copyTr: BoundaryCopy = {
      title: tr["misc.render.title"],
      body: tr["misc.render.body"],
      retry: tr["misc.retry"],
      detailLabel: tr["misc.render.detail"],
      hint: tr["misc.render.hint"],
    };
    mount(<Boom armed />, copyTr);

    expect(screen.getByText(tr["misc.render.title"])).toBeTruthy();
    expect(screen.queryByText(en["misc.render.title"])).toBeNull();
  });

  it("renders children untouched when nothing throws", () => {
    const { container } = mount(<Boom armed={false} />);

    expect(screen.getByText("recovered content")).toBeTruthy();
    expect(container.querySelector("[data-render-failure]")).toBeNull();
  });

  // A screen boundary renders inside <main>, under the shell's own <h1>. Using an
  // <h1> there gave a failed screen two top-level headings - a structure defect
  // that exists only on the error path, so no screenshot of a working build can
  // catch it (DEF-145).
  it("uses an h1 at the root and an h2 inside a screen", () => {
    const root = mount(<Boom armed />);
    expect(root.container.querySelector("h1")).toBeTruthy();
    expect(root.container.querySelector("h2")).toBeNull();
    cleanup();

    const inner = render(
      <I18nProvider locale="en">
        <ErrorBoundary copy={copyEn} headingLevel={2}>
          <Boom armed />
        </ErrorBoundary>
      </I18nProvider>,
    );
    expect(inner.container.querySelector("h1")).toBeNull();
    expect(inner.container.querySelector("h2")).toBeTruthy();
  });
});
