# 10-04 - Release Fix Record

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-AUD-004 |
| Version | 1.0.0 |
| Owner | Emir Tarık Dede (Vellium) |
| Subject | Every change made between the pre-audit tree and release 1.0.0, with the measurement that motivated it and the proof it worked |
| Method | One row per defect: location, measured symptom, change, and the evidence that the change closed it |
| Result | Nine defects closed, three of them critical; the release gate went from unverified to green at 24 steps |
| Closes | DEF-149, DEF-150, DEF-151, DEF-152, DEF-153, DEF-154, DEF-155, DEF-156, DEF-157 |

This record exists so that a reader who joins after the release can answer "why is this line like
this" without archaeology. It is deliberately narrow: it covers the fixes made in the release pass,
not the full history of the register, which is
([`10-02`](10-02-deficiency-register.md)).

The pre-audit findings are in [`10-03`](10-03-pre-deployment-qa.md). This document is the other half:
what was actually changed, in what order, and how the change was proved.

---

## 1. Summary

| Defect | Severity | Files touched | Tests added | Proof |
| :--- | :--- | ---: | ---: | :--- |
| DEF-155 | RED Critical | 2 | 0 (gate instead) | `check:bundle` passes; binary loads `http://tauri.localhost/` |
| DEF-150 | RED Critical | 2 | 1 | `a_purge_reports_a_directory_it_could_not_clear` |
| DEF-152 | RED Critical | 1 | 2 | `an_unreadable_backups_directory_crosses_the_open_boundary` |
| DEF-149 | ORANGE High | 1 | 0 (existing check) | `cargo check -p zenith --tests` clean |
| DEF-151 | AMBER Medium | 1 | 0 (existing check) | `cargo check -p zenith --tests` clean |
| DEF-153 | AMBER Medium | 1 | 2 | `rotation_reports_a_failure_instead_of_silently_missing_the_cap` |
| DEF-154 | AMBER Medium | 3 | 0 (strengthened) | glyph sweep 0 hits; render test asserts empty `textContent` |
| DEF-156 | AMBER Medium | 1 | 0 (measured) | footer spread 0, KPI `clipped: false` |
| DEF-157 | AMBER Medium | 1 | 0 (measured) | every card `footH` 70, `statusH` 18, one baseline per row |

Totals: **five tests added, one gate added, one step added to the release chain.**

---

## 2. DEF-155 - the release binary could not render its own UI

**Measured symptom.** A WebDriver session on `target/release/zenith.exe` reported
`url: "chrome-error://chromewebdata/"` and `title: "localhost"`. The page text was Edge's
connection-refused screen. Zero `[data-action-card]` elements existed, and still do not on the broken
build.

**Cause.** `src-tauri/Cargo.toml` had no `custom-protocol` feature. Tauri builds two shapes from one
crate; the choice is a cargo feature, and the Tauri CLI passes it itself. `cargo build --release`
therefore produced a binary pointed at `build.devUrl` - `http://localhost:1420` - which only exists
while `npm run dev` is running.

**Change.**

```toml
[features]
default = ["custom-protocol"]
custom-protocol = ["tauri/custom-protocol"]
```

**Proof.** Binary grew from 5,356,032 to 6,166,528 bytes: the embedded bundle is now inside. The same
WebDriver probe reports `url: "http://tauri.localhost/"`, 22 action cards, 5 tabs and 6 nav
destinations. The screenshot sweep went from `screens: 10, problems: 2` to `screens: 10, problems: 0`.

**Why a gate and not a test.** This is a property of a build, not of a function. `scripts/check-bundle.mjs`
measures it three ways - manifest declaration, cargo feature resolution via `cargo tree`, and `dist/`
content - and negative proof is recorded in the register: emptying `default` makes it exit 1.

---

## 3. DEF-150 - purge reported a clean wipe while files survived

**Measured symptom.** `purge_snapshots` returned row counts only. The new test plants a file where the
`backups/` directory belongs; before the fix the function returned success.

**Cause.** Two `let _ =` pairs around `remove_dir_all`/`create_dir_all`, plus `query_row(..).unwrap_or(0)`
for the counts.

