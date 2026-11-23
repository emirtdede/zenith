# 06-01 - Localization Strategy

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-L10N-001 |
| Version | 2.0.0 |
| Owner | Frontend / Localization |
| Shipped locales | `en` (source), `tr` (reviewed) - 533 keys each |
| Gate | `node scripts/check-locales.mjs` |
| Closes | DEF-005 (flat key/value, no plurals), DEF-006 (English errors in a Turkish UI) |

The v1.0.0 plan claimed 73 locales and shipped a flat `Record<string, string>` with no plural support.
That combination cannot express Russian, Polish or Arabic plural categories, so 73 locales were
structurally broken at the format level before a single translation existed. This document describes
what the product actually does, why the count is two, and how a new locale is added without weakening
the gate.

---

## 1. What ships

| Locale | Tier | Status | Keys | Evidence |
| :--- | :--- | :--- | ---: | :--- |
| `en` | A | Source of truth | 445 | `src/i18n/en.ts` |
| `tr` | A | Translated + reviewed, full parity | 451 | `src/i18n/tr.ts` |

```text
$ node scripts/check-locales.mjs
All 2 locales agree with English on 533 keys.
```

Parity is necessary but not sufficient, and DEF-089 is the reason this document says so: the gate was
green at 471 keys at the time, while **52 of those keys could not be reached by any code path**.
`check-locales` compares the two catalogues to each other; it cannot see whether a string is ever
rendered. Two further gates now ask that question, and both run before this one in `npm run verify`:

| Gate | Question | Found |
| :--- | :--- | :--- |
| `scripts/check-unused-keys.mjs` | Is every catalogue key referenced by `src/`? | 52 unreachable keys: 30 described behaviour that did not exist (deleted) and 22 described measured data the UI never showed (wired) |
| `scripts/check-step-keys.mjs` | Does every `steps.*` / `error.*` / `remedy.*` key the core can emit exist in **both** catalogues - and does every `steps.*` key have an emitter? | DEF-088's missing `steps.processSelfRefused`, and any dead `steps.*` key |

The shipped total is **442** because 30 dead keys were deleted and one live key (`steps.processSelfRefused`,
DEF-090) was added. A catalogue's size is not a quality measure; its reachability is.

Two locales, not seventy-three. The reason is in §7: a locale is shipped only when a native speaker
has reviewed it and the gate proves structural parity. Shipping machine output as "supported" is the
truthfulness defect ADR-023 exists to prevent.

---

## 2. Catalogue architecture

```text
src/i18n/
├── en.ts        source catalogue (typed key union is derived from this)
├── tr.ts        Turkish catalogue (checked against en.ts)
├── format.ts    ICU subset: {name} {n, plural} {g, select} {n, number} {b, bytes}
└── index.tsx    negotiation, provider, callable translator, formatters
```

`en.ts` exports `const en = { ... } as const`; its key union is `MessageKey`, so a typo in a component
is a TypeScript error, not a runtime `⟦key⟧`. The catalogue is a plain object, not JSON, so comments
survive and keys stay greppable.

The Rust side keeps a parallel, tiny fact: which locales exist. `crates/zenith-core/src/i18n.rs`
holds `SUPPORTED_LOCALES = ["en", "tr"]` and `LOCALE_CHOICES` with endonyms. `preferences_set` rejects a
locale that is not in that list, so a stale UI cannot persist a language the build cannot render.

---

## 3. ICU MessageFormat subset

`src/i18n/format.ts` implements a deliberate subset. It is ~140 lines with tests, chosen over
`intl-messageformat` because the app must work with zero network access and a 40 KB formatter for five
constructs is a poor trade.

| Construct | Example | Supported |
| :--- | :--- | :--- |
| Simple argument | `"Score {score}/100"` | yes |
| `plural` | `"{count, plural, =0 {None} one {1 item} other {# items}}"` | yes |
| `select` | `"{g, select, male {he} female {she} other {they}}"` | yes |
| `number` | `"{n, number}"` | yes, locale-aware |
| `bytes` | `"{v, bytes}"` (Zenith extension) | yes |
| Nested plural inside select | - | **no** (documented limitation) |
| Apostrophe escaping | - | **no** |
| `{n, number, percent}` | - | **no** |

### Why `bytes` is an extension

File size is the most common number in this product. Formatting "2.4 GB" per locale by hand is how
unit names drift ("GB" vs "Go" vs "GB"). `formatBytes` scales once and renders with `Intl.NumberFormat`
plus a narrow no-break space (`\u00a0`) so the unit cannot wrap onto its own line.

### Missing parameters are visible

