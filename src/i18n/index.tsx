/**
 * Locale resolution and the `useT` hook.
 *
 * Two layers, one lookup:
 *
 * * a **full catalogue** (`en`, `tr`) has every key, including every error and
 *   remedy the Rust core can emit;
 * * a **chrome layer** (`src/i18n/chrome`) translates the navigation, the
 *   settings tabs and the window controls for the languages with the largest
 *   Windows install base. Longer prose falls back to English, and Settings >
 *   Language says so before the choice is made.
 *
 * Every other language in `languages.ts` is still selectable: the window uses
 * that locale for dates, numbers and sorting, and renders English text. That is
 * a weaker promise than a translation, and it is written down rather than
 * implied.
 */

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { en } from "./en";
import type { MessageKey } from "./en";
import { format, type MessageParams } from "./format";
import { tr } from "./tr";
import { chromeFor } from "./chrome";
import {
  SUPPORTED_LANGUAGES,
  directionOf,
  isSupportedLanguage,
  languageMeta,
  resolveSystemLanguage,
} from "./languages";
import { NOT_MEASURED } from "../shared/placeholder";

export type { MessageKey, MessageParams };
export { SUPPORTED_LANGUAGES, directionOf, isSupportedLanguage, languageMeta };

const CATALOGUES: Record<string, Record<MessageKey, string>> = {
  en,
  tr,
};

/** Locales with every key translated. */
export const FULL_LOCALES = Object.keys(CATALOGUES);

/** Every locale the picker offers. */
export const SUPPORTED_LOCALES = SUPPORTED_LANGUAGES.map((language) => language.code);

/**
 * Resolve a requested tag onto a language the build knows.
 *
 * A chrome language keeps its own code so that `Intl` can format dates in it;
 * an unknown tag becomes `en` rather than the code of a language nobody
 * translated. Regional variants are resolved through the registry, which knows
 * that `zh-Hant` is Traditional and `nb` is Norwegian.
 */
export function negotiateLocale(requested: string | null | undefined): string {
  if (!requested) {
    return "en";
  }
  return resolveSystemLanguage([requested], "en");
}

export function hasCatalogue(locale: string): boolean {
  return Boolean(CATALOGUES[locale]);
}

export function hasChrome(locale: string): boolean {
  return hasCatalogue(locale) || Boolean(chromeFor(locale));
}

/**
 * The translator is callable *and* carries helpers.
 *
 * Calling it is the common case (`t("app.name")`); the helpers cover values
 * whose key only exists at runtime (`tKey`) and locale-aware formatting. Keeping
 * one object means a component never needs two hooks.
 */
export type Translate = (key: MessageKey, params?: MessageParams) => string;

export interface Translator {
  locale: string;
  /** The BCP-47 locale `Intl` should use; may be regional where the code is not. */
  intlLocale: string;
  dir: "ltr" | "rtl";
  /** True when every key is translated; false when English fills the prose. */
  full: boolean;
  /** Look up, then format. Unknown keys fall back to English, then to the key. */
  t: Translate;
  /** For keys that arrive from the core as strings and cannot be typed. */
  tKey: (key: string, params?: MessageParams) => string;
  formatBytes: (value: number) => string;
  formatDate: (iso: string | null | undefined) => string;
  formatTime: (iso: string | null | undefined) => string;
  /**
   * `now` is optional and exists so a surface that already ticks with `useNow`
   * passes its tick in: the formatted string and the render are then driven by
   * the same instant (DEF-138). Left out, it reads `Date.now()`.
   */
  formatRelative: (iso: string | null | undefined, now?: number) => string;
  formatDuration: (ms: number) => string;
  /** A date in the user's chosen order, independent of the OS default. */
  formatDatePattern: (
    iso: string | null | undefined,
    style: "iso" | "dmy" | "mdy",
  ) => string;
  /** A clock time in the user's chosen 12/24-hour form. */
  formatClock: (date: Date, twelveHour: boolean) => string;
  /** `Intl` collator so Turkish `ı/i` sorting is right. */
  collator: Intl.Collator;
}

