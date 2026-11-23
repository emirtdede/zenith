/**
 * Setup window entry point.
 *
 * `setup.html` is a second Vite page, not a route inside the main application:
 * the wizard must open before any application state, database handle or IPC
 * command exists, and a 640x420 frameless window should not pay for the shell's
 * boot sequence.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { SetupApp, readLaunch } from "./SetupApp";

const container = document.getElementById("setup-root");
if (!container) {
  throw new Error("setup.html is missing #setup-root");
}

createRoot(container).render(
  <StrictMode>
    <SetupApp {...readLaunch(window.location.search)} />
  </StrictMode>,
);
