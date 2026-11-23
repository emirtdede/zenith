// @vitest-environment jsdom
/**
 * Wiring tests for DEF-089 and DEF-090 (T-FE-23).
 *
 * DEF-089 was not a missing component: it was 22 catalogue keys that named real
 * data the renderer received and then dropped. `check-unused-keys` proves a key
 * is *referenced*; it cannot prove the reference renders the right value. These
 * tests are the other half - they mount the component with a contract-shaped
 * payload and assert the measurement reaches the screen.
 *
 * Each case is written so that reverting the wiring makes it fail: the datum
 * asserted (`148 MiB`, `3 pages`, `refused_self` badge, the redaction counts) is
 * the field, not a label, so a key that is present but unbound cannot pass.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionsApi } from "../actions";
import { BridgeContext } from "../bridge";
import type { Bridge } from "../bridge/adapter";
import type {
  Candidates,
  IpcError,
  PortListener,
  SupportBundle,
  TerminateSummary,
} from "../bridge/types";
import { buildTranslator, I18nProvider } from "../i18n";
import { en } from "../i18n/en";
import { tr } from "../i18n/tr";
import { initialState } from "../state/store";
import type { State } from "../state/store";
import { ACTIONS } from "../catalog.generated";
import { ActionGrid } from "./ActionGrid";
import { CandidatesDialog, ScriptDialog } from "./Dialogs";
import { ErrorToast } from "./ErrorToast";
import { TrustScreen } from "./TrustScreen";

afterEach(cleanup);

function makeState(patch: Partial<State> = {}): State {
  return { ...initialState, boot: "ready", ...patch };
}

function noopActions(): ActionsApi {
  const fn = () => vi.fn(() => Promise.resolve());
  return {
    boot: fn(),
    refresh: fn(),
    diagnose: fn(),
    cancel: fn(),
    execute: vi.fn(() => Promise.resolve(null)),
    rollback: fn(),
    savePreferences: fn(),
    setActionPrefs: fn(),
    togglePin: fn(),
    toggleHidden: fn(),
    elevate: fn(),
    terminate: vi.fn(() => Promise.resolve(null)),
    createBundle: vi.fn(() => Promise.resolve(null)),
    purge: fn(),
    saveScript: fn(),
    scan: fn(),
  } as unknown as ActionsApi;
}

function renderWith(
  ui: React.ReactElement,
  { locale = "en", bridge = null as Bridge | null }: { locale?: string; bridge?: Bridge | null } = {},
) {
  const tree = (
    <I18nProvider locale={locale}>{ui}</I18nProvider>
  );
  const utils = render(
    bridge ? <BridgeContext.Provider value={bridge}>{tree}</BridgeContext.Provider> : tree,
  );
  return utils;
}

/** A bridge that answers `candidates` with a fixed payload. */
function candidatesBridge(payload: Candidates): Bridge {
  return {
    native: false,
    kind: "simulator",
    candidates: vi.fn(() => Promise.resolve(payload)),
  } as unknown as Bridge;
}

const PORT_NORMAL: PortListener = {
  port: 3000,
  protocol: "TCP",
  localAddress: "127.0.0.1",
  pid: 14208,
  processName: "node.exe",
  startTimeUnixMs: 1_700_000_000_000,
  commandLineRedacted: "node C:\\work\\api\\server.js --port 3000",
  memoryMb: 148,
  isSelf: false,
};

const PORT_SELF: PortListener = {
  ...PORT_NORMAL,
  port: 4415,
  pid: 999,
  processName: "zenith.exe",
  commandLineRedacted: "zenith.exe",
  memoryMb: 64,
  isSelf: true,
};