export type CallableTranslator = Translator & Translate;

const I18nContext = createContext<CallableTranslator | null>(null);

const dateFormats = new Map<string, Intl.DateTimeFormat>();

function dateFormat(locale: string): Intl.DateTimeFormat {
  let format = dateFormats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    dateFormats.set(locale, format);
  }
  return format;
}

/**
 * `formatTime` is called once per log row. Constructing a `DateTimeFormat` per
 * row is the cost the two maps above exist to avoid, and this one was missed
 * (DEF-142): a 5,000-line log built 5,000 formatters on every render.
 */
const timeFormats = new Map<string, Intl.DateTimeFormat>();

function timeFormat(locale: string): Intl.DateTimeFormat {
  let format = timeFormats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { timeStyle: "short" });
    timeFormats.set(locale, format);
  }
  return format;
}

const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();

function relativeFormat(locale: string): Intl.RelativeTimeFormat {
  let format = relativeFormats.get(locale);
  if (!format) {
    format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    relativeFormats.set(locale, format);
  }
  return format;
}

/** Pattern formatters are keyed by locale + order; both are user choices. */
const patternFormats = new Map<string, Intl.DateTimeFormat>();

function patternFormat(locale: string, style: "iso" | "dmy" | "mdy"): Intl.DateTimeFormat {
  const key = `${locale}:${style}`;
  let formatter = patternFormats.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    patternFormats.set(key, formatter);
  }
  return formatter;
}

/**
 * Reassemble a localised date in the order the user chose.
 *
 * `formatToParts` supplies the digits and the separator in the user's own
 * script; only the order is overridden. Constructing a pattern string and
 * passing it back to `Intl` would lose the locale's calendar for some regions,
 * so the parts are joined here instead.
 */
function formatPattern(
  locale: string,
  style: "iso" | "dmy" | "mdy",
  date: Date,
): string {
  const parts = patternFormat(locale, style).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const separator = parts.find((part) => part.type === "literal")?.value ?? ".";
  const order =
    style === "iso"
      ? (["year", "month", "day"] as const)
      : style === "mdy"
        ? (["month", "day", "year"] as const)
        : (["day", "month", "year"] as const);
  return order.map((type) => byType.get(type) ?? "").join(separator);
}

const clockFormats = new Map<string, Intl.DateTimeFormat>();

function clockFormat(locale: string, twelveHour: boolean): Intl.DateTimeFormat {
  const key = `${locale}:${twelveHour ? "12" : "24"}`;
  let formatter = clockFormats.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      hour: twelveHour ? "numeric" : "2-digit",
      minute: "2-digit",
      hour12: twelveHour,
    });
    clockFormats.set(key, formatter);
  }
  return formatter;
}

