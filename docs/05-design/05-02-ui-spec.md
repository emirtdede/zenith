# 05-02 - UI Specification

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-DSN-002 |
| Version | 2.0.0 |
| Owner | Design / Frontend |
| Implementation | `src/App.tsx`, `src/ui/*`, `src/state/store.ts` |
| Closes | DEF-042 (v1.0.0 listed screens but no state, no keyboard, no empty states) |

Every screen, overlay, state and keystroke in the shipped renderer. A reader can diff this document
against `src/ui/` and find nothing missing in either direction - that is the point (Law L2).

---

## 1. Window and layout

| Property | Value | Source |
| :--- | :--- | :--- |
| Default size | 1180 × 780 | `src-tauri/tauri.conf.json` |
| Minimum size | 960 × 640 | same |
| Resizable / centred / decorated | yes / yes / **no** | same |
| Transparency | `false` (a transparent window cannot pass forced-colors) | same |
| Drag-and-drop | disabled (no file drop target exists) | same |
| Layout | two columns: sidebar (six destinations) + workspace (banner → appbar → notices → health → tabs → main → console → statusbar) | `app.css` `.shell`, `.app-sidebar`, `.workspace` |

The window is **undecorated** (`decorations: false`) and draws its own chrome. Before DEF-161 the app kept
the native Windows caption and stacked its own 40px toolbar beneath it, so one window read as two bars;
the `.appbar` row now *replaces* the OS title bar instead of sitting under it. It carries an empty
`data-tauri-drag-region` handle (so the bar moves the window and a double click maximises, as the OS would
have), the privilege badge, the notices control and the three window buttons (`WindowControls.tsx`), which
exist because the OS stopped drawing them. Tauri's own hit-test still resizes the window from every edge,
so removing decorations does not remove resize.

The main region is the only scroll container for **page content** (`.main { overflow: auto }`). The app
bar, health strip and status bar never scroll away, because "what is my score" and "where am I" must be
answerable at every scroll position.

Five further rules in `app.css` declare a scrollable overflow. Four belong to surfaces that are **not
inside `.main`** at all - overlays and the console drawer are siblings of it (`App.tsx`) - so they cannot
nest a scroller in page content. One *is* inside `.main` and is a deliberate appendix. The inventory is
complete on purpose: a reader diffing `app.css` against this table should find nothing unaccounted for.

| Region | Container | Bound | Why it scrolls |
| :--- | :--- | :--- | :--- |
| `.drawer .log` | console drawer - **sibling** of `.main`, itself bounded at `34vh` | `min-height: 0` | The drawer is a fixed-height panel; its log must scroll or the drawer grows past the viewport. This is the one place a log scroll is correct, which is why the scroll lives on `.drawer .log` and **not** on `.log` (DEF-082) |
| `.dialog` | `.overlay` - modal, **outside** `.main` | `max-height: 86vh` | A long confirm/purge dialog must scroll internally rather than exceed the screen; the scrim already blocks the page behind it |
| `.script` | script overlay - **outside** `.main` | `max-height: 300px` | A generated command script is arbitrary length; it scrolls inside its own overlay |
| `.palette-list` | command palette overlay - **outside** `.main` | `max-height: 48vh` | A partial last row is the affordance that says "there is more below" |
| `.licenses-text` | **inside `.main`** (Trust screen) | `max-height: 420px` | The third-party notices are hundreds of kilobytes. Letting them grow the page would push the score and the nav a hundred screens down; they live in a `<details>` the user opens on purpose (`TrustScreen.tsx`) |

Only the last row is a scroller inside page content, and it is bounded and opt-in. Everything else under
`.main` grows and lets the page scroll once. The `.manage-list` panel used to carry
`max-height: 360px; overflow: auto` and was removed for exactly this reason (DEF-077): a 360 px inner
scroller trapped the wheel and the focus ring in a box the user did not ask for, and at 320 CSS px it hid
rows behind a second scrollbar. `ol.log` on the Activity screen carried the same defect and was fixed the
same way (DEF-082).

---

## 2. Screens and overlays

### 2.1 Six screens (`ScreenId`)

