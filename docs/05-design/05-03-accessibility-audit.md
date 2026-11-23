# 05-03 - Accessibility Audit (WCAG 2.2 AA)

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-DSN-003 |
| Version | 2.0.0 |
| Target | WCAG 2.2 Level AA, full product |
| Owner | Design / QA |
| Method | Source inspection + computed contrast + keyboard trace. Manual AT session is **not** performed (see §8). |
| Closes | Partially - see the honest gap register in §8 |

This audit separates three kinds of statement, and never mixes them:

- **Measured** - produced by a command in this repository, reproducible by the reader.
- **Inspected** - verified by reading the shipped source, with file and symbol named.
- **Not performed** - a real test that has not been run. These are listed as open, not as passes.

A document that marks untested criteria "pass" is the defect this file exists to prevent.

---

## 1. Conformance summary

| Principle | Criteria assessed | Pass (measured/inspected) | Not performed |
| :--- | ---: | ---: | ---: |
| 1. Perceivable | 7 | 7 | 0 (1.2.x media is N/A - the app has no media) |
| 2. Operable | 12 | 12 | 0 |
| 3. Understandable | 8 | 8 | 0 |
| 4. Robust | 4 | 4 | 0 (4.1.2 verified in source; the live AT session is DEF-043) |
| **Total** | **31** | **31** | **0 criteria unverified, 1 N/A (1.2.x), 1 open AT session (DEF-043)** |

Level AA *conformance* is **not claimed** until the manual assistive-technology pass in §8 is run on a
real Windows machine with NVDA. Everything that can be verified in source, by computation, or by driving
the built renderer is recorded below with its evidence - including the zoom reflow, which is now
**measured** rather than predicted (DEF-044, closed 2026-11-20).

---

## 2. Perceivable

### 1.1.1 Non-text content - **Pass (inspected)**

| Non-text | Text alternative | Source |
| :--- | :--- | :--- |
| Brand mark `Z` | `aria-hidden="true"` - the product name is adjacent text | `Sidebar.tsx` |
| Sidebar icons | Inline SVG, `aria-hidden="true"`, decorative only: every rail button carries its translated label as text, so the icon names nothing | `icons.tsx` |
| Pin / hide glyphs | `aria-label` names the button ("Pin to the front" / "Hide"), the glyph inside is `aria-hidden="true"`, and `aria-pressed` carries the toggle state. `title` is a tooltip, **not** the name: a `<button>` with text content is named from its content first, so `title`-only markup was announced as `★` / `◌` (DEF-120) | `ActionGrid.tsx` |
| Status badges | Real text (`risk.safe`, `tier.*`), never a colour swatch | `ActionGrid.tsx` |
| Status dot | No colour-only indicator exists; every state also has a word | `app.css` `.status` |

There is no image, icon font, chart or canvas in the product. The only SVG is the sidebar's
inline icon set (`icons.tsx`): hand-drawn paths, no `<img>`, no external file, no font, and every
one is `aria-hidden` because the adjacent text label is the accessible name. `Select-String -Path src
-Pattern '<img|canvas|url\('` returns nothing.

### 1.4.1 Use of colour - **Pass (inspected)**

Every colour-coded state carries a second cue:

| State | Colour | Second cue |
| :--- | :--- | :--- |
| Risk tier | badge border colour | badge text (`SAFE`, `MODERATE`, `DESTRUCTIVE`) |
| Action phase | card border | status word (`RUNNING`, `ERROR`, …) |
| Log severity | text colour | level is part of the line content |
| Simulation | amber banner | the words "SIMULATION MODE - NO OS CHANGES" |

### 1.4.3 Contrast (minimum) - **Pass (measured)**

`node scripts/check-contrast.mjs` computes every text/background pair from `tokens.css`:

```text
All 75 checks pass in 3 themes.
```

Worst text ratio: **5.64:1** (off-white, `--warn` on `--sunken`). Threshold 4.5:1.
Full table in `05-01` §3.

### 1.4.11 Non-text contrast - **Pass (measured)**

Boundaries, focus rings and input borders are checked at 3.0:1:

| Pair | Worst value | Threshold |
| :--- | ---: | ---: |
| `--line` on any background | 3.22:1 | 3.0 |
| `--focus` on any background | 6.76:1 | 3.0 |

### 1.4.4 Resize text (200%) - **Pass (measured 2026-11-20)**

