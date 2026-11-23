/**
 * Reducer tests (DEF-046).
 *
 * `store.ts` says every transition is testable without a renderer; this file is
 * the proof. It runs in `node` (see `vite.config.ts`) so a failure here is a
 * logic bug, never a DOM quirk.
 *
 * The tests assert the two rules stated at the top of `store.ts`:
 *   * the reducer never invents a phase - it only applies what the core sends;
 *   * errors stay structured (`IpcError`), never flattened to a string.
 */

import { describe, expect, it } from "vitest";

import type { AppStateSnapshot, DiagnosticReport, LogLine, StartupNotice } from "../bridge/types";
import {
  LOG_LIMIT,
  initialState,
  preferencesOf,
  reducer,
  visibleNotices,
  type Action,
  type State,
} from "./store";

/** A complete snapshot so the reducer's spread is exercised realistically. */
function snapshot(overrides: Partial<AppStateSnapshot> = {}): AppStateSnapshot {
  return {
    locale: "en",
    theme: "off-white",
    reduceMotion: false,
    telemetryEnabled: false,
    actionPrefs: { pinned: [], hidden: [] },
    phases: {},
    activeActionId: null,
    lastScanAtUtc: null,
    telemetry: null,
    retention: { snapshots: 0, snapshotBytes: 0, auditRows: 0 },
    notices: [],
    sessionUptimeMs: 0,
    ...overrides,
  };
}

function report(actionId: DiagnosticReport["actionId"]): DiagnosticReport {
  return {
    actionId,
    needsAttention: true,
    severityWeight: 2,
    metricKey: "diagnostics.test",
    metricParams: {},
    reclaimableBytes: 0,
    latencyMs: null,
    tier: "fully_reversible",
    canRollback: true,
    readOnly: false,
    measuredAtUtc: "2026-11-19T00:00:00Z",
  };
}

function logLine(seq: number): LogLine {
  return { seq, atUtc: "2026-11-19T00:00:00Z", level: "info", text: `line ${seq}` };
}

function apply(actions: Action[], from: State = initialState): State {
  return actions.reduce(reducer, from);
}

describe("boot", () => {
  it("starts loading and exposes no invented state", () => {
    expect(initialState.boot).toBe("loading");
    expect(initialState.info).toBeNull();
    expect(initialState.telemetry).toBeNull();
    expect(initialState.error).toBeNull();
  });

  it("keeps the error structured when boot fails", () => {
    const error = {
      code: "INTEGRITY_ERROR",
      messageKey: "errors.integrityError",
      remedyKey: "remedy.reinstall",
      params: {},
      correlationId: "corr-1",
    };
    const state = reducer(initialState, { type: "boot/failed", error });
    expect(state.boot).toBe("failed");
    expect(state.bootError).toBe(error);
    // Not a string: the drawer needs the correlation id.
    expect(typeof state.bootError).toBe("object");
  });

  it("adopts the snapshot verbatim on ready - no optimistic phase is added", () => {
    const state = reducer(initialState, {
      type: "boot/ready",
      info: {
        version: "1.0.0",
        buildCommit: "dev",
        tauriVersion: "2.12.5",
        webviewVersion: "120",
        osBuild: 26100,
        osDisplayVersion: "24H2",
        arch: "x86_64",
        isElevated: false,
        signature: { status: "unknown" },
        storePath: "C:/ProgramData/Zenith",
        storeMode: "machine",
        simulator: false,
      },
      snapshot: snapshot({ theme: "true-black", reduceMotion: true }),
      snapshots: [],
    });
    expect(state.boot).toBe("ready");
    expect(state.theme).toBe("true-black");
    expect(state.reduceMotion).toBe(true);
    expect(state.phases).toEqual({});
  });

  it("records the measured cold-start time and keeps its absence as null", () => {
    // DEF-049 / REQ-N-001: the measurement is either a number or null. `0` is
    // never produced for "not measured", so the UI cannot show a fake instant boot.
    const measured = reducer(initialState, { type: "boot/timed", bootMs: 312 });
    expect(measured.bootMs).toBe(312);

    const unmeasured = reducer(initialState, { type: "boot/timed", bootMs: null });
    expect(unmeasured.bootMs).toBeNull();
    expect(initialState.bootMs).toBeNull();
  });
});

describe("diagnosis", () => {
  it("tracks progress and clears it on finish", () => {
    let state = reducer(initialState, { type: "diagnose/started", total: 22 });
    expect(state.diagnose).toEqual({ done: 0, total: 22 });
    state = reducer(state, { type: "diagnose/progress", done: 5, total: 22 });
    expect(state.diagnose).toEqual({ done: 5, total: 22 });
    state = reducer(state, { type: "diagnose/finished" });
    expect(state.diagnose).toBeNull();
  });

  it("merges reports without dropping earlier ones", () => {
    let state = reducer(initialState, {
      type: "diagnose/reports",
      reports: [report("flush-dns-cache")],
    });
    state = reducer(state, {
      type: "diagnose/reports",
      reports: [report("clean-temp-cache")],
    });
    expect(Object.keys(state.reports).sort()).toEqual(["clean-temp-cache", "flush-dns-cache"]);
  });
});

