/**
 * The setup and uninstall window.
 *
 * One component, two modes, six states. The window is 640x420 and frameless, so
 * the title bar is the drag handle and the only place a window control exists.
 *
 * The state machine is deliberately explicit rather than derived: the installer
 * has to be able to render any state for a screenshot or a test, and a state
 * that only exists after three seconds of timers is a state nobody photographs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import markUrl from "../../assets/zenith-mark.svg";
import "./setup.css";
import {
  SETUP_LANGUAGES,
  interpolate,
  setupDirection,
  setupStringsFor,
  type SetupStrings,
} from "./setupCopy";

export const APP_NAME = "Zenith";
export const APP_VERSION = "1.0.0";
export const ESTIMATED_SIZE_MB = 18;
export const CLI_COMMAND = "zenith";
export const DEFAULT_INSTALL_DIR = "C:\\Program Files\\Zenith";
export const USER_DATA_DIR = "%LOCALAPPDATA%\\Vellium\\Zenith";

export type SetupMode = "setup" | "uninstall";
export type SetupScreen = "welcome" | "progress" | "done" | "uninstall" | "uninstalled" | "failed";

export interface SetupAppProps {
  mode?: SetupMode;
  screen?: SetupScreen;
  /** `options` is the welcome screen with the options sheet open. */
  sheetOpen?: boolean;
  language?: string;
  /** Frozen percentage for screenshots and tests. */
  progress?: number;
  /** Drive the progress bar with a timer. Off for screenshots. */
  autoplay?: boolean;
  errorDetail?: string;
  oldVersion?: string;
  /** Pre-checked "delete my data" box, for the uninstalled screenshots. */
  deleteData?: boolean;
  /** Called instead of the Tauri window API; tests pass a recorder. */
  onWindowAction?: (action: "minimize" | "close" | "launch") => void;
}

const VARS = {
  app: APP_NAME,
  version: APP_VERSION,
  oldVersion: "0.9.4",
  size: String(ESTIMATED_SIZE_MB),
  dataDir: USER_DATA_DIR,
  cli: CLI_COMMAND,
};

function t(strings: SetupStrings, key: keyof SetupStrings, vars = VARS): string {
  return interpolate(strings[key], vars);
}

/* --------------------------------------------------------------- backdrop --- */

/**
 * Three monochrome radial lights drifting behind the card.
 *
 * `prefers-reduced-motion` draws one static frame and never schedules another:
 * a decorative animation is never worth a vestibular reaction.
 */
function SoftBackdrop() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const context = canvas.getContext?.("2d");
    if (!context) return;

    const reduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const width = 640;
    const height = 420;
    canvas.width = width;
    canvas.height = height;

    const blobs = [
      { x: 0.18, y: 0.22, sx: 0.06, sy: 0.08, ax: 0.21, ay: 0.17, radius: 0.42, alpha: 0.095 },
      { x: 0.86, y: 0.8, sx: 0.05, sy: 0.07, ax: 0.19, ay: 0.23, radius: 0.36, alpha: 0.075 },
      { x: 0.7, y: 0.12, sx: 0.07, sy: 0.06, ax: 0.13, ay: 0.29, radius: 0.28, alpha: 0.06 },
    ];

    const draw = (time: number) => {
      context.clearRect(0, 0, width, height);
      for (const blob of blobs) {
        const cx = width * (blob.x + blob.sx * Math.sin(time * blob.ax + blob.radius));
        const cy = height * (blob.y + blob.sy * Math.cos(time * blob.ay));
        const radius = width * blob.radius;
        const gradient = context.createRadialGradient(cx, cy, 0, cx, cy, radius);
        gradient.addColorStop(0, `rgba(255, 255, 255, ${blob.alpha})`);
        gradient.addColorStop(0.55, `rgba(212, 212, 216, ${blob.alpha * 0.35})`);
        gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(cx, cy, radius, 0, Math.PI * 2);
        context.fill();
      }
    };

    if (reduced) {
      draw(0);
      return;
    }

    let frame = 0;
    let timer = 0;
    const tick = () => {
      draw(frame * 1.1);
      timer = window.setTimeout(tick, 33);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, []);

  return <canvas className="setup-backdrop" ref={ref} width={640} height={420} aria-hidden="true" />;
}

/* ------------------------------------------------------------------- logo --- */