`format()` renders a missing parameter as `⟦name⟧` (U+27E6/U+27E7), not an empty string. A blank space
in the UI is a bug report nobody can act on; a bracketed placeholder names the exact missing key. The
same rule applies to an unbalanced brace: the remainder is emitted verbatim rather than throwing,
because a malformed translation is a content bug, not a crash.

### Plural selection

`pluralCategory` delegates to `Intl.PluralRules`, so the *correct* categories for the active locale are
used rather than a hard-coded English `one/other`. Exact matches (`=0`, `=1`) are checked first, then
the CLDR category, then `other`. That ordering is what makes `=0 {None}` render as "None" rather than
"0 items".

Fifteen keys use `plural` today, including `titlebar.notifications.count`, `health.issues.value`,
`diag.screenshotsFew`/`diag.screenshotsMany`, and `snapshots.undoSuccess`.

---

## 4. Backend speaks keys, never prose

ADR-010. Every user-visible string produced by Rust is a key plus typed parameters:

```json
{ "code": "ACCESS_DENIED", "messageKey": "errors.accessDenied",
  "remedyKey": "remedy.closeHandlesOrElevate", "params": { "path": "…" },
  "correlationId": "01H…" }
```

Three consequences, all enforced:

1. A Turkish UI shows Turkish errors, because the renderer localises the key. The v1.0.0 defect -
   English errors inside a translated UI - cannot recur without deleting the key.
2. `scripts/check-contract.mjs` parses the 25 error rows in `03-04` §7 and fails if either the
   `messageKey` or the `remedyKey` is absent from `en.ts` **or** `tr.ts`. A missing translation is a
   build failure, not a runtime fallback.
3. Diagnostic metrics are `metricKey` + `metricParams`. `ActionGrid` renders
   `t.tKey(report.metricKey, report.metricParams)`, so a probe never returns a sentence.

There are exactly 25 error codes, each with a distinct `messageKey` and a `remedyKey` (a test,
`every_code_has_distinct_stable_text`, asserts the codes are distinct and stable).

---

## 5. Negotiation and fallback

```text
requested "tr-TR"  → exact miss → base "tr" → hit            → tr
requested "de-DE"  → exact miss → base "de" → miss           → en   (documented fallback)
requested ""/null  → en
```

Both sides implement the same rule: `negotiateLocale` in `src/i18n/index.tsx` and `negotiate` in
`crates/zenith-core/src/i18n.rs`. The Rust tests pin `tr-TR → tr`, `en-GB → en`, `de-DE → en`, `"" →
en`; the renderer mirrors it.

`<html lang>` is set from the negotiated locale in a `useEffect`. This is not decoration: it drives
spell-check, hyphenation and the screen-reader voice. Turkish read with English phonetics is
unintelligible, which is why it is wired rather than declared.

### Fallback is visible in principle, silent in practice

If a key were missing from `tr.ts`, lookup falls back to English. But the gate makes that state
impossible to ship: the two catalogues have identical key sets. The fallback exists so a future Tier B
locale degrades one key at a time instead of rendering `⟦key⟧`.

---

## 6. The parity gate

`scripts/check-locales.mjs` reads both catalogues as text (no TypeScript execution) and fails on:

| Check | Failure message |
| :--- | :--- |
| Identical key sets | `tr.ts is missing "<key>"` / `tr.ts has extra key "<key>"` |
| Identical placeholder names per key | `"<key>" placeholders: en [a, b] vs tr [a]` |
| Identical ICU branch selectors per key | `"<key>" ICU branches: en [one, other] vs tr [one, few, other]` |
| No U+FFFD in either file | `<locale>.ts contains U+FFFD (mojibake)` |
| Minimum catalogue size | `en.ts parsed only N keys; expected the full catalogue` |

Two details make the gate trustworthy rather than decorative:

- **Branches are parsed only inside an ICU argument.** A naive scan would treat ordinary words before a
  `{placeholder}` as branch names and produce false failures.
- **Placeholders are read after stripping plural bodies.** Otherwise branch words would be counted as
  parameters.

Run:

```powershell
node scripts/check-locales.mjs
```

It is part of `npm run verify`, so `npm run build` cannot succeed with a broken catalogue.

---

## 7. Adding a locale (the real procedure)

1. Copy `src/i18n/en.ts` to `src/i18n/<code>.ts` and translate every value. Do not translate keys, do
   not reorder placeholders' *names*, do not drop an ICU branch.
2. Add the import and entry to `CATALOGUES` in `src/i18n/index.tsx`.
3. Add the code to `SUPPORTED_LOCALES` and the endonym to `LOCALE_CHOICES` in
   `crates/zenith-core/src/i18n.rs`.
