/**
 * Locale resolution and the `useT` hook.
 *
 * Tier A locales are release-gated (ADR-023): `en` and `tr` ship here. A locale
 * that exists in `AppState.locale` but has no catalogue falls back to English and
 * the UI says so once in the console - a silent fallback is how a product ends
 * up shipping English into a Turkish build.
 */

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { en } from "./en";
import type { MessageKey } from "./en";
import { format, type MessageParams } from "./format";
import { tr } from "./tr";
import { NOT_MEASURED } from "../shared/placeholder";

export type { MessageKey, MessageParams };

const CATALOGUES: Record<string, Record<MessageKey, string>> = {
  en,
  tr,
};

export const SUPPORTED_LOCALES = Object.keys(CATALOGUES);

/** The language the OS uses, mapped to a catalogue we actually have. */
export function negotiateLocale(requested: string | null | undefined): string {
  if (!requested) {
    return "en";
  }
  const exact = requested.toLowerCase();
  if (CATALOGUES[exact]) {
    return exact;
  }
  const base = exact.split("-")[0] ?? "en";
  if (CATALOGUES[base]) {
    return base;
  }
  return "en";
}

export function hasCatalogue(locale: string): boolean {
  return Boolean(CATALOGUES[locale]);
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

export function buildTranslator(locale: string): CallableTranslator {
  const active = negotiateLocale(locale);

  const lookup = (key: string): string | undefined =>
    CATALOGUES[active]?.[key as MessageKey] ?? en[key as MessageKey];

  const formatBytesFor = (value: number) => {
    // Imported lazily to keep this module free of a cycle with format.ts.
    return format("{v, bytes}", { v: value }, active);
  };

  const translate: Translate = (key, params) =>
    format(lookup(key) ?? key, params, active);

  return Object.assign(translate, {
    locale: active,
    t: translate,
    tKey: (key: string, params?: MessageParams) =>
      format(lookup(key) ?? key, params, active),
    formatBytes: formatBytesFor,
    formatDate: (iso: string | null | undefined) => {
      if (!iso) {
        return NOT_MEASURED;
      }
      const date = new Date(iso);
      return Number.isNaN(date.getTime()) ? NOT_MEASURED : dateFormat(active).format(date);
    },
    formatTime: (iso: string | null | undefined) => {
      if (!iso) {
        return NOT_MEASURED;
      }
      const date = new Date(iso);
      return Number.isNaN(date.getTime()) ? NOT_MEASURED : timeFormat(active).format(date);
    },
    formatRelative: (iso: string | null | undefined, now?: number) => {
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
        return relativeFormat(active).format(minutes, "minute");
      }
      const hours = Math.round(minutes / 60);
      if (Math.abs(hours) < 36) {
        return relativeFormat(active).format(hours, "hour");
      }
      return relativeFormat(active).format(Math.round(hours / 24), "day");
    },
    formatDuration: (ms: number) => {
      if (!Number.isFinite(ms) || ms <= 0) {
        return NOT_MEASURED;
      }
      if (ms < 1000) {
        return `${Math.round(ms)} ms`;
      }
      const seconds = ms / 1000;
      if (seconds < 60) {
        return `${new Intl.NumberFormat(active, { maximumFractionDigits: 1 }).format(seconds)} s`;
      }
      const minutes = Math.floor(seconds / 60);
      const remainder = Math.round(seconds % 60);
      return `${minutes} m ${remainder} s`;
    },
    collator: new Intl.Collator(active, { sensitivity: "base", numeric: true }),
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

  // `<html lang>` drives spell-check, hyphenation and screen-reader voice. It is
  // not decoration: getting it wrong makes Turkish text read with English
  // phonetics.
  useEffect(() => {
    document.documentElement.lang = translator.locale;
  }, [translator.locale]);

  /**
   * Say it once when a requested locale has no catalogue (DEF-140).
   *
   * This function is documented at the top of the file as the behaviour that
   * distinguishes an honest fallback from a silent one, and nothing called it:
   * `hasCatalogue` was exported and unused, so a store holding `de` rendered
   * English with no trace anywhere. A product that ships English into a German
   * install and says nothing is indistinguishable from one that has no German
   * support at all - and nobody can report it.
   */
  useEffect(() => {
    if (!locale || hasCatalogue(locale)) {
      return;
    }
    console.warn(
      `[zenith] no catalogue for locale "${locale}"; the UI is rendering ${translator.locale}.`,
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
