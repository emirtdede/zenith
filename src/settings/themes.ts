/**
 * The colour system: fourteen curated palettes plus a custom accent.
 *
 * The palette values themselves live in `palettes.json` so that the same numbers
 * are read by three consumers without a second copy: this module (which paints
 * them), `scripts/check-contrast.mjs` (which holds every pair to WCAG 2.2) and
 * the unit tests. A palette that exists only as a TypeScript literal cannot be
 * read by a Node gate, and a gate that re-declares the numbers tests itself.
 *
 * Token names are the ones the design system documents: `canvas`, `surface`,
 * `surface-subtle`, `surface-hover`, `border`, `border-strong`,
 * `text-primary`, `text-secondary`, `text-muted`, `accent`, `accent-hover`,
 * `accent-soft`, `accent-ring`, `accent-fg`. Components never name a raw colour.
 */

import palettes from "./palettes.json";

/** A curated palette id, plus `custom` for a user-supplied accent. */
export type ThemeId =
  | "obsidian"
  | "slate"
  | "navy"
  | "blue"
  | "cyan"
  | "indigo"
  | "purple"
  | "pink"
  | "red"
  | "orange"
  | "yellow"
  | "emerald"
  | "grass"
  | "lime"
  | "custom";

/** Light, dark or follow the operating system. */
export type ThemeMode = "light" | "dark" | "system";

export interface ThemeTokens {
  canvas: string;
  surface: string;
  surfaceSubtle: string;
  surfaceHover: string;
  border: string;
  borderStrong: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentHover: string;
  accentSoft: string;
  accentRing: string;
  accentFg: string;
  accentText: string;
}

export interface ColorTheme {
  id: Exclude<ThemeId, "custom">;
  swatch: string;
  swatchDark: string;
  light: ThemeTokens;
  dark: ThemeTokens;
}

export const COLOR_THEMES = palettes as ColorTheme[];

export const THEME_IDS: readonly ThemeId[] = [
  ...COLOR_THEMES.map((theme) => theme.id),
  "custom",
];

/** The i18n key that names a palette, so a label can never fall out of sync. */
export function themeLabelKey(id: ThemeId): string {
  return `theme.${id}`;
}

export function isValidThemeId(id: unknown): id is Exclude<ThemeId, "custom"> {
  return typeof id === "string" && COLOR_THEMES.some((theme) => theme.id === id);
}

export function getThemeById(id: string): ColorTheme {
  return COLOR_THEMES.find((theme) => theme.id === id) ?? COLOR_THEMES[0]!;
}

export const DEFAULT_ACCENT = "#2563eb";

export function isValidHexColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value.trim());
}

/** Accepts `abc`, `#abc`, `a1b2c3` and `#A1B2C3`; returns `#a1b2c3` or null. */
export function normalizeHexColor(value: string): string | null {
  const trimmed = value.trim();
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  if (/^#[0-9a-fA-F]{6}$/.test(withHash)) {
    return withHash.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{3}$/.test(withHash)) {
    const [, r, g, b] = withHash;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return null;
}

/* ----------------------------------------------------------------- zoom --- */

export const ZOOM_PRESETS = [80, 90, 100, 110, 125, 150] as const;
export const ZOOM_MIN: number = ZOOM_PRESETS[0];
export const ZOOM_MAX: number = ZOOM_PRESETS[ZOOM_PRESETS.length - 1]!;

/** Snap an arbitrary number onto the nearest supported zoom step. */
export function clampZoomPercent(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 100;
  }
  let closest = 100;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const preset of ZOOM_PRESETS) {
    const diff = Math.abs(preset - num);
    if (diff < bestDiff) {
      bestDiff = diff;
      closest = preset;
    }
  }
  return closest;
}

export function nextZoom(current: number): number {
  return ZOOM_PRESETS.find((preset) => preset > current) ?? ZOOM_MAX;
}

export function previousZoom(current: number): number {
  const lower = [...ZOOM_PRESETS].reverse().find((preset) => preset < current);
  return lower ?? ZOOM_MIN;
}

