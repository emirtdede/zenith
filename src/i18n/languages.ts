/**
 * The 73-language registry.
 *
 * Two things live here that a UI must not invent per component:
 *
 * 1. **The list itself.** A language picker that hard-codes 12 languages and a
 *    fallback table that knows 20 is how a product ends up offering Bengali and
 *    rendering English. This table is the single answer to "which languages do
 *    we claim", and `scripts/check-languages.mjs` holds every entry to the
 *    contract: a valid BCP-47 code, a native name, a direction and an `Intl`
 *    locale that `Intl.DateTimeFormat` actually accepts.
 *
 * 2. **Direction.** Arabic, Persian, Urdu and Hebrew are RTL. `dir` is a field,
 *    not a guess from the code, because a guess is how `ur` ends up left
 *    aligned for a release.
 *
 * Full message catalogues exist for `en` and `tr` (release-gated on key parity).
 * Every other language carries a translated *chrome* layer - navigation, the
 * settings tab names and the handful of verbs a user meets before reading any
 * prose - and falls back to English for the rest. The fallback is disclosed in
 * Settings > General, because a silent English string in a Hindi window is
 * indistinguishable from a product that does not support Hindi.
 */

export interface LanguageMeta {
  code: string;
  nativeName: string;
  englishName: string;
  intlLocale: string;
  dir: "ltr" | "rtl";
}

