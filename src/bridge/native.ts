/**
 * Tauri implementation of [`Bridge`].
 *
 * This is the only module in the application allowed to import
 * `@tauri-apps/api`. Everything above it speaks the interface, which is what
 * lets the simulator exist and what keeps `invoke` names from spreading through
 * components.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type {
  Bridge,
  DiagnoseRequest,
  ActionPrefs,
  EventMap,
  EventName,
  ExecuteRequest,
  HandoverRequest,
  PreferencesPatch,
  PurgeRequest,
  SaveTextRequest,
  Unlisten,
} from "./adapter";
import type { IpcError } from "./types";

/**
 * Tauri rejects with whatever the command returns. Our commands always return
 * `IpcError`, but a panic or a missing command surfaces as a string, and a
 * component that receives a bare string would render `[object Object]`. Normalise
 * here so the error boundary has one shape to handle.
 */
function normalise(error: unknown, command: string): IpcError {
  if (typeof error === "object" && error !== null && "code" in error) {
    return error as IpcError;
  }
  return {
    code: "INTERNAL",
    messageKey: "errors.internal",
    remedyKey: "remedy.createSupportBundle",
    params: { command },
    correlationId: "unavailable",
    detail: typeof error === "string" ? error : String(error),
  };
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw normalise(error, command);
  }
}

export function createNativeBridge(): Bridge {
  const appWindow = getCurrentWindow();

  return {
    native: true,
    kind: "native",

    windowControl: {
      minimize: () => appWindow.minimize(),
      toggleMaximize: () => appWindow.toggleMaximize(),
      close: () => appWindow.close(),
      isMaximized: () => appWindow.isMaximized(),
      onMaximizedChange: async (handler: (maximized: boolean) => void) => {
        // `tauri://resize` is the only event the OS emits for both a button
        // press and the native double click on the drag region, so the button's
        // own icon is driven from the same source of truth that the OS is.
        const unlisten: UnlistenFn = await appWindow.onResized(async () => {
          handler(await appWindow.isMaximized());
        });
        return () => {
          unlisten();
        };
      },
    },

    appInfo: () => call("app_info_get"),
    state: () => call("state_get"),
    diagnose: (request?: DiagnoseRequest) => call("diagnose_run", { request: request ?? {} }),
    execute: (request: ExecuteRequest) => call("action_execute", { request }),
    cancel: (scope) => call("action_cancel", { scope }),
    snapshots: (limit?: number) => call("snapshot_list", { limit }),
    rollback: (snapshotId: string) => call("snapshot_rollback", { snapshotId }),
    candidates: (kind) => call("candidates_scan", { kind }),
    terminate: (actionId, targets) =>
      call("process_terminate", { request: { actionId, targets } }),
    saveText: (request: SaveTextRequest) => call("file_save_text", { request }),
    supportBundle: (note?: string) => call("support_bundle_create", { note: note ?? null }),
    purge: (request: PurgeRequest) => call("app_data_purge", { request }),
    requestElevation: (request: HandoverRequest) => call("elevation_handover", { request }),

    // Settings are persisted by `preferences_set`, which returns the fresh state
    // so the renderer never has to guess what was stored. It is an additive
    // command per `03-04` §9 (adding a command is a patch-level change).
    // The parameter is a patch because that is what the command accepts: every
    // field on the Rust `PreferencesPatch` is `Option`. Typing it as the full
    // `Preferences` would force every caller to resend fields it is not changing,
    // which is how a stale value overwrites a newer one.
    savePreferences: async (patch: PreferencesPatch) => {
      await call("preferences_set", { patch });
    },

    // The core returns the normalised set (deduplicated, validated), so the
    // renderer shows what was stored rather than what it sent.
    actionPrefs: (prefs: ActionPrefs) => call("action_prefs_set", { prefs }),

    async on<E extends EventName>(
      event: E,
      handler: (payload: EventMap[E]) => void,
    ): Promise<Unlisten> {
      const unlisten: UnlistenFn = await listen<EventMap[E]>(event, (message) => {
        // Payloads carry `v`. A future version may add fields; ignoring unknown
        // ones is the compatibility rule (03-04 §9).
        handler(message.payload);
      });
      return () => {
        unlisten();
      };
    },
  };
}
