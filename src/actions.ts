/**
 * Every bridge call the UI makes, in one place.
 *
 * Components never call `useBridge()` for a mutation directly: they call a
 * function here, which raises the resulting `IpcError` into the store. That
 * keeps error handling identical across screens and makes "which command runs
 * when I press this?" answerable by reading one file.
 */

import { useCallback, useMemo, useRef } from "react";

import { useBridge } from "./bridge";
import { asIpcError } from "./bridge/adapter";
import type { ActionPrefs, CandidateKind, CancelScope, Preferences } from "./bridge/adapter";
import type {
  ActionId,
  AppStateSnapshot,
  DiagnosticReport,
  ExecutionOutcome,
  SupportBundle,
  TerminateSummary,
  VerifiedPidTarget,
} from "./bridge/types";
import { ACTIONS, FAST_DIAGNOSE_BUDGET_MS, type ActionDef } from "./catalog.generated";
import { auditRows, toCsv, toJson } from "./export";
import { buildTranslator } from "./i18n";
import type { Action, State } from "./state/store";

export interface ActionsApi {
  boot(): Promise<void>;
  refresh(): Promise<void>;
  diagnose(includeSlow?: boolean): Promise<void>;
  cancel(scope: CancelScope): Promise<void>;
  execute(actionId: ActionId, typed?: string): Promise<ExecutionOutcome | null>;
  rollback(snapshotId: string): Promise<void>;
  savePreferences(patch: Partial<Preferences>): Promise<void>;
  setActionPrefs(next: ActionPrefs): Promise<void>;
  togglePin(actionId: ActionId): Promise<void>;
  toggleHidden(actionId: ActionId): Promise<void>;
  elevate(actionId: ActionId): Promise<void>;
  terminate(actionId: ActionId, targets: VerifiedPidTarget[]): Promise<TerminateSummary | null>;
  createBundle(note: string): Promise<SupportBundle | null>;
  purge(scope: "support" | "logs" | "snapshots" | "all", token: string, force: boolean): Promise<void>;
  saveScript(name: string, content: string, format: "ps1" | "bat" | "csv" | "json"): Promise<void>;
  exportAudit(format: "csv" | "json"): Promise<void>;
  scan(kind: CandidateKind): Promise<void>;
}

/**
 * Sequence numbers for lines the shell writes itself.
 *
 * `Date.now()` alone is not monotonic: two dispatches in the same millisecond
 * (a bundle saved and an audit exported) produce the same value, and the
 * contract in `03-04` §4 says `seq` is monotonic per action - a duplicate makes
 * a "gap means dropped batch" reader lie. This keeps the wall clock when it
 * advances and nudges past the last value when it does not.
 */
let uiSeq = 0;
function nextUiSeq(): number {
  uiSeq = Math.max(Date.now(), uiSeq + 1);
  return uiSeq;
}

/** The confirmation word for an irreversible action (`05-02` §4.2). */
export function confirmationWord(def: ActionDef): string {
  if (def.category === "recovery" && def.id === "controlled-reboot") {
    return "RESTART";
  }
  switch (def.id) {
    case "empty-recycle-bin":
      return "DELETE";
    case "close-hung-office":
      return "CLOSE";
    default:
      return "CONFIRM";
  }
}

/** Actions that scan for their targets before they can run. */
export function requiresTargets(actionId: ActionId): CandidateKind | null {
  switch (actionId) {
    case "unlock-dev-ports":
      return "dev_ports";
    case "close-hung-office":
      return "hung_office";
    default:
      return null;
  }
}

