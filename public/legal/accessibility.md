# Accessibility and Support Statement

Version 1.0.0, effective 23 November 2026.

## 1. Commitment

Zenith is an administrative tool. A keyboard-only administrator must be able to
diagnose a machine, approve an action, read the result, and undo it. That is the
bar we test against, not a marketing claim.

## 2. What is implemented

- Every interactive element is a native control: button, link, checkbox, radio,
  select, or input. There are no clickable divs.
- The sidebar is a `nav` landmark with translated names and `aria-current` on the
  current destination.
- The settings screen is a vertical tablist. Arrow keys, Page Up, and Page Down
  move between leaves; the panel heading and the tab name are the same string.
- The command palette traps focus while it is open and returns focus to the
  element that opened it.
- The context menu opens with Shift+F10 or the Menu key, not only with a right
  click. Arrow keys move, Escape closes, and focus returns to the trigger.
- Toasts are live regions. A toast is never the only place a failure is
  reported.
- A skip link moves focus to the main region.
- Reduced motion is honoured from the operating system and can be overridden in
  Settings. With reduced motion on, the shimmer, slide, and pop animations are
  removed, not shortened.
- A high-contrast class raises border and text contrast beyond the default
  palette. Windows forced-colors mode is supported through `forced-color-adjust`.
- Text scales to 200 percent through the zoom setting without clipping the
  settings rail or the status bar.
- Right-to-left locales use logical CSS properties on new surfaces, and the
  document direction is set from the locale registry.
- Every colour pair used for text passes 4.5:1, enforced by
  `scripts/check-contrast.mjs` over 14 palettes in both modes.

## 3. Known limitations

- Some legacy screens still use physical margins, so a right-to-left layout is
  correct in the shell and the settings surface but not yet in every legacy
  panel.
- The snapshot and trust tables scroll horizontally at 200 percent zoom instead
  of reflowing to cards.
- The bitmap captures in the release evidence are not themselves accessible
  documents; the text alternative is the caption in `evidence/README.md`.

## 4. Assistive technology tested

Windows Narrator and NVDA are used manually against the keyboard journeys in
`docs/07-quality/07-01-test-plan.md`. The automated suite asserts role, name, and
state, but it cannot assert that a screen reader reads a sentence well. Manual
results are recorded with the release evidence, and a manual pass is a release
gate, not an optional step.

## 5. Support

- Support policy: `public/legal/support.md`.
- Accessibility reports: accessibility@vellium.dev.
- Security reports: security@vellium.dev, see `SECURITY.md`.
- Response target: two business days for a functional accessibility barrier.
