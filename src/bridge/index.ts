/**
 * Bridge selection.
 *
 * The decision is made once, at boot, and never re-evaluated: a UI that flips
 * between native and simulated mid-session would make "did that actually
 * happen?" unanswerable. If the native host is missing, the simulator is used
 * and `App.shell` shows the non-dismissible badge (REQ-F-107).
 */

import { createContext, useContext } from "react";

import type { Bridge } from "./adapter";
import { createNativeBridge } from "./native";
import { createSimulator } from "./simulator";

export const BridgeContext = createContext<Bridge | null>(null);

export function useBridge(): Bridge {
  const bridge = useContext(BridgeContext);
  if (!bridge) {
    throw new Error("useBridge() outside BridgeContext");
  }
  return bridge;
}

/**
 * Detect the native host without calling into it.
 *
 * Tauri injects `__TAURI_INTERNALS__` into the webview before any app script
 * runs. Checking for that global is the documented way to branch; it costs
 * nothing and it cannot produce a false positive in a browser, because a web
 * page cannot define a property on the window that survives the isolated world.
 */
export function hasNativeHost(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function createBridge(): Bridge {
  if (hasNativeHost()) {
    return createNativeBridge();
  }
  // A notice in preview so the notification surface is reachable without a real
  // recovery event.
  return createSimulator({ withNotice: true });
}