| # | Screen | Route value | Purpose | Component |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Actions | `actions` | The 22 action cards, tabs and search | `ActionGrid` + `Tabs` |
| 2 | Activity | `activity` | Full-height streamed log | `ActivityScreen` |
| 3 | Snapshots | `snapshots` | Ledger, rollback, retention line | `SnapshotsScreen` |
| 4 | Trust | `trust` | Build facts (including the measured cold-start time), privacy, bundle, purge, third-party notices | `TrustScreen` |
| 5 | Settings | `settings` | Locale, theme, motion, telemetry, hidden actions | `SettingsScreen` |
| 6 | Help | `help` | Shortcuts, about | `HelpScreen` |

All six screens render into the same `<main id="main">` landmark, which is the skip-link target and the
only scroll container for page content. Screen 1 (`actions`) additionally renders `Tabs` and the
`role="tabpanel"` region: both are children of `#main`, the panel is `#action-panel`, and the `tablist`
is deliberately *not* inside the panel it controls (DEF-161). Navigation is the sidebar rail
(`Sidebar.tsx`, fed by `nav.ts`) or the command palette. `screen/set` also closes any overlay.

The Trust screen ends with a collapsed third-party-notices panel: the count comes from
`resources/licenses/manifest.json`, and the full text is the generated `THIRD-PARTY-NOTICES.txt`
embedded at build time with Vite `?raw`. It is a `<details>` element so the 335 KB file is present but
never in the reading order until the user asks for it (REQ-F-135, `08-02` §7).

### 2.2 Five overlays (`OverlayId`)

| # | Overlay | Trigger | Component |
| :--- | :--- | :--- | :--- |
| 1 | `palette` | `Ctrl K`, toolbar button | `CmdPalette` |
| 2 | `confirm` | Run on a non-target action, or palette action | `ConfirmDialog` |
| 3 | `script` | "Report" / script button on a card | `ScriptDialog` |
| 4 | `candidates` | Run on `unlock-dev-ports` / `close-hung-office` / scan buttons | `CandidatesDialog` |
| 5 | `purge` | Trust → "Delete data" | `PurgeDialog` |

Exactly one overlay can be open (`State.overlay` is a single value, not a stack). `overlay/close`
clears `confirm`, `script` and `candidateKind` together, so a dialog can never outlive its overlay.

Every overlay is `role="dialog" aria-modal="true"` with an accessible name, renders a scrim, closes
when the scrim itself is clicked (`event.target === event.currentTarget`), and closes on `Escape`
handled globally. The first interactive element is focused on mount (`autoFocus`).

---

## 3. Action screen

### 3.1 Tabs

| Tab | Filter | Shows |
| :--- | :--- | :--- |
| All | none | every non-hidden action, pinned first |
| Cleanup | `category = cleanup` | disk / updates |
| Network | `category = network` | DNS / proxy / Winsock / clock |
| Recovery | `category = recovery` | Windows repair / shell / services / GPU |
| Dev & Office | `category = dev_office` | ports / hung apps / caches / WSL |

`role="tablist"` with `role="tab"` and `aria-selected`. The search box is labelled by an `sr-only`
label bound with `htmlFor="action-search"`.

### 3.2 Sorting and filtering rules (single function, testable)

```text
visible = ACTIONS
  .filter(category matches OR "all")
  .filter(NOT hidden OR showHidden)
  .filter(search matches title, description or id, locale-lowercased)
  .sort(pinned by pin order first, then by manifest `order`)
```

Pinned actions keep their pin order, not manifest order. Hiding removes an action from the grid but
never from search results when `showHidden` is on, and never from the palette.

When the result set is empty the grid renders `tabs.search.empty` with the query echoed back - never
a blank area.

### 3.3 The action card

| Region | Content | Contract |
| :--- | :--- | :--- |
| Title | `t(<i18nPrefix>.title)` | from `catalog.generated.ts` |
| Tools | pin, hide (icon buttons) | `aria-pressed` reflects state |
| Description | `t(<i18nPrefix>.desc)` | |
| Metric | last `DiagnosticReport.metricKey` or `card.unknown` | **never** a fabricated `0` |
| Badges | risk, tier, admin, read-only, reboot | `risk-safe/moderate/destructive` classes |
| Status | `t(status.<phase>)` | phases from `EventMap`, not invented |
| Actions | Report, Rollback (only if a committed unrestored snapshot exists), Run/Cancel | |