describe("phase transitions", () => {
  it("marks the running action active", () => {
    const state = reducer(initialState, {
      type: "phase/changed",
      actionId: "flush-dns-cache",
      phase: "running",
    });
    expect(state.phases["flush-dns-cache"]).toBe("running");
    expect(state.activeActionId).toBe("flush-dns-cache");
  });

  it("clears activeActionId when that action leaves running", () => {
    const running = reducer(initialState, {
      type: "phase/changed",
      actionId: "flush-dns-cache",
      phase: "running",
    });
    const done = reducer(running, {
      type: "phase/changed",
      actionId: "flush-dns-cache",
      phase: "success",
    });
    expect(done.activeActionId).toBeNull();
    expect(done.phases["flush-dns-cache"]).toBe("success");
  });

  it("does not steal focus when a different action finishes", () => {
    const running = reducer(initialState, {
      type: "phase/changed",
      actionId: "flush-dns-cache",
      phase: "running",
    });
    const other = reducer(running, {
      type: "phase/changed",
      actionId: "clean-temp-cache",
      phase: "success",
    });
    expect(other.activeActionId).toBe("flush-dns-cache");
  });

  it("never turns a phase into success on its own", () => {
    const state = reducer(initialState, {
      type: "phase/changed",
      actionId: "flush-dns-cache",
      phase: "error",
    });
    expect(state.phases["flush-dns-cache"]).toBe("error");
  });
});

describe("log ring buffer", () => {
  it("appends below the limit without dropping", () => {
    const state = reducer(initialState, {
      type: "log/appended",
      lines: [logLine(1), logLine(2)],
    });
    expect(state.logs).toHaveLength(2);
    expect(state.droppedLogs).toBe(0);
  });

  it("drops the oldest lines past the cap and counts them", () => {
    const lines = Array.from({ length: LOG_LIMIT + 3 }, (_, i) => logLine(i + 1));
    const state = reducer(initialState, { type: "log/appended", lines });
    expect(state.logs).toHaveLength(LOG_LIMIT);
    expect(state.droppedLogs).toBe(3);
    // The newest line survives; the three oldest are gone.
    expect(state.logs[state.logs.length - 1]?.seq).toBe(LOG_LIMIT + 3);
    expect(state.logs[0]?.seq).toBe(4);
  });

  it("clears the buffer and the dropped counter together", () => {
    const lines = Array.from({ length: LOG_LIMIT + 1 }, (_, i) => logLine(i + 1));
    const state = reducer(
      reducer(initialState, { type: "log/appended", lines }),
      { type: "log/cleared" },
    );
    expect(state.logs).toEqual([]);
    expect(state.droppedLogs).toBe(0);
  });
});

describe("notices", () => {
  const notice: StartupNotice = {
    id: "store-recovered",
    severity: "warning",
    messageKey: "notices.storeRecovered",
    params: {},
  };

  it("ignores a duplicate id so a reconnect cannot double-post", () => {
    const once = reducer(initialState, { type: "notice/received", notice });
    const twice = reducer(once, { type: "notice/received", notice });
    expect(twice.notices).toHaveLength(1);
  });

  it("hides a dismissed notice without deleting it", () => {
    const raised = reducer(initialState, { type: "notice/received", notice });
    const dismissed = reducer(raised, { type: "notice/dismissed", id: notice.id });
    expect(visibleNotices(dismissed)).toHaveLength(0);
    expect(dismissed.notices).toHaveLength(1);
  });
});

describe("preferences", () => {
  it("refuses a locale with no catalogue", () => {
    const state = reducer(initialState, { type: "prefs/locale", locale: "de" });
    expect(state.locale).toBe("en");
  });

  it("accepts a locale that ships", () => {
    const state = reducer(initialState, { type: "prefs/locale", locale: "tr" });
    expect(state.locale).toBe("tr");
  });

  it("derives the preferences payload without extra fields", () => {
    const state = apply([
      { type: "prefs/theme", theme: "spatial-glass" },
      { type: "prefs/motion", reduceMotion: true },
    ]);
    expect(preferencesOf(state)).toEqual({
      locale: "en",
      theme: "spatial-glass",
      reduceMotion: true,
      telemetryEnabled: false,
    });
  });
});

describe("navigation and overlays", () => {
  it("closes any overlay when the screen changes", () => {
    const open = reducer(initialState, { type: "overlay/open", overlay: "palette" });
    const moved = reducer(open, { type: "screen/set", screen: "snapshots" });
    expect(moved.screen).toBe("snapshots");
    expect(moved.overlay).toBeNull();
  });

  it("clears every overlay payload on close", () => {
    const state = apply(
      [
        { type: "candidates/open", kind: "dev_ports" },
        { type: "overlay/close" },
      ],
    );
    expect(state.overlay).toBeNull();
    expect(state.confirm).toBeNull();
    expect(state.script).toBeNull();
    expect(state.candidateKind).toBeNull();
  });

  it("toggles the console when no explicit target is given", () => {
    const opened = reducer(initialState, { type: "console/toggle" });
    expect(opened.consoleOpen).toBe(true);
    const closed = reducer(opened, { type: "console/toggle" });
    expect(closed.consoleOpen).toBe(false);
  });
});

describe("keyboard focus", () => {
  it("wraps forward and backward through a list", () => {
    let state = reducer(initialState, { type: "focus/set", index: 0 });
    state = reducer(state, { type: "focus/move", delta: -1, count: 3 });
    expect(state.focusedIndex).toBe(2);
    state = reducer(state, { type: "focus/move", delta: 1, count: 3 });
    expect(state.focusedIndex).toBe(0);
  });

  it("ignores movement on an empty list", () => {
    const state = reducer(initialState, { type: "focus/move", delta: 1, count: 0 });
    expect(state.focusedIndex).toBe(0);
  });

  it("resets focus when the filter changes", () => {
    const moved = reducer(initialState, { type: "focus/set", index: 7 });
    expect(reducer(moved, { type: "search/set", search: "dns" }).focusedIndex).toBe(0);
    expect(reducer(moved, { type: "category/set", category: "network" }).focusedIndex).toBe(0);
  });

  it("clamps a negative focus index to zero", () => {
    const state = reducer(initialState, { type: "focus/set", index: -4 });
    expect(state.focusedIndex).toBe(0);
  });
});
