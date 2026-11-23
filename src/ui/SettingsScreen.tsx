/**
 * Settings.
 *
 * The screen is three groups of leaves, and a leaf's title is derived from its
 * id: `settings.tab.<id>` labels the button *and* heads the panel. That is the
 * "tab title equals tab content" rule made structural - a click can only show
 * the thing it named, because there is no second string to drift.
 *
 * Every control writes through `actions.updateSettings`, which paints
 * optimistically and persists one section. A control never holds a copy of the
 * document: a settings screen that keeps local state is how a debounced save
 * overwrites a field changed in another tab.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch } from "react";

import type { ActionsApi } from "../actions";
import { useT } from "../i18n";
import { deliverNotification } from "../settings/delivery";
import {
  SUPPORTED_LANGUAGES,
  directionOf,
  hasCatalogue,
  languageMeta,
} from "../i18n";
import {
  APP_ICONS,
  NOTIFICATION_KINDS,
  NOTIFICATION_PROFILES,
  channelsForProfile,
  type SectionKey,
} from "../settings/model";
import {
  ensureNativePermission,
  nativeAvailable,
  profileSummaryKey,
} from "../settings/notifications";
import {
  createPinRecord,
  passwordScore,
  PIN_LENGTHS,
} from "../settings/pin";
import {
  SETTINGS_GROUPS,
  adjacentTab,
  isSettingsTab,
  tabLabelKey,
} from "../settings/tabs";
import {
  SHORTCUTS,
  findConflicts,
  formatShortcut,
  normalizeShortcut,
  shortcutFromEvent,
} from "../settings/shortcuts";
import {
  ZOOM_PRESETS,
  COLOR_THEMES,
  getThemeById,
  isValidHexColor,
  normalizeHexColor,
} from "../settings/themes";
import type { AppSettings, SettingsTabId, TrashEntry } from "../settings/types";
import { parseSettings } from "../settings/model";
import type { Action, State } from "../state/store";
import {
  Badge,
  PanelSection,
  Segmented,
  SelectField,
  ToggleRow,
} from "./controls";

type Update = <K extends SectionKey>(
  section: K,
  patch: Partial<AppSettings[K]>,
) => void;

const LAST_SETTINGS_TAB = "zenith.settings.tab";

export function SettingsScreen({
  state,
  dispatch,
  actions,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  actions: ActionsApi;
}) {
  const t = useT();
  const tab = state.settingsTab;
  const navRef = useRef<HTMLDivElement | null>(null);

  const update: Update = (section, patch) => {
    void actions.updateSettings(section, patch);
  };

  // Arrow keys and Ctrl+PageDown/Up move between leaves, the same keys a tab
  // strip uses everywhere else on Windows. Focus follows, so the next Enter
  // opens the panel the user just landed on.
  function onNavKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const delta =
      event.key === "ArrowDown" || event.key === "PageDown"
        ? 1
        : event.key === "ArrowUp" || event.key === "PageUp"
          ? -1
          : 0;
    if (delta === 0) {
      return;
    }
    event.preventDefault();
    const next = adjacentTab(tab, delta);
    dispatch({ type: "settings/tab", tab: next });
    window.localStorage.setItem(LAST_SETTINGS_TAB, next);
    requestAnimationFrame(() => {
      navRef.current?.querySelector<HTMLButtonElement>(`[data-tab='${next}']`)?.focus();
    });
  }

  return (
    <section className="screen screen-settings">
      <header className="screen-head">
        <div>
          <h2>{t("settings.title")}</h2>
          <p className="muted">{t("settings.subtitle")}</p>
        </div>
        {state.settingsRepaired ? (
          <p className="notice notice-warn" role="status">
            {t("settings.repaired")}
          </p>
        ) : null}
      </header>

      <div className="set-shell">
        <div
          ref={navRef}
          className="set-nav"
          role="tablist"
          aria-orientation="vertical"
          aria-label={t("settings.title")}
          onKeyDown={onNavKeyDown}
        >
          {SETTINGS_GROUPS.map((group) => (
            <div key={group.id} className="set-nav-group">
              <p className="set-nav-title">{t(group.labelKey)}</p>
              {group.tabs.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  data-tab={id}
                  id={`settings-tab-${id}`}
                  aria-selected={tab === id}
                  aria-controls={`settings-panel-${id}`}
                  tabIndex={tab === id ? 0 : -1}
                  className={`set-nav-item ${tab === id ? "is-active" : ""}`}
                  onClick={() => {
                    dispatch({ type: "settings/tab", tab: id });
                    window.localStorage.setItem(LAST_SETTINGS_TAB, id);
                  }}
                >
                  {t(tabLabelKey(id))}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div
          className="set-panel"
          role="tabpanel"
          id={`settings-panel-${tab}`}
          aria-labelledby={`settings-tab-${tab}`}
        >
          <h3 className="set-panel-title">{t(tabLabelKey(tab))}</h3>
          <SettingsPanel tab={tab} state={state} actions={actions} dispatch={dispatch} update={update} />
        </div>
      </div>
    </section>
  );
}

/** Restore the last visited leaf; ignoring a stale value is not an error. */
export function lastSettingsTab(fallback: SettingsTabId): SettingsTabId {
  if (typeof window === "undefined") {
    return fallback;
  }
  const stored = window.localStorage.getItem(LAST_SETTINGS_TAB);
  return isSettingsTab(stored) ? stored : fallback;
}

