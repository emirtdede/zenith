// @vitest-environment jsdom
/**
 * Modal focus containment (DEF-086, T-FE-21).
 *
 * `aria-modal="true"` is a promise that the rest of the page is inert. Before
 * this hook, nothing enforced it: Tab walked out of an open confirmation into
 * the page behind it, and closing the dialog dropped focus to `<body>`, so the
 * next Tab restarted at the top of the document.
 *
 * The hook decides wrap boundaries with `offsetParent !== null`, which is the
 * honest test in a real browser (it is null for `display:none`). jsdom computes
 * no layout and returns null for everything, so this file replaces the getter on
 * `HTMLElement.prototype` with the one fact that matters: connected elements are
 * rendered. Patching each element *after* render would be too late - effects
 * have already read the property - which is exactly how the first draft of this
 * file failed.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { useFocusTrap } from "./useFocusTrap";

beforeAll(() => {
  // jsdom: `offsetParent` is always null. Model "attached to the document".
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get(this: HTMLElement) {
      return this.isConnected ? document.body : null;
    },
  });
});

afterEach(cleanup);

function Trap({ buttons = 3 }: { buttons?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref);
  return (
    <div ref={ref} data-testid="dialog" tabIndex={-1}>
      {Array.from({ length: buttons }, (_, i) => (
        <button key={i} type="button">{`b${i + 1}`}</button>
      ))}
    </div>
  );
}

function tab(shift = false): void {
  fireEvent.keyDown(document, { key: "Tab", shiftKey: shift });
}

describe("modal focus containment (T-FE-21, DEF-086)", () => {
  it("moves focus into the dialog on mount when it was outside", () => {
    render(<Trap />);

    expect(document.activeElement).toBe(screen.getByText("b1"));
  });

  it("wraps Tab from the last control back to the first", () => {
    render(<Trap />);
    const buttons = screen.getAllByRole("button");
    buttons[2]!.focus();

    tab();

    // Without the trap this leaves the dialog entirely, which is the defect.
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("wraps Shift+Tab from the first control to the last", () => {
    render(<Trap />);
    const buttons = screen.getAllByRole("button");
    buttons[0]!.focus();

    tab(true);

    expect(document.activeElement).toBe(buttons[2]);
  });

  it("pulls focus back in when Tab is pressed while focus is outside", () => {
    render(
      <>
        <button type="button">outside</button>
        <Trap />
      </>,
    );
    const outside = screen.getByText("outside");
    outside.focus();

    tab();

    // The dialog declared the background inert; focus must not remain there.
    expect(document.activeElement).not.toBe(outside);
    expect(screen.getByTestId("dialog").contains(document.activeElement)).toBe(true);
  });

  it("keeps focus on the dialog itself when nothing inside is focusable", () => {
    render(<Trap buttons={0} />);

    tab();

    expect(document.activeElement).toBe(screen.getByTestId("dialog"));
  });

  it("restores focus to the trigger when the overlay unmounts", () => {
    function Host({ open }: { open: boolean }) {
      return (
        <>
          <button type="button">trigger</button>
          {open ? <Trap /> : null}
        </>
      );
    }
    const { rerender } = render(<Host open={false} />);
    const trigger = screen.getByText("trigger");
    trigger.focus();

    // Open: focus moves into the dialog…
    rerender(<Host open />);
    expect(screen.getByTestId("dialog").contains(document.activeElement)).toBe(true);

    // …and closing returns it to the control the user came from, rather than
    // dropping it to <body> (the defect).
    rerender(<Host open={false} />);
    expect(document.activeElement).toBe(screen.getByText("trigger"));
  });

  it("restores focus to the trigger when the dialog contains an autoFocus field (DEF-086)", () => {
    // The packaged-binary probe found this after every test above passed:
    // `autoFocus` moves focus on commit, effects run after commit, so reading
    // `document.activeElement` inside the effect recorded the *dialog's input* as
    // the restore target. On close that input is unmounting, the restore silently
    // did nothing, and the user landed on <body>. The capture therefore happens
    // during render, and this test pins that ordering.
    function TrapWithField() {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref);
      return (
        <div ref={ref} data-testid="dialog" tabIndex={-1}>
          <input autoFocus aria-label="typed confirmation" />
          <button type="button">cancel</button>
        </div>
      );
    }
    function Host({ open }: { open: boolean }) {
      return (
        <>
          <button type="button">trigger</button>
          {open ? <TrapWithField /> : null}
        </>
      );
    }
    const { rerender } = render(<Host open={false} />);
    const trigger = screen.getByText("trigger");
    trigger.focus();

    rerender(<Host open />);
    // autoFocus won the commit, as it does in the real dialog:
    expect(document.activeElement).toBe(screen.getByLabelText("typed confirmation"));

    rerender(<Host open={false} />);
    // …and focus still goes back to the trigger, not to the unmounted input and
    // not to <body>.
    expect(document.activeElement).toBe(screen.getByText("trigger"));
  });

  it("does not steal focus on mount when it is already inside the dialog", () => {
    function Preset() {
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref);
      return (
        <div ref={ref} data-testid="dialog" tabIndex={-1}>
          <button type="button">first</button>
          <button type="button">second</button>
        </div>
      );
    }
    const { rerender } = render(<Preset />);
    const [, second] = screen.getAllByRole("button");
    second!.focus();

    // A re-render must not yank a deliberately focused control back to the first.
    rerender(<Preset />);

    expect(document.activeElement).toBe(second);
  });

  it("removes its document listener on unmount", () => {
    const remove = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(<Trap />);
    unmount();

    const keydownRemovals = remove.mock.calls.filter(([type]) => type === "keydown");
    expect(keydownRemovals.length).toBeGreaterThan(0);
    remove.mockRestore();
  });
});
