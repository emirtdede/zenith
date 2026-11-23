/**
 * Deterministic in-memory implementation of [`Bridge`] (ADR-012).
 *
 * Three rules make this safe to ship in a browser build:
 *
 * 1. **No native imports.** This module must not import `@tauri-apps`, `fs`, or
 *    anything privileged. `scripts/check-simulator.mjs` walks its import graph
 *    and fails CI if that line is crossed.
 * 2. **No fake success on a real machine.** The simulator is only selected when
 *    the native host is absent, and the UI shows a non-dismissible badge while it
 *    is active (`REQ-F-107`).
 * 3. **Seeded, not random.** The same seed produces the same numbers, so a
 *    screenshot in a design review matches the next run and tests are stable.
 *
 * Values are plausible rather than measured. Nothing here claims to describe the
 * user's actual PC.
 */

import { ACTIONS, SAFE_PRESET, type ActionDef } from "../catalog.generated";
import { THEME_IDS } from "../settings/themes";

import type {
  Bridge,
  DiagnoseRequest,
  EventMap,
  EventName,
  ExecuteRequest,
  HandoverRequest,
  Preferences,
  PreferencesPatch,
  PurgeRequest,
  SaveTextRequest,
  Unlisten,
} from "./adapter";
import type {
  ActionId,
  ActionPrefs,
  AppInfo,
  AppStateSnapshot,
  CancelResult,
  CandidateKind,
  Candidates,
  DiagnosticReport,
  ExecutionOutcome,
  HungWindow,
  IpcError,
  LogLine,
  PortListener,
  PrintJob,
  PurgeSummary,
  RollbackOutcome,
  SavedFile,
  SnapshotRecord,
  StartupNotice,
  StepResult,
  SupportBundle,
  TerminateSummary,
  ThemeId,
  VerifiedPidTarget,
  WslSession,
} from "./types";

