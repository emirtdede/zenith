# Redesign Gap Analysis: Agendamea to Zenith

| Field | Value |
| :--- | :--- |
| Document ID | DOC-11-01 |
| Version | 1.0.0 |
| Owner | Design Systems and Release Engineering |
| Closes | REQ-N-040, REQ-N-041, REQ-N-042, REQ-N-043, REQ-N-044, REQ-N-045 |

## 1. Purpose

This document is the phase 0 deliverable of the redesign programme. It compares the
reference product (`Agendamea`, Electron) with Zenith (`Tauri 2`, React 19) as the
two trees stood at the start of the programme, records every difference that
affects the interface, the settings architecture, the distribution channels, or the
quality gates, and states what was changed and what remains open.

The reference tree is read-only. Nothing in this document authorises a change to it.

## 2. Method

1. Both trees were inventoried by directory, entry point, build script, test
   script, and CI workflow.
2. The reference design system was read from `src/index.css`, `src/utils/themes.ts`,
   and the component directory. Values were copied, not reinterpreted.
3. Zenith's IPC contract (`docs/03-architecture/03-04-ipc-contract.md`), command
   registry (`src-tauri/src/commands.rs`), and native bridge (`src/bridge/native.ts`)
   were treated as frozen at 15 commands. A redesign may not add a sixteenth
   command, so preferences were extended through the existing
   `preferences_set` patch.
4. Each gap below was given a disposition: port, adapt, defer, or reject. A
   deferred item is listed again in the release checklists with a FAIL result
   until it is closed.

## 3. Design system and themes

| Area | Agendamea (reference) | Zenith before | Disposition |
| :--- | :--- | :--- | :--- |
| Tokens | `--canvas`, `--surface`, `--surface-subtle`, `--surface-hover`, `--border`, `--border-strong`, `--text-primary/secondary/muted`, `--accent`, `--accent-soft`, `--accent-ring`, `--accent-fg` | 3 ad-hoc themes with different names (`off-white`, `true-black`, `spatial-glass`) and local overrides per screen | Ported. `src/styles/tokens.css` is now the only token source; legacy aliases (`--bg`, `--text`, `--line`) point at the new names so existing screens keep working in one direction. |
| Palettes | 14 curated palettes, light and dark | 3 themes, no gallery | Ported. `src/settings/palettes.json` is the single data file consumed by the renderer, the contrast gate, and the tests. |
| Custom colour | Spectrum picker with hex input | None | Ported as a normalised hex field with live preview and a derived palette. Invalid input never becomes a stored value. |
| Accent text | `--accent` used for both fill and text | Low-contrast accent text on several surfaces | Adapted. A fifteenth token, `--accent-text`, is derived by blending toward the ink colour until it passes 4.5:1. The saturated `--accent` stays a fill. |
| Typography | Plus Jakarta Sans display, DM Sans body, JetBrains Mono | Inter and system fallbacks | Ported. Fonts are bundled in `public/fonts` (no CDN, offline first paint). Complex-script fallbacks are declared for Cyrillic, Greek, Arabic, Hebrew, Devanagari, Bengali, Tamil, Telugu, Kannada, Malayalam, Sinhala, Thai, Khmer, Lao, Myanmar, Georgian, and Armenian. |
| Geometry | 4 px spacing scale, radii, motion timings | Mixed 6 px and 8 px values, per-component durations | Ported. `--space-*`, `--radius-*`, `--duration-*`, `--ease-*` are the only geometry tokens. |
| Icons | SVG components | Mixed inline SVG and badge images | Ported. Decorative icons are `aria-hidden`; a control always has a translated name. |
| Contrast | Curated values | No automated gate | Added. `scripts/check-contrast.mjs` runs 520 WCAG checks: 14 palettes x 2 modes x semantic tokens, plus the mode-derived status colours parsed from `tokens.css`. |

The contrast gate is the reason the palette file exists at all. It enforces
4.5:1 for text, 3.05:1 for `borderStrong`, and 1.28:1 for `border` on the two
surfaces where a border is decorative. It fails the build rather than warning.