function SettingsPanel({
  tab,
  state,
  actions,
  dispatch,
  update,
}: {
  tab: SettingsTabId;
  state: State;
  actions: ActionsApi;
  dispatch: Dispatch<Action>;
  update: Update;
}) {
  switch (tab) {
    case "appearance":
      return <AppearancePanel state={state} update={update} />;
    case "accessibility":
      return <AccessibilityPanel state={state} update={update} />;
    case "general":
      return <GeneralPanel state={state} actions={actions} update={update} />;
    case "language":
      return <LanguagePanel state={state} actions={actions} update={update} />;
    case "shortcuts":
      return <ShortcutsPanel state={state} update={update} />;
    case "notifications":
      return <NotificationsPanel state={state} actions={actions} update={update} />;
    case "data":
      return <DataPanel state={state} actions={actions} dispatch={dispatch} update={update} />;
    case "trash":
      return <TrashPanel state={state} actions={actions} />;
    case "cli":
      return <CliPanel state={state} update={update} />;
    case "webhook":
      return <WebhookPanel state={state} update={update} />;
    case "legal":
      return <LegalPanel state={state} />;
    case "about":
      return <AboutPanel state={state} actions={actions} update={update} />;
    default:
      return null;
  }
}

/* -------------------------------------------------------------- appearance */

function AppearancePanel({ state, update }: { state: State; update: Update }) {
  const t = useT();
  const appearance = state.settings.appearance;
  const [hex, setHex] = useState(appearance.customColor);
  const hexValid = isValidHexColor(hex);

  useEffect(() => {
    setHex(appearance.customColor);
  }, [appearance.customColor]);

  return (
    <>
      <Segmented
        label={t("theme.mode")}
        value={appearance.mode}
        options={[
          { value: "system", label: t("theme.mode.system") },
          { value: "light", label: t("theme.mode.light") },
          { value: "dark", label: t("theme.mode.dark") },
        ]}
        onChange={(mode) => update("appearance", { mode })}
      />
      <p className="set-hint">{t("theme.mode.systemHint")}</p>

      <PanelSection title={t("theme.paletteGallery")} description={t("theme.zoomHint")}>
        <div className="palette-grid">
          {COLOR_THEMES.map((palette) => (
            <button
              key={palette.id}
              type="button"
              className={`palette-card ${appearance.themeId === palette.id ? "is-active" : ""}`}
              aria-pressed={appearance.themeId === palette.id}
              aria-label={t("theme.swatch", { name: t(`theme.${palette.id}` as Parameters<typeof t>[0]) })}
              onClick={() => update("appearance", { themeId: palette.id })}
            >
              <span className="palette-swatch" aria-hidden="true">
                <span style={{ background: palette.swatch }} />
                <span style={{ background: palette.light.surface }} />
                <span style={{ background: palette.light.textPrimary }} />
              </span>
              <span className="palette-name">{t(`theme.${palette.id}` as Parameters<typeof t>[0])}</span>
            </button>
          ))}
          <button
            type="button"
            className={`palette-card ${appearance.themeId === "custom" ? "is-active" : ""}`}
            aria-pressed={appearance.themeId === "custom"}
            onClick={() => update("appearance", { themeId: "custom" })}
          >
            <span className="palette-swatch" aria-hidden="true">
              <span style={{ background: appearance.customColor }} />
            </span>
            <span className="palette-name">{t("theme.custom")}</span>
          </button>
        </div>
      </PanelSection>

      <PanelSection title={t("theme.customAccent")} description={t("theme.customHint")}>
        <div className="set-inline">
          <input
            className="set-input set-input-hex"
            value={hex}
            spellCheck={false}
            aria-label={t("theme.customAccent")}
            onChange={(event) => {
              const next = event.target.value;
              setHex(next);
              const normalized = normalizeHexColor(next);
              if (normalized) {
                update("appearance", { customColor: normalized, themeId: "custom" });
              }
            }}
          />
          <span
            className="hex-preview"
            aria-hidden="true"
            style={{ background: hexValid ? (normalizeHexColor(hex) ?? "#000000") : "transparent" }}
          />
        </div>
        {!hexValid ? <p className="set-hint set-hint-warn">{t("theme.customInvalid")}</p> : null}
      </PanelSection>

      <SelectField
        label={t("theme.icon")}
        value={appearance.appIcon}
        options={APP_ICONS.map((icon) => ({
          value: icon,
          label: t(`theme.icon.${icon === "match-theme" ? "matchTheme" : icon === "mono-dark" ? "monoDark" : icon === "mono-light" ? "monoLight" : "accent"}` as Parameters<typeof t>[0]),
        }))}
        onChange={(appIcon) => update("appearance", { appIcon })}
      />

      <SelectField
        label={t("theme.zoom")}
        value={String(appearance.zoomPercent) as `${number}`}
        options={ZOOM_PRESETS.map((zoom) => ({ value: String(zoom) as `${number}`, label: `${zoom}%` }))}
        onChange={(zoom) => update("appearance", { zoomPercent: Number(zoom) })}
        hint={t("theme.zoomHint")}
      />

      <PanelSection title={t("theme.preview")}>
        <div className="theme-preview" data-theme-preview={appearance.themeId}>
          <strong>{getThemeById(appearance.themeId === "custom" ? "obsidian" : appearance.themeId).id}</strong>
          <p>{t("theme.previewBody")}</p>
          <p className="muted">{t("theme.previewMuted")}</p>
        </div>
      </PanelSection>

      <button
        type="button"
        className="btn btn-quiet"
        onClick={() =>
          update("appearance", {
            themeId: "obsidian",
            mode: "system",
            customColor: "#2563eb",
            zoomPercent: 100,
            highContrast: false,
            reducedMotion: false,
            appIcon: "match-theme",
          })
        }
      >
        {t("theme.reset")}
      </button>
    </>
  );
}

/* ----------------------------------------------------------- accessibility */

