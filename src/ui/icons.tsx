/**
 * The sidebar's icon set: one inline SVG per destination.
 *
 * Hand-drawn rather than pulled from an icon font on purpose. A font adds a
 * network-shaped dependency and a licence obligation to a security tool that
 * must render its own UI offline, and a glyph rendered as text is announced by
 * a screen reader as punctuation - the defect DEF-120 closed on the card tools.
 * These are decorative only: every one is `aria-hidden`, because the adjacent
 * button already has a translated text label. They inherit `currentColor`, so
 * the active/hover colours come from CSS and never from the icon itself.
 *
 * Strokes are 1.75 units on a 24-unit grid with round caps, which keeps the
 * icons visually equal weight to the 12.5 px UI text beside them.
 */

import type { ReactElement, ReactNode } from "react";

import type { ScreenId } from "../state/store";

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function Frame({ children, size = 19 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      {...STROKE}
    >
      {children}
    </svg>
  );
}

/** Four squares: the action grid. */
function GridIcon() {
  return (
    <Frame>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </Frame>
  );
}

/** A clock with a return arrow: undo history. */
function HistoryIcon() {
  return (
    <Frame>
      <path d="M3.6 12a8.4 8.4 0 1 0 2.5-5.96" />
      <path d="M3.4 4.4v4.1h4.1" />
      <path d="M12 7.9V12l2.9 1.8" />
    </Frame>
  );
}

/** Terminal prompt: the activity log. */
function TerminalIcon() {
  return (
    <Frame>
      <rect x="3" y="4.5" width="18" height="15" rx="2.2" />
      <path d="M7 9.6l2.7 2.4L7 14.4" />
      <path d="M12.4 15h4.2" />
    </Frame>
  );
}

/** Shield with a tick: the Trust Center. */
function ShieldIcon() {
  return (
    <Frame>
      <path d="M12 3.2l7 2.6v5.4c0 4.3-2.9 7.5-7 9.6-4.1-2.1-7-5.3-7-9.6V5.8z" />
      <path d="M8.9 11.9l2.1 2.1 4.1-4.3" />
    </Frame>
  );
}

/** Three sliders: settings. */
function SlidersIcon() {
  return (
    <Frame>
      <path d="M4 7.2h8.5M17 7.2h3M4 16.8h3M11.5 16.8H20" />
      <circle cx="14.9" cy="7.2" r="2.1" />
      <circle cx="9.4" cy="16.8" r="2.1" />
    </Frame>
  );
}

/** A question mark in a circle: help and shortcuts. */
function HelpIcon() {
  return (
    <Frame>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M9.7 9.4a2.4 2.4 0 0 1 4.6.9c0 1.6-2.3 1.9-2.3 3.4" />
      <path d="M12 16.7h.01" />
    </Frame>
  );
}

/**
 * A five-pointed star for "pin this card".
 *
 * These two live here rather than as text glyphs. DEF-120 established why: a
 * symbol rendered as text is part of the accessible name and is announced as
 * punctuation, and a bare symbol is a fallback glyph whose shape depends on
 * whatever font the machine happens to have. The `aria-label` on the button is
 * what names it; this is the picture. DEF-154 removed the last two text glyphs
 * from the card tools for exactly this reason.
 */
export function PinIcon() {
  return (
    <Frame size={16}>
      <path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z" />
    </Frame>
  );
}

/** A star with a slash: the card is not pinned, so offer "pin". */
export function UnpinIcon() {
  return (
    <Frame size={16}>
      <path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z" />
      <path d="M4 20L20 4" />
    </Frame>
  );
}

/** An eye: the card is visible, so the button hides it. */
export function HideIcon() {
  return (
    <Frame size={16}>
      <path d="M2.6 12s3.4-6.4 9.4-6.4S21.4 12 21.4 12s-3.4 6.4-9.4 6.4S2.6 12 2.6 12z" />
      <circle cx="12" cy="12" r="2.9" />
    </Frame>
  );
}

/** An eye with a slash: the card is hidden, so the button restores it. */
export function ShowIcon() {
  return (
    <Frame size={16}>
      <path d="M2.6 12s3.4-6.4 9.4-6.4S21.4 12 21.4 12s-3.4 6.4-9.4 6.4S2.6 12 2.6 12z" />
      <circle cx="12" cy="12" r="2.9" />
      <path d="M4 20L20 4" />
    </Frame>
  );
}

/**
 * Window chrome icons: 10px, on the same 24 grid but with a heavier stroke.
 *
 * A 1.75 stroke scaled to 10px renders as a hairline that disappears on a
 * light theme, so these carry their own weight instead of reusing `STROKE`.
 * They are the one icon family a user sees before the window paints, so they
 * are drawn here rather than loaded.
 */
function WinIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/** A horizontal rule: minimise. */
export function MinimizeIcon() {
  return (
    <WinIcon>
      <path d="M5 12h14" />
    </WinIcon>
  );
}

/** One square: maximise. */
export function MaximizeIcon() {
  return (
    <WinIcon>
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </WinIcon>
  );
}

/** Two offset squares: restore. */
export function RestoreIcon() {
  return (
    <WinIcon>
      <rect x="4" y="9" width="11" height="11" rx="2" />
      <path d="M8.5 9V6.5A2.5 2.5 0 0 1 11 4h7a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18 16h-3" />
    </WinIcon>
  );
}

/** An X: close. */
export function CloseIcon() {
  return (
    <WinIcon>
      <path d="M6 6l12 12M18 6L6 18" />
    </WinIcon>
  );
}

/**
 * The one icon per screen. A `Record<ScreenId, …>` rather than a switch: adding
 * a seventh screen fails to compile until it is given an icon, which is the
 * same completeness guarantee `ScreenId` already gives the router.
 */
export const SCREEN_ICON: Record<ScreenId, () => ReactElement> = {
  actions: GridIcon,
  snapshots: HistoryIcon,
  activity: TerminalIcon,
  trust: ShieldIcon,
  settings: SlidersIcon,
  help: HelpIcon,
};