export const SUPPORTED_LANGUAGES: readonly LanguageMeta[] = [
  { code: "tr", nativeName: "Türkçe", englishName: "Turkish", intlLocale: "tr-TR", dir: "ltr" },
  { code: "en", nativeName: "English", englishName: "English", intlLocale: "en-US", dir: "ltr" },
  { code: "de", nativeName: "Deutsch", englishName: "German", intlLocale: "de-DE", dir: "ltr" },
  { code: "fr", nativeName: "Français", englishName: "French", intlLocale: "fr-FR", dir: "ltr" },
  { code: "es", nativeName: "Español", englishName: "Spanish", intlLocale: "es-ES", dir: "ltr" },
  { code: "it", nativeName: "Italiano", englishName: "Italian", intlLocale: "it-IT", dir: "ltr" },
  { code: "pt", nativeName: "Português", englishName: "Portuguese", intlLocale: "pt-PT", dir: "ltr" },
  { code: "pt-BR", nativeName: "Português (Brasil)", englishName: "Brazilian Portuguese", intlLocale: "pt-BR", dir: "ltr" },
  { code: "ru", nativeName: "Русский", englishName: "Russian", intlLocale: "ru-RU", dir: "ltr" },
  { code: "ja", nativeName: "日本語", englishName: "Japanese", intlLocale: "ja-JP", dir: "ltr" },
  { code: "ko", nativeName: "한국어", englishName: "Korean", intlLocale: "ko-KR", dir: "ltr" },
  { code: "zh-CN", nativeName: "简体中文", englishName: "Simplified Chinese", intlLocale: "zh-CN", dir: "ltr" },
  { code: "zh-TW", nativeName: "繁體中文", englishName: "Traditional Chinese", intlLocale: "zh-TW", dir: "ltr" },
  { code: "ar", nativeName: "العربية", englishName: "Arabic", intlLocale: "ar-SA", dir: "rtl" },
  { code: "hi", nativeName: "हिन्दी", englishName: "Hindi", intlLocale: "hi-IN", dir: "ltr" },
  { code: "bn", nativeName: "বাংলা", englishName: "Bengali", intlLocale: "bn-BD", dir: "ltr" },
  { code: "pa", nativeName: "ਪੰਜਾਬੀ", englishName: "Punjabi", intlLocale: "pa-IN", dir: "ltr" },
  { code: "ur", nativeName: "اردو", englishName: "Urdu", intlLocale: "ur-PK", dir: "rtl" },
  { code: "fa", nativeName: "فارسی", englishName: "Persian", intlLocale: "fa-IR", dir: "rtl" },
  { code: "he", nativeName: "עברית", englishName: "Hebrew", intlLocale: "he-IL", dir: "rtl" },
  { code: "nl", nativeName: "Nederlands", englishName: "Dutch", intlLocale: "nl-NL", dir: "ltr" },
  { code: "pl", nativeName: "Polski", englishName: "Polish", intlLocale: "pl-PL", dir: "ltr" },
  { code: "uk", nativeName: "Українська", englishName: "Ukrainian", intlLocale: "uk-UA", dir: "ltr" },
  { code: "cs", nativeName: "Čeština", englishName: "Czech", intlLocale: "cs-CZ", dir: "ltr" },
  { code: "sk", nativeName: "Slovenčina", englishName: "Slovak", intlLocale: "sk-SK", dir: "ltr" },
  { code: "hu", nativeName: "Magyar", englishName: "Hungarian", intlLocale: "hu-HU", dir: "ltr" },
  { code: "ro", nativeName: "Română", englishName: "Romanian", intlLocale: "ro-RO", dir: "ltr" },
  { code: "bg", nativeName: "Български", englishName: "Bulgarian", intlLocale: "bg-BG", dir: "ltr" },
  { code: "el", nativeName: "Ελληνικά", englishName: "Greek", intlLocale: "el-GR", dir: "ltr" },
  { code: "sv", nativeName: "Svenska", englishName: "Swedish", intlLocale: "sv-SE", dir: "ltr" },
  { code: "da", nativeName: "Dansk", englishName: "Danish", intlLocale: "da-DK", dir: "ltr" },
  { code: "no", nativeName: "Norsk", englishName: "Norwegian", intlLocale: "nb-NO", dir: "ltr" },
  { code: "fi", nativeName: "Suomi", englishName: "Finnish", intlLocale: "fi-FI", dir: "ltr" },
  { code: "is", nativeName: "Íslenska", englishName: "Icelandic", intlLocale: "is-IS", dir: "ltr" },
  { code: "et", nativeName: "Eesti", englishName: "Estonian", intlLocale: "et-EE", dir: "ltr" },
  { code: "lv", nativeName: "Latviešu", englishName: "Latvian", intlLocale: "lv-LV", dir: "ltr" },
  { code: "lt", nativeName: "Lietuvių", englishName: "Lithuanian", intlLocale: "lt-LT", dir: "ltr" },
  { code: "hr", nativeName: "Hrvatski", englishName: "Croatian", intlLocale: "hr-HR", dir: "ltr" },
  { code: "sr", nativeName: "Српски", englishName: "Serbian", intlLocale: "sr-RS", dir: "ltr" },
  { code: "sl", nativeName: "Slovenščina", englishName: "Slovenian", intlLocale: "sl-SI", dir: "ltr" },
  { code: "bs", nativeName: "Bosanski", englishName: "Bosnian", intlLocale: "bs-BA", dir: "ltr" },
  { code: "mk", nativeName: "Македонски", englishName: "Macedonian", intlLocale: "mk-MK", dir: "ltr" },
  { code: "sq", nativeName: "Shqip", englishName: "Albanian", intlLocale: "sq-AL", dir: "ltr" },
  { code: "az", nativeName: "Azərbaycan", englishName: "Azerbaijani", intlLocale: "az-AZ", dir: "ltr" },
  { code: "kk", nativeName: "Қазақша", englishName: "Kazakh", intlLocale: "kk-KZ", dir: "ltr" },
  { code: "uz", nativeName: "Oʻzbekcha", englishName: "Uzbek", intlLocale: "uz-UZ", dir: "ltr" },
  { code: "ky", nativeName: "Кыргызча", englishName: "Kyrgyz", intlLocale: "ky-KG", dir: "ltr" },
  { code: "tk", nativeName: "Türkmençe", englishName: "Turkmen", intlLocale: "tk-TM", dir: "ltr" },
  { code: "ka", nativeName: "ქართული", englishName: "Georgian", intlLocale: "ka-GE", dir: "ltr" },
  { code: "hy", nativeName: "Հայերեն", englishName: "Armenian", intlLocale: "hy-AM", dir: "ltr" },
  { code: "id", nativeName: "Bahasa Indonesia", englishName: "Indonesian", intlLocale: "id-ID", dir: "ltr" },
  { code: "ms", nativeName: "Bahasa Melayu", englishName: "Malay", intlLocale: "ms-MY", dir: "ltr" },
  { code: "vi", nativeName: "Tiếng Việt", englishName: "Vietnamese", intlLocale: "vi-VN", dir: "ltr" },
  { code: "th", nativeName: "ไทย", englishName: "Thai", intlLocale: "th-TH", dir: "ltr" },
  { code: "tl", nativeName: "Filipino", englishName: "Filipino", intlLocale: "fil-PH", dir: "ltr" },
  { code: "km", nativeName: "ខ្មែរ", englishName: "Khmer", intlLocale: "km-KH", dir: "ltr" },
  { code: "lo", nativeName: "ລາວ", englishName: "Lao", intlLocale: "lo-LA", dir: "ltr" },
  { code: "my", nativeName: "မြန်မာ", englishName: "Burmese", intlLocale: "my-MM", dir: "ltr" },
  { code: "ta", nativeName: "தமிழ்", englishName: "Tamil", intlLocale: "ta-IN", dir: "ltr" },
  { code: "te", nativeName: "తెలుగు", englishName: "Telugu", intlLocale: "te-IN", dir: "ltr" },
  { code: "mr", nativeName: "मराठी", englishName: "Marathi", intlLocale: "mr-IN", dir: "ltr" },
  { code: "gu", nativeName: "ગુજરાતી", englishName: "Gujarati", intlLocale: "gu-IN", dir: "ltr" },
  { code: "kn", nativeName: "ಕನ್ನಡ", englishName: "Kannada", intlLocale: "kn-IN", dir: "ltr" },
  { code: "ml", nativeName: "മലയാളം", englishName: "Malayalam", intlLocale: "ml-IN", dir: "ltr" },
  { code: "si", nativeName: "සිංහල", englishName: "Sinhala", intlLocale: "si-LK", dir: "ltr" },
  { code: "ne", nativeName: "नेपाली", englishName: "Nepali", intlLocale: "ne-NP", dir: "ltr" },
  { code: "sw", nativeName: "Kiswahili", englishName: "Swahili", intlLocale: "sw-KE", dir: "ltr" },
  { code: "am", nativeName: "አማርኛ", englishName: "Amharic", intlLocale: "am-ET", dir: "ltr" },
  { code: "af", nativeName: "Afrikaans", englishName: "Afrikaans", intlLocale: "af-ZA", dir: "ltr" },
  { code: "ca", nativeName: "Català", englishName: "Catalan", intlLocale: "ca-ES", dir: "ltr" },
  { code: "eu", nativeName: "Euskara", englishName: "Basque", intlLocale: "eu-ES", dir: "ltr" },
  { code: "gl", nativeName: "Galego", englishName: "Galician", intlLocale: "gl-ES", dir: "ltr" },
  { code: "cy", nativeName: "Cymraeg", englishName: "Welsh", intlLocale: "cy-GB", dir: "ltr" },
];

