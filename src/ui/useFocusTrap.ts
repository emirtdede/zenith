/**
 * Modal focus containment (DEF-086).
 *
 * Every overlay in Zenith declares `aria-modal="true"`, which tells a screen
 * reader that everything outside the dialog is inert. That promise was never
 * kept: nothing trapped Tab, so a keyboard user could walk out of an open
 * confirmation into the page behind it - interacting with controls the dialog
 * had just declared unavailable - and when the dialog closed, focus fell to
 * `<body>`, so the next Tab started from the top of the document instead of the
 * card the user came from.
 *
 * This is one hook rather than logic copied into `Dialogs` and `CmdPalette`,
 * because DEF-083 was exactly the failure of fixing one renderer and leaving its
 * twin. Both overlays call it; both get the same guarantee.
 *
 * Deliberately *not* implemented: making the background `inert`. That changes
 * hit-testing and is a larger behavioural change than the accessibility promise
 * requires once focus is contained; `aria-modal` plus a real trap is the
 * standard pattern, and the L10 sweep still measures the rendered result.
 */

import { useEffect, useRef } from "react";
import type { RefObject } from "react";

/**
 * Elements that can receive focus. Deliberately matches what the platform
 * actually focuses, not what CSS looks like: a `disabled` control and a
 * `[hidden]` subtree are excluded, because a trap that stops on them strands the
 * user on a dead step.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusable(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * Contain Tab/Shift+Tab inside `ref` while mounted, and restore focus to
 * whatever held it before the overlay opened.
 *
 * `active` exists because `CmdPalette` and the dialogs are conditionally
 * mounted, whereas a caller may keep the overlay mounted and toggle a flag; an
 * unused `active` would still be correct, but the hook refuses to steal focus
 * on mount unless the caller says the overlay is open.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true): void {
  // The trigger is captured during **render**, not in the effect.
  //
  // This was a real bug, found by `scripts/probe-focus-trap.mjs` in the packaged
  // binary after every unit test passed: `autoFocus` moves focus on commit, and
  // effects run *after* commit, so by the time the effect read
  // `document.activeElement` it was the dialog's own input. The hook then
  // "restored" focus to that input on close - an element being unmounted - and
  // the user was left on `<body>`. jsdom tests did not catch it because they
  // asserted the effect's behaviour with no `autoFocus` in the tree.
  //
  // Render runs before commit, so the trigger is still focused here. `ref` is
  // not attached yet on the first render, which is why the containment check
  // tolerates `null`.
  const restoreTo = useRef<HTMLElement | null>(null);
  const captured = useRef(false);
  if (!captured.current) {
    captured.current = true;
    const focused = document.activeElement;
    const insideContainer = ref.current !== null && ref.current.contains(focused);
    if (focused instanceof HTMLElement && focused !== document.body && !insideContainer) {
      restoreTo.current = focused;
    }
  }

  useEffect(() => {
    if (!active) {
      return;
    }
    const container = ref.current;
    if (!container) {
      return;
    }

    // If the overlay is mounted closed and opened later, the render-time capture
    // predates the interaction that opened it. Recapture at the moment it turns
    // active - but never from inside the dialog, which is the autoFocus case.
    const focused = document.activeElement;
    if (
      focused instanceof HTMLElement &&
      focused !== document.body &&
      !container.contains(focused)
    ) {
      restoreTo.current = focused;
    }

    // `autoFocus` already put focus on the first meaningful control in most
    // dialogs; only pull focus in when it is still outside, so a deliberately
    // focused input is not stolen from.
    if (!container.contains(document.activeElement)) {
      const first = focusable(container)[0];
      if (first) {
        first.focus();
      } else {
        container.focus();
      }
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Tab") {
        return;
      }
      const items = focusable(container!);
      if (items.length === 0) {
        // Nothing focusable: keep focus on the dialog itself rather than letting
        // Tab escape into the (declared inert) background.
        event.preventDefault();
        container!.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const current = document.activeElement;

      if (event.shiftKey && (current === first || !container!.contains(current))) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && (current === last || !container!.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    }

    // Capture phase: the handler must see Tab before a component-level handler
    // cancels it, and it must work for controls that stop propagation.
    document.addEventListener("keydown", onKeyDown, true);

    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const target = restoreTo.current;
      // Only restore if the element is still in the document: a dialog that
      // closes because its trigger was removed must not throw.
      if (target && document.contains(target)) {
        target.focus();
      }
    };
  }, [ref, active]);
}