function AccessibilityPanel({ state, update }: { state: State; update: Update }) {
  const t = useT();
  const appearance = state.settings.appearance;
  return (
    <>
      <p className="set-hint">{t("a11y.subtitle")}</p>
      <ToggleRow
        label={t("a11y.highContrast")}
        description={t("a11y.highContrastDesc")}
        checked={appearance.highContrast}
        onChange={(highContrast) => update("appearance", { highContrast })}
      />
      <ToggleRow
        label={t("a11y.reducedMotion")}
        description={t("a11y.reducedMotionDesc")}
        checked={appearance.reducedMotion}
        onChange={(reducedMotion) => update("appearance", { reducedMotion })}
      />
      <SelectField
        label={t("a11y.zoom")}
        value={String(appearance.zoomPercent) as `${number}`}
        options={ZOOM_PRESETS.map((zoom) => ({ value: String(zoom) as `${number}`, label: `${zoom}%` }))}
        onChange={(zoom) => update("appearance", { zoomPercent: Number(zoom) })}
        hint={t("a11y.zoomDesc")}
      />
      <PanelSection title={t("a11y.focus")} description={t("a11y.focusDesc")}>
        <p className="set-hint">{t("context.hint")}</p>
      </PanelSection>
    </>
  );
}

/* ------------------------------------------------------------------ general */

function GeneralPanel({
  state,
  actions,
  update,
}: {
  state: State;
  actions: ActionsApi;
  update: Update;
}) {
  const t = useT();
  const general = state.settings.general;
  return (
    <>
      <SelectField
        label={t("general.closeBehavior")}
        value={general.closeBehavior}
        options={[
          { value: "ask", label: t("general.close.ask") },
          { value: "tray", label: t("general.close.tray") },
          { value: "quit", label: t("general.close.quit") },
        ]}
        onChange={(closeBehavior) => update("general", { closeBehavior })}
      />
      <ToggleRow
        label={t("general.launchAtStartup")}
        description={t("general.launchAtStartupDesc")}
        checked={general.launchAtStartup}
        onChange={(launchAtStartup) => update("general", { launchAtStartup })}
      />
      <ToggleRow
        label={t("general.dragLock")}
        description={t("general.dragLockDesc")}
        checked={general.dragDropLocked}
        onChange={(dragDropLocked) => update("general", { dragDropLocked })}
      />
      <div className="set-grid-2">
        <SelectField
          label={t("general.clock")}
          value={general.clockFormat}
          options={[
            { value: "auto", label: t("general.clock.auto") },
            { value: "12h", label: t("general.clock.12h") },
            { value: "24h", label: t("general.clock.24h") },
          ]}
          onChange={(clockFormat) => update("general", { clockFormat })}
        />
        <SelectField
          label={t("general.date")}
          value={general.dateFormat}
          options={[
            { value: "auto", label: t("general.date.auto") },
            { value: "iso", label: t("general.date.iso") },
            { value: "dmy", label: t("general.date.dmy") },
            { value: "mdy", label: t("general.date.mdy") },
          ]}
          onChange={(dateFormat) => update("general", { dateFormat })}
        />
      </div>
      <ToggleRow
        label={t("general.confirmDestructive")}
        description={t("general.confirmDestructiveDesc")}
        checked={general.confirmDestructive}
        onChange={(confirmDestructive) => update("general", { confirmDestructive })}
      />
      <LockSection state={state} actions={actions} update={update} />
    </>
  );
}

/* ----------------------------------------------------------------- app lock */