/**
 * The application mark.
 *
 * The wizard renders the same `assets/zenith-mark.svg` the window icon, the
 * taskbar, and the Store tiles are generated from, so the installer can never
 * drift from the shipped brand: one square SVG, rasterised at build time.
 */
function SetupLogo({ size }: { size: number }) {
  return (
    <img
      className="setup-logo"
      src={markUrl}
      width={size}
      height={size}
      alt={APP_NAME}
      draggable={false}
    />
  );
}

function CheckBurst() {
  return (
    <svg
      width={88}
      height={88}
      viewBox="0 0 96 96"
      aria-hidden="true"
      style={{ filter: "drop-shadow(0 8px 20px rgba(0, 0, 0, 0.4))" }}
    >
      <circle cx="48" cy="48" r="42" fill="rgba(255,255,255,0.08)" />
      <circle cx="48" cy="48" r="32" fill="#fafafa" />
      <path
        d="M34 48.5 L43.5 58 L62.5 38.5"
        fill="none"
        stroke="#09090b"
        strokeWidth="5.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* -------------------------------------------------------------- chrome --- */

function ChevronUp() {
  return (
    <svg width={12} height={8} viewBox="0 0 12 8" aria-hidden="true">
      <path d="M1,6 L6,1 L11,6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg width={12} height={8} viewBox="0 0 12 8" aria-hidden="true">
      <path d="M1,1 L6,6 L11,1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function MinimiseIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true">
      <path d="M1,6 L11,6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true">
      <path d="M1,1 L11,11 M11,1 L1,11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/* ---------------------------------------------------------------- screen --- */

export function SetupApp({
  mode = "setup",
  screen,
  sheetOpen = false,
  language = "en",
  progress = 0,
  autoplay = true,
  errorDetail = "",
  oldVersion,
  deleteData: initialDeleteData = false,
  onWindowAction,
}: SetupAppProps) {
  const [activeScreen, setActiveScreen] = useState<SetupScreen>(screen ?? (mode === "uninstall" ? "uninstall" : "welcome"));
  const [sheet, setSheet] = useState(sheetOpen);
  const [locale, setLocale] = useState(language);
  const [percent, setPercent] = useState(progress);
  const [deleteData, setDeleteData] = useState(initialDeleteData);

  const strings = useMemo(() => setupStringsFor(locale), [locale]);
  const dir = setupDirection(locale);
  const vars = useMemo(() => ({ ...VARS, oldVersion: oldVersion ?? VARS.oldVersion }), [oldVersion]);

  const go = useCallback((next: SetupScreen) => {
    setSheet(false);
    setPercent(0);
    setActiveScreen(next);
  }, []);

  // The progress screen advances on its own. A screenshot and a unit test pass
  // `autoplay={false}` and an explicit percentage, so the same component renders
  // a deterministic frame without a timer.
  useEffect(() => {
    if (!autoplay || activeScreen !== "progress") return;
    const timer = window.setInterval(() => {
      setPercent((current) => {
        const next = Math.min(100, current + 4);
        if (next >= 100) {
          window.clearInterval(timer);
          window.setTimeout(() => {
            setActiveScreen(mode === "uninstall" ? "uninstalled" : "done");
          }, 220);
        }
        return next;
      });
    }, 60);
    return () => window.clearInterval(timer);
  }, [activeScreen, autoplay, mode]);

  const windowTitle = mode === "uninstall" ? t(strings, "windowUninstall", vars) : t(strings, "windowSetup", vars);

  const close = () => {
    if (onWindowAction) onWindowAction("close");
  };

  return (
    <div className="setup-viewport">
      <div className="setup-card" dir={dir} lang={locale}>
        <SoftBackdrop />

        <div className="setup-titlebar" data-tauri-drag-region>
          <span className="setup-titlebar-text" data-tauri-drag-region>
            {windowTitle}
          </span>
          <div className="setup-window-controls">
            {mode === "uninstall" ? (
              <select
                className="setup-lang-compact"
                aria-label={t(strings, "language", vars)}
                value={locale}
                onChange={(event) => setLocale(event.target.value)}
              >
                {SETUP_LANGUAGES.map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {entry.nativeName} ({entry.englishName})
                  </option>
                ))}
              </select>
            ) : null}
            <button
              type="button"
              className="setup-window-button"
              aria-label={t(strings, "minimiseWindow", vars)}
              onClick={() => (onWindowAction ? onWindowAction("minimize") : undefined)}
            >
              <MinimiseIcon />
            </button>
            {activeScreen !== "progress" ? (
              <button
                type="button"
                className="setup-window-button is-close"
                aria-label={t(strings, "closeWindow", vars)}
                onClick={close}
              >
                <CloseIcon />
              </button>
            ) : null}
          </div>
        </div>

        {activeScreen === "welcome" ? (
          <div className="setup-state">
            <div className="setup-center">
              <SetupLogo size={96} />
              <h1 className="setup-title">{APP_NAME}</h1>
              <p className="setup-subtitle">
                {oldVersion
                  ? t(strings, "welcomeUpdate", vars)
                  : t(strings, "welcomeInstall", vars)}
              </p>
              <div className="setup-actions">
                <button type="button" className="setup-primary" onClick={() => go("progress")}>
                  {oldVersion ? t(strings, "update", vars) : t(strings, "install", vars)}
                </button>
              </div>
              <button type="button" className="setup-link" onClick={() => setSheet(true)} aria-expanded={sheet}>
                {t(strings, "options", vars)}
                <ChevronUp />
              </button>
            </div>
            <div className="setup-footer">{t(strings, "footer", vars)}</div>
          </div>
        ) : null}

        {activeScreen === "progress" ? (
          <div className="setup-state">
            <div className="setup-center">
              <SetupLogo size={84} />
              <div className="setup-progress-title">
                {mode === "uninstall" ? t(strings, "removing", vars) : t(strings, "installing", vars)}
              </div>
            </div>
            <div className="setup-progress-block">
              <div className="setup-progress-meta">
                <span className="setup-progress-status">
                  {percent < 25
                    ? t(strings, "preparing", vars)
                    : percent < 85
                      ? t(strings, "writing", vars)
                      : t(strings, "finishing", vars)}
                </span>
                <span className="setup-progress-percent">{percent}%</span>
              </div>
              <div
                className="setup-progress-track"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-label={mode === "uninstall" ? t(strings, "removing", vars) : t(strings, "installing", vars)}
              >
                <div className="setup-progress-fill" style={{ width: `${percent}%` }} />
              </div>
            </div>
          </div>
        ) : null}

        {activeScreen === "done" ? (
          <div className="setup-state">
            <div className="setup-center">
              <CheckBurst />
              <h1 className="setup-title is-compact">{t(strings, "doneTitle", vars)}</h1>
              <p className="setup-subtitle">{t(strings, "doneBody", vars)}</p>
            </div>
            <div className="setup-actions">
              <button type="button" className="setup-soft" onClick={close}>
                {t(strings, "close", vars)}
              </button>
              <button
                type="button"
                className="setup-primary"
                onClick={() => (onWindowAction ? onWindowAction("launch") : undefined)}
              >
                {t(strings, "launch", vars)}
              </button>
            </div>
          </div>
        ) : null}

        {activeScreen === "uninstall" ? (
          <div className="setup-state">
            <div className="setup-center">
              <SetupLogo size={72} />
              <h1 className="setup-title is-compact">{t(strings, "uninstallTitle", vars)}</h1>
              <p className="setup-subtitle">{t(strings, "uninstallBody", vars)}</p>
              <div className="setup-inner-card">
                <label className="setup-inner-card-head">
                  <input
                    type="checkbox"
                    checked={deleteData}
                    onChange={(event) => setDeleteData(event.target.checked)}
                  />
                  {t(strings, "dataLabel", vars)}
                </label>
                <p className="setup-inner-card-hint">{t(strings, "dataHint", vars)}</p>
              </div>
            </div>
            <div className="setup-actions">
              <button type="button" className="setup-soft" onClick={close}>
                {t(strings, "cancel", vars)}
              </button>
              <button type="button" className="setup-primary" onClick={() => go("progress")}>
                {t(strings, "uninstall", vars)}
              </button>
            </div>
          </div>
        ) : null}

        {activeScreen === "uninstalled" ? (
          <div className="setup-state">
            <div className="setup-center">
              <CheckBurst />
              <h1 className="setup-title is-compact">{t(strings, "uninstalledTitle", vars)}</h1>
              <p className="setup-subtitle">
                {deleteData ? t(strings, "deletedBody", vars) : t(strings, "keptBody", vars)}
              </p>
            </div>
            <div className="setup-actions">
              <button type="button" className="setup-primary" onClick={close}>
                {t(strings, "close", vars)}
              </button>
            </div>
          </div>
        ) : null}

        {activeScreen === "failed" ? (
          <div className="setup-state">
            <div className="setup-center">
              <div className="setup-error-badge" aria-hidden="true">
                !
              </div>
              <h1 className="setup-title is-compact">{t(strings, "failedTitle", vars)}</h1>
              <p className="setup-subtitle">{t(strings, "failedBody", vars)}</p>
              <div className="setup-error-detail">{errorDetail}</div>
            </div>
            <div className="setup-actions">
              <button
                type="button"
                className="setup-soft"
                onClick={() => {
                  if (typeof navigator !== "undefined" && navigator.clipboard) {
                    void navigator.clipboard.writeText(errorDetail);
                  }
                }}
              >
                {t(strings, "copyDetails", vars)}
              </button>
              <button type="button" className="setup-primary" onClick={close}>
                {t(strings, "close", vars)}
              </button>
            </div>
          </div>
        ) : null}

        <div className={`setup-options${sheet ? " is-open" : ""}`} aria-hidden={!sheet} dir={dir} lang={locale}>
          <div className="setup-options-head">
            <span className="setup-options-title">{t(strings, "options", vars)}</span>
            <button type="button" className="setup-link" onClick={() => setSheet(false)}>
              {t(strings, "hide", vars)}
              <ChevronDown />
            </button>
          </div>
          <div className="setup-options-body">
            <div className="setup-row">
              <span className="setup-row-label">{t(strings, "language", vars)}</span>
              <select
                className="setup-select"
                aria-label={t(strings, "language", vars)}
                value={locale}
                onChange={(event) => setLocale(event.target.value)}
              >
                {SETUP_LANGUAGES.map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {entry.nativeName} ({entry.englishName})
                  </option>
                ))}
              </select>
            </div>
            <div className="setup-group">
              <span className="setup-group-label">{t(strings, "folder", vars)}</span>
              <div className="setup-folder">
                <input
                  className="setup-input"
                  aria-label={t(strings, "folder", vars)}
                  defaultValue={DEFAULT_INSTALL_DIR}
                  dir="ltr"
                />
                <button type="button" className="setup-browse">
                  {t(strings, "browse", vars)}
                </button>
              </div>
            </div>
            <div className="setup-checks">
              <label className="setup-check">
                <input type="checkbox" defaultChecked />
                {t(strings, "desktopShortcut", vars)}
              </label>
              <label className="setup-check">
                <input type="checkbox" defaultChecked />
                {t(strings, "startMenu", vars)}
              </label>
              <label className="setup-check">
                <input type="checkbox" />
                {t(strings, "startup", vars)}
              </label>
              <label className="setup-check">
                <input type="checkbox" defaultChecked />
                {t(strings, "pathEntry", vars)}
              </label>
            </div>
            <p className="setup-hint">{t(strings, "optionsHint", vars)}</p>
          </div>
          <div className="setup-options-foot">
            <span className="setup-options-size">{t(strings, "size", vars)}</span>
            <button type="button" className="setup-primary is-compact" onClick={() => go("progress")}>
              {oldVersion ? t(strings, "update", vars) : t(strings, "install", vars)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Read the launch contract: `?setup=1`, `?uninstall=1`, plus screenshot knobs. */
export function readLaunch(search: string): SetupAppProps {
  const params = new URLSearchParams(search);
  const mode: SetupMode = params.get("uninstall") === "1" ? "uninstall" : "setup";
  const raw = params.get("state");
  const screen =
    raw === "welcome" || raw === "progress" || raw === "done" || raw === "uninstall" || raw === "uninstalled" || raw === "failed"
      ? raw
      : undefined;
  const progress = Number(params.get("progress") ?? "0");
  return {
    mode,
    screen,
    sheetOpen: params.get("state") === "options",
    language: params.get("lang") ?? undefined,
    progress: Number.isFinite(progress) ? Math.min(100, Math.max(0, progress)) : 0,
    autoplay: params.get("state") === "progress" ? false : true,
    deleteData: params.get("delete") === "1",
    errorDetail: params.get("error") ?? "INSTALL_WRITE_DENIED: 0x80070005 (access is denied)",
  };
}