/* -------------------------------------------------------------- colour --- */

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = (normalizeHexColor(hex) ?? DEFAULT_ACCENT).slice(1);
  return {
    r: Number.parseInt(clean.slice(0, 2), 16),
    g: Number.parseInt(clean.slice(2, 4), 16),
    b: Number.parseInt(clean.slice(4, 6), 16),
  };
}

function toByte(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) {
    return { h: 0, s: 0, l };
  }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) {
    h = (gn - bn) / d + (gn < bn ? 6 : 0);
  } else if (max === gn) {
    h = (bn - rn) / d + 2;
  } else {
    h = (rn - gn) / d + 4;
  }
  return { h: (h / 6) * 360, s, l };
}

function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(1, s));
  const lig = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lig - c / 2;
  let rgb: [number, number, number];
  if (hue < 60) {
    rgb = [c, x, 0];
  } else if (hue < 120) {
    rgb = [x, c, 0];
  } else if (hue < 180) {
    rgb = [0, c, x];
  } else if (hue < 240) {
    rgb = [0, x, c];
  } else if (hue < 300) {
    rgb = [x, 0, c];
  } else {
    rgb = [c, 0, x];
  }
  return rgbToHex((rgb[0] + m) * 255, (rgb[1] + m) * 255, (rgb[2] + m) * 255);
}

/** Black or white, whichever reads on the given accent. */
export function getContrastingForeground(hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  const toLinear = (value: number) => {
    const srgb = value / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  return luminance > 0.42 ? "#09090b" : "#ffffff";
}

export function resolveEffectiveThemeMode(mode: ThemeMode): "light" | "dark" {
  if (mode === "light" || mode === "dark") {
    return mode;
  }
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }
  return "light";
}

/**
 * Derive a full token set from one accent.
 *
 * A pale custom colour would make white-on-accent unreadable in light mode and a
 * near-black one would disappear on a dark canvas, so the accent is lifted or
 * deepened per mode before the foreground is chosen. Everything else is tinted
 * from the same hue at low saturation so cards and borders stay neutral.
 */
export function buildCustomThemeTokens(hex: string, mode: ThemeMode): ThemeTokens {
  const effectiveMode = resolveEffectiveThemeMode(mode);
  const normalized = normalizeHexColor(hex) ?? DEFAULT_ACCENT;
  const { r, g, b } = hexToRgb(normalized);
  const { h, s, l } = rgbToHsl(r, g, b);
  const subtleSat = Math.min(s, 0.35);

  if (effectiveMode === "light") {
    const accent = l > 0.84 ? hslToHex(h, Math.max(s, 0.25), 0.48) : normalized;
    const accentRgb = hexToRgb(accent);
    const accentHsl = rgbToHsl(accentRgb.r, accentRgb.g, accentRgb.b);
    const accentHover = hslToHex(accentHsl.h, accentHsl.s, Math.max(0.14, accentHsl.l - 0.08));
    return {
      canvas: hslToHex(h, subtleSat * 0.45, 0.985),
      surface: "#ffffff",
      surfaceSubtle: hslToHex(h, subtleSat * 0.55, 0.96),
      surfaceHover: hslToHex(h, subtleSat * 0.65, 0.93),
      border: hslToHex(h, subtleSat * 0.55, 0.89),
      borderStrong: hslToHex(h, subtleSat * 0.6, 0.81),
      textPrimary: hslToHex(h, Math.min(s, 0.25), 0.09),
      textSecondary: hslToHex(h, Math.min(s, 0.22), 0.32),
      textMuted: hslToHex(h, Math.min(s, 0.18), 0.46),
      accent,
      accentHover,
      accentSoft: `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.11)`,
      accentRing: `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.28)`,
      accentFg: getContrastingForeground(accent),
      // A custom accent is already lifted or deepened until it reads as text on
      // every surface, so one value serves both roles.
      accentText: accent,
    };
  }

  const accent = l < 0.34 ? hslToHex(h, Math.max(s, 0.35), 0.62) : normalized;
  const accentRgb = hexToRgb(accent);
  const accentHsl = rgbToHsl(accentRgb.r, accentRgb.g, accentRgb.b);
  const accentHover = hslToHex(accentHsl.h, accentHsl.s, Math.min(0.86, accentHsl.l + 0.09));
  return {
    canvas: hslToHex(h, subtleSat * 0.55, 0.055),
    surface: hslToHex(h, subtleSat * 0.55, 0.095),
    surfaceSubtle: hslToHex(h, subtleSat * 0.55, 0.135),
    surfaceHover: hslToHex(h, subtleSat * 0.55, 0.175),
    border: hslToHex(h, subtleSat * 0.55, 0.21),
    borderStrong: hslToHex(h, subtleSat * 0.55, 0.29),
    textPrimary: hslToHex(h, Math.min(s, 0.25), 0.96),
    textSecondary: hslToHex(h, Math.min(s, 0.28), 0.72),
    textMuted: hslToHex(h, Math.min(s, 0.24), 0.54),
    accent,
    accentHover,
    accentSoft: `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.16)`,
    accentRing: `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.32)`,
    accentFg: getContrastingForeground(accent),
    accentText: accent,
  };
}

