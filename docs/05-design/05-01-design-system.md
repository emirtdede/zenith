# 05-01 - Design System

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-DSN-001 |
| Version | 2.0.0 |
| Owner | Design / Frontend |
| Source of truth | [`src/styles/tokens.css`](../../src/styles/tokens.css) |
| Gate | `node scripts/check-contrast.mjs` (75 checks, 3 themes) |
| Closes | DEF-041 (v1.0.0 had no token layer; colours were inline hex) |

Three themes share one geometry, one type scale and one motion vocabulary. Colour is the *only*
thing a theme changes, and colour exists in exactly one file. A component that writes a raw hex
value is a defect.

---

## 1. Token layers

Tokens are grouped by intent, never by appearance. `--danger` is the same *role* - "this destroys
something" - whether it renders deep red on paper or pale red on black.

| Layer | Examples | Changes per theme? |
| :--- | :--- | :--- |
| Geometry | `--radius-xs…xl`, `--space-1…10`, `--ring-width`, `--ring-offset` | No |
| Type | `--font-ui`, `--font-mono`, `--text-xs…3xl`, `--leading-*`, `--weight-*` | No |
| Motion | `--duration-instant…slow`, `--ease-out`, `--ease-in-out` | No |
| Elevation | `--shadow-1…3`, `--shadow-drawer` | Yes (shadow alpha differs on dark) |
| Surface | `--bg`, `--bg-elevated`, `--surface`, `--surface-hover`, `--surface-active`, `--sunken` | Yes |
| Ink | `--text`, `--text-inverse`, `--muted`, `--faint` | Yes |
| Boundary | `--line`, `--line-soft` | Yes |
| Accent | `--accent`, `--accent-hover`, `--accent-soft`, `--accent-text` | Yes |
| Status | `--ok`, `--warn`, `--bad`, `--info` + `-soft` pairs | Yes |
| Focus / overlay | `--focus`, `--overlay`, `--glass` | Yes |

`app.css` - the only other stylesheet - contains **zero** colour literals. Verified:

```powershell
Select-String -Path src\styles\app.css -Pattern '#[0-9a-fA-F]{3,8}\b'
# (no output)
```

---

## 2. Type scale

Inter (UI) and JetBrains Mono (numbers, paths, logs). Both are local WOFF2 files under
`public/fonts/`; the CSP is `default-src 'self'`, so a CDN font would fail to load - that is the
enforcement, not a policy statement.

| Token | Size | Use |
| :--- | ---: | :--- |
| `--text-xs` | 11.5px | log lines, table captions, badges |
| `--text-sm` | 12.5px | secondary UI, buttons, table cells |
| `--text-base` | 14px | body |
| `--text-md` | 15.5px | card titles, dialog headings |
| `--text-lg` | 18px | section headings |
| `--text-xl` | 22px | the health score |
| `--text-2xl` | 28px | reserved (empty-state headings) |
| `--text-3xl` | 34px | reserved (boot screen) |

Line heights: `--leading-tight` 1.2 for headings, `--leading-snug` 1.35 for UI labels,
`--leading-normal` 1.55 for body. Body text never goes below 11.5px, which is the smallest size that
still passes a 200% zoom test without horizontal scroll (WCAG 1.4.4, see `05-03` §5).

Mono is used for anything where digit width matters: byte counts, timestamps, PIDs, ports, correlation
ids, script bodies. Proportional figures would make a column of file sizes ragged.

---

## 3. Colour and measured contrast

The palette is not asserted; it is computed. `scripts/check-contrast.mjs` parses `tokens.css`,
converts each colour to relative luminance with the WCAG formula, and fails if a pair misses its
threshold.

Thresholds (WCAG 2.2):

- **4.5:1** - normal text (1.4.3 AA)
- **3.0:1** - large text, UI component boundaries, focus indicators (1.4.11)

The `--line` colour is held to 3:1 because it is the only visible boundary of an input, a card edge or
a divider. A 1.3:1 border is decoration, not an affordance.

### Measured results (all 75 checks pass)

| Theme | `--text` on bg | `--muted` on bg | `--line` on bg | `--focus` on bg |
| :--- | ---: | ---: | ---: | ---: |
| off-white | 17.48:1 | 6.13:1 | 3.64:1 | 7.32:1 |
| true-black | 18.18:1 | 8.96:1 | 3.89:1 | 10.94:1 |
| spatial-glass | 16.51:1 | 8.58:1 | 3.47:1 | 9.31:1 |

Worst-case text ratio across all three themes and all three backgrounds (bg / surface / sunken) is
**5.64:1** (`off-white`, `--warn` on `sunken`) - still above 4.5:1. Worst-case UI boundary is
**3.22:1** (`spatial-glass`, `--line` on `surface`) - above 3.0:1.

Reproduce:

