// @vitest-environment jsdom
/**
 * Controller-level tests for `useActions` (T-FE-15).
 *
 * The render tests exercise the screens with a stubbed `ActionsApi`, which
 * proves what a screen *asks for* but not what the controller *sends*. DEF-071
 * was exactly that gap: the settings screen correctly sent `{ theme }`, and the
 * controller merged the whole preference object back in before calling the
 * bridge - so a screen opened before a change reverted it on the next save.
 *
 * These tests mount the real hook against a fake `Bridge`, so the assertion is
 * on the bytes that cross the IPC boundary.
 */

import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useReducer } from "react";

import { useActions } from "./actions";
import { BridgeContext } from "./bridge";
import type { Bridge } from "./bridge/adapter";
import type { Preferences } from "./bridge/adapter";
import type { AppStateSnapshot } from "./bridge/types";
import { initialState, reducer } from "./state/store";
import type { Action } from "./state/store";

const PREFS: Preferences = {
  locale: "en",
  theme: "obsidian",
  reduceMotion: false,
  telemetryEnabled: false,
};

function snapshot(preferences: Partial<Preferences> = {}): AppStateSnapshot {
  return {
    version: "1.0.0",
    isElevated: false,
    locale: "en",
    theme: "obsidian",
    reduceMotion: false,
    telemetryEnabled: false,
    preferences: { ...PREFS, ...preferences },
    activeActionId: null,
    phases: {},
    telemetry: null,
    diagnoseRunning: false,
    simulator: false,
    startupNotices: [],
  } as unknown as AppStateSnapshot;
}

/** A Bridge whose every method is a spy; only the called ones need to resolve. */
function fakeBridge(): Bridge {
  const spy = () => vi.fn(() => Promise.resolve(undefined));
  return {
    appInfo: vi.fn(() => Promise.resolve({ version: "1.0.0", simulator: false })),
    state: vi.fn(() => Promise.resolve(snapshot())),
    snapshots: vi.fn(() => Promise.resolve([])),
    diagnose: vi.fn(() => Promise.resolve([])),
    execute: vi.fn(() => Promise.resolve({ phase: "succeeded", snapshotId: null })),
    cancel: vi.fn(() => Promise.resolve({ cancelled: true })),
    rollback: vi.fn(() => Promise.resolve(undefined)),
    candidates: vi.fn(() => Promise.resolve({ kind: "dev_ports", items: [] })),
    terminate: vi.fn(() => Promise.resolve({ terminated: 0, skipped: 0 })),
    saveText: vi.fn(() => Promise.resolve({ path: null })),
    supportBundle: vi.fn(() => Promise.resolve({ path: "x.zip", bytes: 0 })),
    purge: vi.fn(() => Promise.resolve(undefined)),
    requestElevation: spy(),
    savePreferences: vi.fn(() => Promise.resolve(undefined)),
    actionPrefs: vi.fn(() => Promise.resolve({ pinned: [], hidden: [] })),
    on: vi.fn(() => Promise.resolve(() => {})),
  } as unknown as Bridge;
}

/** Mount the hook and hand its API to the test body. */
function harness(bridge: Bridge) {
  const captured: {
    api?: ReturnType<typeof useActions>;
    state?: ReturnType<typeof reducer>;
    actions: Action[];
  } = { actions: [] };

  function Probe() {
    const [state, dispatch] = useReducer(
      (current: ReturnType<typeof reducer>, action: Action) => {
        captured.actions.push(action);
        return reducer(current, action);
      },
      initialState,
    );
    captured.api = useActions(state, dispatch);
    captured.state = state;
    return null;
  }

  render(
    <BridgeContext.Provider value={bridge}>
      <Probe />
    </BridgeContext.Provider>,
  );

  return captured;
}