function LockSection({
  state,
  actions,
  update,
}: {
  state: State;
  actions: ActionsApi;
  update: Update;
}) {
  const t = useT();
  const security = state.settings.security;
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"pin" | "password">("pin");
  const [digits, setDigits] = useState<4 | 6 | 8>(4);
  const [secret, setSecret] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (secret !== confirm) {
      setError(t("pin.mismatch"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const record = await createPinRecord(secret, kind, digits);
      update("security", { pin: record });
      setOpen(false);
      setSecret("");
      setConfirm("");
      actions.toast({ tone: "success", titleKey: "pin.enabled" });
    } catch {
      setError(kind === "pin" ? t("pin.wrongLength") : t("pin.weak"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PanelSection title={t("pin.title")} description={t("pin.subtitle")}>
      {security.pin ? (
        <div className="set-inline set-inline-between">
          <span className="badge" lang="en">
            {security.pin.kind === "pin" ? `${security.pin.digits}-${t("pin.kind.pin")}` : t("pin.kind.password")}
          </span>
          <div className="set-inline">
            <button type="button" className="btn btn-quiet" onClick={() => actions.lock()}>
              {t("pin.lockNow")}
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                update("security", { pin: null });
                actions.toast({ tone: "info", titleKey: "pin.removed" });
              }}
            >
              {t("pin.remove")}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn" onClick={() => setOpen(!open)}>
          {t("pin.setup")}
        </button>
      )}

      {open ? (
        <div className="set-form">
          <div className="set-grid-2">
            <SelectField
              label={t("pin.kind")}
              value={kind}
              options={[
                { value: "pin", label: t("pin.kind.pin") },
                { value: "password", label: t("pin.kind.password") },
              ]}
              onChange={(next) => setKind(next)}
            />
            {kind === "pin" ? (
              <SelectField
                label={t("pin.digits")}
                value={String(digits)}
                options={PIN_LENGTHS.map((value) => ({ value: String(value), label: String(value) }))}
                onChange={(value) => setDigits(Number(value) as 4 | 6 | 8)}
              />
            ) : null}
          </div>
          <label className="set-field">
            <span className="set-label">{kind === "pin" ? t("pin.enter") : t("pin.enterPassword")}</span>
            <input
              className="set-input"
              type="password"
              inputMode={kind === "pin" ? "numeric" : undefined}
              autoComplete="new-password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
          </label>
          {kind === "password" ? (
            <p className="set-hint">{`${t("pin.weak")} (${passwordScore(secret)}/4)`}</p>
          ) : null}
          <label className="set-field">
            <span className="set-label">{t("pin.confirm")}</span>
            <input
              className="set-input"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </label>
          {error ? <p className="set-hint set-hint-warn" role="alert">{error}</p> : null}
          <button type="button" className="btn" disabled={busy || !secret} onClick={() => void save()}>
            {t("pin.setup")}
          </button>
        </div>
      ) : null}

      <ToggleRow
        label={t("pin.lockOnMinimize")}
        checked={security.lockOnMinimize}
        onChange={(lockOnMinimize) => update("security", { lockOnMinimize })}
      />
      <SelectField
        label={t("pin.autoLock")}
        value={String(security.lockTimeoutMinutes)}
        options={[0, 1, 5, 10, 15, 30, 60].map((minutes) => ({
          value: String(minutes),
          label: minutes === 0 ? t("notify.disabled") : t("pin.minutes", { count: minutes }),
        }))}
        onChange={(value) => update("security", { lockTimeoutMinutes: Number(value) })}
        hint={t("pin.autoLockDesc")}
      />
      {security.pin ? <p className="set-hint">{t("pin.forgot")}</p> : null}
    </PanelSection>
  );
}

/* ----------------------------------------------------------------- language */

function LanguagePanel({
  state,
  actions,
  update,
}: {
  state: State;
  actions: ActionsApi;
  update: Update;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const current = state.settings.general.locale;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return SUPPORTED_LANGUAGES;
    }
    return SUPPORTED_LANGUAGES.filter(
      (language) =>
        language.nativeName.toLowerCase().includes(needle) ||
        language.englishName.toLowerCase().includes(needle) ||
        language.code.toLowerCase().includes(needle),
    );
  }, [query]);

  function choose(locale: string) {
    update("general", { locale });
    actions.toast({ tone: "info", titleKey: "general.languageChanged" });
  }

  return (
    <>
      <p className="set-hint">{t("language.subtitle")}</p>
      <label className="set-field">
        <span className="set-label">{t("language.search")}</span>
        <input
          className="set-input"
          type="search"
          value={query}
          placeholder={t("language.search")}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <p className="set-hint" aria-live="polite">{t("language.count", { count: filtered.length })}</p>
      <div className="language-grid" role="listbox" aria-label={t("palette.locale")}>
        {filtered.map((language) => {
          const active = language.code === current;
          const full = hasCatalogue(language.code);
          return (
            <button
              key={language.code}
              type="button"
              role="option"
              aria-selected={active}
              className={`language-item ${active ? "is-active" : ""}`}
              onClick={() => choose(language.code)}
              aria-label={t("language.select", { name: language.nativeName })}
            >
              <span className="language-name" lang={language.code} dir={language.dir}>
                {language.nativeName}
              </span>
              <span className="language-meta">
                {language.englishName}
                {language.dir === "rtl" ? <Badge>{t("language.rtl")}</Badge> : null}
                <span className={`language-badge ${full ? "is-full" : ""}`}>
                  {full ? t("language.full") : t("language.chromeOnly")}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {filtered.length === 0 ? <p className="set-hint">{t("language.noMatch")}</p> : null}
      <p className="set-hint">
        <Badge>{languageMeta(current).englishName}</Badge> {t("language.current")}:{" "}
        {languageMeta(current).nativeName}
        {directionOf(current) === "rtl" ? ` (${t("language.rtl")})` : ""}
      </p>
    </>
  );
}

/* ---------------------------------------------------------------- shortcuts */

function ShortcutsPanel({ state, update }: { state: State; update: Update }) {
  const t = useT();
  const bindings = state.settings.shortcuts;
  const conflicts = findConflicts(bindings);
  const [recording, setRecording] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const conflictIds = useMemo(() => {
    const set = new Set<string>();
    for (const conflict of conflicts) {
      set.add(conflict.id);
      set.add(conflict.otherId);
    }
    return set;
  }, [conflicts]);

  function commit(id: string, keys: string) {
    if (!keys) {
      setRecording(null);
      return;
    }
    const duplicate = Object.entries(bindings).find(
      ([other, value]) => other !== id && normalizeShortcut(value) === keys,
    );
    if (duplicate) {
      setWarning(t("shortcuts.duplicate"));
      setRecording(null);
      return;
    }
    setWarning(null);
    setRecording(null);
    update("shortcuts", { [id]: keys } as Partial<Record<string, string>>);
  }

  return (
    <>
      <p className="set-hint">{t("shortcuts.subtitle")}</p>
      {warning ? <p className="set-hint set-hint-warn" role="alert">{warning}</p> : null}
      {(["navigation", "actions", "view", "help"] as const).map((group) => (
        <PanelSection key={group} title={t(`shortcuts.group.${group}` as Parameters<typeof t>[0])}>
          <div className="shortcut-list">
            {SHORTCUTS.filter((shortcut) => shortcut.group === group).map((shortcut) => {
              const keys = bindings[shortcut.id] ?? shortcut.defaultKeys;
              const isRecording = recording === shortcut.id;
              const conflicted = conflictIds.has(shortcut.id);
              return (
                <div key={shortcut.id} className="shortcut-row">
                  <span className="set-row-label">{t(shortcut.labelKey as Parameters<typeof t>[0])}</span>
                  <div className="set-inline">
                    {conflicted ? <span className="badge badge-warn">{t("shortcuts.conflictShort")}</span> : null}
                    <button
                      type="button"
                      className={`keycap ${isRecording ? "is-recording" : ""}`}
                      aria-label={t("shortcuts.record")}
                      onClick={() => {
                        setWarning(null);
                        setRecording(isRecording ? null : shortcut.id);
                      }}
                      onKeyDown={(event) => {
                        if (!isRecording) {
                          return;
                        }
                        event.preventDefault();
                        event.stopPropagation();
                        if (event.key === "Escape") {
                          setRecording(null);
                          return;
                        }
                        commit(shortcut.id, shortcutFromEvent(event));
                      }}
                    >
                      {isRecording ? t("shortcuts.recording") : formatShortcut(keys)}
                    </button>
                    <button
                      type="button"
                      className="btn btn-quiet btn-small"
                      aria-label={t("shortcuts.reset")}
                      onClick={() => commit(shortcut.id, shortcut.defaultKeys)}
                    >
                      {t("shortcuts.reset")}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </PanelSection>
      ))}
      <button
        type="button"
        className="btn btn-quiet"
        onClick={() =>
          update(
            "shortcuts",
            Object.fromEntries(SHORTCUTS.map((shortcut) => [shortcut.id, shortcut.defaultKeys])),
          )
        }
      >
        {t("shortcuts.resetAll")}
      </button>
    </>
  );
}

/* ------------------------------------------------------------ notifications */

function NotificationsPanel({
  state,
  actions,
  update,
}: {
  state: State;
  actions: ActionsApi;
  update: Update;
}) {
  const t = useT();
  const notifications = state.settings.notifications;
  const [native, setNative] = useState<"granted" | "denied" | "unsupported" | "unknown">("unknown");
  const [testResult, setTestResult] = useState<
    "notify.testSent" | "notify.testQuieted" | "notify.testSuppressed" | "notify.testUnsupported" | null
  >(null);

  useEffect(() => {
    if (!nativeAvailable()) {
      setNative("unsupported");
      return;
    }
    setNative(Notification.permission === "granted" ? "granted" : Notification.permission === "denied" ? "denied" : "unknown");
  }, []);

  const nativeDisabled = native === "denied" || native === "unsupported";

  return (
    <>
      <p className="set-hint">{t("notify.subtitle")}</p>
      <div className="card-grid">
        {NOTIFICATION_PROFILES.map((profile) => (
          <button
            key={profile}
            type="button"
            className={`choice-card ${notifications.profile === profile ? "is-active" : ""}`}
            aria-pressed={notifications.profile === profile}
            onClick={() =>
              update("notifications", { profile, channels: channelsForProfile(profile) })
            }
          >
            <strong>{t(`notify.profile.${profile}` as Parameters<typeof t>[0])}</strong>
            <span className="set-hint">{t(profileSummaryKey(profile) as Parameters<typeof t>[0])}</span>
          </button>
        ))}
      </div>

      <PanelSection title={t("notify.matrix")} description={t("notify.matrixHint")}>
        {nativeDisabled ? <p className="set-hint set-hint-warn">{t("notify.channelUnavailable")}</p> : null}
        <div className="matrix">
          {NOTIFICATION_KINDS.map((kind) => (
            <div key={kind} className="matrix-row">
              <span className="set-row-label">{t(`notify.kind.${kind}` as Parameters<typeof t>[0])}</span>
              <SelectField
                label={t(`notify.kind.${kind}` as Parameters<typeof t>[0])}
                hideLabel
                value={notifications.channels[kind]}
                options={(["in-app", "native", "both", "none"] as const).map((channel) => ({
                  value: channel,
                  label: t(`notify.channel.${channel}` as Parameters<typeof t>[0]),
                }))}
                onChange={(channel) => {
                  if ((channel === "native" || channel === "both") && nativeDisabled) {
                    return;
                  }
                  update("notifications", {
                    channels: { ...notifications.channels, [kind]: channel },
                  });
                }}
              />
            </div>
          ))}
        </div>
      </PanelSection>

      <PanelSection title={t("notify.quiet")} description={t("notify.quietDesc")}>
        <div className="set-grid-2">
          <label className="set-field">
            <span className="set-label">{t("notify.quietStart")}</span>
            <input
              className="set-input"
              type="time"
              value={notifications.quietHoursStart}
              onChange={(event) => update("notifications", { quietHoursStart: event.target.value })}
            />
          </label>
          <label className="set-field">
            <span className="set-label">{t("notify.quietEnd")}</span>
            <input
              className="set-input"
              type="time"
              value={notifications.quietHoursEnd}
              onChange={(event) => update("notifications", { quietHoursEnd: event.target.value })}
            />
          </label>
        </div>
      </PanelSection>

      <SelectField
        label={t("notify.reminderLead")}
        value={String(notifications.reminderLeadMinutes)}
        options={[0, 5, 10, 15, 30, 60].map((minutes) => ({
          value: String(minutes),
          label: t("notify.minutes", { count: minutes }),
        }))}
        onChange={(value) => update("notifications", { reminderLeadMinutes: Number(value) })}
        hint={t("notify.reminderLeadDesc")}
      />
      <ToggleRow
        label={t("notify.sound")}
        description={t("notify.soundDesc")}
        checked={notifications.sound}
        onChange={(sound) => update("notifications", { sound })}
      />
      <button
        type="button"
        className="btn"
        onClick={async () => {
          // The permission prompt only exists for a channel the matrix actually
          // wants. Asking for it on an in-app-only configuration would show a
          // Windows dialog for a surface the user just turned off.
          const wantsNative =
            notifications.channels.system === "native" ||
            notifications.channels.system === "both";
          const permission = wantsNative ? await ensureNativePermission() : "granted";
          if (wantsNative) {
            setNative(permission);
          }
          // One test message through the real router, so the answer describes
          // this configuration rather than a hardcoded toast. The outcome is
          // reported in the user's own language: "sent" is only claimed when a
          // surface actually showed something.
          const outcome = deliverNotification(
            {
              kind: "system",
              titleKey: "notify.toast",
              bodyKey: "notify.testBody",
            },
            {
              settings: notifications,
              locale: state.locale,
              toast: actions.toast,
            },
          );
          setTestResult(
            outcome.inApp || outcome.native
              ? outcome.quieted
                ? "notify.testQuieted"
                : "notify.testSent"
              : outcome.unsupported
                ? "notify.testUnsupported"
                : "notify.testSuppressed",
          );
        }}
      >
        {t("notify.test")}
      </button>
      {testResult ? <p className="set-hint" role="status">{t(testResult)}</p> : null}
    </>
  );
}

/* --------------------------------------------------------------------- data */

function DataPanel({
  state,
  actions,
  dispatch,
  update,
}: {
  state: State;
  actions: ActionsApi;
  dispatch: Dispatch<Action>;
  update: Update;
}) {
  const t = useT();
  const data = state.settings.data;
  const fileRef = useRef<HTMLInputElement | null>(null);

  function exportSettings() {
    const payload = {
      application: "zenith",
      schemaVersion: state.settings.schemaVersion,
      exportedAtUtc: new Date().toISOString(),
      appVersion: state.info?.version ?? "",
      settings: state.settings,
      trash: state.trash,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `zenith-settings-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    actions.toast({ tone: "success", titleKey: "data.exported" });
  }

  async function importSettings(file: File) {
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw) as { settings?: unknown };
      const candidate = parsed.settings ?? parsed;
      const result = parseSettings(JSON.stringify(candidate));
      await actions.replaceSettings(result.settings);
      actions.toast({ tone: "success", titleKey: "data.imported" });
    } catch {
      actions.toast({ tone: "error", titleKey: "data.invalid" });
    }
  }

  return (
    <>
      <p className="set-hint">{t("data.subtitle")}</p>
      <ToggleRow
        label={t("trust.telemetry")}
        description={state.telemetryEnabled ? t("trust.telemetry.on") : t("trust.telemetry.off")}
        checked={state.telemetryEnabled}
        onChange={(telemetryEnabled) => {
          dispatch({ type: "prefs/telemetry", telemetryEnabled });
          void actions.savePreferences({ telemetryEnabled });
        }}
      />
      <div className="set-inline">
        <button type="button" className="btn" onClick={exportSettings}>
          {t("data.export")}
        </button>
        <button type="button" className="btn btn-quiet" onClick={() => fileRef.current?.click()}>
          {t("data.import")}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="visually-hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              void importSettings(file);
            }
            event.target.value = "";
          }}
        />
      </div>
      <p className="set-hint">{t("data.exportDesc")}</p>
      <p className="set-hint">{t("data.importDesc")}</p>

      <ToggleRow
        label={t("data.autoBackup")}
        description={t("data.autoBackupDesc")}
        checked={data.autoBackup}
        onChange={(autoBackup) => update("data", { autoBackup })}
      />
      <label className="set-field">
        <span className="set-label">{t("data.folder")}</span>
        <input
          className="set-input"
          value={data.cloudSyncPath}
          placeholder={t("data.choose")}
          onChange={(event) => update("data", { cloudSyncPath: event.target.value })}
        />
        <span className="set-hint">{t("data.folderDesc")}</span>
      </label>
      <ToggleRow
        label={t("data.includeLogs")}
        description={t("data.includeLogsDesc")}
        checked={data.exportIncludesLogs}
        onChange={(exportIncludesLogs) => update("data", { exportIncludesLogs })}
      />
      <SelectField
        label={t("data.trashDays")}
        value={String(data.trashRetentionDays)}
        options={[7, 14, 30, 60, 90, 180, 365].map((days) => ({
          value: String(days),
          label: t("data.days", { count: days }),
        }))}
        onChange={(value) => update("data", { trashRetentionDays: Number(value) })}
        hint={t("data.trashDaysDesc")}
      />
      <p className="set-hint">{t("data.storage")}</p>
      <button
        type="button"
        className="btn btn-quiet btn-danger"
        onClick={() => {
          const confirmed = window.confirm(t("data.resetConfirm"));
          if (!confirmed) {
            return;
          }
          const fresh = parseSettings(null).settings;
          fresh.security = state.settings.security;
          fresh.onboarding = state.settings.onboarding;
          void actions.replaceSettings(fresh);
        }}
      >
        {t("data.reset")}
      </button>
      <p className="set-hint">{t("data.resetDesc")}</p>
    </>
  );
}

/* -------------------------------------------------------------------- trash */

function TrashPanel({ state, actions }: { state: State; actions: ActionsApi }) {
  const t = useT();
  const entries: TrashEntry[] = state.trash;

  return (
    <>
      <p className="set-hint">{t("trash.subtitle")}</p>
      {entries.length === 0 ? (
        <p className="set-hint">{t("trash.empty")}</p>
      ) : (
        <div className="trash-list">
          {entries.map((entry) => (
            <div key={entry.id} className="trash-row">
              <div>
                <strong>{t(entry.titleKey as Parameters<typeof t>[0], entry.titleParams)}</strong>
                <p className="set-hint">{t("trash.expires", { date: entry.expiresAtUtc.slice(0, 10) })}</p>
              </div>
              <div className="set-inline">
                <button
                  type="button"
                  className="btn btn-quiet btn-small"
                  onClick={() => void actions.restoreFromTrash(entry.id)}
                >
                  {t("trash.restore")}
                </button>
                <button
                  type="button"
                  className="btn btn-quiet btn-small btn-danger"
                  onClick={() => void actions.deleteFromTrash(entry.id)}
                >
                  {t("trash.delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="set-hint">{t("trash.autoNote")}</p>
      {entries.length > 0 ? (
        <button type="button" className="btn btn-quiet btn-danger" onClick={() => void actions.emptyTrash()}>
          {t("trash.emptyAction")}
        </button>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------- cli and mcp */

function CliPanel({ state, update }: { state: State; update: Update }) {
  const t = useT();
  const [copied, setCopied] = useState<string | null>(null);
  const integrations = state.settings.integrations;
  const commands = [
    "zenith --help",
    "zenith diagnose --json",
    "zenith repair --id disk-cleanup --dry-run",
    "zenith --support-bundle",
    "zenith mcp --stdio",
  ];

  function copy(command: string) {
    void navigator.clipboard?.writeText(command).then(() => {
      setCopied(command);
      setTimeout(() => setCopied(null), 1600);
    });
  }

  return (
    <>
      <p className="set-hint">{t("cli.subtitle")}</p>
      <PanelSection title={t("cli.install")} description={t("cli.installDesc")}>
        <ToggleRow
          label={t("cli.install")}
          checked={integrations.cliInstalled}
          onChange={(cliInstalled) => update("integrations", { cliInstalled })}
        />
        {integrations.cliInstalled ? <p className="set-hint">{t("cli.installed")}</p> : null}
      </PanelSection>
      <PanelSection title={t("cli.headless")} description={t("cli.headlessDesc")}>
        <div className="code-list">
          {commands.map((command) => (
            <div key={command} className="code-row">
              <code>{command}</code>
              <button
                type="button"
                className="btn btn-quiet btn-small"
                onClick={() => copy(command)}
                aria-label={`${t("cli.copy")} ${command}`}
              >
                {copied === command ? t("cli.copied") : t("cli.copy")}
              </button>
            </div>
          ))}
        </div>
      </PanelSection>
      <PanelSection title={t("cli.exitCodes")}>
        <ul className="plain-list">
          <li>{t("cli.exit.ok")}</li>
          <li>{t("cli.exit.usage")}</li>
          <li>{t("cli.exit.failed")}</li>
          <li>{t("cli.exit.cancelled")}</li>
          <li>{t("cli.exit.elevation")}</li>
          <li>{t("cli.exit.refused")}</li>
        </ul>
      </PanelSection>
      <PanelSection title={t("mcp.title")} description={t("mcp.subtitle")}>
        <ToggleRow
          label={t("mcp.transport")}
          description={t("mcp.stdio")}
          checked={integrations.mcpEnabled}
          onChange={(mcpEnabled) => update("integrations", { mcpEnabled })}
        />
        <p className="set-hint">{t("mcp.safety")}</p>
        <ul className="plain-list">
          <li>{t("mcp.tool.status")}</li>
          <li>{t("mcp.tool.actions")}</li>
          <li>{t("mcp.tool.diagnose")}</li>
          <li>{t("mcp.tool.snapshots")}</li>
        </ul>
        <div className="code-row">
          <code>zenith mcp --stdio</code>
          <button type="button" className="btn btn-quiet btn-small" onClick={() => copy("zenith mcp --stdio")}>
            {copied === "zenith mcp --stdio" ? t("cli.copied") : t("cli.copy")}
          </button>
        </div>
        <p className="set-hint">{t("mcp.config")}</p>
        <pre className="code-block">{t("mcp.example")}</pre>
      </PanelSection>
    </>
  );
}

/* ----------------------------------------------------------------- webhook */

function WebhookPanel({ state, update }: { state: State; update: Update }) {
  const t = useT();
  const integrations = state.settings.integrations;
  const [url, setUrl] = useState(integrations.webhookUrl);
  const [copied, setCopied] = useState(false);
  const validUrl = /^https:\/\/\S+$/.test(url);
  // The primary verification path is the CLI, because a real delivery needs the
  // DPAPI-protected secret and that never enters the renderer. Printing a
  // synthetic event with --dry-run shows the exact header a receiver must
  // verify; dropping --dry-run performs the same POST on demand.
  const verifyCommand = `zenith webhook --url ${integrations.webhookUrl || "<endpoint>"} --dry-run --json`;

  useEffect(() => {
    setUrl(integrations.webhookUrl);
  }, [integrations.webhookUrl]);

  return (
    <>
      <p className="set-hint">{t("webhook.subtitle")}</p>
      <label className="set-field">
        <span className="set-label">{t("webhook.url")}</span>
        <input
          className="set-input"
          value={url}
          spellCheck={false}
          placeholder="https://"
          onChange={(event) => setUrl(event.target.value)}
          onBlur={() => update("integrations", { webhookUrl: validUrl ? url : "" })}
        />
        <span className="set-hint">{validUrl ? t("webhook.urlHint") : t("webhook.invalidUrl")}</span>
      </label>
      <PanelSection title={t("webhook.events")}>
        {(["completed", "failed", "rollback"] as const).map((event) => (
          <ToggleRow
            key={event}
            label={t(`webhook.event.${event}` as Parameters<typeof t>[0])}
            checked={integrations.webhookEvents.includes(event)}
            onChange={(checked) =>
              update("integrations", {
                webhookEvents: checked
                  ? [...integrations.webhookEvents, event]
                  : integrations.webhookEvents.filter((item) => item !== event),
              })
            }
          />
        ))}
      </PanelSection>
      <ToggleRow
        label={t("webhook.enable")}
        description={t("webhook.retry")}
        checked={integrations.webhookEnabled}
        disabled={!validUrl}
        onChange={(webhookEnabled) => update("integrations", { webhookEnabled })}
      />
      <PanelSection title={t("webhook.signature")} description={t("webhook.signatureDesc")}>
        <p className="set-hint">{t("webhook.payload")}</p>
        <p className="set-hint">{t("webhook.secretNote")}</p>
      </PanelSection>
      <PanelSection title={t("webhook.verify")} description={t("webhook.verifyDesc")}>
        <div className="set-inline">
          <code className="set-code">{verifyCommand}</code>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              void navigator.clipboard?.writeText(verifyCommand).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              });
            }}
          >
            {copied ? t("cli.copied") : t("cli.copy")}
          </button>
        </div>
        <p className="set-hint">{t("webhook.verifyHint")}</p>
      </PanelSection>
    </>
  );
}

/* ------------------------------------------------------------------- legal */

const LEGAL_DOCS = [
  { id: "privacy", file: "privacy.md", key: "legal.privacy" },
  { id: "terms", file: "terms.md", key: "legal.terms" },
  { id: "kvkk", file: "kvkk.md", key: "legal.kvkk" },
  { id: "licenses", file: "licenses.md", key: "legal.licenses" },
  { id: "accessibility", file: "accessibility.md", key: "legal.accessibility" },
  { id: "security", file: "security.md", key: "legal.security" },
  { id: "support", file: "support.md", key: "legal.support" },
  { id: "contributing", file: "contributing.md", key: "legal.contributing" },
  { id: "conduct", file: "conduct.md", key: "legal.conduct" },
  { id: "changelog", file: "changelog.md", key: "legal.changelog" },
] as const;

function LegalPanel({ state }: { state: State }) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setBody(null);
      return;
    }
    let cancelled = false;
    const doc = LEGAL_DOCS.find((entry) => entry.id === open);
    if (!doc) {
      return;
    }
    fetch(`/legal/${doc.file}`)
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error("missing"))))
      .then((text) => {
        if (!cancelled) {
          setBody(text);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBody(t("legal.notFound"));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, t]);

  return (
    <>
      <p className="set-hint">{t("legal.subtitle")}</p>
      <p className="set-hint">{t("legal.version", { version: state.info?.version ?? "" })}</p>
      <div className="legal-grid">
        {LEGAL_DOCS.map((doc) => (
          <button
            key={doc.id}
            type="button"
            className={`choice-card ${open === doc.id ? "is-active" : ""}`}
            aria-pressed={open === doc.id}
            onClick={() => setOpen(open === doc.id ? null : doc.id)}
          >
            <strong>{t(doc.key as Parameters<typeof t>[0])}</strong>
            <span className="set-hint">{t("legal.open")}</span>
          </button>
        ))}
      </div>
      {open ? (
        <article className="legal-reader">
          {body === null ? <p className="set-hint">{t("skeleton.loading")}</p> : <pre>{body}</pre>}
        </article>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------- about */

function AboutPanel({
  state,
  actions,
  update,
}: {
  state: State;
  actions: ActionsApi;
  update: Update;
}) {
  const t = useT();
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const updates = state.settings.updates;

  function compareVersions(left: string, right: string): number {
    const parse = (value: string) =>
      value
        .replace(/^v/, "")
        .split("-")[0]!
        .split(".")
        .map((part) => Number(part) || 0);
    const a = parse(left);
    const b = parse(right);
    for (let index = 0; index < 3; index += 1) {
      const delta = (a[index] ?? 0) - (b[index] ?? 0);
      if (delta !== 0) {
        return delta;
      }
    }
    return 0;
  }

  async function check() {
    if (updates.channel === "store") {
      setMessage(`${t("about.storeManaged")} ${t("update.channel.storeHint")}`);
      return;
    }
    setChecking(true);
    setMessage(null);
    try {
      const response = await fetch(
        "https://api.github.com/repos/emirtdede/zenith/releases/latest",
        { headers: { Accept: "application/vnd.github+json" } },
      );
      if (!response.ok) {
        throw new Error(String(response.status));
      }
      const release = (await response.json()) as { tag_name?: string };
      const latest = release.tag_name ?? "";
      if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(latest)) {
        setMessage(t("update.semver.invalid"));
        return;
      }
      update("updates", { lastCheckedUtc: new Date().toISOString() });
      if (latest && compareVersions(latest, state.info?.version ?? "0.0.0") > 0) {
        setMessage(t("about.available", { version: latest.replace(/^v/, "") }));
      } else {
        setMessage(t("about.upToDate"));
      }
    } catch {
      // A blocked or offline request is not an unimplemented feature: telling
      // the user so sent them looking for a setting that already exists.
      setMessage(t("update.checkFailed"));
    } finally {
      setChecking(false);
    }
  }

  const versionInfo = [
    `${t("app.name")} ${state.info?.version ?? ""}`,
    `${t("about.build")}: ${state.info?.buildCommit ?? ""}`,
    `${t("about.channel")}: ${updates.channel}`,
  ].join("\n");

  return (
    <>
      <p className="set-hint">{t("about.subtitle")}</p>
      <div className="about-grid">
        <div>
          <p className="set-hint">{t("about.version")}</p>
          <strong className="about-version" lang="en">{state.info?.version ?? "-"}</strong>
        </div>
        <div>
          <p className="set-hint">{t("about.build")}</p>
          <strong lang="en">{state.info?.buildCommit ?? "-"}</strong>
        </div>
      </div>
      <SelectField
        label={t("about.channel")}
        value={updates.channel}
        options={[
          { value: "github", label: t("about.channel.github") },
          { value: "store", label: t("about.channel.store") },
        ]}
        onChange={(channel) => {
          update("updates", { channel });
          setMessage(null);
        }}
        hint={t("about.channelDesc")}
      />
      <div className="set-inline">
        <button type="button" className="btn" disabled={checking} onClick={() => void check()}>
          {checking ? t("about.checking") : t("about.check")}
        </button>
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => {
            void navigator.clipboard?.writeText(versionInfo);
            actions.toast({ tone: "success", titleKey: "about.copied" });
          }}
        >
          {t("about.copyInfo")}
        </button>
      </div>
      {message ? <p className="set-hint" role="status">{message}</p> : null}
      <p className="set-hint">{t("about.semverHint")}</p>
      <PanelSection title={t("about.welcome")} description={t("about.welcomeDesc")}>
        <button type="button" className="btn btn-quiet" onClick={() => void actions.finishOnboarding(true)}>
          {t("about.replay")}
        </button>
      </PanelSection>
      <p className="set-hint">{t("about.license")}</p>
    </>
  );
}