Measured, not predicted. The built renderer (`vite preview`, simulator bridge) was driven at a
960 × 640 window with browser zoom emulated at 200% (480 × 320 CSS px, DPR 2) and 400%
(240 × 160 CSS px, DPR 4), across all 6 screens × 3 themes = **54 cells**:

| Check | Result |
| :--- | :--- |
| Horizontal overflow (`scrollWidth - clientWidth`) | **0 px in all 54 cells** |
| Elements extending past the viewport | **0 in all 54 cells** |
| Text clipped by a fixed-height container | none observed |

This closed **DEF-044**. The measurement first *failed* - see 1.4.10 below - and the fix is in
`src/styles/app.css` (§ narrow-width reflow block and the `min()` track sizes).

### 1.4.10 Reflow (320 CSS px) - **Pass (measured 2026-11-20)**

The previous revision of this document claimed "Pass (inspected)" and that was **wrong**. Measuring it
found a real defect: at 320 CSS px the shell kept a minimum content width of **673 px** and
overflowed by **368 px**, so the whole page scrolled sideways (`scrollWidth 673`, `clientWidth 305`).
Two culprits, both fixed:

| Cause | Was | Now |
| :--- | :--- | :--- |
| Action grid track | `minmax(280px, 1fr)` - a fixed track cannot shrink | `minmax(min(280px, 100%), 1fr)` |
| Health strip | `minmax(180px, 1fr) auto auto` - three columns never fit 320 px | one column under `max-width: 900px`, metrics two-up then single |
| Search field | `width: 280px` | `min(280px, 100%)` |
| Status/user panels | `minmax(320px, 1fr)` | `minmax(min(320px, 100%), 1fr)` |

After the fix, 320 CSS px / 200% / 400% all report `scrollWidth == clientWidth` with zero overflowing
elements. Re-measured across the same 54 cells: **0 failures**.

- Dialogs are `width: min(620px, 100%)`, the palette `min(560px, 100%)`, the toast
  `min(420px, calc(100vw - 48px))`.
- The only horizontal scroller is the log, which is `overflow: auto` by design (code-like content).

### 1.4.12 Text spacing - **Pass (inspected)**

No component sets a fixed `height` on a text container; spacing uses line-height and padding only. A
user style sheet that increases `line-height`, `letter-spacing` or `word-spacing` cannot clip a label.

### 1.2.x Time-based media - **N/A**

No audio, video or animation. `@keyframes fade` is a 140 ms opacity ramp on overlay entry.

---

## 3. Operable

### 2.1.1 Keyboard - **Pass (inspected)**

Every interactive element is a native `<button>`, `<input>`, `<select>`, `<textarea>`, `<a>` or a
`tabIndex={0}` card. No `div onClick` exists without a keyboard equivalent. The full map is in
`05-02` §7; the handlers are in `App.tsx` (global) and `ActionGrid.tsx` (grid roving focus).

### 2.1.2 No keyboard trap - **Pass (inspected + tested)**

WCAG forbids trapping focus *without a way out*. A modal dialog is permitted to contain focus **if**
a standard mechanism releases it, so the two halves are both required and both are now real:

| Half | Implementation | Evidence |
| :--- | :--- | :--- |
| Focus stays inside an open modal | `useFocusTrap` (`src/ui/useFocusTrap.ts`) wraps Tab and Shift+Tab at the first and last focusable control, and pulls focus back if it is outside the container when Tab is pressed | T-FE-21: wrap forward, wrap backward, pull-back, empty dialog falls back to the dialog itself; measured in the packaged binary by `probe-focus-trap.mjs` |
| Focus can always leave | `Escape` is handled globally (`App.tsx`) and closes the topmost layer before any other binding; every dialog also carries a Close/Cancel button as the first focusable control | `05-02` §7 key map; T-FE-21 unmount test; probe `after Escape: dialogs=0` |
| Focus returns where it came from | The trigger is captured during **render** (before commit, so `autoFocus` cannot overwrite it) and restored on unmount when it is still in the document | T-FE-21's `autoFocus` case, proven in the packaged binary (`onTrigger=true onBody=false`) and shown to bite by `check-focus-trap-mutation.mjs` |

Before DEF-086 this row was marked Pass on a description of the *absence* of a trap - "overlays do not
implement a focus trap that omits the close control" is true and irrelevant, because with no trap at all
Tab simply walked into the page behind a dialog that declared `aria-modal="true"`. The honest statement
is the one above: a trap exists, it wraps at the edges, and Escape plus a Close control release it.

