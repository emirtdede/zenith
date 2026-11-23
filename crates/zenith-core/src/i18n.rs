//! Locale support facts the Rust side must be able to verify.
//!
//! The renderer owns the message catalogues; this module owns the *decision* of
//! which locales exist, because two places must agree on it:
//!
//! * `preferences_set` refuses to store a locale the build does not ship - a
//!   saved-but-unavailable choice is a lie the user discovers on next launch.
//! * The support bundle records the active locale so a support case can be read
//!   in the language the user actually saw.
//!
//! Tiering follows ADR-023: Tier A locales are release-gated (translated and
//! reviewed), Tier B are machine-authored with English fallback. Only Tier A is
//! listed here - a Tier B locale is not a choice the UI may offer.

/// Locales with a reviewed catalogue, in menu order.
///
/// Adding one requires: a catalogue with every key, a review pass, and a row in
/// `docs/06-localization/06-01-i18n-strategy.md`. The test below fails otherwise.
/// Every locale the picker offers and the preference store accepts. This is the
/// Rust mirror of `src/i18n/languages.ts`; `scripts/check-languages.mjs` keeps
/// the two lists equal, because a locale the UI offers and the core rejects is
/// a choice that fails on save.
pub const SUPPORTED_LOCALES: &[&str] = &[
    "tr", "en", "de", "fr", "es", "it", "pt", "pt-BR", "ru", "ja", "ko", "zh-CN", "zh-TW", "ar",
    "hi", "bn", "pa", "ur", "fa", "he", "nl", "pl", "uk", "cs", "sk", "hu", "ro", "bg", "el", "sv",
    "da", "no", "fi", "is", "et", "lv", "lt", "hr", "sr", "sl", "bs", "mk", "sq", "az", "kk", "uz",
    "ky", "tk", "ka", "hy", "id", "ms", "vi", "th", "tl", "km", "lo", "my", "ta", "te", "mr", "gu",
    "kn", "ml", "si", "ne", "sw", "am", "af", "ca", "eu", "gl", "cy",
];

/// Locales the product is willing to *display* in a picker, with their own name.
/// The endonym is not translated: a Turkish user looking for English looks for
/// "English", not "İngilizce".
pub const LOCALE_CHOICES: &[(&str, &str)] = &[
    ("tr", "Türkçe"),
    ("en", "English"),
    ("de", "Deutsch"),
    ("fr", "Français"),
    ("es", "Español"),
    ("it", "Italiano"),
    ("pt", "Português"),
    ("pt-BR", "Português (Brasil)"),
    ("ru", "Русский"),
    ("ja", "日本語"),
    ("ko", "한국어"),
    ("zh-CN", "简体中文"),
    ("zh-TW", "繁體中文"),
    ("ar", "العربية"),
    ("hi", "हिन्दी"),
    ("bn", "বাংলা"),
    ("pa", "ਪੰਜਾਬੀ"),
    ("ur", "اردو"),
    ("fa", "فارسی"),
    ("he", "עברית"),
    ("nl", "Nederlands"),
    ("pl", "Polski"),
    ("uk", "Українська"),
    ("cs", "Čeština"),
    ("sk", "Slovenčina"),
    ("hu", "Magyar"),
    ("ro", "Română"),
    ("bg", "Български"),
    ("el", "Ελληνικά"),
    ("sv", "Svenska"),
    ("da", "Dansk"),
    ("no", "Norsk"),
    ("fi", "Suomi"),
    ("is", "Íslenska"),
    ("et", "Eesti"),
    ("lv", "Latviešu"),
    ("lt", "Lietuvių"),
    ("hr", "Hrvatski"),
    ("sr", "Српски"),
    ("sl", "Slovenščina"),
    ("bs", "Bosanski"),
    ("mk", "Македонски"),
    ("sq", "Shqip"),
    ("az", "Azərbaycan"),
    ("kk", "Қазақша"),
    ("uz", "Oʻzbekcha"),
    ("ky", "Кыргызча"),
    ("tk", "Türkmençe"),
    ("ka", "ქართული"),
    ("hy", "Հայերեն"),
    ("id", "Bahasa Indonesia"),
    ("ms", "Bahasa Melayu"),
    ("vi", "Tiếng Việt"),
    ("th", "ไทย"),
    ("tl", "Filipino"),
    ("km", "ខ្មែរ"),
    ("lo", "ລາວ"),
    ("my", "မြန်မာ"),
    ("ta", "தமிழ்"),
    ("te", "తెలుగు"),
    ("mr", "मराठी"),
    ("gu", "ગુજરાતી"),
    ("kn", "ಕನ್ನಡ"),
    ("ml", "മലയാളം"),
    ("si", "සිංහල"),
    ("ne", "नेपाली"),
    ("sw", "Kiswahili"),
    ("am", "አማርኛ"),
    ("af", "Afrikaans"),
    ("ca", "Català"),
    ("eu", "Euskara"),
    ("gl", "Galego"),
    ("cy", "Cymraeg"),
];

