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
  indicator, toast stack, an application context menu with a text group (cut,
  copy, paste, select all) reachable by right click, Shift+F10, or the Menu key,
  and reduced-motion and high-contrast modes.
- A settings surface of 3 groups and 12 leaves where the tab name and the panel
  heading are the same string: Appearance, Accessibility, General, Language,
  Shortcuts, Notifications, Data and Backup, Trash, CLI and MCP, Webhook, Legal,
  and Update and About.
- A 73-language registry with 2 complete catalogues, 12 chrome translations, and
  English fallback disclosed in the picker. Right-to-left direction is derived
  from the locale, and the layout uses logical properties throughout.
- A first-run guide with the full language grid, a palette chooser, a privacy
  statement, and a replay entry in Settings.
- A 4, 6, or 8 digit PIN and a password option, hashed with PBKDF2-HMAC-SHA256 at
  600,000 iterations, with a persisted five-attempt lockout.
- Notification presets and a per-kind channel matrix that decides delivery: the
  in-app toast and the Windows notification are separate surfaces, quiet hours
  silence only the native one, and the same router backs the Settings test
  button.
- A 30-day trash with restore, permanent delete, and empty, plus a settings
  export and import that includes the trash.
- In-app readers for the privacy policy, terms, KVKK and GDPR notice, third-party
  licences, accessibility statement, security policy, support policy,
  contributing guide, code of conduct, and this changelog.
- An MCP server that answers JSON-RPC 2.0 over stdio (`zenith mcp --stdio`) with
  two read-only tools, a loopback-only local API with Host, Origin, and bearer
  token checks, and a signed webhook that reports completed, failed, and
  rolled-back runs.
- A headless mode (`zenith diagnose --json`) for scripts and CI, and a command
  line grammar shared with the graphical application.
- A Vellium monochrome setup and uninstall surface in six states, reached through
  a launch mode (`--setup`, `--uninstall`) so the setup page never holds an IPC
  capability. It ships as a separate 640x420 page; the installer itself remains
  Tauri's NSIS template, which offers 52 installer translations of the 73 UI
  locales.
- An icon set generated from a single brand SVG: ICO 16 to 256, the PNG ladder,
  the four Store tiles, the wide tile, the Store logo, and the tray icon.
- A GitHub Releases update check with semantic version comparison. The Microsoft
  Store channel reports availability and never downloads an installer itself.
- An MSIX packaging path for the Microsoft Store: `npm run msix:package` renders
  the package manifest, validates it with the Windows SDK's own packer, and
  `npm run check:msix` re-opens the package and measures its contents. The Store
  identity is a separate reserved value, so the script refuses to label a local
  test build submittable.

### Changed

- Theme ids are now the 14 palette ids plus `custom`. Stored `true-black`,
  `spatial-glass`, and `off-white` values migrate to `obsidian` or `slate`.
- Theme and locale changes are written as one section patch instead of a
  four-field preference save.
- The settings document is stored as one versioned JSON blob in the existing
  preferences patch. The IPC surface remains at 15 commands.
- The loading state is the shell's own geometry rather than a centred word, so
  the first frame and the loaded frame share a layout.

### Security

- Preference and audit writes are atomic.
- The renderer has no filesystem, shell, or network plugin permission, and the
  only remote origin in the content security policy is the release feed.
- Logs and support bundles pass a redaction filter before they are written.
- The webhook signing secret is stored with DPAPI outside the settings document
  and is never echoed back to the renderer.

### Known limitations

- The installer and the binary are not Authenticode-signed in this build. The
  Trust Center reports the signature as unverified rather than valid.
- 71 of the 73 languages fall back to English outside the translated chrome.
- The Microsoft Store package can be built locally with `npm run msix:package`,
  but the Store identity is not reserved and nothing has been submitted, so this
  release ships the NSIS installer only.
- Windows 10 and Windows 11 are both supported, but the real-host matrix is not
  complete.