describe("CandidatesDialog renders the measurement each family promises (DEF-089)", () => {
  it("shows port memory and the redacted command line, not just the pid", async () => {
    const bridge = candidatesBridge({
      kind: "dev_ports",
      scannedAtUtc: new Date().toISOString(),
      items: [PORT_NORMAL],
    });

    renderWith(
      <CandidatesDialog
        state={makeState({ overlay: "candidates", candidateKind: "dev_ports" })}
        dispatch={vi.fn()}
        actions={noopActions()}
      />,
      { bridge },
    );

    // The header names the measurement it is about to show.
    expect(await screen.findByText(en["ports.memory"])).toBeTruthy();
    // The value is the field: 148 MiB formatted by the shared formatter.
    expect(screen.getByText(/148/)).toBeTruthy();
    // The command line is what tells three node.exe listeners apart.
    expect(screen.getByText(/server\.js --port 3000/)).toBeTruthy();
    expect(screen.getByText(/node\.exe . 14208/)).toBeTruthy();
  });

  it("marks Zenith's own listener and offers no checkbox for it (DEF-090)", async () => {
    const bridge = candidatesBridge({
      kind: "dev_ports",
      scannedAtUtc: new Date().toISOString(),
      items: [PORT_NORMAL, PORT_SELF],
    });

    renderWith(
      <CandidatesDialog
        state={makeState({ overlay: "candidates", candidateKind: "dev_ports" })}
        dispatch={vi.fn()}
        actions={noopActions()}
      />,
      { bridge },
    );

    // The promise is stated before the tick, not only after a refused kill.
    expect(await screen.findByText(en["ports.self"])).toBeTruthy();

    // Exactly one selectable row: the normal listener. The self row has no
    // checkbox, so a user cannot tick the process that is running the request.
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(1);
    // The accessible name is a sentence a screen reader can read, not the raw
    // row key. This assertion used to pin "3000:14208" - the defect itself -
    // so the test certified a name that announces as a string of digits.
    expect(boxes[0]!.getAttribute("aria-label")).toBe(
      buildTranslator("en")("ports.select", {
        port: 3000,
        process: "node.exe",
        pid: 14208,
      }),
    );
    // And it must actually name the port and the process, not merely differ.
    expect(boxes[0]!.getAttribute("aria-label")).toContain("3000");
    expect(boxes[0]!.getAttribute("aria-label")).toContain("node.exe");
  });

  it("reports the measured terminate summary and rescans (DEF-089)", async () => {
    const summary: TerminateSummary = {
      requested: 1,
      terminated: 1,
      results: [{ pid: 14208, outcome: "terminated" }],
      correlationId: "corr-1",
    };
    const actions = noopActions();
    (actions.terminate as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(summary);

    const bridge = candidatesBridge({
      kind: "dev_ports",
      scannedAtUtc: new Date().toISOString(),
      items: [PORT_NORMAL],
    });

    renderWith(
      <CandidatesDialog
        state={makeState({ overlay: "candidates", candidateKind: "dev_ports" })}
        dispatch={vi.fn()}
        actions={actions}
      />,
      { bridge },
    );

    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: en["ports.stop"] }));

    // `1 of 1 stopped.` - the number the dialog learned from the core.
    expect(await screen.findByText(buildTranslator("en")("ports.result", { terminated: 1, requested: 1 }))).toBeTruthy();
    expect(actions.terminate).toHaveBeenCalledWith("unlock-dev-ports", [
      { pid: 14208, expectedName: "node.exe", expectedStartTimeUnixMs: 1_700_000_000_000 },
    ]);
    // The rescan button is real and named.
    expect(screen.getByRole("button", { name: en["ports.refresh"] })).toBeTruthy();
  });

  it("shows page count and owner for print jobs", async () => {
    const bridge = candidatesBridge({
      kind: "print_jobs",
      scannedAtUtc: new Date().toISOString(),
      items: [
        {
          jobId: 42,
          printer: "HP LaserJet Pro",
          document: "Invoice-2026-118.pdf",
          owner: "office",
          pages: 3,
          submittedAtUtc: null,
        },
      ],
    });

    renderWith(
      <CandidatesDialog
        state={makeState({ overlay: "candidates", candidateKind: "print_jobs" })}
        dispatch={vi.fn()}
        actions={noopActions()}
      />,
      { bridge },
    );

    expect(await screen.findByText(en["spooler.owner"])).toBeTruthy();
    expect(screen.getByText(en["spooler.pages"])).toBeTruthy();
    expect(screen.getByText("office")).toBeTruthy();
    // The page count is the field, rendered as the bare number in its column.
    expect(screen.getByText("3")).toBeTruthy();

    // The print queue is read-only, so the table has three columns, not four.
    // It used to draw a named "Select" header over empty cells - a column that
    // labels nothing and tells a screen-reader user a control exists that does
    // not (DEF-114).
    expect(screen.queryByRole("columnheader", { name: en["misc.selectRow"] })).toBeNull();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
  });

  it("shows the WSL state and the shared VM memory", async () => {
    const bridge = candidatesBridge({
      kind: "wsl",
      scannedAtUtc: new Date().toISOString(),
      items: [{ distro: "Ubuntu-24.04", state: "Running", vmMemoryMb: 3412 }],
    });

    renderWith(
      <CandidatesDialog
        state={makeState({ overlay: "candidates", candidateKind: "wsl" })}
        dispatch={vi.fn()}
        actions={noopActions()}
      />,
      { bridge },
    );

    expect(await screen.findByText(en["wsl.state"])).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText(/3[.,]3/)).toBeTruthy();
  });

  it("renders the unresponsive duration for a hung window", async () => {
    const bridge = candidatesBridge({
      kind: "hung_office",
      scannedAtUtc: new Date().toISOString(),
      items: [
        {
          pid: 5512,
          processName: "WINWORD.EXE",
          startTimeUnixMs: 1_700_000_000_000,
          windowTitleRaw: "Quarterly report.docx",
          memoryMb: 324,
          hungForMs: 5_000,
        },
      ],
    });

    renderWith(
      <CandidatesDialog
        state={makeState({ overlay: "candidates", candidateKind: "hung_office" })}
        dispatch={vi.fn()}
        actions={noopActions()}
      />,
      { bridge },
    );

    // The value is interpolated, so the assertion is on the rendered sentence,
    // not on the raw catalogue pattern. It must say **at least**: the core
    // reports the OS threshold, never a stopwatch reading, and the sentence used
    // to claim a measured duration (DEF-112).
    expect(await screen.findByText(/Unresponsive for at least/)).toBeTruthy();
    expect(screen.getByText("Quarterly report.docx")).toBeTruthy();
    // The header over the checkbox column is named, not a bare `<th>`.
    expect(screen.getByRole("columnheader", { name: en["misc.selectRow"] })).toBeTruthy();
  });

  it("names an untitled frozen window instead of leaving the row blank (DEF-112)", async () => {
    const bridge = candidatesBridge({
      kind: "hung_office",
      scannedAtUtc: new Date().toISOString(),
      items: [
        {
          pid: 5512,
          processName: "WINWORD.EXE",
          startTimeUnixMs: 1_700_000_000_000,
          // A document window that has not finished loading has no caption.
          windowTitleRaw: "",
          memoryMb: 324,
          hungForMs: 5_000,
        },
      ],
    });

    renderWith(
      <CandidatesDialog
        state={makeState({ overlay: "candidates", candidateKind: "hung_office" })}
        dispatch={vi.fn()}
        actions={noopActions()}
      />,
      { bridge },
    );

    // The cell and the accessible name both carry the placeholder, so neither
    // the row nor the spoken label has a hole where the title should be.
    expect(await screen.findAllByText(en["hung.untitled"])).toHaveLength(1);
    const box = screen.getByRole("checkbox");
    expect(box.getAttribute("aria-label")).toContain(en["hung.untitled"]);
    // And no double space from the empty interpolation.
    expect(box.getAttribute("aria-label")).not.toMatch(/ {2}/);
  });
});