```powershell
node scripts/check-contrast.mjs
# ... 75 lines ...
# All 75 checks pass in 3 themes.
```

### Theme rationale

| Theme | Base | Why not the obvious choice |
| :--- | :--- | :--- |
| **off-white** | `#fbfbf9` | Pure `#FFFFFF` is uncomfortable at night and makes the app look like a web page. A warm paper tone reads as a tool, and screenshots print cleanly on white paper. |
| **true-black** | `#07080a` | Absolute `#000000` with light text smears visibly on OLED during scroll and removes all depth cues. `#07080a` keeps the OLED power benefit without the smear. |
| **spatial-glass** | `#0d1220` | Frosted blur is applied only to the two overlay surfaces, never behind body text. A label over a moving blur is an accessibility trap; this theme looks layered without ever rendering text on an unstable background. |

---

## 4. Motion

| Token | Value | Use |
| :--- | ---: | :--- |
| `--duration-instant` | 80 ms | state flips that must feel immediate (pressed) |
| `--duration-fast` | 140 ms | hover, focus ring, overlay fade |
| `--duration-base` | 220 ms | drawer slide |
| `--duration-slow` | 380 ms | reserved (theme cross-fade) |
| `--ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | entrances |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | moves |

Motion is a **preference**, not decoration. Two independent switches collapse every duration to 1 ms:

1. `data-reduce-motion="true"` on `<html>` - set by `main.tsx`/`App.tsx` from the in-app toggle **or**
   the OS `prefers-reduced-motion` media query.
2. A `@media (prefers-reduced-motion: reduce)` block that also zeroes the duration tokens, so a user
   who changes the OS setting mid-session is honoured without a reload.

There is no parallax, no auto-playing animation, and nothing that flashes more than three times per
second (WCAG 2.3.1).

---

## 5. Elevation and depth

| Token | Role |
| :--- | :--- |
| `--shadow-1` | resting card |
| `--shadow-2` | hovered card |
| `--shadow-3` | dialog / toast |
| `--shadow-drawer` | upward shadow for the console drawer |

Depth is never the *only* signal. A dialog also has a border and a scrim (`--overlay`); a hovered card
also changes its border colour (`--line-soft` → `--line`). This matters in `forced-colors` mode, where
`@media (forced-colors: active)` removes every `box-shadow` and the border becomes the sole cue.

---

## 6. Component grammar

Every screen is built from the same six primitives, styled once in `app.css`:

| Primitive | Class | Used by |
| :--- | :--- | :--- |
| Panel | `.panel` | every screen's content block |
| Card | `.card` | the 22 action cards |
| Table | `.table` | snapshots, candidates, settings lists |
| Field | `.field` | inputs, selects, textareas, radio groups |
| Badge | `.badge` + `risk-*` / `is-bad` | risk tier, status |
| Pill | `.pill` + `-ok` / `-warn` | retention line, simulation flag |

Buttons have exactly four intents: `.btn-primary` (the one action), `.btn` (secondary), `.btn-quiet`
(tertiary), `.btn-danger` (destructive). A screen never invents a fifth.

---

## 7. Iconography

Icons are text glyphs (`★` pin, `◌` hide) rather than an icon font or SVG sprite, for one
reason: they inherit `currentColor`, scale with `--text-sm`, and add zero bytes to the bundle.
Every icon-only button carries an `aria-label` **and** an `aria-pressed` where it is a toggle
(`ActionGrid.tsx` pin/hide), with the glyph itself wrapped in `aria-hidden="true"`, so the
glyph is never the only label and the label is a translated sentence rather than a character.
`title` is a tooltip and cannot name the button: name-from-content outranks it (DEF-120).

---

## 8. What the system forbids

| Forbidden | Why | How it is caught |
| :--- | :--- | :--- |
| Raw colour in a component | Theme drift, contrast regression | `app.css` has no hex; review |
| A new font | CSP blocks it; adds a network dependency | `@font-face` count is 5, all local |
| Animation without a reducer | Motion-sickness, WCAG 2.3 | every `transition` uses a duration token |
| Colour as the only state cue | WCAG 1.4.1 | status always adds a label or border |
| Blur behind text | Legibility | `--glass` is used on overlays only |
| A fourth button intent | Visual noise | four `.btn*` classes exist |

---

## 9. Verification

```powershell
# Contrast, all themes and pairs
node scripts/check-contrast.mjs

# No hex outside the token file
Select-String -Path src\styles\app.css -Pattern '#[0-9a-fA-F]{3,8}\b'

# Fonts are local and complete
Get-ChildItem public\fonts -Name

# Reduced-motion wiring
Select-String -Path src\App.tsx -Pattern 'prefers-reduced-motion|reduceMotion'
```

The 75/75 result is the evidence behind every ratio in §3. If a designer changes `--muted` by two
percent, the script fails before the change can ship.