export function buildTranslator(locale: string): CallableTranslator {
  const active = negotiateLocale(locale);
  const meta = languageMeta(active);
  const chrome = chromeFor(active);
  const full = Boolean(CATALOGUES[active]);

  const lookup = (key: string): string | undefined =>
    CATALOGUES[active]?.[key as MessageKey] ??
    chrome?.[key as MessageKey] ??
    en[key as MessageKey];

  const formatBytesFor = (value: number) => {
    // Imported lazily to keep this module free of a cycle with format.ts.
    return format("{v, bytes}", { v: value }, meta.intlLocale);
  };

  const translate: Translate = (key, params) =>
    format(lookup(key) ?? key, params, meta.intlLocale);

  const formatRelative = (iso: string | null | undefined, now?: number) => {
    if (!iso) {
      return NOT_MEASURED;
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return NOT_MEASURED;
    }
    const deltaMs = date.getTime() - (now ?? Date.now());
    const minutes = Math.round(deltaMs / 60_000);
    if (Math.abs(minutes) < 60) {
      return relativeFormat(meta.intlLocale).format(minutes, "minute");
    }
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 36) {
      return relativeFormat(meta.intlLocale).format(hours, "hour");
    }
    return relativeFormat(meta.intlLocale).format(Math.round(hours / 24), "day");
  };

  return Object.assign(translate, {
    locale: active,
    intlLocale: meta.intlLocale,
    dir: meta.dir,
    full,
    t: translate,
    tKey: (key: string, params?: MessageParams) =>
      format(lookup(key) ?? key, params, meta.intlLocale),
    formatBytes: formatBytesFor,
    formatDate: (iso: string | null | undefined) => {
      if (!iso) {
        return NOT_MEASURED;
      }
      const date = new Date(iso);
      return Number.isNaN(date.getTime()) ? NOT_MEASURED : dateFormat(meta.intlLocale).format(date);
    },
    formatTime: (iso: string | null | undefined) => {
      if (!iso) {
        return NOT_MEASURED;
      }
      const date = new Date(iso);
      return Number.isNaN(date.getTime()) ? NOT_MEASURED : timeFormat(meta.intlLocale).format(date);
    },
    formatRelative,
    formatDuration: (ms: number) => {
      if (!Number.isFinite(ms) || ms <= 0) {
        return NOT_MEASURED;
      }
      if (ms < 1000) {
        return `${Math.round(ms)} ms`;
      }
      const seconds = ms / 1000;
      if (seconds < 60) {
        return `${new Intl.NumberFormat(meta.intlLocale, { maximumFractionDigits: 1 }).format(seconds)} s`;
      }
      const minutes = Math.floor(seconds / 60);
      const remainder = Math.round(seconds % 60);
      return `${minutes} m ${remainder} s`;
    },
    formatDatePattern: (iso: string | null | undefined, style: "iso" | "dmy" | "mdy") => {
      if (!iso) {
        return NOT_MEASURED;
      }
      const date = new Date(iso);
      return Number.isNaN(date.getTime()) ? NOT_MEASURED : formatPattern(meta.intlLocale, style, date);
    },
    formatClock: (date: Date, twelveHour: boolean) =>
      Number.isNaN(date.getTime())
        ? NOT_MEASURED
        : clockFormat(meta.intlLocale, twelveHour).format(date),
    collator: new Intl.Collator(meta.intlLocale, { sensitivity: "base", numeric: true }),
  });
}

export function I18nProvider({
  locale,
  children,
}: {
  locale: string;
  children: ReactNode;
}) {
  const translator = useMemo(() => buildTranslator(locale), [locale]);

  // `<html lang>` and `<html dir>` drive spell-check, hyphenation, screen-reader
  // voice and the physical side a menu opens from. Both are not decoration:
  // reading Turkish with English phonetics, or an Urdu menu that opens on the
  // wrong side, are visible defects even when every string is correct.
  useEffect(() => {
    document.documentElement.lang = translator.locale;
    document.documentElement.dir = translator.dir;
  }, [translator.locale, translator.dir]);

  /**
   * Say it once when a requested locale has neither a catalogue nor chrome
   * (DEF-140).
   *
   * This function is documented at the top of the file as the behaviour that
   * distinguishes an honest fallback from a silent one, and nothing called it:
   * `hasCatalogue` was exported and unused, so a store holding `de` rendered
   * English with no trace anywhere. The product now translates a chrome layer
   * for the largest languages and discloses the rest in Settings; a language
   * with neither is still reported to the console so a support case can see it.
   */
  useEffect(() => {
    if (!locale || hasChrome(locale)) {
      return;
    }
    console.warn(
      `[zenith] no catalogue or chrome for locale "${locale}"; the UI is rendering ${translator.locale}.`,
    );
  }, [locale, translator.locale]);

  return <I18nContext.Provider value={translator}>{children}</I18nContext.Provider>;
}

export function useT(): CallableTranslator {
  const translator = useContext(I18nContext);
  if (!translator) {
    throw new Error("useT() outside I18nProvider");
  }
  return translator;
}

/**
 * Re-render once a minute so relative timestamps ("2 minutes ago") stay true.
 * One shared timer beats one per component.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