describe("TrustScreen renders the bundle it actually created (DEF-089)", () => {
  const info = {
    version: "1.0.0",
    buildCommit: "release-20261121",
    tauriVersion: "2.12.5",
    webviewVersion: "unknown",
    osBuild: 26100,
    osDisplayVersion: "Windows 11",
    arch: "x86_64",
    isElevated: false,
    signature: { status: "valid" as const, publisher: "Vellium Bilisim A.S." },
    storePath: "C:\\ProgramData\\Vellium\\Zenith",
    storeMode: "machine" as const,
    simulator: false,
  };

  it("shows the publisher only when the signature carries one", () => {
    const { unmount } = renderWith(
      <TrustScreen
        state={makeState({ info })}
        actions={noopActions()}
        dispatch={vi.fn()}
        onPurge={vi.fn()}
      />,
    );
    expect(screen.getByText(en["trust.publisher"])).toBeTruthy();
    expect(screen.getByText("Vellium Bilisim A.S.")).toBeTruthy();
    unmount();

    // Unsigned: the row must be absent, not an empty label.
    renderWith(
      <TrustScreen
        state={makeState({ info: { ...info, signature: { status: "unsigned" } } })}
        actions={noopActions()}
        dispatch={vi.fn()}
        onPurge={vi.fn()}
      />,
    );
    expect(screen.queryByText(en["trust.publisher"])).toBeNull();
  });

  it("renders path, size, included files and redaction counts from the result", async () => {
    const bundle: SupportBundle = {
      path: "C:\\Users\\emir\\Desktop\\bundle.zip",
      bytes: 204_800,
      includedFiles: ["audit.db", "logs/zenith.log", "state.json"],
      redactionReport: { maskedValues: 7, scrubbedPaths: 3 },
    };
    const actions = noopActions();
    (actions.createBundle as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(bundle);

    renderWith(
      <TrustScreen
        state={makeState({ info })}
        actions={actions}
        dispatch={vi.fn()}
        onPurge={vi.fn()}
      />,
    );

    // Before the press there is no result panel: the screen never claims a
    // bundle exists because a button is present.
    expect(screen.queryByText(en["trust.bundle.contents"])).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: en["trust.bundle.action"] }));

    expect(await screen.findByText(en["trust.bundle.contents"])).toBeTruthy();
    expect(screen.getByText("audit.db")).toBeTruthy();
    expect(screen.getByText("logs/zenith.log")).toBeTruthy();
    expect(screen.getByText(en["trust.bundle.redaction"])).toBeTruthy();
    expect(
      screen.getByText(
        buildTranslator("en")("trust.bundle.redaction.value", { masked: 7, paths: 3 }),
      ),
    ).toBeTruthy();
    // The save line carries the measured byte size, not a placeholder.
    expect(screen.getByText(/bundle\.zip/)).toBeTruthy();
  });
});