Card visual state is driven by `phase`: `is-running` (info border), `is-warn`, `is-bad`, `is-ok`.
A card is `tabIndex={0}` and is a keyboard target in its own right; `Arrow` keys move focus between
cards, `Enter` runs the same path as the button.

**State honesty.** If the action requires admin and the session is not elevated, the primary button
reads "Run as administrator" and `execute()` routes to `elevation_handover` rather than attempting the
mutation. If a diagnostic has not run, the metric reads "unknown", never "healthy".

### 3.4 Run paths

| Action kind | First step | Then |
| :--- | :--- | :--- |
| Requires target scan (`unlock-dev-ports`, `close-hung-office`) | `candidates` overlay → `candidates_scan` | selected rows → `process_terminate` |
| Everything else | `confirm` overlay | `action_execute` (or `elevation_handover` when admin is missing) |

`requiresTargets()` in `src/actions.ts` is the single decision point. It returns a `CandidateKind`
or `null`; there is no third path.

---

## 4. Confirmation dialog

### 4.1 Content order

1. Title - `confirm.title` with the action name interpolated.
2. Body - what will happen (`confirm.body`).
3. **Effect** - the action description.
4. **Undo** - `confirm.undo.yes` or `confirm.undo.no`, the latter styled `.danger`.
5. Tier help - `t(tier.<tier>.help)`.
6. Admin note - shown only when `requiresAdmin && !isElevated`.
7. Typed challenge - only for `irreversible`.

### 4.2 Typed-challenge rules

`confirmationWord(def)` returns exactly one token per action class:

| Action | Word |
| :--- | :--- |
| `controlled-reboot` | `RESTART` |
| `empty-recycle-bin` | `DELETE` |
| `close-hung-office` | `CLOSE` |
| any other irreversible | `CONFIRM` |

The input is compared case-insensitively (locale-aware uppercase) against the word. The confirm button
is disabled until it matches, and `aria-invalid` is set the moment the typed text diverges. The button
label names the verb (`confirm.goDestructive`). A reversible action never asks for a typed word - see
§4.3.

### 4.3 What is *not* asked

`fully_reversible` and `partially_reversible` actions show the dialog but do not require typing. Asking
for a typed word on a reversible action trains users to type without reading, which is how a
destructive confirmation becomes muscle memory. The tier determines the friction, and the tier comes
from the manifest, not from a per-screen choice.

---

## 5. Console drawer

| Property | Value |
| :--- | :--- |
| Open | `` ` `` (backtick), status-bar button, or a console chip |
| Close | `` ` ``, "Close", or `Escape` when nothing else is open |
| Height | max 34vh, internally scrollable |
| Buffer | 5,000 lines (`LOG_LIMIT`), oldest dropped first |
| Overflow notice | `console.dropped` prints how many lines fell off |
| Live region | `<ol aria-live="polite">` |
| Actions | Copy all, Clear |

Line classes map to severity: `log-error`, `log-warn`, `log-debug`, everything else default. Each row
is `time | text` in mono, so timestamps align.

The drawer never claims a line exists that the ring dropped: the count is displayed.

---

## 6. Settings screen

| Group | Control | Persisted via |
| :--- | :--- | :--- |
| Language | select (English / Türkçe) | `preferences_set { locale }` |
| Theme | 3 radios | `preferences_set { theme }` |
| Reduce motion | checkbox | `preferences_set { reduceMotion }` |
| Telemetry | checkbox (off by default) | `preferences_set { telemetryEnabled }` |
| Hidden actions | per-action checkbox list | `action_prefs_set` (complete set) |

Pin/hide is optimistic: the reducer updates first, then the core returns the normalised set and the
reducer applies that. The core is always the final authority; a rejected set raises the error toast and
the optimistic state is replaced on the next `state_get`.

`showHidden` is **session-only** (never persisted) - it is a temporary "where did it go" view, not a
preference. That is stated in the UI copy (`card.hiddenBody`).

---

## 7. Keyboard map