## 4. Application shell

| Area | Agendamea | Zenith before | Disposition |
| :--- | :--- | :--- | :--- |
| Frameless window | Custom title bar plus `-webkit-app-region: drag` | Undecorated window, drag region, `WindowControls` | Adapted to `data-tauri-drag-region`. The Tauri window-buttons permission set is declared in `src-tauri/capabilities/default.json`. |
| Sidebar | Full rail and a minimal rail, stored as a preference | Fixed rail, collapsed only by a CSS breakpoint | Ported. `sidebarMinimal` is stored in the settings document and toggled from the rail. The breakpoint remains a responsive fallback, not a silent preference. |
| Search | Palette trigger on the rail with the shortcut printed | Palette trigger on the rail | Kept. The shortcut label is read from the catalogue, not hard-coded. |
| External links | GitHub and Sponsor buttons | None | Added. Both are anchors with `rel="noreferrer"`; the URLs are `github.com/emirtdede/zenith` and `github.com/sponsors/emirtdede`. |
| Offline state | Indicator in the chrome | None | Added. Driven by the browser `online`/`offline` events, so the label cannot claim connectivity that the adapter does not have. |
| Toasts | Stack with tone and auto-dismiss | Error toast only | Added. `ToastHub` is a live region; each toast is dismissible and the timer is cleared on unmount. |
| Context menu | Right click plus Shift+F10 and Menu key, arrow navigation, Escape | One grid-local mouse listener | Added. One host for the whole window, with a text group (cut, copy, paste, select all) that acts on the element the menu was opened on, and a per-surface group: an action card contributes pin or unpin. |
| Skeletons | 1:1 skeletons per surface | Spinner | Added. `BootSkeleton` renders the shell's own boxes (rail, KPI strip, page head, card grid) from the real component classes, in place of the centred "Loading" word that used to jump into a different layout when boot finished. A per-screen skeleton would be dead code: every screen's data arrives during boot, so the boot skeleton is the only loading state the user can observe, and an empty list is drawn as the empty state it is. |
| Reduced motion | Honour the OS preference and a stored override | Manual toggle only | Ported. The media listener updates the document attribute, and the stored value overrides it in either direction. |
| RTL | Logical CSS properties | Physical margins and left/right | Adapted. Every rule in `tokens.css` and `app.css` uses logical properties: `margin-inline`, `padding-inline`, `border-inline`, `inset-inline`, `text-align: start`. The context menu is the one deliberate physical position, because it opens at pointer coordinates. |

## 5. Settings architecture