export function useActions(state: State, dispatch: (action: Action) => void): ActionsApi {
  const bridge = useBridge();

  // Guards `diagnose()` against a second concurrent call (DEF-121). A ref, not
  // state: the guard must be readable synchronously on the click that fires it,
  // before React has re-rendered, and it must survive the re-creation of the
  // action object below.
  const diagnosing = useRef(false);

  const fail = useCallback(
    (error: unknown) => {
      dispatch({ type: "error/raised", error: asIpcError(error) });
    },
    [dispatch],
  );

  const applyState = useCallback(
    async (snapshot?: AppStateSnapshot) => {
      const next = snapshot ?? (await bridge.state());
      dispatch({ type: "state/replaced", snapshot: next });
    },
    [bridge, dispatch],
  );

  return useMemo(
    () => ({
      async boot() {
        try {
          const [info, snapshot, snapshots] = await Promise.all([
            bridge.appInfo(),
            bridge.state(),
            bridge.snapshots(100),
          ]);
          dispatch({ type: "boot/ready", info, snapshot, snapshots });
        } catch (error) {
          dispatch({ type: "boot/failed", error: asIpcError(error) });
        }
      },

      async refresh() {
        try {
          const [snapshot, snapshots] = await Promise.all([
            bridge.state(),
            bridge.snapshots(100),
          ]);
          dispatch({ type: "state/replaced", snapshot });
          dispatch({ type: "snapshots/replaced", snapshots });
        } catch (error) {
          fail(error);
        }
      },

      async diagnose(includeSlow = true) {
        // One diagnosis at a time, enforced here as well as in the core.
        //
        // `diagnose_run` refuses a second call with ALREADY_RUNNING, but the
        // renderer used to fire it anyway: `Ctrl+D` while a scan was running
        // dispatched `diagnose/started`, which reset the progress bar to 0 and
        // shrank the total to the fast set, then the core's rejection surfaced
        // as an error toast and the `finally` below cleared `state.diagnose` -
        // destroying the progress display of the scan that was still running.
        // A second press must be a no-op, not a lie about the first (DEF-121).
        if (diagnosing.current) {
          return;
        }
        diagnosing.current = true;
        // The threshold is a manifest fact, emitted into the generated
        // catalogue. Typing `3000` here (it used to be a bare literal while the
        // core kept its own copy) meant the progress total could drift from the
        // set the core actually probes - DEF-093.
        const total = ACTIONS.filter(
          (def) => includeSlow || def.diagnoseBudgetMs <= FAST_DIAGNOSE_BUDGET_MS,
        ).length;
        dispatch({ type: "diagnose/started", total });
        try {
          const reports: DiagnosticReport[] = await bridge.diagnose({ includeSlow });
          dispatch({ type: "diagnose/reports", reports });
          dispatch({ type: "telemetry/updated", telemetry: (await bridge.state()).telemetry });
        } catch (error) {
          fail(error);
        } finally {
          diagnosing.current = false;
          dispatch({ type: "diagnose/finished" });
        }
      },

      async cancel(scope) {
        try {
          await bridge.cancel(scope);
        } catch (error) {
          fail(error);
        }
      },

      async execute(actionId, typed) {
        const def = ACTIONS.find((entry) => entry.id === actionId);
        if (!def) {
          return null;
        }
        if (def.requiresAdmin && state.info && !state.info.isElevated) {
          try {
            await bridge.requestElevation({
              resumeQueue: [actionId],
              nextTheme: state.theme,
              locale: state.locale,
            });
            // Native never resolves: the process exits after launching the
            // elevated instance. The simulator rejects, and the error path
            // below reports it honestly.
          } catch (error) {
            fail(error);
          }
          return null;
        }
        try {
          const outcome = await bridge.execute({
            actionId,
            confirmation: {
              acknowledgedTier: def.tier,
              ...(typed ? { typedCount: typed.length } : {}),
            },
          });
          dispatch({
            type: "phase/changed",
            actionId,
            phase: outcome.phase,
          });
          await applyState();
          dispatch({
            type: "snapshots/replaced",
            snapshots: await bridge.snapshots(100),
          });
          return outcome;
        } catch (error) {
          fail(error);
          return null;
        }
      },

      async rollback(snapshotId) {
        try {
          await bridge.rollback(snapshotId);
          dispatch({ type: "snapshots/replaced", snapshots: await bridge.snapshots(100) });
          await applyState();
        } catch (error) {
          fail(error);
        }
      },

      async savePreferences(patch) {
        try {
          // The patch is sent as-is. Merging the whole current preference set in
          // would reintroduce exactly the stale-overwrite bug the patch type
          // exists to prevent.
          await bridge.savePreferences(patch);
          await applyState();
        } catch (error) {
          fail(error);
        }
      },

      async setActionPrefs(next) {
        try {
          // Optimistic: pin/hide is presentation, and the core returns the
          // normalised set a moment later.
          dispatch({ type: "prefs/actionPrefs", actionPrefs: next });
          const stored = await bridge.actionPrefs(next);
          dispatch({ type: "prefs/actionPrefs", actionPrefs: stored });
        } catch (error) {
          fail(error);
        }
      },

      async togglePin(actionId) {
        const current = state.actionPrefs;
        const pinned = current.pinned.includes(actionId)
          ? current.pinned.filter((id) => id !== actionId)
          : [...current.pinned, actionId];
        const hidden = current.hidden.filter((id) => id !== actionId);
        try {
          dispatch({ type: "prefs/actionPrefs", actionPrefs: { pinned, hidden } });
          const stored = await bridge.actionPrefs({ pinned, hidden });
          dispatch({ type: "prefs/actionPrefs", actionPrefs: stored });
        } catch (error) {
          fail(error);
        }
      },

      async toggleHidden(actionId) {
        const current = state.actionPrefs;
        const hidden = current.hidden.includes(actionId)
          ? current.hidden.filter((id) => id !== actionId)
          : [...current.hidden, actionId];
        const pinned = current.pinned.filter((id) => id !== actionId);
        try {
          dispatch({ type: "prefs/actionPrefs", actionPrefs: { pinned, hidden } });
          const stored = await bridge.actionPrefs({ pinned, hidden });
          dispatch({ type: "prefs/actionPrefs", actionPrefs: stored });
        } catch (error) {
          fail(error);
        }
      },

      async elevate(actionId) {
        try {
          await bridge.requestElevation({
            resumeQueue: [actionId],
            nextTheme: state.theme,
            locale: state.locale,
          });
        } catch (error) {
          fail(error);
        }
      },

      async terminate(actionId, targets) {
        try {
          // The dialog stays open and shows the measured outcome: closing on
          // success hid which of the ticked processes were actually stopped
          // (`ports.result`), and a partial result is the normal case.
          const summary = await bridge.terminate(actionId, targets);
          await applyState();
          dispatch({ type: "snapshots/replaced", snapshots: await bridge.snapshots(100) });
          return summary;
        } catch (error) {
          fail(error);
          return null;
        }
      },

      async createBundle(note) {
        try {
          const bundle = await bridge.supportBundle(note.trim() || undefined);
          // The log keeps the raw path for support; the screen renders the
          // localized summary from the catalogue (`trust.bundle.done` and the
          // redaction/contents rows), which is what the user actually reads.
          dispatch({
            type: "log/appended",
            lines: [
              {
                seq: nextUiSeq(),
                atUtc: new Date().toISOString(),
                level: "info",
                text: `support bundle: ${bundle.path}`,
                stepKey: "console.bundleSaved",
                params: { path: bundle.path },
              },
            ],
          });
          return bundle;
        } catch (error) {
          fail(error);
          return null;
        }
      },

      async purge(scope, token, force) {
        try {
          await bridge.purge({ scope, confirmToken: token, force });
          await applyState();
          dispatch({ type: "snapshots/replaced", snapshots: await bridge.snapshots(100) });
        } catch (error) {
          fail(error);
        }
      },

      async saveScript(name, content, format) {
        try {
          await bridge.saveText({ suggestedName: name, content, format });
        } catch (error) {
          fail(error);
        }
      },

      async exportAudit(format) {
        try {
          // DEF-135: the export used to carry raw catalogue keys in its `action`
          // and `summary` columns. Translating here, from the state's active
          // locale, means the file a helpdesk opens reads in the user's language
          // - and the export stays a pure function of state, not of a hook.
          const rows = auditRows(state.snapshots, buildTranslator(state.locale).tKey);
          const stamp = new Date().toISOString().slice(0, 10);
          const request =
            format === "csv"
              ? {
                  suggestedName: `zenith-audit-${stamp}.csv`,
                  content: toCsv(rows),
                  format: "csv" as const,
                }
              : {
                  suggestedName: `zenith-audit-${stamp}.json`,
                  content: toJson(rows, new Date().toISOString()),
                  format: "json" as const,
                };
          const saved = await bridge.saveText(request);
          // A cancelled dialog returns { path: null }. Saying "exported" then
          // would be a lie, so it stays silent and lets the button read as
          // pressed-but-not-saved.
          if (saved.path) {
            dispatch({
              type: "log/appended",
              lines: [
                {
                  seq: nextUiSeq(),
                  atUtc: new Date().toISOString(),
                  level: "info",
                  text: `audit export: ${saved.path}`,
                  stepKey: "console.auditExported",
                  params: { path: saved.path },
                },
              ],
            });
          }
        } catch (error) {
          fail(error);
        }
      },

      async scan(kind) {
        try {
          dispatch({ type: "candidates/open", kind });
        } catch (error) {
          fail(error);
        }
      },
    }),
    [bridge, dispatch, fail, applyState, state],
  );
}
