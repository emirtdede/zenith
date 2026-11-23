/**
 * Renderer entry point.
 *
 * The only module that touches `document`. Everything below receives its data
 * through the bridge and its text through the translator, so a screenshot test
 * and a native run exercise the same components.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { markBootStart } from "./perf";
import "./styles/tokens.css";
import "./styles/app.css";

// Before React is created, so the measurement covers module evaluation and the
// first render, not just the mount call.
markBootStart();

const container = document.getElementById("root");
if (!container) {
  throw new Error("index.html is missing #root");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