**Change.** `purge_snapshots` returns `(u64, Vec<String>)`, `purge` returns `(u64, u64, Vec<String>)`;
`reset_owned_dir` and `drop_owned_dir` collect one message per failed step, and
`engine::purge::purge` folds them into `PurgeSummary.warnings` so they reach the UI. Counts use
`map_err(..)?` rather than a zero default.

**Proof.** `a_purge_reports_a_directory_it_could_not_clear` (new) and `purge_empties_the_store`
(updated to the 3-tuple, asserting the clean case reports no warnings).

---

## 4. DEF-152 - recovery called a directory it could not read reconciled

**Measured symptom.** `if let Ok(entries) = std::fs::read_dir(&backups)` skipped the entire scan on a
permission error or a path replaced by a file, and returned a `RecoveryReport` whose `is_empty()`
answered `true`.

**Change.** `RecoveryReport.unreadable_directories`, included in `is_empty()` and `summary()`
(`recovery.directory_unreadable <path>`). A missing directory stays silent: that is normal on a fresh
install.

**A second instance caught in the fix.** `Store::open` copies the reconciliation report field by
field, and the first cut of the fix built the field correctly and then dropped it on assignment. The
compiler cannot see that, so the test asserts at the `Store::open` boundary rather than on
`reconcile`.

**Proof.** `an_unreadable_backups_directory_crosses_the_open_boundary` (new) and
`a_healthy_layout_reports_no_unreadable_directories` (new).

---

## 5. DEF-149 - elevation handover swallowed the preference write

**Measured symptom.** `let _ = state.save_preferences(..)` before `run_as`. A failed write discarded,
the ticket went out, and the elevated instance read the old `preferences.json` on start - so the user
cleared a UAC prompt and the new window came up in the previous theme and language.

**Change.** `state.save_preferences(next)?`. The command runs before the ticket is written, so a failed
write refuses the handover with the error on the window the user is looking at.

**Proof.** `cargo check -p zenith --tests` clean; the command's error path is exercised by the existing
IPC tests.

---

## 6. DEF-151 - the preference write named the wrong file

**Measured symptom.** `let _ = std::fs::create_dir_all(parent)` discarded, then `File::create` on
`preferences.json.tmp` failed with `ENOENT` - a message about a temporary file the user never asked
for, one layer away from the directory that could not be made.

**Change.** `create_dir_all(..).map_err(|err| IpcError::internal(&format!("could not create {}: {err}", parent.display())))?`.

**Proof.** `cargo check -p zenith --tests` clean. This is the visibility half of DEF-149: the error
now names the cause, so DEF-149's refusal is readable.

---

## 7. DEF-153 - log rotation could stop working without saying so

**Measured symptom.** A directory planted where the shifted `.1` must land made the rename fail;
`rotate_if_needed` returned `()`, so nothing anywhere recorded that the ring had stopped rotating and
the active log grew past the published `LOG_MAX_BYTES`.

**Change.** `rotate_if_needed` returns `Vec<String>` naming each failed step; `append` prints each one
to stderr and still writes the line. `metadata(..).unwrap_or(0)` became an explicit match: a missing
file is zero, any other error is reported, because rotating on an unknown size is a guess.

**Proof.** `rotation_reports_a_failure_instead_of_silently_missing_the_cap` (new) and
`a_rotation_that_succeeds_reports_no_failure` (new). The first test's initial assertion
(`active.is_file()`) was wrong and was corrected rather than the code: rotation is a sequence of
renames, so a mid-way failure leaves the active file as `.1` while `.1 -> .2` was refused. What must
never happen is losing bytes silently, so the test asserts the body exists under one of the two names
and that the caller was told the ring is incomplete.

---

## 8. DEF-154 - the card tools still used text glyphs

**Measured symptom.** A glyph-range sweep over production sources found `★` and `◌` as text nodes in
`ActionGrid.tsx`, in the very component whose sibling module documents that glyph as the reason to
hand-draw icons.

