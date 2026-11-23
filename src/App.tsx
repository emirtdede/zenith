/**
 * Application shell.
 *
 * One reducer owns every piece of UI state; this component wires it to the
 * bridge, to the six screens and to the keyboard. Nothing here decides what is
 * wrong with the PC - it only shows what the core measured.
 */

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Dispatch } from "react";

import { type ActionsApi, useActions } from "./actions";
import { BridgeContext, createBridge, useBridge } from "./bridge";
import { asIpcError } from "./bridge/adapter";
import type { Unlisten } from "./bridge/adapter";
import { markInteractive } from "./perf";
import { buildTranslator, I18nProvider, negotiateLocale, useT } from "./i18n";
import { initialState, reducer, visibleNotices } from "./state/store";
import type { Action, State } from "./state/store";
import { ActionGrid } from "./ui/ActionGrid";
import { ActivityScreen } from "./ui/ActivityScreen";
import { AppBar } from "./ui/AppBar";
import { CmdPalette } from "./ui/CmdPalette";
import { Console } from "./ui/Console";
import { CandidatesDialog, ConfirmDialog, PurgeDialog, ScriptDialog } from "./ui/Dialogs";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import type { BoundaryCopy } from "./ui/ErrorBoundary";
import { ErrorToast } from "./ui/ErrorToast";
import { HealthStrip } from "./ui/HealthStrip";
import { HelpScreen } from "./ui/HelpScreen";
import { SettingsScreen } from "./ui/SettingsScreen";
import { SnapshotsScreen } from "./ui/SnapshotsScreen";
import { StatusBar } from "./ui/StatusBar";
import { ACTION_PANEL_ID, Tabs } from "./ui/Tabs";
import { TrustScreen } from "./ui/TrustScreen";
import { Sidebar } from "./ui/Sidebar";

/**
 * Copy for the root boundary, resolved without a provider.
 *
 * A throw can happen above `I18nProvider` (in the provider itself, or in the
 * reducer wiring), and at that moment `useT()` is unavailable. Building the
 * translator directly keeps the recovery screen in the user's own language
 * instead of falling back to English for the one message that matters most.
 */
function rootFailCopy(): BoundaryCopy {
  const locale = negotiateLocale(
    typeof navigator === "undefined" ? "en" : navigator.language,
  );
  return screenFailCopy(buildTranslator(locale));
}

/**
 * Copy for the per-screen boundary, from the live translator.
 *
 * It is deliberately *not* `misc.fatal.*`: that copy says the native host is
 * unreachable, which would be a lie when it was the screen that failed, and it
 * offers a retry that restarts boot instead of redrawing the screen.
 */
function screenFailCopy(t: ReturnType<typeof useT>): BoundaryCopy {
  return {
    title: t("misc.render.title"),
    body: t("misc.render.body"),
    retry: t("misc.retry"),
    detailLabel: t("misc.render.detail"),
    hint: t("misc.render.hint"),
  };
}

export function App() {
  const bridge = useMemo(() => createBridge(), []);
  return (
    // Outer boundary: `Body` reads the bridge context and owns the reducer, so a
    // throw there would otherwise take the document with it. It sits outside the
    // provider on purpose - it must survive the provider failing.
    <ErrorBoundary copy={rootFailCopy()}>
      <BridgeContext.Provider value={bridge}>
        <Body />
      </BridgeContext.Provider>
    </ErrorBoundary>
  );
}

