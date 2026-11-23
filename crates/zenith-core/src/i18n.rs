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
pub const SUPPORTED_LOCALES: &[&str] = &["en", "tr"];

/// Locales the product is willing to *display* in a picker, with their own name.
/// The endonym is not translated: a Turkish user looking for English looks for
/// "English", not "İngilizce".
pub const LOCALE_CHOICES: &[(&str, &str)] = &[("en", "English"), ("tr", "Türkçe")];

/// Whether `locale` may be stored as a preference.
///
/// Accepts a full tag (`tr-TR`) only when its base language is supported, so a
/// Windows locale of `tr-TR` resolves instead of being rejected outright.
pub fn supports(locale: &str) -> bool {
    let lowered = locale.to_ascii_lowercase();
    if SUPPORTED_LOCALES.contains(&lowered.as_str()) {
        return true;
    }
    match lowered.split(['-', '_']).next() {
        Some(base) => SUPPORTED_LOCALES.contains(&base),
        None => false,
    }
}

/// Resolve an OS tag to a catalogue that exists, mirroring the renderer's
/// `negotiateLocale`. Kept in sync by `tests::negotiation_matches_the_renderer`.
pub fn negotiate(locale: &str) -> &'static str {
    let lowered = locale.to_ascii_lowercase();
    if let Some(exact) = SUPPORTED_LOCALES.iter().find(|item| **item == lowered) {
        return exact;
    }
    let base = lowered.split(['-', '_']).next().unwrap_or("en");
    SUPPORTED_LOCALES
        .iter()
        .find(|item| **item == base)
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
        assert!(!supports("de-DE"));
        assert_eq!(negotiate("tr-TR"), "tr");
        assert_eq!(negotiate("en-US"), "en");
        assert_eq!(negotiate("de-DE"), "en");
        assert_eq!(negotiate(""), "en");
    }

    #[test]
    fn english_is_always_the_fallback() {
        assert!(SUPPORTED_LOCALES.contains(&"en"));
        assert_eq!(negotiate("zz"), "en");
    }
}