**Change.** `PinIcon`, `UnpinIcon`, `HideIcon` and `ShowIcon` added to `src/ui/icons.tsx` as inline
SVG sharing the `Frame` and stroke geometry, with `aria-hidden="true"` and `focusable="false"`. The
two `span` text nodes are gone. `Frame` gained a `size` prop so the card icons are 16px against the
sidebar's 19px.

**Proof.** Glyph sweep reports 0 hits across 120 production files. The render test was tightened from
asserting the glyph text to asserting `textContent === ""` plus an `aria-hidden` `svg` child, which is
the property that matters: with no text content the accessible name can only come from `aria-label`.

---

## 9. DEF-156 - a clipped KPI label and a stairstep of card footers

**Measured symptom.** WebDriver measurement of the action screen:

```
"text": "Geçici dosya", "clipped": false      (after)
footSpread: 43                                 (before, per grid row)
```

KPI label read `GEÇİCİ DO...` in the shipped Turkish UI. Card footers on one grid row sat 43px apart
because `.card-desc { flex: 1 }` gave the spare height to the description, which pushed badges and
footer down in the cards with longer text.

**Change.**

- `.health-metrics dt` wraps (`overflow-wrap: anywhere`, `hyphens: auto`) and the metric box uses
  `justify-content: space-between`, so a two-line label cannot push its number out of line.
- `.card-desc` no longer grows.
- `.card-badges` carries `margin-top: auto`, pinning the badge cluster and footer to the card's bottom
  edge.
- `.card-foot` uses `align-items: end` so a wrapped two-row action area shares its last row with the
  status text. (DEF-157 replaced this with a stacked footer: bottom-aligning two rows of unequal height
  fixed the baseline but left the footer's height content-dependent.)

**Proof.** Re-measured on the rebuilt binary: all four KPI labels `clipped: false`, and footers share
one baseline per row (the `Çalıştır` buttons at 467, 745, 1056, 1342 in their four rows).

---

## 10. DEF-157 - one grid row, three footer heights

**Measured symptom.** WebDriver measurement of the action screen, before:

```
row top=230 cards=3
  Geçici dosyaları temizle      footH=44  statusH=18  btnTops=467,467
  Geri Dönüşüm Kutusu'nu boşalt footH=44  statusH=18  btnTops=467,467
  Eski ekran görüntülerini ...  footH=88  statusH=36  btnTops=424,424,467
```

The third card carried one more button (its action had an undo copy available), the footer grew to
88px, and the squeezed status label wrapped to two lines at 36px tall. The row read as three
misaligned cards.

**Cause.** `.card-foot` was a single flex row with `justify-content: space-between`. At the measured
282px card width the actions of that card need 209px and the status label needs ~79px, against 248px
of footer width: the action cluster wrapped, and the status - now in a column one button-row wide -
broke mid-phrase. Wrapping was applied to the wrong element.

**Change.** `.card-foot` is `flex-direction: column-reverse` with `align-items: stretch`. The footer
is one geometry for every card - an 18px status line, an 8px gap, a 35px action row - with the
buttons pinned to the card's bottom edge. Button count and status length no longer change its height.

**Proof.** Re-measured on the rebuilt binary: every card reports `footH` 70 and `statusH` 18, and the
button rows share one baseline per grid row (427, 427, 427 in the first; 731, 731, 731 in the second).
The ten-state screenshot sweep is still 10 of 10 with zero problems.

---

## 11. Tooling added

| Artefact | Purpose |
| :--- | :--- |
| `scripts/check-bundle.mjs` | The DEF-155 gate: manifest, cargo feature resolution, `dist/` content and freshness |
| `check:bundle` in `verify` | The chain is now twenty-four steps, and `check:verify-chain` enforces that the prose says so |
| WebDriver measurement scripts | `measure-cards.mjs`, `measure-layout.mjs`, `measure-foot.mjs` - the instruments that found DEF-156 and DEF-157 and proved both fixes |

Those measurement scripts live outside the repository on purpose: they drive the user's browser
through `tauri-driver` and depend on a local `msedgedriver.exe`, so they are reproduction steps rather
than gates. The gate they produced is `check-bundle.mjs`, which has no such dependency.