/** Mulberry32: 32-bit, fast, and good enough for visual noise. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const nowIso = () => new Date().toISOString();

function newId(prefix: string, random: () => number): string {
  const chunk = () => Math.floor(random() * 0xffffffff).toString(16).padStart(8, "0");
  return `${prefix}-${chunk()}${chunk()}`.slice(0, prefix.length + 17);
}

/** Plausible per-action diagnostic values, stable across runs. */
function simulateReport(def: ActionDef, random: () => number): DiagnosticReport {
  const roll = random();
  const needsAttention = roll > 0.62;
  const mb = (low: number, high: number) => Math.round(low + random() * (high - low));

  let metricKey = "diag.unavailable";
  const metricParams: Record<string, string> = {};
  let reclaimableBytes = 0;
  let latencyMs: number | null = null;

  switch (def.id) {
    case "clean-temp-cache": {
      const megabytes = mb(400, 3800);
      reclaimableBytes = megabytes * 1024 * 1024;
      metricKey = needsAttention ? "diag.junkOver" : "diag.junkUnder";
      metricParams.mb = String(megabytes);
      metricParams.minAgeHours = "24";
      break;
    }
    case "empty-recycle-bin": {
      const megabytes = mb(20, 2400);
      reclaimableBytes = megabytes * 1024 * 1024;
      metricKey = needsAttention ? "diag.recycleOver" : "diag.recycleUnder";
      metricParams.mb = String(megabytes);
      metricParams.items = String(mb(3, 420));
      break;
    }
    case "archive-screenshots":
      metricKey = needsAttention ? "diag.screenshotsMany" : "diag.screenshotsFew";
      metricParams.files = String(mb(4, 64));
      metricParams.days = "30";
      metricParams.mb = String(mb(120, 900));
      break;
    case "flush-dns-cache": {
      latencyMs = mb(8, 120);
      metricKey = latencyMs > 60 ? "diag.dnsSlow" : "diag.dnsFast";
      metricParams.ms = String(latencyMs);
      metricParams.threshold = "60";
      break;
    }
    case "reset-winsock-stack":
      metricKey = roll > 0.5 ? "diag.winsockLastReset" : "diag.winsockNeverReset";
      metricParams.days = String(mb(2, 300));
      break;
    case "clear-stuck-proxy-vpn":
      metricKey = needsAttention ? "diag.proxyStuck" : "diag.proxyDirect";
      metricParams.proxyEnable = needsAttention ? "1" : "0";
      break;
    case "sync-ntp-time":
      metricKey = needsAttention ? "diag.timeServiceStopped" : "diag.timeServiceRunning";
      metricParams.state = needsAttention ? "stopped" : "running";
      break;
    case "restart-explorer":
      metricKey = "diag.explorerRunning";
      metricParams.count = String(mb(1, 3));
      break;
    case "rebuild-icon-cache":
      metricKey = needsAttention ? "diag.iconCacheOver" : "diag.iconCacheUnder";
      metricParams.mb = String(mb(40, 620));
      break;
    case "restart-bluetooth":
      metricKey = "diag.serviceRunning";
      metricParams.service = "bthserv";
      metricParams.state = "running";
      break;
    case "reset-print-spooler":
      metricKey = "diag.serviceRunning";
      metricParams.service = "Spooler";
      metricParams.state = "running";
      break;
    case "controlled-reboot":
      metricKey = needsAttention ? "diag.uptimeLong" : "diag.uptimeShort";
      metricParams.days = String(mb(0, 24));
      break;
    case "unlock-dev-ports":
      metricKey = needsAttention ? "diag.portsBusy" : "diag.portsFree";
      metricParams.count = needsAttention ? String(mb(1, 3)) : "0";
      if (needsAttention) {
        metricParams.ports = "3000:node, 8080:java";
      }
      break;
    case "close-hung-office":
      metricKey = needsAttention ? "diag.officeHung" : "diag.officeHealthy";
      metricParams.running = String(mb(0, 3));
      metricParams.hung = needsAttention ? "1" : "0";
      break;
    case "clear-teams-outlook-cache":
      metricKey = needsAttention ? "diag.cacheOver" : "diag.cacheUnder";
      metricParams.mb = String(mb(80, 1400));
      break;
    case "reclaim-wsl-docker-ram":
      metricKey = needsAttention ? "diag.wslHolding" : "diag.wslIdle";
      metricParams.percent = "71.0";
      metricParams.usedMb = "11600";
      metricParams.totalMb = "16384";
      metricParams.vmmemMb = needsAttention ? String(mb(2400, 6000)) : "0";
      break;
    case "windows-update-scan":
      metricKey = needsAttention ? "diag.updateNeverScanned" : "diag.updateLastScan";
      metricParams.lastScan = nowIso();
      break;
    case "dism-restore-health":
      metricKey = "diag.cbsAge";
      metricParams.days = String(mb(0, 40));
      break;
    case "sfc-system-scan":
      metricKey = "diag.sfc";
      break;
    case "winget-upgrade-all":
      metricKey = "diag.toolPresent";
      metricParams.program = "winget.exe";
      metricParams.path = "C:\\Users\\*\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe";
      break;
    case "copy-sysadmin-info":
      metricKey = "diag.observationalOnly";
      break;
    default:
      metricKey = "diag.observationalOnly";
      break;
  }

  return {
    actionId: def.id,
    needsAttention,
    severityWeight: def.severityWeight,
    metricKey,
    metricParams,
    reclaimableBytes,
    latencyMs,
    tier: def.tier,
    canRollback: def.tier !== "irreversible",
    readOnly: def.readOnly,
    measuredAtUtc: nowIso(),
  };
}

const SIMULATED_PORTS: PortListener[] = [
  {
    port: 3000,
    protocol: "TCP",
    localAddress: "127.0.0.1",
    pid: 14208,
    processName: "node.exe",
    startTimeUnixMs: Date.now() - 3_600_000,
    commandLineRedacted: "node C:\\work\\api\\server.js --port 3000",
    memoryMb: 148,
    isSelf: false,
  },
  {
    port: 8080,
    protocol: "TCP",
    localAddress: "0.0.0.0",
    pid: 9112,
    processName: "java.exe",
    startTimeUnixMs: Date.now() - 7_200_000,
    commandLineRedacted: "java -jar build\\libs\\service.jar",
    memoryMb: 612,
    isSelf: false,
  },
];