| Area | Agendamea | Zenith before | Disposition |
| :--- | :--- | :--- | :--- |
| Navigation | Grouped leaves with strict "tab title equals tab content" | Two-column screen with an ad-hoc tab strip | Ported as 3 groups and 12 leaves. `src/settings/tabs.ts` is the navigation model; a leaf's label and its panel heading are the same catalogue key, so they cannot drift. |
| Persistence | One settings document | Four preferences via `preferences_set` | Adapted. The four boot-critical values stay on the Rust `Preferences`; everything else is one JSON document in an optional `settings` field of the same patch. The IPC command count is unchanged. |
| Appearance | Palette gallery, custom colour, icon, zoom, preview | Theme radio group | Ported. |
| Accessibility | Contrast, motion, zoom, focus guidance | Reduced motion only | Ported. |
| General | Close behaviour, tray, startup, clock, date, destructive confirmation | Close behaviour only | Ported. The clock and date formats detect the OS default on first run and fall back to `en`. |
| Language | 73-language grid with search and RTL labels | Two locales, `en` and `tr` | Adapted. 73 selectable languages; `en` and `tr` ship full catalogues and are parity-gated. Twelve languages ship a translated chrome layer. The remaining languages fall back to English, and the picker says so instead of hiding it. |
| Shortcuts | Full catalogue, live recorder, conflict warning, per-row reset | Fixed bindings | Ported. 18 bindings, normalised to a canonical string, conflicts detected before a write. |
| Notifications | Four presets plus a per-kind channel matrix | None | Ported and wired. `src/settings/delivery.ts` is the single route from a pipeline event to the two surfaces, so the matrix decides what a user actually sees: `none` suppresses the event, `in-app` draws only a toast, `native` and `both` construct a Windows notification, and quiet hours silence only the native surface. The Settings test button sends one message through the same router and reports whether it was shown, quieted, suppressed, or unsupported. |
| Data and backup | Export, import, folder, logs, trash retention, reset | None | Ported. Export includes the trash array; import validates through the same parser as boot. |
| Trash | 30-day soft delete with restore, delete, empty | None | Ported. Expiry is enforced by `pruneTrash` on every load, not by a background timer. |
| CLI and MCP | Built-in documentation tabs and copyable commands | None | Added. The built-in tabs describe the shipped grammar, and the MCP server and loopback API they document exist in the core (section 8). |
| Webhook | URL, events, HMAC signature, test send | None | Added and wired. The panel stores the endpoint and the event subscriptions; `src-tauri/src/integrations.rs` reads them from the persisted settings document and dispatches completed, failed, and rolled-back events with an HMAC-SHA256 signature. The secret never enters the settings file. |
| Legal | In-app reader for ten documents | None | Added. Documents live in `public/legal` and are fetched only when opened. |
| Update and about | Channel-aware check, copyable build facts, welcome replay | None | Added. The Store channel never offers an in-app download. |
| Lock | 4, 6, or 8 digit PIN or a password, attempt lockout | None | Added. PBKDF2-HMAC-SHA256, 600,000 iterations, constant-time compare, five attempts, five-minute lockout persisted in the record. Argon2 was rejected for a 4 to 8 digit keyspace: the WASM download and CSP exception buy no real work factor, and the record names its algorithm so a future migration is possible. |

## 6. Internationalisation

| Area | Agendamea | Zenith before | Disposition |
| :--- | :--- | :--- | :--- |
| Locale count | 73 selectable, 17 complete | 2 complete | Adapted. A 73-entry registry with endonyms, English names, and direction. System negotiation handles `zh-Hant`, `pt-BR`, `nb`/`nn`, `fil`/`tl`, `iw`/`he`, and `in`/`id`. |
| Fallback | English | English | Kept, and made visible in the picker. |
| Plural and number format | ICU messages | ICU messages | Kept. Date, clock, and pattern formatting are locale-aware through `Intl`. |
| Dash policy | Not defined | No dash in first-party text | Kept and enforced by `scripts/check-dashes.mjs`. The two specification attachments are excluded because they are external reference text, not product copy. |
| Encoding | UTF-8 without BOM | Mixed | Enforced by the documentation gate (no U+FFFD) and by reading every file as UTF-8. |
| Mojibake | Decode JSON bodies by declared charset | Assumed UTF-8 | Ported on the server side: strict UTF-8, then the Content-Type charset, then Windows-1254. |

## 7. Distribution, icons, and installer

| Area | Agendamea | Zenith before | Disposition |
| :--- | :--- | :--- | :--- |
| Channels | GitHub and Microsoft Store | GitHub only | Adapted. The update channel is explicit; a Store build disables in-app downloads. |
| Installer | Custom monochrome NSIS wizard | Stock Tauri NSIS, English and Turkish | **Partial.** The Vellium surface exists: `src/setup` is a 640x420 page in six states, reached by a launch mode (`--setup`/`--uninstall`) rather than a route, and the six state captures are in `evidence/screens/setup`. It is **not wired as the shipped installer's UI** - the NSIS package still uses Tauri's template - so this row is not claimed as ported (DEF-169). What did land on the install path: the per-machine directory the wizard now names is the one the installer writes (`check:installer` ties the two together), and the installer's language list is measured against the pinned NSIS archive (52 of 73 locales, DEF-168). |
| Icons | Generated ICO, PNG, APPX tiles, tray | Tauri defaults | Ported. `assets/zenith-mark.svg` is the single source; `scripts/generate-icons.mjs` writes ICO 16 to 256, the PNG ladder, the four APPX tiles, the Store logo, the wide tile, and the tray icon. `check:icons` reproduces all 17 files byte-for-byte. |
| Readme | Fixed section order and dual language | Custom readme that still claims three themes | Ported. `README.md` follows the template's section order in both halves, and every badge states a value measured from this tree. |
| Legal documents | Privacy, terms, KVKK/GDPR, licences, accessibility, security, support, contributing, conduct, changelog | LICENSE only | Added. |

