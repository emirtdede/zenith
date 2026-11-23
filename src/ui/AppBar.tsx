import { useT } from "../i18n";
import type { State } from "../state/store";
import { WindowControls } from "./WindowControls";

/**
 * The one strip at the top of the window.
 *
 * The window is undecorated (`tauri.conf.json`: `decorations: false`), so this
 * row is not a second title bar under the Windows one - it *replaces* it. That
 * is the whole point: the earlier shell stacked a native title bar and an
 * application toolbar, which read as two bars for one window and cost 40px of
 * height on every screen. A window that owns its chrome draws one surface.
 *
 * What the row carries, left to right:
 *
 * 1. **The drag region.** A frameless window cannot be moved unless something
 *    is marked as a drag handle. It is an empty, `aria-hidden` div that fills
 *    the space, marked `data-tauri-drag-region`, which is what Tauri's own
 *    handler listens for - and a double click in it maximises, because that is
 *    the behaviour the OS would have provided.
 * 2. **The two facts a user needs before acting**: whether this session is
 *    elevated (it changes what an action will do) and whether there are
 *    notices (they can be urgent). Neither is decorative.
 * 3. **The window buttons.** Minimise, maximise/restore, close, drawn here
 *    because the OS stopped drawing them.
 *
 * The command palette trigger is *not* here any more. It moved to the rail,
 * directly under the product name, where a user who does not know the keyboard
 * shortcut will actually look for it.
 */
export function AppBar({
  state,
  noticeOpen,
  setNoticeOpen,
  noticeCount,
}: {
  state: State;
  noticeOpen: boolean;
  setNoticeOpen: (open: boolean) => void;
  noticeCount: number;
}) {
  const t = useT();

  return (
    <header className="appbar">
      {/*
       * The drag handle. `role="presentation"` and `aria-hidden` because it is
       * a hit area, not content: a screen reader user moves the window with the
       * OS, and naming this would add an unlabelled region to the landmark list.
       */}
      <div className="appbar-drag" data-tauri-drag-region aria-hidden="true" />

      <div className="appbar-actions">
        <span
          className={`pill ${state.online ? "" : "pill-warn"}`}
          role="status"
          title={state.online ? undefined : t("offline.offlineHint")}
        >
          {state.online ? t("offline.online") : t("offline.offline")}
        </span>

        <span className={`pill ${state.info?.isElevated ? "pill-ok" : ""}`}>
          {state.info?.isElevated ? t("mode.admin") : t("mode.standard")}
        </span>

        <button
          className={`btn btn-quiet ${noticeOpen ? "is-active" : ""}`}
          type="button"
          aria-expanded={noticeOpen}
          aria-label={t("titlebar.notifications.count", { count: noticeCount })}
          onClick={() => setNoticeOpen(!noticeOpen)}
        >
          {t("titlebar.notifications")}
          <span className="count">{noticeCount}</span>
        </button>

        <WindowControls />
      </div>
    </header>
  );
}