/** The tokens for the active palette, mode and custom accent. */
export function resolveThemeTokens(
  themeId: ThemeId,
  mode: ThemeMode,
  customColor?: string,
): ThemeTokens {
  const effectiveMode = resolveEffectiveThemeMode(mode);
  if (themeId === "custom") {
    return buildCustomThemeTokens(customColor ?? DEFAULT_ACCENT, effectiveMode);
  }
  const theme = getThemeById(themeId);
  return effectiveMode === "dark" ? theme.dark : theme.light;
}

const TOKEN_VARIABLES: Record<keyof ThemeTokens, string> = {
  canvas: "--canvas",
  surface: "--surface",
  surfaceSubtle: "--surface-subtle",
  surfaceHover: "--surface-hover",
  border: "--border",
  borderStrong: "--border-strong",
  textPrimary: "--text-primary",
  textSecondary: "--text-secondary",
  textMuted: "--text-muted",
  accent: "--accent",
  accentHover: "--accent-hover",
  accentSoft: "--accent-soft",
  accentRing: "--accent-ring",
  accentFg: "--accent-fg",
  accentText: "--accent-text",
};

/**
 * Paint a palette onto the document.
 *
 * The palette is applied as custom properties rather than as a generated
 * stylesheet: one write per token on the root element, no style recalculation of
 * the whole tree and no flash of an unstyled intermediate theme. `color-scheme`
 * is set too, so the native scrollbar and the caret follow the mode.
 */
export function applyThemeToDocument(
  themeId: ThemeId,
  mode: ThemeMode,
  customColor?: string,
): "light" | "dark" {
  const effectiveMode = resolveEffectiveThemeMode(mode);
  const tokens = resolveThemeTokens(themeId, mode, customColor);

  if (typeof document !== "undefined") {
    const root = document.documentElement;
    for (const [key, variable] of Object.entries(TOKEN_VARIABLES)) {
      root.style.setProperty(variable, tokens[key as keyof ThemeTokens]);
    }
    root.dataset.themeId = themeId;
    root.dataset.mode = effectiveMode;
    root.style.colorScheme = effectiveMode;
    root.classList.toggle("dark", effectiveMode === "dark");
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute("content", tokens.surface);
    }
  }

  return effectiveMode;
}

export interface AccessibilityOptions {
  zoomPercent: number;
  highContrast: boolean;
  reducedMotion: boolean;
}

/** Zoom, contrast and motion are document-level; nothing here is a component. */
export function applyAccessibilityToDocument(options: AccessibilityOptions): number {
  const zoom = clampZoomPercent(options.zoomPercent);
  if (typeof document === "undefined") {
    return zoom;
  }
  const root = document.documentElement;
  root.classList.toggle("high-contrast", options.highContrast);
  root.classList.toggle("reduce-motion", options.reducedMotion);
  root.dataset.reduceMotion = String(options.reducedMotion);
  root.style.zoom = zoom === 100 ? "" : `${zoom}%`;
  return zoom;
}
