import { useEffect, useState } from "react";

import { useBridge } from "../bridge";
import { useT } from "../i18n";
import { CloseIcon, MaximizeIcon, MinimizeIcon, RestoreIcon } from "./icons";

/**
 * The three window buttons an undecorated window has to draw itself.
 *
 * Why this exists: `tauri.conf.json` sets `decorations: false` so the app owns
 * its whole surface instead of stacking its own toolbar under a native Windows
 * title bar - the "double chrome" a reader sees as two bars with one window.
 * That removes the OS buttons with the OS title bar, and a window you cannot
 * minimise or close is not shippable, so the renderer provides them.
 *
 * Three details are deliberate:
 *
 * 1. **The icons are inline SVG**, not text glyphs. A `x` or `_` rendered as
 *    text is announced as punctuation and its shape depends on the font
 *    (DEF-120, DEF-154).
 * 2. **The accessible name is translated** and the button has no text content,
 *    so `aria-label` is the only name the name algorithm can produce. A
 *    `title`-only button is announced as "button" (DEF-120).
 * 3. **The maximise icon reflects the OS, not a local guess.** A double click
 *    on the drag region maximises the window without going through this
 *    button, so the state comes from the window itself through the bridge.
 *    Without that, the button shows "maximise" over a maximised window and the
 *    next click restores what the user did not know was restored.
 *
 * The simulator answers all four calls as no-ops, because a browser tab has no
 * window to minimise; that keeps this component renderable in a test and in
 * `npm run dev` without a native host.
 */
export function WindowControls() {
  const t = useT();
  const bridge = useBridge();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let live = true;
    let unlisten: (() => void) | undefined;

    void bridge.windowControl.isMaximized().then((value) => {
      if (live) {
        setMaximized(value);
      }
    });
    void bridge.windowControl.onMaximizedChange(setMaximized).then((off) => {
      if (live) {
        unlisten = off;
      } else {
        // The effect was cleaned up before the listener resolved; unsubscribing
        // here is what keeps a remount from leaving two subscriptions behind.
        off();
      }
    });

    return () => {
      live = false;
      unlisten?.();
    };
  }, [bridge]);

  return (
    <div className="window-controls">
      <button
        className="win-btn"
        type="button"
        aria-label={t("win.minimize")}
        title={t("win.minimize")}
        onClick={() => void bridge.windowControl.minimize()}
      >
        <MinimizeIcon />
      </button>
      <button
        className="win-btn"
        type="button"
        aria-label={maximized ? t("win.restore") : t("win.maximize")}
        title={maximized ? t("win.restore") : t("win.maximize")}
        onClick={() => void bridge.windowControl.toggleMaximize()}
      >
        {maximized ? <RestoreIcon /> : <MaximizeIcon />}
      </button>
      <button
        className="win-btn is-close"
        type="button"
        aria-label={t("win.close")}
        title={t("win.close")}
        onClick={() => void bridge.windowControl.close()}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