describe("ErrorToast exposes the technical detail (DEF-089)", () => {
  const error: IpcError = {
    code: "SERVICE_UNAVAILABLE",
    messageKey: "errors.internal",
    remedyKey: "remedy.createSupportBundle",
    params: {},
    correlationId: "corr-42",
    detail: "spooler RPC returned 0x800706BA",
  };

  it("renders the detail in a disclosure and still shows the correlation id", () => {
    renderWith(<ErrorToast error={error} dispatch={vi.fn()} />);

    expect(screen.getByText(en["misc.error.detail"])).toBeTruthy();
    expect(screen.getByText("spooler RPC returned 0x800706BA")).toBeTruthy();
    expect(screen.getByText(/corr-42/)).toBeTruthy();
  });

  it("omits the disclosure when the core attached no detail", () => {
    renderWith(
      <ErrorToast error={{ ...error, detail: undefined }} dispatch={vi.fn()} />,
    );
    expect(screen.queryByText(en["misc.error.detail"])).toBeNull();
    expect(screen.queryByText(/spooler RPC/)).toBeNull();
  });

  it("dismisses through the reducer, not local state", () => {
    const dispatch = vi.fn();
    renderWith(<ErrorToast error={error} dispatch={dispatch} />);
    fireEvent.click(screen.getByRole("button", { name: en["misc.error.dismiss"] }));
    expect(dispatch).toHaveBeenCalledWith({ type: "error/cleared" });
  });

  it("renders in Turkish from the catalogue", () => {
    renderWith(<ErrorToast error={error} dispatch={vi.fn()} />, { locale: "tr" });
    expect(screen.getByText(tr["misc.error.detail"])).toBeTruthy();
  });
});

describe("ActionGrid says an action can be stopped (DEF-089)", () => {
  it("badges only the actions whose manifest sets abortable", () => {
    renderWith(<ActionGrid state={makeState()} dispatch={vi.fn()} actions={noopActions()} />);

    const abortable = ACTIONS.filter((def) => def.abortable);
    expect(abortable.length).toBeGreaterThan(0);

    // One badge per abortable action, and no badge on the others. Counting both
    // directions is what makes a hard-coded badge fail.
    expect(screen.getAllByText(en["card.abortable"])).toHaveLength(abortable.length);

    const card = document.querySelector<HTMLElement>(
      `[data-action-card][data-action-id="${abortable[0]!.id}"]`,
    );
    expect(card).not.toBeNull();
    expect(within(card!).getByText(en["card.abortable"])).toBeTruthy();
  });
});

