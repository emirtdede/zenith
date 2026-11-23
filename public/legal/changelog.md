# Changelog

All notable changes to Zenith are recorded here. The format follows Keep a
Changelog, and the version numbers follow semantic versioning.

## 1.0.0 - 23 November 2026

First public release.

### Added

- A 14-palette design system with light and dark modes, a custom hex palette, 15
  semantic tokens, bundled DM Sans, Plus Jakarta Sans, and JetBrains Mono, and an
  automated 520-check WCAG contrast gate.
- A frameless shell with a full and minimal sidebar, window controls, an offline
  indicator, toast stack, application context menu with Shift+F10 and Menu key
  support, and reduced-motion and high-contrast modes.
- A settings surface of 3 groups and 12 leaves where the tab name and the panel
  heading are the same string: Appearance, Accessibility, General, Language,
  Shortcuts, Notifications, Data and Backup, Trash, CLI and MCP, Webhook, Legal,
  and Update and About.
- A 73-language registry with 2 complete catalogues, 12 chrome translations, and
  English fallback disclosed in the picker. Right-to-left direction is derived
  from the locale.
- A first-run guide with the full language grid, a palette chooser, a privacy
  statement, and a replay entry in Settings.
- A 4, 6, or 8 digit PIN and a password option, hashed with PBKDF2-HMAC-SHA256 at
  600,000 iterations, with a persisted five-attempt lockout.
- Notification presets and a per-kind in-app and native channel matrix, with
  quiet hours.
- A 30-day trash with restore, permanent delete, and empty, plus a settings
  export and import that includes the trash.
- In-app readers for the privacy policy, terms, KVKK and GDPR notice, third-party
  licences, accessibility statement, security policy, support policy,
  contributing guide, code of conduct, and this changelog.
- A GitHub Releases update check with semantic version comparison. The Microsoft
  Store channel reports availability and never downloads an installer itself.

### Changed

- Theme ids are now the 14 palette ids plus `custom`. Stored `true-black`,
  `spatial-glass`, and `off-white` values migrate to `obsidian` or `slate`.
- Theme and locale changes are written as one section patch instead of a
  four-field preference save.
- The settings document is stored as one versioned JSON blob in the existing
  preferences patch. The IPC surface remains at 15 commands.

### Security

- Preference and audit writes are atomic.
- The renderer has no filesystem, shell, or network plugin permission.
- Logs and support bundles pass a redaction filter before they are written.

### Known limitations

- The MCP stdio server, the loopback local API, and the webhook sender are
  documented in the interface but are not implemented in this release.
- 71 of the 73 languages fall back to English outside the translated chrome.
- The setup and uninstall wizard still uses the Tauri template, not the Vellium
  monochrome design.