const BY_CODE = new Map(SUPPORTED_LANGUAGES.map((language) => [language.code.toLowerCase(), language]));
const BY_INTL = new Map(SUPPORTED_LANGUAGES.map((language) => [language.intlLocale.toLowerCase(), language]));

export const LANGUAGE_COUNT = SUPPORTED_LANGUAGES.length;

export function isSupportedLanguage(code: unknown): code is string {
  return typeof code === "string" && BY_CODE.has(code.toLowerCase());
}

export function languageMeta(code: string | null | undefined): LanguageMeta {
  if (code) {
    const exact = BY_CODE.get(code.toLowerCase());
    if (exact) {
      return exact;
    }
  }
  return BY_CODE.get("en")!;
}

export function directionOf(code: string | null | undefined): "ltr" | "rtl" {
  return languageMeta(code).dir;
}

/**
 * Map an OS locale list onto the registry.
 *
 * Order matters: `navigator.languages` is the user's own preference order, so
 * the first entry that resolves wins. `zh-Hant` and `pt-BR` have their own
 * entries and are checked before the base-language fallback, which is the
 * difference between a Taiwanese user reading Traditional or Simplified.
 */
export function resolveSystemLanguage(
  candidates?: readonly string[] | null,
  fallback = "en",
): string {
  if (!candidates || candidates.length === 0) {
    return fallback;
  }

  for (const raw of candidates) {
    if (typeof raw !== "string") {
      continue;
    }
    const normalized = raw.trim().replace(/_/g, "-").toLowerCase();
    if (!normalized) {
      continue;
    }
    const exact = BY_CODE.get(normalized) ?? BY_INTL.get(normalized);
    if (exact) {
      return exact.code;
    }
    if (/^zh-(tw|hk|mo)/.test(normalized) || normalized.includes("hant")) {
      return "zh-TW";
    }
    if (normalized.startsWith("zh")) {
      return "zh-CN";
    }
    if (normalized.startsWith("pt-br")) {
      return "pt-BR";
    }
    if (/^(nb|nn|no)/.test(normalized)) {
      return "no";
    }
    if (/^(fil|tl)/.test(normalized)) {
      return "tl";
    }
    if (/^(iw|he)/.test(normalized)) {
      return "he";
    }
    if (/^(in|id)/.test(normalized)) {
      return "id";
    }
    const base = normalized.split("-")[0] ?? "";
    const baseMatch = BY_CODE.get(base);
    if (baseMatch) {
      return baseMatch.code;
    }
  }

  return fallback;
}