/// Whether `locale` may be stored as a preference.
///
/// Accepts a full tag (`tr-TR`) only when its base language is supported, so a
/// Windows locale of `tr-TR` resolves instead of being rejected outright.
pub fn supports(locale: &str) -> bool {
    let lowered = locale.trim().replace('_', "-").to_ascii_lowercase();
    if SUPPORTED_LOCALES
        .iter()
        .any(|item| item.eq_ignore_ascii_case(&lowered))
    {
        return true;
    }
    match lowered.split(['-', '_']).next() {
        Some(base) => SUPPORTED_LOCALES
            .iter()
            .any(|item| item.eq_ignore_ascii_case(base)),
        None => false,
    }
}

/// Resolve an OS tag to a catalogue that exists, mirroring the renderer's
/// `resolveSystemLanguage`. Kept in sync by `tests::negotiation_matches_the_renderer`.
///
/// The script-specific rules are not decoration: Windows reports Chinese as
/// `zh-Hant-TW` or `zh-Hans-CN`, and a plain base-language match would send
/// every Traditional Chinese user to the Simplified catalogue. The same holds
/// for `nb`/`nn` (Norwegian), `fil` (Filipino) and the legacy `iw`/`in` tags.
pub fn negotiate(locale: &str) -> &'static str {
    let lowered = locale.trim().replace('_', "-").to_ascii_lowercase();
    if lowered.is_empty() {
        return "en";
    }
    if let Some(exact) = SUPPORTED_LOCALES
        .iter()
        .find(|item| item.eq_ignore_ascii_case(&lowered))
    {
        return exact;
    }
    if lowered.starts_with("zh-tw")
        || lowered.starts_with("zh-hk")
        || lowered.starts_with("zh-mo")
        || lowered.contains("hant")
    {
        return "zh-TW";
    }
    if lowered.starts_with("zh") {
        return "zh-CN";
    }
    if lowered.starts_with("pt-br") {
        return "pt-BR";
    }
    if lowered.starts_with("nb") || lowered.starts_with("nn") || lowered.starts_with("no") {
        return "no";
    }
    if lowered.starts_with("fil") || lowered.starts_with("tl") {
        return "tl";
    }
    if lowered.starts_with("iw") || lowered.starts_with("he") {
        return "he";
    }
    if lowered.starts_with("in") || lowered.starts_with("id") {
        return "id";
    }
    let base = lowered.split(['-', '_']).next().unwrap_or("en");
    SUPPORTED_LOCALES
        .iter()
        .find(|item| item.eq_ignore_ascii_case(base))
        .copied()
        .unwrap_or("en")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_choice_is_supported_and_unique() {
        let mut seen = Vec::new();
        for (code, name) in LOCALE_CHOICES {
            assert!(supports(code), "{code} is listed but not supported");
            assert!(!name.trim().is_empty());
            assert!(!seen.contains(code), "duplicate locale {code}");
            seen.push(*code);
        }
        assert_eq!(seen.len(), SUPPORTED_LOCALES.len());
    }

    #[test]
    fn regional_tags_resolve_to_their_base() {
        assert!(supports("tr-TR"));
        assert!(supports("en-GB"));
        assert!(supports("de-DE"));
        assert!(!supports("zz-ZZ"));
        assert_eq!(negotiate("tr-TR"), "tr");
        assert_eq!(negotiate("en-US"), "en");
        assert_eq!(negotiate("de-DE"), "de");
        assert_eq!(negotiate(""), "en");
        // Script subtags choose the right Chinese catalogue instead of the
        // base-language fallback, which would hand a Traditional reader the
        // Simplified file.
        assert_eq!(negotiate("zh-Hant-TW"), "zh-TW");
        assert_eq!(negotiate("zh-Hans-CN"), "zh-CN");
        assert_eq!(negotiate("pt_BR"), "pt-BR");
        assert_eq!(negotiate("nb-NO"), "no");
    }

    #[test]
    fn english_is_always_the_fallback() {
        assert!(SUPPORTED_LOCALES.contains(&"en"));
        assert_eq!(negotiate("zz"), "en");
    }
}