| Keys | Action | Scope |
| :--- | :--- | :--- |
| `Ctrl/⌘ K` | Open command palette | global |
| `Ctrl/⌘ D` | Run full diagnosis | global (not while typing) |
| `/` | Focus the search box | global (not while typing) |
| `` ` `` | Toggle console | global (not while typing) |
| `?` | Open Help | global (not while typing) |
| `Esc` | Close overlay → cancel running action → close console | global, in that priority |
| `↑ ↓` | Move palette selection | palette |
| `Enter` | Run palette selection | palette |
| `← ↑ → ↓` | Move focus between cards | grid |
| `Enter` | Open confirm for focused card | grid |
| `Esc` (in search) | Clear the query | search |
| `↓` (in search) | Focus the first card | search |

Typing detection is by `tagName` (`INPUT`, `TEXTAREA`, `SELECT`), so a shortcut never fires while the
user is entering text. Every shortcut is reachable without a pointer, satisfying WCAG 2.1.1.

---

## 8. Boot, error and simulation states

| State | Rendering | Notes |
| :--- | :--- | :--- |
| `boot = loading` | centred `role="status" aria-live="polite"` | no spinner animation when reduced motion |
| `boot = failed` | `role="alert"`, heading, body, correlation id, Retry button | retry re-runs `actions.boot()` |
| `boot = ready`, first launch | diagnosis starts automatically, health strip shows `health.diagnosing done/total` and a Cancel button | REQ-F-002: no click required; the run is read-only (`03-05` §5) |
| Events unavailable | error toast with code + remedy + correlation id | never a silent `console.error` |
| Simulator active | non-dismissible `simulation-banner` above the title bar, `role="status"` | states "NO OS CHANGES" |

The simulation banner is rendered whenever `info.simulator` is true, at the top of the shell, before
anything else. A screenshot of the simulator therefore cannot be mistaken for a real run.

**Why the first launch diagnoses itself.** The alternative was a shell full of "not measured" cards and
a button the user has to find. The probe layer is read-only by contract, so measuring costs the user
nothing; and a screen that says "Puan -" tells them nothing about their machine. The automatic run
fires once, only after `state.info` exists - a failed boot already renders its own `role="alert"`, and a
diagnosis error stacked on top would report two faults for one cause. The primary button returns when
the run finishes, so a manual re-scan is always one click away.

---

## 9. Error toast

Every failed command flows through `asIpcError()` → `state.error`. The toast shows, in order:

1. `misc.error.title`
2. the localised `messageKey` with `params`
3. the localised `remedyKey`
4. `misc.error.correlation` with the correlation id in mono

The correlation id is the string a support case quotes. It is never omitted, even for an unknown error
(the fallback id is `unavailable`, explicitly not a fake UUID).

---

## 10. Candidate dialogs

| Kind | Table columns | Selectable | Result |
| :--- | :--- | :--- | :--- |
| `dev_ports` | port, process (name + pid), checkbox | yes | `process_terminate` with `VerifiedPidTarget` |
| `hung_office` | window title, process, checkbox | yes | same |
| `print_jobs` | document, owner, - | no | informational; the spooler action handles it |
| `wsl` | distro + state, owner, memory | no | informational |

Termination targets carry `pid`, `expectedName` and `expectedStartTimeUnixMs`, so the core re-verifies
identity before killing (`04-01` §4, PID-recycling defence). The table shows the scan result verbatim;
an empty scan says "nothing found", never "all clean".

---

## 11. copy rules

| Rule | Example |
| :--- | :--- |
| Never claim a measurement that did not happen | `card.unknown` instead of `0 MB` |
| Name the next action in a remedy | "Restart as administrator", not "Access denied" |
| Keep sentences under ~90 characters | fits the 280px card |
| No exclamation marks, no "Oops" | a diagnostic tool is not a chat app |
| Turkish uses formal second person (`-in`) | see `06-01` §7 |

All copy lives in the catalogues, never in components - except two documented literals: the script
fallback comment in `ScriptDialog` and the purge token `PURGE`, both of which are machine-facing.

---

## 12. Traceability

| Screen | Requirement | Evidence |
| :--- | :--- | :--- |
| Actions | REQ-F-011..016, 022, 023 | `ActionGrid.tsx`, `Tabs.tsx` |
| Snapshots | REQ-F-041..045 | `SnapshotsScreen.tsx` |
| Trust | REQ-F-097, 098 | `TrustScreen.tsx` |
| Settings | REQ-F-120..126 | `SettingsScreen.tsx` |
| Activity | REQ-F-090 | `ActivityScreen.tsx`, `Console.tsx` |
| Help | REQ-F-100 | `HelpScreen.tsx` |
| All | REQ-F-100..114 | `App.tsx`, `StatusBar.tsx` |