4. Run `node scripts/check-locales.mjs` - it must print parity for the new locale.
5. Add a native-speaker review row to §8 of this document with the reviewer's name and date.
6. Add the locale to the settings picker and to `05-02` §6.

Step 5 is not optional. A locale without a reviewer is a Tier B candidate, and Tier B does not appear
in the picker (ADR-023). This is why the product ships two locales rather than a number it cannot
defend.

---

## 8. Review log

| Locale | Reviewer | Date | Scope reviewed |
| :--- | :--- | :--- | :--- |
| `tr` | Owner (native speaker) | 2026-11-18 | All 467 keys at the time of that review: terminology, formal register, plural branches, confirmation words |
| `en` | Owner | 2026-11-18 | Source catalogue, copy rules from `05-02` §11 |

The Turkish review covered the glossary in §9 and every destructive-dialog string, because a mistranslation
in a confirmation is a safety issue, not a style issue.

---

## 9. Glossary (fixed terms)

Consistency beats elegance in a diagnostic tool: the same concept must use the same word on the card,
in the dialog, in the log and in the error.

| Concept | English | Turkish | Note |
| :--- | :--- | :--- | :--- |
| Snapshot | snapshot | geri yükleme noktası | "snapshot" is jargon in Turkish |
| Rollback | roll back / undo | geri al | verb form for buttons |
| Action | action | işlem | |
| Diagnosis | diagnosis | tanılama | |
| Health score | health score | sistem sağlığı | the number, not the act |
| Elevation | administrator | yönetici | never "root" |
| Scope | - (not user-facing) | - | internal only |
| Destructive | irreversible / destructive | geri alınamaz | describes consequence, not drama |
| Service | service | hizmet | |
| Proxy | proxy | vekil sunucu | first use; "proxy" thereafter |
| Spooler | print queue | yazdırma kuyruğu | the user's model, not the service name |
| Component store | component store | bileşen deposu | DISM's target |

Confirmation words stay **Latin** in every locale (`RESTART`, `DELETE`, `CLOSE`, `CONFIRM`). A typed
challenge in a non-Latin script is harder to reproduce on a keyboard layout the user may not have, and
the word is a speed bump, not a sentence.

---

## 10. Formatting rules beyond messages

| Concern | Implementation | Why |
| :--- | :--- | :--- |
| Numbers | `Intl.NumberFormat(locale)` cached per locale + digit count | Turkish uses `,` decimal |
| Bytes | `formatBytes` → `Intl.NumberFormat` + `\u00a0` + unit | unit never wraps |
| Dates | `Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" })` | |
| Relative time | `Intl.RelativeTimeFormat(locale, { numeric: "auto" })` | "2 minutes ago" / "2 dakika önce" |
| Duration | ms / s / m+s with locale numbers | logs and uptime |
| Sorting/search | `Intl.Collator(locale, { sensitivity: "base", numeric: true })` | Turkish `ı/İ` must sort correctly |
| Case folding | `toLocaleLowerCase(locale)` for search | Turkish dotted/dotless i |

The Turkish locale is the reason the last two rows exist. `"I".toLowerCase()` is `"i"` in English and
`"ı"` in Turkish; using the non-locale form makes search miss words. Every comparison in `ActionGrid`,
`CmdPalette` and `ConfirmDialog` passes the active locale.

`formatDate`/`formatTime`/`formatRelative` return `-` (em dash) for `null`, invalid input or a missing
timestamp. They never return `Invalid Date` and never invent a time.

---

## 11. What is deliberately untranslated

| Content | Why |
| :--- | :--- |
| Action ids (`clean-temp-cache`) | machine identifiers, shown only in mono debug contexts |
| Snapshot ids, correlation ids | opaque strings |
| Port numbers, PIDs, paths | data |
| Script bodies | PowerShell/Batch must stay ASCII-commandable; a translated command fails |
| The purge token `PURGE` | a literal the core compares |
| Log lines from the core | they carry keys; the renderer localises them |

Script bodies are the important exception: a "localised" `ipconfig /flushdns` would be a broken command.
The dialog labels the script in the user's language and leaves the code alone.

---

## 12. Verification

```powershell
# Parity: keys, placeholders, ICU branches, mojibake
node scripts/check-locales.mjs

# Every documented error code resolves in both catalogues
node scripts/check-contract.mjs

# The Rust side agrees on which locales exist
cargo test -p zenith-core i18n::

# No translation key is referenced but undefined (TypeScript)
npx tsc --noEmit
```

The fourth command is the reason `MessageKey` exists: `t("does.not.exist")` is a compile error, not a
`⟦does.not.exist⟧` on screen.