describe("useActions.savePreferences (T-FE-15)", () => {
  it("forwards the patch verbatim instead of merging the whole preference set", async () => {
    const bridge = fakeBridge();
    const captured = harness(bridge);

    await act(async () => {
      await captured.api?.savePreferences({ theme: "slate" });
    });

    await waitFor(() => expect(bridge.savePreferences).toHaveBeenCalled());
    expect(bridge.savePreferences).toHaveBeenCalledWith({ theme: "slate" });

    const calls = (bridge.savePreferences as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
    const sent = calls[0]?.[0];
    expect(Object.keys(sent as Record<string, unknown>)).toEqual(["theme"]);
  });

  it("refreshes state after a successful save so the UI shows what was stored", async () => {
    const bridge = fakeBridge();
    const captured = harness(bridge);

    await act(async () => {
      await captured.api?.savePreferences({ reduceMotion: true });
    });

    await waitFor(() => expect(bridge.state).toHaveBeenCalled());
  });
});

describe("shell-written log lines (T-FE-24, DEF-094)", () => {
  it("tags the bundle line with a catalogue key and its path as a parameter", async () => {
    const bridge = fakeBridge();
    (bridge.supportBundle as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: "C:\\Users\\emir\\bundle.zip",
      bytes: 2048,
      includedFiles: [],
      redactionReport: { maskedValues: 0, scrubbedPaths: 0 },
    });
    const captured = harness(bridge);

    await act(async () => {
      await captured.api?.createBundle("note");
    });

    const lines = captured.state?.logs ?? [];
    const line = lines.at(-1);
    expect(line).toBeTruthy();
    // The key is what makes the line translatable; `text` stays support-facing.
    expect(line?.stepKey).toBe("console.bundleSaved");
    expect(line?.params).toEqual({ path: "C:\\Users\\emir\\bundle.zip" });
    expect(line?.text).toContain("support bundle:");
  });

  it("tags the audit-export line the same way", async () => {
    const bridge = fakeBridge();
    (bridge.saveText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: "D:\\audit.csv",
    });
    const captured = harness(bridge);

    await act(async () => {
      await captured.api?.exportAudit("csv");
    });

    const line = (captured.state?.logs ?? []).at(-1);
    expect(line?.stepKey).toBe("console.auditExported");
    expect(line?.params).toEqual({ path: "D:\\audit.csv" });
  });

  it("gives two same-millisecond lines distinct, increasing seq values", async () => {
    // `Date.now()` alone fails here: two dispatches in the same tick produce the
    // same number, and `03-04` §4 promises `seq` is monotonic.
    const bridge = fakeBridge();
    (bridge.supportBundle as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      path: "a.zip",
      bytes: 0,
      includedFiles: [],
      redactionReport: { maskedValues: 0, scrubbedPaths: 0 },
    });
    (bridge.saveText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ path: "b.csv" });
    const captured = harness(bridge);

    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await act(async () => {
        await captured.api?.createBundle("");
        await captured.api?.exportAudit("csv");
      });
    } finally {
      spy.mockRestore();
    }

    const seqs = (captured.state?.logs ?? []).map((line) => line.seq);
    expect(seqs).toHaveLength(2);
    expect(seqs[0]).not.toBe(seqs[1]);
    expect(seqs[1]!).toBeGreaterThan(seqs[0]!);
  });
});

describe("fast-diagnose threshold is a single source (T-FE-25, DEF-093)", () => {
  it("counts the fast pass from the generated catalogue constant, not a literal", async () => {
    const { ACTIONS, FAST_DIAGNOSE_BUDGET_MS } = await import("./catalog.generated");
    const bridge = fakeBridge();
    const captured = harness(bridge);

    await act(async () => {
      await captured.api?.diagnose(false);
    });

    const expected = ACTIONS.filter(
      (def) => def.diagnoseBudgetMs <= FAST_DIAGNOSE_BUDGET_MS,
    ).length;
    // `diagnose/finished` clears `state.diagnose`, so the announced total is
    // read from the dispatched action rather than from the final render.
    const started = captured.actions.find((action) => action.type === "diagnose/started");
    expect(started).toBeTruthy();
    // The number the UI announced must equal the set the same rule selects.
    // When `actions.ts` carried its own `3000`, changing the manifest budget
    // moved one side and not the other.
    expect((started as { total: number }).total).toBe(expected);
    expect(expected).toBeLessThan(ACTIONS.length);
  });
});

describe("one diagnosis at a time (T-FE-26, DEF-121)", () => {
  it("ignores a second diagnose() while the first is still in flight", async () => {
    const bridge = fakeBridge();
    // A diagnosis that does not resolve until the test releases it - the window
    // in which a user pressing Ctrl+D a second time used to do damage.
    let release: () => void = () => {};
    const inFlight = new Promise<never[]>((resolve) => {
      release = () => resolve([]);
    });
    (bridge.diagnose as unknown as ReturnType<typeof vi.fn>).mockReturnValue(inFlight);

    const captured = harness(bridge);

    let second: Promise<void> | undefined;
    await act(async () => {
      const first = captured.api?.diagnose(true);
      // Second press, same tick, while the first is genuinely in flight.
      second = captured.api?.diagnose(true);
      // Let the second call's microtasks run before the first resolves.
      await Promise.resolve();
      void first;
    });

    // The core would reject the duplicate with ALREADY_RUNNING; the renderer
    // must never send it. One `bridge.diagnose` call means the guard works.
    expect(bridge.diagnose).toHaveBeenCalledTimes(1);
    // And it must not have announced a second run: exactly one `diagnose/started`.
    expect(captured.actions.filter((action) => action.type === "diagnose/started")).toHaveLength(1);

    await act(async () => {
      release();
      await second;
    });

    // After the first finishes the guard is released, so a later press works.
    expect(captured.actions.filter((action) => action.type === "diagnose/finished")).toHaveLength(1);
  });

  it("leaves the running diagnosis's progress intact when a duplicate press is ignored", async () => {
    const bridge = fakeBridge();
    let release: () => void = () => {};
    (bridge.diagnose as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<never[]>((resolve) => {
        release = () => resolve([]);
      }),
    );

    const captured = harness(bridge);

    await act(async () => {
      void captured.api?.diagnose(true);
      await Promise.resolve();
      // The second press used to dispatch `diagnose/started`, resetting the bar
      // to 0 and shrinking the total to the fast set, then clearing it entirely
      // in `finally` - destroying the display of the scan still running.
      void captured.api?.diagnose(false);
      await Promise.resolve();
    });

    expect(captured.actions.filter((action) => action.type === "diagnose/started")).toHaveLength(1);
    expect(captured.actions.filter((action) => action.type === "diagnose/finished")).toHaveLength(0);

    await act(async () => {
      release();
    });
  });
});