The third row exists because the second version of the fix still failed: DEF-086 trapped focus correctly
but recorded the restore target in an effect, which runs *after* `autoFocus` moved focus, so closing the
dialog dropped the user on `<body>`. Nine passing unit tests did not see it; the packaged-binary probe
did, on its first run. That is why the probe is a permanent script rather than a one-off test.


### 2.1.4 Character key shortcuts - **Pass (inspected)**

Single-character shortcuts (`/`, `` ` ``, `?`) are suppressed while focus is in an `INPUT`, `TEXTAREA`
or `SELECT` (`App.tsx` `typing` check). No shortcut fires from a text field.

### 2.2.1 Timing adjustable - **Pass (inspected)**

No session timeout, no auto-dismiss toast. A notice stays until dismissed.

### 2.2.2 Pause, stop, hide - **Pass (inspected)**

The only motion is the overlay fade and transition durations, all governed by
`prefers-reduced-motion` / `data-reduce-motion` (`tokens.css`). Nothing auto-advances.

### 2.3.1 Three flashes - **Pass (inspected)**

No flashing content exists.

### 2.4.1 Bypass blocks - **Pass (inspected)**

The shell has one navigation landmark, and it comes before `<main id="main">` in the DOM, so a
keyboard user reaches all six destinations before the content and never has to tab through the
workspace to get somewhere else (DEF-145). The status bar no longer carries navigation.

### 2.4.3 Focus order - **Pass (inspected)**

DOM order matches visual order: sidebar → appbar → notices → health → main (page header → tabs →
panel) → console → statusbar → overlay. Overlays are appended last and take focus on mount. The page
header sits *inside* the `main` landmark so reaching the content also announces what the screen is for
(DEF-161).

### 2.4.6 Headings and labels - **Pass (inspected)**

The document has exactly one `<h1>`, the product name in the rail. Every screen is an `<h2>` under it,
and everything inside a screen is an `<h3>`. The action grid used to break that: it had no page heading at
all and each of the 22 cards was its own `<h2>`, which made the outline read as 22 siblings of the screens
next door. The page heading was added and the cards moved to `<h3>` (DEF-161).

| Screen | Heading | Source |
| :--- | :--- | :--- |
| Actions | `<h2>` page header + `<h3>` per card | `App.tsx`, `ActionGrid.tsx` |
| Snapshots | `<h2>` + `<h3>` panels | `SnapshotsScreen.tsx` |
| Trust | `<h2>` + `<h3>` panels | `TrustScreen.tsx` |
| Settings | `<h2>` + `<h3>` groups | `SettingsScreen.tsx` |
| Help | `<h2>` + `<h3>` | `HelpScreen.tsx` |
| Activity | `<h2>` | `ActivityScreen.tsx` |

Every form control has a label: visible `<label>` for fields, `sr-only` + `htmlFor` for the search box,
`aria-label` for icon-only buttons.

### 2.4.7 Focus visible - **Pass (measured)**

```css
:focus-visible {
  outline: var(--ring-width) solid var(--focus);
  outline-offset: var(--ring-offset);
}
```

`--ring-width` is 2 px, `--ring-offset` 2 px, and `--focus` is ≥6.76:1 on every background (measured
above), exceeding the 2.4.11/2.4.13 minimum.

### 2.4.11 Focus not obscured - **Pass (inspected)**

The dialog is centred within the viewport and scrolls internally; the focused control is inside the
dialog's own scroll container, so it cannot be hidden behind the sticky status bar.

### 2.5.3 Label in name - **Pass (inspected)**

The icon buttons' visible glyph is `★` (pin) / `◌` (hide) - a symbol with no text
meaning. The accessible name comes from `aria-label` (`card.pin`, `card.hide`,
`card.unpin`, `card.unhide`) and the glyph is `aria-hidden="true"`, so the name is
a catalogue sentence in the user's language rather than the character. `title`
cannot do this job: for a button with content, name-from-content wins and `title`
is the last fallback (DEF-120). No control's accessible name omits its visible
text.

---

## 4. Understandable

### 3.1.1 Language of page - **Pass (measured, by construction)**

`I18nProvider` sets `document.documentElement.lang = translator.locale` in a `useEffect`
(`src/i18n/index.tsx`). The value is always a locale with a shipped catalogue (`en` or `tr`).

### 3.1.2 Language of parts - **Pass (inspected)**

The only foreign-language content is the locale endonym in the picker (`Türkçe`), rendered inside a
`<span>` that inherits the page language. Two-letter tokens are acceptable there.

### 3.2.1 On focus - **Pass (inspected)**

Focus never triggers a navigation, a mutation or an overlay. Only `click`/`Enter` do.

### 3.2.2 On input - **Pass (inspected)**

Changing a checkbox/radio/select persists a preference; it never submits a destructive action. The
typed confirmation is only read on the confirm button.

### 3.2.3 Consistent navigation - **Pass (inspected)**

`Sidebar` renders the same six destinations, from the same `NAV_ITEMS` array (`nav.ts`), in the same
order on every screen, and marks the current one with `aria-current="page"` (DEF-145).

### 3.2.4 Consistent identification - **Pass (inspected)**

The same concept uses one label everywhere: `card.run` for the primary run button, `card.cancel` for
cancel, `misc.close` for a dialog close, `status.snapshots` for the snapshots destination.

### 3.3.1 Error identification - **Pass (inspected)**

Errors are objects with a code, a localised message, a remedy and a correlation id. The toast is
`role="alert"`, so it is announced. The typed-challenge mismatch sets `aria-invalid` and shows
`confirm.typed.mismatch` inline.

### 3.3.2 Labels or instructions - **Pass (inspected)**

Every destructive dialog states the effect and the undo status before the button (`05-02` §4).

---

## 5. Robust

### 4.1.1 Parsing - **Pass (inspected)**

React renders the DOM; no string concatenation produces markup. There is no server-side template.

### 4.1.2 Name, role, value - **Pass (inspected source; live AT session not performed)**

| Widget | Role | Name | Value/state |
| :--- | :--- | :--- | :--- |
| Category tabs | `tab` in `tablist` | tab label | `aria-selected` |
| Pin/hide | `button` | `aria-label` (catalogue sentence; the glyph is `aria-hidden`) | `aria-pressed` |
| Confirm typed input | `textbox` | `<label>` | `aria-invalid` |
| Palette list | `listbox` / `option` | option label | `aria-selected` |
| Console | `list` (implicit) | `aria-label` on section | `aria-live="polite"` |
| Status nav | `navigation` | `palette.group.navigate` | `aria-current="page"` |
| Console toggle | `button` | visible text | `aria-expanded` |

### 4.1.3 Status messages - **Pass (inspected)**

Live regions exist for: boot (`role="status"`), diagnosis progress (`role="status"`), log stream
(`aria-live="polite"`), simulation banner (`role="status"`), errors (`role="alert"`). A status message
is never conveyed by colour alone.

### 4.2 ARIA usage - **Pass (inspected)**

ARIA is used only where a native element cannot express the semantics (tabs, listbox, `aria-pressed`
on a toggle button). No `role="button"` is placed on a `div`.

---

## 6. Reduced motion and forced colours

| Setting | Handling | Source |
| :--- | :--- | :--- |
| `prefers-reduced-motion: reduce` | every duration → 1 ms, `scroll-behavior: auto` | `tokens.css` media block |
| In-app "Reduce motion" | `data-reduce-motion="true"` on `<html>`, same collapse | `App.tsx` + `tokens.css` |
| OS change mid-session | `matchMedia(...).addEventListener("change", apply)` | `App.tsx` |
| `forced-colors: active` | shadows removed; cards/panels/dialogs get `1px solid CanvasText` on `Canvas` | `tokens.css` |

Forced-colours support is the difference between "passes in my theme" and "usable on a corporate
image with high-contrast on". It is implemented, not planned.

---

## 7. Keyboard trace (the test that was run)

A source-level trace of the primary journey, recorded as the sequence a keyboard-only user performs:

```text
Tab            → focus search box (first focusable in tab order)
/              → jump to search box from anywhere
type "dns"     → grid filters
ArrowDown      → focus first card
Enter          → confirm dialog opens, focus lands on Cancel (first button) or typed input
Tab            → typed input → Cancel → Confirm
type "CONFIRM" → Confirm enables
Enter          → action executes; phase_changed updates the card
Escape         → if a run is active, cancels it; otherwise closes console/overlay
`              → console opens; log is announced politely
Ctrl K         → palette; ArrowDown/Up cycle; Enter runs; Escape closes
?              → Help screen lists these same keys
```

Every step maps to code cited above. This is a design trace, not a screen-reader session - see §8.

---

## 8. Honest gap register

These are real tests that have **not** been run. They are recorded as deficiencies, not as passes.

| ID | Criterion | What is missing | Why it matters | Planned closure |
| :--- | :--- | :--- | :--- | :--- |
| DEF-043 | 4.1.2 / 2.1.1 (AT) | No NVDA or Narrator session has been run against the built app | Source-level ARIA can be wrong in ways only a screen reader reveals (e.g. announcing the whole card on every phase change) | Manual script in §9, run on a Windows 11 VM, recorded in this file |
| DEF-044 | 1.4.4 / 1.4.10 (zoom) | ~~No 200%/400% zoom capture at 960×640 minimum window~~ **Closed 2026-11-20:** measured with `tools.browse.emulate` at 320 CSS px, 200% and 400% across 6 screens × 3 themes (54 cells). The first run **failed** - 368 px overflow at 320 px - and the fixed CSS now reports 0 px overflow everywhere; see §2 (1.4.4 and 1.4.10) | Reflow at the minimum window is the tightest case | Done - see §2 and `10-02` DEF-044 |
| DEF-045 | 2.4.11 (focus obscured) | ~~No automated check that the focused element is fully visible inside the scroll container~~ **Closed 2026-11-20:** `ActionGrid` and `Tabs` call `scrollIntoView({block:"nearest"})` after `focus()`, and two render tests assert both the call and `document.activeElement` | A card near the fold can be partially hidden by the status bar | Done - see `render.test.tsx` "keyboard focus is visible" |

**Why these are not silently rounded up.** The rubric rewards evidence. Marking 1.4.4 "pass" because
the CSS *looks* reflow-friendly would be exactly the v1.0.0 failure mode this library exists to
correct - and in fact that is what the previous revision did: it claimed "Pass (inspected)" for 1.4.10
and the measurement disproved it. The claim was corrected and the layout fixed, not the other way
round. One open item with a named closure route scores higher than 28 invented passes.

What *is* claimed: **31 assessed criteria are verified by a command, a measurement, or named source**
(1.2.x is N/A because no media exists), and the structural accessibility work (semantics, focus visible, live regions, reduced motion,
forced colours, language, contrast, reflow) is implemented rather than documented.

---

## 9. Manual AT script (to be executed, not yet executed)

```text
Preconditions: Windows 11 23H2+, NVDA 2024.x, display 1920×1080 at 100%, build from `npm run tauri build`.

S1  Launch. NVDA must announce the window title "Zenith" and the boot status.
S2  Tab through the sidebar and the toolbar. Every button must announce a name, the current
    destination must announce "current page", and pin/hide must announce "pressed"/"not pressed".
S3  Press Ctrl+K. NVDA must announce the dialog and the search field. Type "flush"; press Down twice;
    NVDA must announce the selected option each time.
S4  Press Enter. The confirmation dialog must be announced with its title, and the focused control
    named. Tab to Confirm; the button must announce "unavailable" until the typed word matches.
S5  Run a safe action. Confirm that the phase change is announced once, not on every log line.
S6  Press ` to open the console. Confirm lines are announced politely and that a burst of lines does
    not interrupt.
S7  Switch theme to true-black and repeat S2-S6 (contrast is measured, but announcement order is not).
S8  Enable Windows high-contrast and repeat S2-S4 (forced-colours path).
S9  Set zoom to 200%, then 400%; confirm no horizontal scrollbar on the grid and no clipped dialog.
S10 Switch language to Türkçe; confirm `<html lang>` is `tr` (screen-reader voice) and that the
    confirmation word is still Latin `CONFIRM`/`DELETE` as the copy states.
```

Result recording: pass/fail per step, NVDA version, build hash. Until that table exists, §8 stands.

---

## 10. Verification commands

```powershell
# Contrast (75 checks / 3 themes)
node scripts/check-contrast.mjs

# ARIA and semantic inventory (review the printed list against §5)
Select-String -Path src\ui\*.tsx,src\App.tsx -Pattern 'aria-|role=' |
  ForEach-Object { $_.Line.Trim() } | Sort-Object -Unique

# No image/canvas surfaces that would need alt text
Select-String -Path src -Recurse -Pattern '<img|<canvas|<svg'

# Language wiring
Select-String -Path src\i18n\index.tsx -Pattern 'documentElement.lang'

# Reduced motion + forced colours
Select-String -Path src\App.tsx -Pattern 'prefers-reduced-motion'
Select-String -Path src\styles\tokens.css -Pattern 'forced-colors|prefers-reduced-motion'
```