function Body() {
  const bridge = useBridge();
  const [state, dispatch] = useReducer(reducer, initialState);
  const actions = useActions(state, dispatch);
  const [noticeOpen, setNoticeOpen] = useState(false);

  // Boot once. `actions.boot` is re-created with state, so it is captured here
  // rather than listed as a dependency: re-entering boot after every event would
  // reset the screen the user is working in.
  const boot = actions.boot;
  useEffect(() => {
    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // REQ-F-002: diagnostics run on first launch without the user pressing
  // anything. It is read-only by contract (`03-05` §5, T-SEC-04), so doing it
  // unprompted cannot change the machine; the alternative - a wall of
  // "not measured" cards - makes the user do work the app can do itself.
  //
  // Fires only once, and only after `state.info` proves boot succeeded: a failed
  // boot already renders its own error, and adding a diagnosis error on top
  // would report two faults for one cause.
  const diagnoseOnBoot = actions.diagnose;
  const autoDiagnosed = useRef(false);
  useEffect(() => {
    if (autoDiagnosed.current || !state.info) {
      return;
    }
    autoDiagnosed.current = true;
    void diagnoseOnBoot(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.info]);

  // REQ-N-001 / DEF-049: close the cold-start measurement after the first commit.
  // `markInteractive` returns null when the User Timing API is unavailable, and
  // null is rendered as "unknown" rather than as a suspiciously fast boot.
  useEffect(() => {
    dispatch({ type: "boot/timed", bootMs: markInteractive() });
  }, []);

  useEffect(() => {
    const stops: Unlisten[] = [];
    let cancelled = false;

    async function subscribe() {
      stops.push(
        await bridge.on("phase_changed", (payload) =>
          dispatch({ type: "phase/changed", actionId: payload.actionId, phase: payload.phase }),
        ),
        await bridge.on("terminal_log", (payload) =>
          dispatch({ type: "log/appended", lines: payload.lines }),
        ),
        await bridge.on("diagnose_progress", (payload) =>
          dispatch({ type: "diagnose/progress", done: payload.completed, total: payload.total }),
        ),
        await bridge.on("telemetry_update", (payload) =>
          dispatch({ type: "telemetry/updated", telemetry: payload.telemetry }),
        ),
        await bridge.on("snapshot_changed", () => {
          void bridge.snapshots(100).then((snapshots) => {
            dispatch({ type: "snapshots/replaced", snapshots });
          });
        }),
        await bridge.on("startup_notice", (payload) =>
          dispatch({ type: "notice/received", notice: payload.notice }),
        ),
      );
      if (cancelled) {
        for (const stop of stops) {
          stop();
        }
      }
    }

    void subscribe().catch((error: unknown) => {
      dispatch({ type: "error/raised", error: asIpcError(error) });
    });

    return () => {
      cancelled = true;
      for (const stop of stops) {
        stop();
      }
    };
  }, [bridge, dispatch]);

  return (
    <I18nProvider locale={state.locale}>
      <Shell
        state={state}
        dispatch={dispatch}
        actions={actions}
        noticeOpen={noticeOpen}
        setNoticeOpen={setNoticeOpen}
      />
    </I18nProvider>
  );
}

interface ShellProps {
  state: State;
  dispatch: Dispatch<Action>;
  actions: ActionsApi;
  noticeOpen: boolean;
  setNoticeOpen: (open: boolean) => void;
}

function Shell({ state, dispatch, actions, noticeOpen, setNoticeOpen }: ShellProps) {
  const t = useT();

  // Theme and reduced motion are attributes on <html>, not component props:
  // tokens.css keys off them, and the native window chrome reads the same
  // `color-scheme`.
  useEffect(() => {
    document.documentElement.dataset.theme = state.theme;
  }, [state.theme]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      document.documentElement.dataset.reduceMotion = String(
        state.reduceMotion || media.matches,
      );
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [state.reduceMotion]);

  // Global keyboard. Every shortcut in `05-02` §7 is reachable without a
  // pointer; the palette and the grid have their own inner handling.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT";

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        dispatch({ type: "overlay/open", overlay: "palette" });
        return;
      }
      if (event.key === "Escape") {
        if (state.overlay) {
          dispatch({ type: "overlay/close" });
        } else if (state.activeActionId) {
          void actions.cancel(state.activeActionId);
        } else if (state.consoleOpen) {
          dispatch({ type: "console/toggle", open: false });
        }
        return;
      }
      if (typing) {
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        void actions.diagnose();
        return;
      }
      if (event.key === "/") {
        event.preventDefault();
        document.getElementById("action-search")?.focus();
        return;
      }
      if (event.key === "`") {
        event.preventDefault();
        dispatch({ type: "console/toggle" });
        return;
      }
      if (event.key === "?") {
        event.preventDefault();
        dispatch({ type: "screen/set", screen: "help" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, dispatch, state.activeActionId, state.consoleOpen, state.overlay]);

  const notices = visibleNotices(state);

  if (state.boot === "loading") {
    return (
      <div className="boot" role="status" aria-live="polite">
        {t("misc.loading")}
      </div>
    );
  }

  if (state.boot === "failed") {
    return (
      <div className="boot boot-failed" role="alert">
        <h1>{t("misc.fatal.title")}</h1>
        <p>{t("misc.fatal.body")}</p>
        {state.bootError ? (
          <p className="mono">
            {t("misc.error.correlation", { id: state.bootError.correlationId })}
          </p>
        ) : null}
        <button className="btn" type="button" onClick={() => void actions.boot()}>
          {t("misc.retry")}
        </button>
      </div>
    );
  }

  return (
    <div className="shell">
      <Sidebar state={state} dispatch={dispatch} actions={actions} />

      <div className="workspace">
        {state.info?.simulator ? (
          <div className="simulation-banner" role="status">
            <strong>{t("mode.simulation")}</strong>
            <span>{t("mode.simulation.detail")}</span>
          </div>
        ) : null}

        {/* One strip, not two: the window is undecorated, so this row *is* the
            title bar and the toolbar in one (DEF-161). The palette trigger
            moved to the rail; the drag handle, the privilege badge, notices and
            the window buttons stay here. */}
        <AppBar
          state={state}
          noticeOpen={noticeOpen}
          setNoticeOpen={setNoticeOpen}
          noticeCount={notices.length}
        />

        {noticeOpen ? (
          <section className="notice-list panel" aria-label={t("notices.title")}>
            {notices.length === 0 ? (
              <p className="muted">{t("titlebar.notifications.empty")}</p>
            ) : (
              notices.map((notice) => (
                <article key={notice.id} className={`notice notice-${notice.severity}`}>
                  <p>{t.tKey(notice.messageKey, notice.params)}</p>
                  <button
                    className="btn btn-quiet"
                    type="button"
                    onClick={() => dispatch({ type: "notice/dismissed", id: notice.id })}
                  >
                    {t("notices.dismiss")}
                  </button>
                </article>
              ))
            )}
          </section>
        ) : null}

        <HealthStrip state={state} actions={actions} />

        {state.screen === "actions" ? (
          /*
           * One landmark, three children: the page header, the filters and the
           * panel. The earlier shape put the header and the tabs *outside*
           * `<main>` and gave `role="tabpanel"` to `<main>` itself, which meant
           * the page title sat outside the landmark (so a screen reader
           * arriving at `main` never heard it) and the panel contained the
           * `tablist` that controlled it. Both are invalid; measuring the built
           * binary is what surfaced it, because `#main h2` resolved to a card
           * title on this screen and to the page title on the other five.
           *
           * `#main` stays the skip-link target and the only scroll container.
           * The panel is a plain child: it has no overflow of its own, so this
           * adds no nested scroller.
           */
          <main className="main" id="main" data-screen="actions">
            <div className="page">
              <div className="page-head">
                <h2>{t("actions.pageTitle")}</h2>
                <p className="muted">{t("actions.pageSubtitle")}</p>
              </div>
              <Tabs state={state} dispatch={dispatch} />
              {/* The tabs own this panel through `aria-controls`, and the panel
                  points back with `aria-labelledby`, so the pair is a real
                  tab/tabpanel relation rather than a `role="tab"` with no
                  target (DEF-122, DEF-161). */}
              <div
                id={ACTION_PANEL_ID}
                role="tabpanel"
                aria-labelledby={`tab-${state.category}`}
                tabIndex={-1}
              >
                <ErrorBoundary copy={screenFailCopy(t)} resetKey={state.screen} headingLevel={2}>
                  <ActionGrid state={state} dispatch={dispatch} actions={actions} />
                </ErrorBoundary>
              </div>
            </div>
          </main>
        ) : (
          <main className="main" id="main" data-screen={state.screen}>
            {/* `resetKey` is the screen id: a throw costs this screen only, and
                switching tabs to it and back clears the fault (DEF-085). */}
            <ErrorBoundary copy={screenFailCopy(t)} resetKey={state.screen} headingLevel={2}>
              {state.screen === "snapshots" ? (
                <SnapshotsScreen state={state} actions={actions} />
              ) : null}
              {state.screen === "trust" ? (
                <TrustScreen
                  state={state}
                  actions={actions}
                  dispatch={dispatch}
                  onPurge={() => dispatch({ type: "overlay/open", overlay: "purge" })}
                />
              ) : null}
              {state.screen === "settings" ? (
                <SettingsScreen state={state} dispatch={dispatch} actions={actions} />
              ) : null}
              {state.screen === "help" ? <HelpScreen /> : null}
              {state.screen === "activity" ? <ActivityScreen state={state} dispatch={dispatch} /> : null}
            </ErrorBoundary>
          </main>
        )}

        <Console state={state} dispatch={dispatch} />
        <StatusBar state={state} dispatch={dispatch} actions={actions} />
      </div>

      {state.overlay === "palette" ? (
        <CmdPalette state={state} dispatch={dispatch} actions={actions} />
      ) : null}
      {state.overlay === "confirm" && state.confirm ? (
        <ConfirmDialog state={state} dispatch={dispatch} actions={actions} />
      ) : null}
      {state.overlay === "script" && state.script ? (
        <ScriptDialog state={state} dispatch={dispatch} actions={actions} />
      ) : null}
      {state.overlay === "candidates" && state.candidateKind ? (
        <CandidatesDialog state={state} dispatch={dispatch} actions={actions} />
      ) : null}
      {state.overlay === "purge" ? (
        <PurgeDialog state={state} dispatch={dispatch} actions={actions} />
      ) : null}

      {state.error ? <ErrorToast error={state.error} dispatch={dispatch} /> : null}
    </div>
  );
}