const SIMULATED_HUNG: HungWindow[] = [
  {
    pid: 5512,
    processName: "WINWORD.EXE",
    startTimeUnixMs: Date.now() - 5_400_000,
    windowTitleRaw: "Quarterly report.docx",
    memoryMb: 324,
    hungForMs: 5000,
  },
];

const SIMULATED_JOBS: PrintJob[] = [
  {
    jobId: 42,
    printer: "HP LaserJet Pro",
    document: "Invoice-2026-118.pdf",
    owner: "office",
    pages: 3,
    submittedAtUtc: new Date(Date.now() - 900_000).toISOString(),
  },
];

const SIMULATED_WSL: WslSession[] = [
  { distro: "Ubuntu-24.04", state: "Running", vmMemoryMb: 3412 },
];

export interface SimulatorOptions {
  seed?: number;
  /** Emit a startup notice, so the notice surface is exercised in preview. */
  withNotice?: boolean;
}

export function createSimulator(options: SimulatorOptions = {}): Bridge {
  const random = seeded(options.seed ?? 0x5eed1e);
  const listeners = new Map<EventName, Set<(payload: never) => void>>();

  const reports = new Map<ActionId, DiagnosticReport>();
  for (const def of ACTIONS) {
    reports.set(def.id, simulateReport(def, random));
  }

  const phases: Partial<Record<ActionId, ExecutionOutcome["phase"]>> = {};
  let activeActionId: ActionId | null = null;

  /**
   * The scans and diagnoses currently in flight in the simulation.
   *
   * `cancel("scan")` used to answer `nothing_running` unconditionally, which made
   * the dialog's Stop button a lie: it rendered, it was clickable, and it never
   * stopped anything. The real shell keeps one cancel token per run (DEF-108), so
   * the simulator keeps one record per run and answers the same way. `diagnose`
   * had the same lie and is fixed here for the same reason: a Stop button that
   * cannot stop is worse than no button, because it teaches the user the control
   * is broken.
   */
  const scansInFlight = new Set<{ cancelled: boolean }>();
  let diagnoseInFlight: { cancelled: boolean } | null = null;

  function cancelledError(): IpcError {
    return {
      code: "CANCELLED",
      messageKey: "errors.cancelled",
      remedyKey: "remedy.none",
      params: {},
      correlationId: newId("sim", random),
    };
  }

  /** A wait that notices cancellation, so the simulated Stop is not theatre. */
  async function cancellableDelay(ms: number, record: { cancelled: boolean }): Promise<void> {
    const step = 20;
    let waited = 0;
    while (waited < ms) {
      if (record.cancelled) {
        throw cancelledError();
      }
      const slice = Math.min(step, ms - waited);
      await delay(slice);
      waited += slice;
    }
    if (record.cancelled) {
      throw cancelledError();
    }
  }

  const snapshots: SnapshotRecord[] = [
    {
      snapshotId: "snap-0a1b2c3d4e5f6071",
      actionId: "archive-screenshots",
      createdAtUtc: new Date(Date.now() - 86_400_000).toISOString(),
      tier: "fully_reversible",
      snapshotType: "archive",
      isRestored: false,
      restoredAtUtc: null,
      estBytes: 412 * 1024 * 1024,
      status: "committed",
      // DEF-135: `snapshots.<prefix>` was never a catalogue key, so this row
      // exported a raw key. A snapshot records that an action completed, which
      // is exactly `actions.<prefix>.done`.
      summaryKey: "actions.archiveScreenshots.done",
      summaryParams: {},
    },
    {
      snapshotId: "snap-1122334455667788",
      actionId: "clear-teams-outlook-cache",
      createdAtUtc: new Date(Date.now() - 4 * 86_400_000).toISOString(),
      tier: "fully_reversible",
      snapshotType: "archive",
      isRestored: false,
      restoredAtUtc: null,
      estBytes: 96 * 1024 * 1024,
      status: "committed",
      summaryKey: "actions.clearTeamsOutlookCache.done",
      summaryParams: {},
    },
  ];

  const notices: StartupNotice[] = options.withNotice
    ? [
        {
          id: "sim-notice",
          severity: "info",
          messageKey: "notices.telemetryOff",
          params: {},
        },
      ]
    : [];

  const preferences: Preferences = {
    locale: "tr",
    theme: "obsidian",
    reduceMotion: false,
    telemetryEnabled: false,
  };
  const actionPrefs: ActionPrefs = { pinned: [], hidden: [] };

  const logs: LogLine[] = [];
  let sequence = 0;

  function emit<E extends EventName>(event: E, payload: EventMap[E]): void {
    const set = listeners.get(event);
    if (!set) {
      return;
    }
    for (const handler of set) {
      (handler as (value: EventMap[E]) => void)(payload);
    }
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  function stateSnapshot(): AppStateSnapshot {
    const all = [...reports.values()];
    const junkBytes = all.reduce((sum, report) => sum + report.reclaimableBytes, 0);
    const dns = reports.get("flush-dns-cache")?.latencyMs ?? null;
    const issues = all.filter((report) => report.needsAttention);
    const weightedIssues = issues.reduce(
      (sum, report) => sum + Math.min(3, report.severityWeight) / 3,
      0,
    );

    const memoryUsedMb = 11_600;
    const memoryTotalMb = 16_384;
    const penalty =
      Math.min(45, Math.min(1, junkBytes / (8 * 1024 * 1024 * 1024)) * 45) +
      Math.min(20, Math.max(0, ((dns ?? 0) - 40) / 160) * 20) +
      Math.min(20, Math.max(0, (memoryUsedMb / memoryTotalMb - 0.75) / 0.2) * 20) +
      Math.min(15, (weightedIssues / 6) * 15);

    return {
      locale: preferences.locale,
      theme: preferences.theme,
      reduceMotion: preferences.reduceMotion,
      telemetryEnabled: preferences.telemetryEnabled,
      actionPrefs: { pinned: [...actionPrefs.pinned], hidden: [...actionPrefs.hidden] },
      phases: { ...phases },
      activeActionId,
      lastScanAtUtc: all[0]?.measuredAtUtc ?? null,
      telemetry: {
        healthScore: Math.max(0, Math.min(100, Math.round(100 - penalty))),
        junkBytes,
        dnsLatencyMs: dns,
        memoryUsedMb,
        memoryTotalMb,
        memoryUsedPercent: (memoryUsedMb / memoryTotalMb) * 100,
        issueCount: issues.length,
        issueIds: issues.map((report) => report.actionId),
        osBuild: 26100,
        win10EsuWarning: false,
        measuredAtUtc: nowIso(),
        breakdown: { junk: 0, dns: 0, memory: 0, issues: 0 },
      },
      retention: {
        snapshots: snapshots.length,
        snapshotBytes: snapshots.reduce((sum, row) => sum + row.estBytes, 0),
        auditRows: 37,
      },
      notices,
      sessionUptimeMs: 42_000,
    };
  }

  const notSupported = (what: string): IpcError => ({
    code: "NOT_IMPLEMENTED",
    messageKey: "errors.notImplemented",
    remedyKey: "remedy.updateApp",
    params: { feature: what, mode: "simulation" },
    correlationId: newId("sim", random),
  });

  return {
    native: false,
    kind: "simulator",

    // A browser tab has no window to minimise, so these are honest no-ops
    // rather than simulated state. `isMaximized` answers `false` because the
    // tab cannot be maximised, and the subscription never fires - the same
    // shape a real window has before the user touches it.
    windowControl: {
      minimize: async () => {},
      toggleMaximize: async () => {},
      close: async () => {},
      isMaximized: async () => false,
      onMaximizedChange: async () => () => {},
    },

    appInfo: async (): Promise<AppInfo> => ({
      version: "1.0.0",
      buildCommit: "simulated",
      tauriVersion: "2.12.5",
      webviewVersion: "simulated",
      osBuild: 26100,
      osDisplayVersion: "24H2",
      arch: "x86_64",
      isElevated: false,
      signature: { status: "unsigned" },
      storePath: "C:\\ProgramData\\Vellium\\Zenith",
      storeMode: "machine",
      simulator: true,
    }),

    state: async () => stateSnapshot(),

    diagnose: async (request?: DiagnoseRequest): Promise<DiagnosticReport[]> => {
      const selection = request?.actionIds?.length
        ? request.actionIds
        : ACTIONS.map((def) => def.id);
      const results: DiagnosticReport[] = [];
      // Publishing the run is what makes `cancel("diagnose")` answer honestly.
      // The previous simulator always said `nothing_running`, so the Stop button
      // on the health strip could not stop a diagnosis it was watching.
      const record = { cancelled: false };
      diagnoseInFlight = record;
      try {
        for (const [index, id] of selection.entries()) {
          const def = ACTIONS.find((entry) => entry.id === id);
          if (!def) {
            throw {
              code: "INVALID_ARGUMENT",
              messageKey: "errors.invalidArgument",
              remedyKey: "remedy.checkSelection",
              params: { field: "actionIds" },
              correlationId: newId("sim", random),
            } satisfies IpcError;
          }
          await cancellableDelay(40, record);
          const report = simulateReport(def, random);
          reports.set(def.id, report);
          results.push(report);
          emit("diagnose_progress", {
            v: 1,
            completed: index + 1,
            total: selection.length,
            actionId: def.id,
          });
        }
      } finally {
        if (diagnoseInFlight === record) {
          diagnoseInFlight = null;
        }
      }
      emit("telemetry_update", { v: 1, telemetry: stateSnapshot().telemetry });
      return results;
    },

    execute: async (request: ExecuteRequest): Promise<ExecutionOutcome> => {
      const def = ACTIONS.find((entry) => entry.id === request.actionId);
      if (!def) {
        throw notSupported(`action:${request.actionId}`);
      }
      if (activeActionId) {
        throw {
          code: "ALREADY_RUNNING",
          messageKey: "errors.alreadyRunning",
          remedyKey: "remedy.waitOrCancel",
          params: {},
          correlationId: newId("sim", random),
        } satisfies IpcError;
      }
      if (def.requiresAdmin) {
        // The simulator is not elevated and must not pretend that it is: showing
        // the elevation path is the point of previewing this screen.
        throw {
          code: "ELEVATION_REQUIRED",
          messageKey: "errors.elevationRequired",
          remedyKey: "remedy.restartAsAdmin",
          params: { actionId: def.id },
          correlationId: newId("sim", random),
        } satisfies IpcError;
      }

      activeActionId = def.id;
      phases[def.id] = "running";
      emit("phase_changed", { v: 1, actionId: def.id, phase: "running", atUtc: nowIso() });

      const stepKeys =
        def.tier === "irreversible"
          ? def.id === "empty-recycle-bin"
            ? ["steps.driveEmptied"]
            : ["steps.commandSucceeded"]
          : ["steps.archiveWritten", "steps.originalsRemoved"];

      const steps: StepResult[] = [];
      for (const stepKey of stepKeys) {
        await delay(320);
        sequence += 1;
        const line: LogLine = {
          seq: sequence,
          atUtc: nowIso(),
          level: "info",
          text: `${stepKey} ok`,
          stepKey,
        };
        logs.push(line);
        emit("terminal_log", {
          v: 1,
          actionId: def.id,
          lines: [line],
        });
        steps.push({ stepKey, status: "success", errorCode: null, params: {} });
      }

      const snapshotId =
        def.tier === "irreversible"
          ? null
          : newId("snap", random).replace(/-/g, "").slice(0, 21);

      if (snapshotId) {
        snapshots.unshift({
          snapshotId,
          actionId: def.id,
          createdAtUtc: nowIso(),
          tier: def.tier,
          snapshotType: "archive",
          isRestored: false,
          restoredAtUtc: null,
          estBytes: 64 * 1024 * 1024,
          status: "committed",
          // DEF-135: `snapshots.${def.id}` was never a catalogue key. The
          // snapshot marks the action's completion, so it carries the done key.
          summaryKey: `${def.i18nPrefix}.done`,
          summaryParams: {},
        });
        emit("snapshot_changed", { v: 1, snapshotId, kind: "created" });
      }

      const previous = reports.get(def.id);
      reports.set(def.id, {
        ...(previous ?? simulateReport(def, random)),
        needsAttention: false,
        reclaimableBytes: 0,
        measuredAtUtc: nowIso(),
      });

      phases[def.id] = "success";
      activeActionId = null;
      emit("phase_changed", { v: 1, actionId: def.id, phase: "success", atUtc: nowIso() });

      return {
        actionId: def.id,
        phase: "success",
        success: true,
        durationMs: 960 + Math.round(random() * 900),
        summaryKey: `${def.i18nPrefix}.done`,
        summaryParams: {},
        beforeKey: "outcomes.none",
        beforeParams: {},
        afterKey: "outcomes.none",
        afterParams: {},
        snapshotId,
        tier: def.tier,
        requiresReboot: def.id === "reset-winsock-stack",
        abortable: def.abortable,
        triggerEffect: def.id === "reset-gpu-driver" ? "gpu-reset-flash" : null,
        correlationId: newId("corr", random),
        steps,
      };
    },

    cancel: async (scope): Promise<CancelResult> => {
      if (scope === "diagnose") {
        if (!diagnoseInFlight) {
          return { cancelled: false, reason: "nothing_running" };
        }
        diagnoseInFlight.cancelled = true;
        return { cancelled: true };
      }
      if (scope === "scan") {
        if (scansInFlight.size === 0) {
          return { cancelled: false, reason: "nothing_running" };
        }
        // Every scan in flight, exactly as the shell stops every token in its
        // registry: stopping only the newest would leave the older one running.
        for (const record of scansInFlight) {
          record.cancelled = true;
        }
        return { cancelled: true };
      }
      if (activeActionId === scope) {
        phases[activeActionId] = "cancelled";
        activeActionId = null;
        return { cancelled: true };
      }
      return { cancelled: false, reason: "nothing_running" };
    },

    snapshots: async (limit?: number) => snapshots.slice(0, limit ?? 100),

    rollback: async (snapshotId: string): Promise<RollbackOutcome> => {
      const record = snapshots.find((row) => row.snapshotId === snapshotId);
      if (!record) {
        throw {
          code: "SNAPSHOT_NOT_FOUND",
          messageKey: "errors.snapshotNotFound",
          remedyKey: "remedy.refreshList",
          params: { snapshotId },
          correlationId: newId("sim", random),
        } satisfies IpcError;
      }
      await delay(600);
      record.isRestored = true;
      record.restoredAtUtc = nowIso();
      emit("snapshot_changed", { v: 1, snapshotId, kind: "restored" });
      return {
        snapshotId,
        success: true,
        restoredItems: 128,
        skippedItems: 3,
        skippedReasons: [
          { itemKey: "files/in-use.tmp", reasonCode: "locked" },
          { itemKey: "files/gone.tmp", reasonCode: "missing" },
        ],
        durationMs: 604,
        correlationId: newId("corr", random),
      };
    },

    candidates: async (kind: CandidateKind): Promise<Candidates> => {
      // One record per run, like the shell's one token per run: a second scan
      // must not be able to clear the first one's stop request (DEF-108).
      const record = { cancelled: false };
      scansInFlight.add(record);
      try {
        await cancellableDelay(480, record);
        switch (kind) {
          case "dev_ports":
            return { kind, scannedAtUtc: nowIso(), items: [...SIMULATED_PORTS] };
          case "hung_office":
            return { kind, scannedAtUtc: nowIso(), items: [...SIMULATED_HUNG] };
          case "print_jobs":
            return { kind, scannedAtUtc: nowIso(), items: [...SIMULATED_JOBS] };
          case "wsl":
            return { kind, scannedAtUtc: nowIso(), items: [...SIMULATED_WSL] };
          default:
            throw notSupported(`candidates:${kind}`);
        }
      } finally {
        scansInFlight.delete(record);
      }
    },

    terminate: async (
      _actionId: ActionId,
      targets: VerifiedPidTarget[],
    ): Promise<TerminateSummary> => {
      await delay(420);
      return {
        requested: targets.length,
        terminated: targets.length,
        results: targets.map((target) => ({ pid: target.pid, outcome: "terminated" as const })),
        correlationId: newId("corr", random),
      };
    },

    saveText: async (request: SaveTextRequest): Promise<SavedFile> => {
      if (request.content.length > 2 * 1024 * 1024) {
        throw {
          code: "INVALID_ARGUMENT",
          messageKey: "errors.invalidArgument",
          remedyKey: "remedy.checkSelection",
          params: { field: "content" },
          correlationId: newId("sim", random),
        } satisfies IpcError;
      }
      // A browser has no save dialog wired to a real directory, and inventing a
      // path would be a lie. Return `null`, which the contract already defines
      // as "the user cancelled" - the honest shape for "not saved".
      return { path: null, bytes: 0 };
    },

    supportBundle: async (): Promise<SupportBundle> => {
      await delay(700);
      return {
        path: "C:\\Users\\*\\AppData\\Local\\Vellium\\Zenith\\support\\Zenith-Support-20261119T141200.zip",
        bytes: 84_213,
        includedFiles: ["manifest.json", "audit.json", "snapshots.json", "environment.json"],
        redactionReport: { maskedValues: 12, scrubbedPaths: 8 },
      };
    },

    purge: async (request: PurgeRequest): Promise<PurgeSummary> => {
      if (request.confirmToken !== "PURGE") {
        throw {
          code: "CONFIRMATION_REQUIRED",
          messageKey: "errors.confirmationRequired",
          remedyKey: "remedy.confirmAction",
          params: {},
          correlationId: newId("sim", random),
        } satisfies IpcError;
      }
      await delay(360);
      if (request.scope === "snapshots" || request.scope === "all") {
        snapshots.length = 0;
      }
      return {
        scopes: [request.scope],
        deletedFiles: 24,
        freedBytes: 18 * 1024 * 1024,
        snapshotsRemoved: request.scope === "logs" || request.scope === "support" ? 0 : 2,
        quarantinedKept: 0,
        warnings: [],
      };
    },

    requestElevation: async (_request: HandoverRequest): Promise<void> => {
      throw {
        code: "ELEVATION_HANDOVER_INVALID",
        messageKey: "errors.handoverInvalid",
        remedyKey: "remedy.restartManually",
        params: { reason: "simulation" },
        correlationId: newId("sim", random),
      } satisfies IpcError;
    },

    savePreferences: async (next: PreferencesPatch): Promise<void> => {
      Object.assign(preferences, next);
    },

    actionPrefs: async (next: ActionPrefs): Promise<ActionPrefs> => {
      // Mirror the core's normalisation so simulation and native agree on the
      // result a caller sees: de-duplicate in order, refuse a pinned+hidden id.
      const pinned = next.pinned.filter((id, index) => next.pinned.indexOf(id) === index);
      const hidden = next.hidden.filter((id, index) => next.hidden.indexOf(id) === index);
      const conflict = pinned.find((id) => hidden.includes(id));
      if (conflict) {
        throw {
          code: "INVALID_ARGUMENT",
          messageKey: "errors.invalidArgument",
          remedyKey: "remedy.checkSelection",
          params: { field: "actionPrefs", reason: conflict },
          correlationId: newId("sim", random),
        } satisfies IpcError;
      }
      actionPrefs.pinned = pinned;
      actionPrefs.hidden = hidden;
      return { pinned: [...pinned], hidden: [...hidden] };
    },

    async on<E extends EventName>(
      event: E,
      handler: (payload: EventMap[E]) => void,
    ): Promise<Unlisten> {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const wrapped = handler as (payload: never) => void;
      set.add(wrapped);
      return () => {
        set.delete(wrapped);
      };
    },
  };
}

/** Exported for the palette's "safe preset" affordance in simulation. */
export const SIMULATED_SAFE_PRESET = SAFE_PRESET;

/** The theme list the simulator accepts, kept next to the type it must match. */
export const SIMULATED_THEMES: ThemeId[] = THEME_IDS.filter((id) => id !== "custom");