## 8. Capabilities that were claimed but not shipped

These are recorded because a gap analysis that only lists successes is a
sales document. Every row below was a FAIL in both release checklists while the
capability existed only as copy; the "State" column records whether that is
still true.

| Capability | State | Where it now lives |
| :--- | :--- | :--- |
| MCP server over stdio (JSON-RPC 2.0) | Shipped | `zenith_core::mcp` answers `initialize`, `tools/list` and `tools/call` on stdin/stdout with exactly two read-only tools (`zenith_list_actions`, `zenith_diagnose`). Reached by `zenith mcp --stdio`; unit tested in `crates/zenith-core/src/mcp.rs`. |
| Loopback local API with CSRF, Origin, and Host protection | Shipped | `zenith_core::api` binds `127.0.0.1` only, rejects a non-loopback `Host`, a foreign `Origin`, and a request without the per-launch bearer token; only `GET /v1/health`, `/v1/actions`, `/v1/diagnose` exist. A real-socket test asserts each rejection. |
| Webhook delivery with HMAC-SHA256 | Shipped | `zenith_core::webhook` signs `t=<unix>,v1=<hex>` over `t.body`, stores a 32-byte DPAPI-protected secret outside the settings file, and retries with backoff to a hard cap. `src-tauri/src/integrations.rs` dispatches a real completed, failed, or rollback event to the configured endpoint on a detached thread. |
| On-device AI and RAG | Rejected | There is no model that would make a local diagnosis better than the measured rules already in the core. Shipping a placebo assistant would violate the product's own honesty rule. This row stays a deliberate non-feature. |
| 73 complete translations | Partial by design | 2 full catalogues (866 keys each, parity enforced), 12 chrome layers, English fallback. Disclosed in the picker, in Settings > Language, and in the readme. |
| Microsoft Store (MSIX) package | Not produced | `tauri.conf.json` builds an NSIS installer only, and no Partner Center identity or Microsoft signing certificate exists. This is a FAIL on the Store checklist and is not claimed anywhere in the product. |
| EV code signing | Not produced | No certificate is available on the build machine, so `app_info_get` reports `signature.status = "unknown"` rather than inventing a verdict. A FAIL on both checklists. |

## 9. Quality gates and verification

| Gate | Before | After |
| :--- | :--- | :--- |
| Type check | Passing | Passing (`npx tsc --noEmit`) |
| Frontend tests | 12 files, 166 tests | 14 files, 196 tests; the settings persistence tests assert section-scoped patches, and the webhook panel asserts a real verification command |
| Rust tests | 306 tests | 341 tests, including MCP, loopback API, webhook signing, and the launch-mode contract |
| Contrast | None | 520 checks |
| Locale parity | 2 catalogues | 2 catalogues, 866 keys each, 1.3 percent identical strings |
| Unused keys | Failing on 76 entries | 0 unused |
| Typographic dashes | Failing on the two specification attachments | Passing; the attachments are excluded by name |
| IPC contract | 15 commands | 15 commands, unchanged |
| Evidence ledger | Every artifact has a row | Any new artifact must add a row before the gate passes |

## 10. Open items carried into the release checklists

Two items remain open, and neither of them is code in this tree:

1. Signing, a signed installer, and a clean-clone CI run on the final commit.
2. The Microsoft Store (MSIX) package and Partner Center identity.

The first needs an EV certificate and a push; the second needs a Partner Center
reservation. Both are tracked as `FAIL` rows with an owner action in
`docs/11-release/11-02-github-checklist.md` and
`docs/11-release/11-03-store-checklist.md`. Nothing in this list is marked PASS
in either checklist until the artifact exists in the tree and the command that
produces it has a log in `evidence/`.