describe("ScriptDialog reports its own copy (DEF-089)", () => {
  it("switches the label to Copied only after a real clipboard write", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const def = ACTIONS.find((entry) => entry.id === "flush-dns-cache")!;
    renderWith(
      <ScriptDialog
        state={makeState({
          overlay: "script",
          script: { actionId: def.id, format: "ps1" },
          // No diagnostic report: the metric line is a *report* projection, and
          // this test is about copy feedback, not about `metricKey` rendering.
          reports: {},
        })}
        dispatch={vi.fn()}
        actions={noopActions()}
      />,
    );

    const copy = screen.getByRole("button", { name: en["script.copy"] });
    fireEvent.click(copy);

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(await screen.findByText(en["script.copied"])).toBeTruthy();
  });
});

/**
 * DEF-108: the scan's Stop button must exist, name the `scan` scope, and treat
 * the resulting cancellation as the outcome the user chose - not as a failure.
 *
 * The button is the whole reason the scope exists. Before it, the core promised a
 * slow spooler was interruptible "between printers and between jobs" and nothing
 * ever interrupted one; the dialog simply waited. A button that renders but is
 * not wired is worse than none, so this test clicks it and asserts both effects.
 */
describe("CandidatesDialog stops its own scan (DEF-108)", () => {
  const CANCELLED: IpcError = {
    code: "CANCELLED",
    messageKey: "errors.cancelled",
    remedyKey: "remedy.none",
    params: {},
    correlationId: "corr-cancel",
  };

  it("offers Stop while scanning and routes the cancellation to the quiet line", async () => {
    let rejectScan: ((reason: unknown) => void) | null = null;
    const bridge = {
      native: false,
      kind: "simulator",
      candidates: vi.fn(
        () =>
          new Promise<Candidates>((_resolve, reject) => {
            rejectScan = reject;
          }),
      ),
    } as unknown as Bridge;
    const actions = noopActions();

    renderWith(
      <CandidatesDialog
        state={makeState({ overlay: "candidates", candidateKind: "print_jobs" })}
        dispatch={vi.fn()}
        actions={actions}
      />,
      { bridge },
    );

    // While in flight the footer offers Stop, not "Scan again" - rescanning a
    // scan that is still running is how two spooler walks pile up.
    const stop = await screen.findByRole("button", { name: en["ports.cancelScan"] });
    expect(screen.queryByRole("button", { name: en["ports.refresh"] })).toBeNull();

    fireEvent.click(stop);
    // The scope must be `scan`: naming an ActionId here would stop a repair
    // instead, and `diagnose` would withdraw a diagnosis.
    expect(actions.cancel).toHaveBeenCalledWith("scan");

    await act(async () => {
      rejectScan?.(CANCELLED);
    });

    // The user asked for this, so it is a status line and not an alert.
    expect(await screen.findByText(en["ports.scanStopped"])).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
  });

  /**
   * DEF-107: a rejected scan is an `IpcError` object, not an `Error`, so
   * `instanceof Error` is false and the old `String(reason)` fallback printed
   * `[object Object]`. The catalogue sentence is the only acceptable output.
   */
  it("renders the catalogue sentence for a rejected scan, never [object Object]", async () => {
    const failure: IpcError = {
      code: "TOOL_MISSING",
      messageKey: "errors.toolMissing",
      remedyKey: "remedy.installTool",
      params: { tool: "Get-PrintJob" },
      correlationId: "corr-missing",
    };
    const bridge = {
      native: false,
      kind: "simulator",
      candidates: vi.fn(() => Promise.reject(failure)),
    } as unknown as Bridge;

    renderWith(
      <CandidatesDialog
        state={makeState({ overlay: "candidates", candidateKind: "print_jobs" })}
        dispatch={vi.fn()}
        actions={noopActions()}
      />,
      { bridge },
    );

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(en["errors.toolMissing"])).toBeTruthy();
    // The remedy is what makes the message actionable.
    expect(within(alert).getByText(en["remedy.installTool"])).toBeTruthy();
    // The defect itself: a JavaScript internal must never reach the user.
    expect(alert.textContent ?? "").not.toContain("[object Object]");
    expect(screen.queryByText(/\[object Object\]/)).toBeNull();
  });
});

beforeEach(() => {
  // jsdom has no clipboard; each test that needs one installs its own spy so a
  // previous case cannot make a later one pass.
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
});
