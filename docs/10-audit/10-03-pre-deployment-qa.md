# 10-03 - Pre-Deployment QA & Architecture Audit

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-AUD-003 |
| Version | 1.0.0 |
| Owner | Emir Tarık Dede (Vellium) |
| Subject | Every production source file in `crates/zenith-core`, `src-tauri`, `src` and `scripts`, audited against the 1.0.0 release |
| Method | Static scan plus live measurement: a defect scanner, an FFI sweep, a glyph/dash sweep, a DOM measurement pass through WebDriver on the release binary, and a ten-state screenshot sweep |
| Result | Nine defects found and closed in this pass; every file has a verdict; the release gate is green |
| Closes | DEF-149, DEF-150, DEF-151, DEF-152, DEF-153, DEF-154, DEF-155, DEF-156, DEF-157 |

This is the audit the release depends on, and it is the easiest kind of document to falsify: a
file-by-file review reads as authoritative whether or not anything was read. So the method is stated
first, and every verdict in §5 is generated from a measurement of that file rather than written from
memory. Where a class of finding was judged *not* a defect, §4 names it and gives the reason, because
a silently dropped hit is indistinguishable from a hit that was never looked at.

Configuration files are out of scope by the owner's instruction, with one exception that is not
configuration in any meaningful sense: `src-tauri/Cargo.toml` decides whether the artefact can render
its own UI, so DEF-155 lives there.

---

## 1. Method

Five instruments, each measuring something the others cannot.

| Instrument | What it measures | Why the others cannot |
| :--- | :--- | :--- |
| `defectscan2.mjs` | `let _ =` on results, `if let Ok(..)` without an else, discarded `Result`, panics in production | Reading code finds these one at a time and only when the reader is looking for that shape |
| `scripts/check-ffi.mjs` | Every `unsafe` block and its `SAFETY` comment | The crate lint only sees what the current target compiles; on Windows the non-Windows adapters are stripped |
| Glyph and dash sweeps | Emoji-range codepoints, U+2014 and U+2013, fallback symbols used as icons | A screenshot shows a star; it does not show whether the star is an SVG or a font glyph |
| `measure-cards.mjs` (WebDriver) | Footer baselines, badge heights, KPI label clipping, computed overflow | A DOM query answers "is the element there", not "does the row line up" |
| `scripts/sweep-screens.mjs` | Ten rendered states: blank render, horizontal escape, console error, missing heading | A unit test mocks the failing call and passes while the real webview shows an error page |

The last two matter more than their size suggests. Both defects that shipped in the release binary
(DEF-155, DEF-156) were invisible to `cargo test`, `tsc` and every static gate, and both were found by
opening the artefact and measuring it.

---

## 2. Verdict

| Severity | Meaning | Found | Closed |
| :--- | :--- | ---: | ---: |
| RED Critical | The shipped artefact does not do what it claims, or loses user data silently | 3 | 3 |
| ORANGE High | A user-facing promise is broken on a normal path | 1 | 1 |
| AMBER Medium | A failure is misreported, or a rule holds in one place and not another | 5 | 5 |
| BLUE Low | Cosmetic, or a consistency gap with no user-visible effect | 0 | 0 |

No finding in the RED or ORANGE bands remains open in this audit. The register's nine open rows (listed in
§7) are blocked on owner-supplied assets or external infrastructure, not on code, and none of them is
an audit finding of this pass.

---

## 3. Findings closed in this audit

| ID | Severity | Location | Defect | Fix |
| :--- | :--- | :--- | :--- | :--- |
| DEF-155 | RED Critical | `src-tauri/Cargo.toml` | No `custom-protocol` feature, so `cargo build --release` linked a binary that loads `devUrl` instead of the embedded bundle. Shipped as-is it shows the browser's connection-refused page | `default = ["custom-protocol"]`; `scripts/check-bundle.mjs` measures manifest, cargo feature resolution and `dist/` freshness, and is the last step of the gate |
| DEF-150 | RED Critical | `crates/zenith-core/src/engine/db.rs:737`, `:770` | Purge cleared the owned directories with `let _ =` on both calls and returned only row counts, so a directory that refused to disappear left archives with no ledger entry and a `PurgeSummary` claiming success | `purge_snapshots` returns `(u64, Vec<String>)`, `purge` returns `(u64, u64, Vec<String>)`; failures reach `PurgeSummary.warnings`; `query_row(..).unwrap_or(0)` became `map_err(..)?` |
| DEF-152 | RED Critical | `crates/zenith-core/src/engine/db.rs:850`, `:873` | Startup recovery opened the backups directory with `if let Ok(entries)`, so an unreadable directory skipped the whole scan and returned a report indistinguishable from a clean install | `RecoveryReport.unreadable_directories`, folded into `is_empty()` and `summary()`; a missing directory stays silent; two tests pin both cases, including the `Store::open` field-by-field copy that dropped the new field on first attempt |
| DEF-149 | ORANGE High | `src-tauri/src/commands.rs:1276` | `let _ = state.save_preferences(..)` before the elevation handover, so a failed write started a UAC-elevated session in the previous theme and language with no message | `save_preferences(..)?` propagates before the ticket exists |
| DEF-151 | AMBER Medium | `src-tauri/src/state.rs:295` | `let _ = std::fs::create_dir_all(parent)` made the following write fail with `ENOENT` on `preferences.json.tmp`, naming a file the user never asked for instead of the directory that could not be made | `create_dir_all(..).map_err(..)?` names the parent and the OS error |
| DEF-153 | AMBER Medium | `src-tauri/src/logging.rs:120` | `rotate_if_needed` returned `()` with six `let _ =` inside and read size with `metadata(..).unwrap_or(0)`, so a locked log grew past the published `LOG_MAX_BYTES` with nothing said anywhere | Returns `Vec<String>`; `append` prints each failure to stderr and still writes the line; partial rotation is reported rather than pretended atomic |
| DEF-154 | AMBER Medium | `src/ui/ActionGrid.tsx:188`, `:198` | The pin and hide buttons rendered `★` and `◌` as text while `icons.tsx` exists to hand-draw exactly those shapes, so the zero-fallback-icon rule held for the sidebar and not for the card tools | `PinIcon`, `UnpinIcon`, `HideIcon`, `ShowIcon` are inline SVG with `aria-hidden` and `focusable="false"`; the buttons now have no text content, so `aria-label` is the only name |
| DEF-156 | AMBER Medium | `src/styles/app.css:510`, `:654` | The junk KPI label rendered as `GEÇİCİ DO...` in the shipped Turkish UI, and card footers on one grid row sat 43px apart because `flex: 1` on the description absorbed the spare height | `dt` wraps and the value is bottom-pinned; `margin-top: auto` on `.card-badges` pins badges and footer to the card edge; footers verified at one baseline |
| DEF-157 | AMBER Medium | `src/styles/app.css:731` | Cards in one grid row had three footer heights (44, 70 and 88px), and the status label of the tallest broke in half at 36px tall: a single-row footer with `space-between` does not hold once three buttons must share the width with a status label | `.card-foot` is `column-reverse` with `align-items: stretch`, so every footer is one geometry regardless of button count; measured `footH` 70 and `statusH` 18 on every card, button rows on one baseline per row |

Full narrative, evidence and negative proofs are in the deficiency register
([`10-02`](10-02-deficiency-register.md)). This table is the audit's index into it.

---

## 4. Findings that are not defects

The scanner reports shapes, not verdicts. Each hit below was read and judged, and the reason is
recorded so the next reader does not have to redo the judgement.

| Location | Shape | Why it is not a defect |
| :--- | :--- | :--- |
| `crates/zenith-core/src/adapters/dpapi.rs:123`, `:125`, `:132` | `.expect(..)` | Inside `#[cfg(all(test, windows))] mod tests`. A test that cannot DPAPI-round-trip a key must fail loudly; there is no caller to return an error to |
| `crates/zenith-core/src/manifest.rs:819` | `.expect(..)` | `action_by_id` documents the invariant, carries `#[allow(clippy::expect_used)]`, and `every_code_row_matches_the_table` proves the table covers every `ActionId` variant. Returning `Option` would push an impossible branch onto every call site |
| `crates/zenith-core/src/engine/snapshot.rs:73` | `unreachable!` | HMAC accepts keys of any length; the arm cannot be reached with a 32-byte key. The alternative is an unverified archive |
| `crates/zenith-core/tests/catalog_in_sync.rs:19`, `:35`, `:38` | `panic!` | The drift test's assertions. A test that cannot read the catalogue must fail, not continue |
| `crates/zenith-core/src/adapters/child.rs:175`, `:178` | `.join().ok()` | A reader thread that panicked has already lost its output; the child's exit status is the authoritative result and is checked separately |
| `crates/zenith-core/src/adapters/probes.rs:392`, `:726`, `:765` | `.ok()` on metadata/registry reads | These are health probes. A probe that cannot read a value reports "unknown", which is the honest answer and the DEF-101 pattern rather than a swallowed failure |
| `crates/zenith-core/src/engine/headless.rs:402`-`:431`, `src-tauri/src/lib.rs:56`-`:58` | `let _ = writeln!(..)` | Writing the CLI's own output to stdout. There is no recovery from a closed stdout and no second channel to report on |
| `src-tauri/src/lib.rs:42`, `:53`, `:63` | `let _ = console::detach_for_gui(..)` | Console re-attachment is best-effort by design; the GUI runs without a console |
| `crates/zenith-core/src/bin/zenith-audit.rs:269`-`:306` | The string `TODO` | The audit tool's own scanner looking for unattributed TODO comments. It is the check, not an instance |
| `crates/zenith-core/src/manifest.rs:960` | The string `TODO` | A test asserting that no shipped script contains a `TODO` placeholder |
| `crates/zenith-core/src/engine/pipeline.rs:219`, `:226` | `let _ = abort_snapshot(..)` | The row is already being returned as an error; the abort is forensics and its own failure must not mask the original one |
| `crates/zenith-core/src/engine/pipeline.rs:321`, `:367`, `snapshot.rs:209`, `:268`, `support.rs:334` | `let _ = remove_file/remove_dir_all` | Staging and temp cleanup on a path the code just created. The restore loop iterates the extraction's returned list, not a directory read, so a leftover cannot be counted as restored |

---

## 5. File-by-file audit

One row per production source file: path, layer, line count, verdict. `Config` files are out of scope
except `src-tauri/Cargo.toml`, which decides whether the binary can render (DEF-155). Where a file
carries a finding from §3, its row is in that table instead, and the finding is the verdict.

Every row below was generated by measuring the file: the line count is the file's, and the `unsafe`
count is the number of `unsafe {` blocks outside `#[cfg(test)]`. A file with no tests, no unsafe
blocks and no mutable state is not "unverified"; it is a mapping, a constant table or a type module,
and the verdict says so.

| File | Layer | Lines | Verdict |
| :--- | :--- | ---: | :--- |
| `crates/zenith-core/examples/dump_manifest.rs` | Core / root | 16 | Clean. Emits the catalogue for `catalog_ts`; no logic, no state. |
| `crates/zenith-core/src/adapters/candidates.rs` | Core / adapter | 575 | Clean. 10 unsafe block(s), each with a SAFETY comment; inline `#[cfg(test)]`. |
| `crates/zenith-core/src/adapters/child.rs` | Core / adapter | 626 | Clean. 7 unsafe block(s), each with a SAFETY comment; inline `#[cfg(test)]`. |
| `crates/zenith-core/src/adapters/cleanup.rs` | Core / adapter | 431 | Clean. 2 unsafe block(s), each with a SAFETY comment; inline `#[cfg(test)]`. |
| `crates/zenith-core/src/adapters/console.rs` | Core / adapter | 114 | Clean. 2 unsafe block(s), each with a SAFETY comment; inline `#[cfg(test)]`. |
| `crates/zenith-core/src/adapters/dpapi.rs` | Core / adapter | 144 | Clean. 4 unsafe block(s), each with a SAFETY comment. |
| `crates/zenith-core/src/adapters/mod.rs` | Core / adapter | 110 | Clean. no unsafe blocks, no mutable state. |
| `crates/zenith-core/src/adapters/privilege.rs` | Core / adapter | 188 | Clean. 15 unsafe block(s), each with a SAFETY comment; inline `#[cfg(test)]`. |
| `crates/zenith-core/src/adapters/probes.rs` | Core / adapter | 953 | Clean. 8 unsafe block(s), each with a SAFETY comment. |
| `crates/zenith-core/src/adapters/process.rs` | Core / adapter | 785 | Clean. 24 unsafe block(s), each with a SAFETY comment; inline `#[cfg(test)]`. |
| `crates/zenith-core/src/adapters/services.rs` | Core / adapter | 500 | Clean. 7 unsafe block(s), each with a SAFETY comment; inline `#[cfg(test)]`. |
| `crates/zenith-core/src/adapters/system.rs` | Core / adapter | 344 | Clean. 9 unsafe block(s), each with a SAFETY comment; inline `#[cfg(test)]`. |
| `crates/zenith-core/src/bin/zenith-audit.rs` | Core / binary | 323 | Clean. no unsafe blocks, no mutable state. |
| `crates/zenith-core/src/catalog_ts.rs` | Core / root | 188 | Clean. no unsafe blocks, no mutable state. |
| `crates/zenith-core/src/cli.rs` | Core / root | 437 | Clean. inline `#[cfg(test)]`. |
| `crates/zenith-core/src/config.rs` | Core / root | 252 | Clean. inline `#[cfg(test)]`. |
| `crates/zenith-core/src/engine/audit.rs` | Core / engine | 294 | Clean. inline `#[cfg(test)]`. |
| `crates/zenith-core/src/engine/dag.rs` | Core / engine | 218 | Clean. inline `#[cfg(test)]`. |
| `crates/zenith-core/src/engine/executor.rs` | Core / engine | 707 | Clean. inline `#[cfg(test)]`. |
| `crates/zenith-core/src/engine/headless.rs` | Core / engine | 492 | Clean. inline `#[cfg(test)]`. |
| `crates/zenith-core/src/engine/health.rs` | Core / engine | 371 | Clean. inline `#[cfg(test)]`. |
| `crates/zenith-core/src/engine/keystore.rs` | Core / engine | 77 | Clean. inline `#[cfg(test)]`. |
| `crates/zenith-core/src/engine/mod.rs` | Core / engine | 21 | Clean. no unsafe blocks, no mutable state. |
| `crates/zenith-core/src/engine/pipeline.rs` | Core / engine | 569 | Clean. inline `#[cfg(test)]`. |
| `crates/zenith-core/src/engine/redact.rs` | Core / engine | 631 | Clean. inline `#[cfg(test)]`. |
| `crates/zenith-core/src/engine/retention.rs` | Core / engine | 208 | Clean. inline `#[cfg(test)]`. |
| `crates/zenith-core/src/engine/scope.rs` | Core / engine | 394 | Clean. inline `#[cfg(test)]`. |
| `crates/zenith-core/src/engine/snapshot.rs` | Core / engine | 641 | Clean. inline `#[cfg(test)]`. |
| `crates/zenith-core/src/error.rs` | Core / root | 361 | Clean. inline `#[cfg(test)]`. |
| `crates/zenith-core/src/i18n.rs` | Core / root | 89 | Clean. inline `#[cfg(test)]`. |
| `crates/zenith-core/src/lib.rs` | Core / root | 74 | Clean. no unsafe blocks, no mutable state. |
| `crates/zenith-core/src/manifest.rs` | Core / root | 1166 | Clean. inline `#[cfg(test)]`. |
| `crates/zenith-core/src/models.rs` | Core / root | 464 | Clean. inline `#[cfg(test)]`. |
| `crates/zenith-core/tests/catalog_in_sync.rs` | Core / test | 50 | Clean. The drift test itself; its three `panic!` calls are the assertions. |
| `scripts/audit-nonwindows.mjs` | Gate script | 80 | Clean. A gate; its exit code is the deliverable. |
| `scripts/check-bands-mutation.mjs` | Gate script | 106 | Clean. A gate; its exit code is the deliverable. |
| `scripts/check-build-identity-mutation.mjs` | Gate script | 175 | Clean. A gate; its exit code is the deliverable. |
| `scripts/check-build-identity.mjs` | Gate script | 190 | Clean. A gate; its exit code is the deliverable. |
| `scripts/check-contract.mjs` | Gate script | 127 | Clean. A gate; its exit code is the deliverable. |
| `scripts/check-contrast.mjs` | Gate script | 153 | Clean. A gate; its exit code is the deliverable. |
| `scripts/check-dashes.mjs` | Gate script | 129 | Clean. A gate; its exit code is the deliverable. |
| `scripts/check-deny.mjs` | Gate script | 246 | Clean. A gate; its exit code is the deliverable. |
| `scripts/check-doc-counts-mutation.mjs` | Gate script | 241 | Clean. A gate; its exit code is the deliverable. |
| `scripts/check-doc-counts.mjs` | Gate script | 378 | Clean. A gate; its exit code is the deliverable. |
| `scripts/check-docs.mjs` | Gate script | 137 | Clean. A gate; its exit code is the deliverable. |
| `scripts/check-evidence-ledger.mjs` | Gate script | 200 | Clean. A gate; its exit code is the deliverable. |
| `scripts/check-ffi.mjs` | Gate script | 52 | Clean. A gate; its exit code is the deliverable. |
| `scripts/check-focus-trap-mutation.mjs` | Gate script | 83 | Clean. A gate; its exit code is the deliverable. |
| `scripts/check-licenses.mjs` | Gate script | 102 | Clean. A gate; its exit code is the deliverable. |
| `scripts/check-locales.mjs` | Gate script | 178 | Clean. A gate; its exit code is the deliverable. |
| `scripts/check-mutate-restore.mjs` | Gate script | 141 | Clean. A gate; its exit code is the deliverable. |
| `scripts/check-scorecard-mutation.mjs` | Gate script | 115 | Clean. A gate; its exit code is the deliverable. |
| `scripts/check-scorecard.mjs` | Gate script | 278 | Clean. A gate; its exit code is the deliverable. |
| `scripts/check-simulator.mjs` | Gate script | 127 | Clean. A gate; its exit code is the deliverable. |
| `scripts/check-step-keys-negative.mjs` | Gate script | 152 | Clean. A gate; its exit code is the deliverable. |
| `scripts/check-step-keys.mjs` | Gate script | 92 | Clean. A gate; its exit code is the deliverable. |
| `scripts/check-unused-keys.mjs` | Gate script | 134 | Clean. A gate; its exit code is the deliverable. |
| `scripts/check-verify-chain.mjs` | Gate script | 181 | Clean. A gate; its exit code is the deliverable. |
| `scripts/e2e-journeys.mjs` | Gate script | 483 | Clean. A gate; its exit code is the deliverable. |
| `scripts/generate-licenses.mjs` | Gate script | 463 | Clean. A gate; its exit code is the deliverable. |
| `scripts/generate-sbom.mjs` | Gate script | 256 | Clean. A gate; its exit code is the deliverable. |
| `scripts/lib/ffi-measure.mjs` | Gate script | 72 | Clean. A gate; its exit code is the deliverable. |
| `scripts/lib/key-scan.mjs` | Gate script | 173 | Clean. A gate; its exit code is the deliverable. |
| `scripts/lib/mutate-restore.mjs` | Gate script | 72 | Clean. A gate; its exit code is the deliverable. |
| `scripts/probe-focus-trap.mjs` | Gate script | 280 | Clean. A gate; its exit code is the deliverable. |
| `scripts/probe-layout.mjs` | Gate script | 191 | Clean. A gate; its exit code is the deliverable. |
| `scripts/probe-overlay-scroll.mjs` | Gate script | 226 | Clean. A gate; its exit code is the deliverable. |
| `scripts/sweep-screens.mjs` | Gate script | 366 | Clean. A gate; its exit code is the deliverable. |
| `src-tauri/src/error.rs` | Shell | 67 | Clean. no unsafe blocks, no mutable state. |
| `src-tauri/src/handover.rs` | Shell | 299 | Clean. 1 unsafe block(s), each with a SAFETY comment; inline `#[cfg(test)]`. |
| `src-tauri/src/lib.rs` | Shell | 395 | Clean. inline `#[cfg(test)]`. |
| `src-tauri/src/main.rs` | Shell | 16 | Clean. no unsafe blocks, no mutable state. |
| `src-tauri/src/maintenance.rs` | Shell | 457 | Clean. inline `#[cfg(test)]`. |
| `src-tauri/src/telemetry.rs` | Shell | 160 | Clean. inline `#[cfg(test)]`. |
| `src/actions.ts` | Renderer | 420 | Clean. no unsafe blocks, no mutable state. |
| `src/App.tsx` | Renderer | 420 | Clean. no unsafe blocks, no mutable state. |
| `src/bridge/adapter.ts` | Renderer / bridge | 207 | Clean. no unsafe blocks, no mutable state. |
| `src/bridge/index.ts` | Renderer / bridge | 46 | Clean. no unsafe blocks, no mutable state. |
| `src/bridge/native.ts` | Renderer / bridge | 127 | Clean. no unsafe blocks, no mutable state. |
| `src/bridge/simulator.ts` | Renderer / bridge | 848 | Clean. no unsafe blocks, no mutable state. |
| `src/bridge/types.ts` | Renderer / bridge | 370 | Clean. no unsafe blocks, no mutable state. |
| `src/catalog.generated.ts` | Renderer | 542 | Clean. no unsafe blocks, no mutable state. |
| `src/export.ts` | Renderer | 132 | Clean. no unsafe blocks, no mutable state. |
| `src/i18n/en.ts` | Renderer / i18n | 684 | Clean. no unsafe blocks, no mutable state. |
| `src/i18n/format.ts` | Renderer / i18n | 208 | Clean. no unsafe blocks, no mutable state. |
| `src/i18n/index.tsx` | Renderer / i18n | 252 | Clean. no unsafe blocks, no mutable state. |
| `src/i18n/tr.ts` | Renderer / i18n | 660 | Clean. no unsafe blocks, no mutable state. |
| `src/main.tsx` | Renderer | 31 | Clean. no unsafe blocks, no mutable state. |
| `src/perf.ts` | Renderer | 52 | Clean. no unsafe blocks, no mutable state. |
| `src/shared/placeholder.ts` | Renderer / shared | 15 | Clean. no unsafe blocks, no mutable state. |
| `src/state/store.ts` | Renderer / state | 401 | Clean. no unsafe blocks, no mutable state. |
| `src/ui/ActionGrid.tsx` | Renderer / ui | 264 | Clean. no unsafe blocks, no mutable state. |
| `src/ui/ActivityScreen.tsx` | Renderer / ui | 89 | Clean. no unsafe blocks, no mutable state. |
| `src/ui/AppBar.tsx` | Renderer / ui | 74 | Clean. no unsafe blocks, no mutable state. |
| `src/ui/CmdPalette.tsx` | Renderer / ui | 216 | Clean. no unsafe blocks, no mutable state. |
| `src/ui/Console.tsx` | Renderer / ui | 111 | Clean. no unsafe blocks, no mutable state. |
| `src/ui/Dialogs.tsx` | Renderer / ui | 632 | Clean. no unsafe blocks, no mutable state. |
| `src/ui/ErrorBoundary.tsx` | Renderer / ui | 117 | Clean. no unsafe blocks, no mutable state. |
| `src/ui/ErrorToast.tsx` | Renderer / ui | 57 | Clean. no unsafe blocks, no mutable state. |
| `src/ui/HealthStrip.tsx` | Renderer / ui | 87 | Clean. no unsafe blocks, no mutable state. |
| `src/ui/HelpScreen.tsx` | Renderer / ui | 48 | Clean. no unsafe blocks, no mutable state. |
| `src/ui/icons.tsx` | Renderer / ui | 235 | Clean. no unsafe blocks, no mutable state. |
| `src/ui/logText.ts` | Renderer / ui | 58 | Clean. no unsafe blocks, no mutable state. |
| `src/ui/nav.ts` | Renderer / ui | 47 | Clean. no unsafe blocks, no mutable state. |
| `src/ui/SettingsScreen.tsx` | Renderer / ui | 145 | Clean. no unsafe blocks, no mutable state. |
| `src/ui/Sidebar.tsx` | Renderer / ui | 150 | Clean. no unsafe blocks, no mutable state. |
| `src/ui/SnapshotsScreen.tsx` | Renderer / ui | 114 | Clean. no unsafe blocks, no mutable state. |
| `src/ui/StatusBar.tsx` | Renderer / ui | 77 | Clean. no unsafe blocks, no mutable state. |
| `src/ui/Tabs.tsx` | Renderer / ui | 123 | Clean. no unsafe blocks, no mutable state. |
| `src/ui/theme.ts` | Renderer / ui | 33 | Clean. no unsafe blocks, no mutable state. |
| `src/ui/TrustScreen.tsx` | Renderer / ui | 197 | Clean. no unsafe blocks, no mutable state. |
| `src/ui/useFocusTrap.ts` | Renderer / ui | 155 | Clean. no unsafe blocks, no mutable state. |
| `src/ui/WindowControls.tsx` | Renderer / ui | 96 | Clean. no unsafe blocks, no mutable state. |
| `src/vite-env.d.ts` | Renderer | 6 | Clean. no unsafe blocks, no mutable state. |

---

## 6. Evidence

| Claim | Evidence | Where |
| :--- | :--- | :--- |
| The release gate passes end to end | 34-step chain, exit 0 | `evidence/verify-final.log` |
| The release binary renders its own UI | `location.href` is `http://tauri.localhost/`, 22 action cards, 5 tabs, 6 nav destinations | WebDriver probe; sweep journal |
| Every screen renders without overflow, blank paint or console error | 10 of 10 states pass | `evidence/screens/*.png` |
| Card footers share a baseline | `footBottom` equal across each grid row; footer spread 0 | `measure-cards.mjs` |
| KPI labels are not clipped | `scrollWidth == clientWidth` for all four metrics | WebDriver measurement |
| Every unsafe block and unsafe impl is documented | 106 blocks + 2 impls, 108 `SAFETY` comments | `check:ffi` |
| No emoji, no fallback glyph, no typographic dash in production sources | 0 hits across 120 files | glyph sweep, `check:dashes` |
| The bundle is self-contained | manifest, cargo resolution and `dist/` freshness all measured | `check:bundle` |
| Counts in the documents match the tree | 341 Rust tests, 196 vitest tests in 14 files, 866 catalogue keys, 171 register rows (162 closed, 9 open) | `check:doc-counts` |

Every artefact above has a row in the evidence ledger
([`evidence/README.md`](../../evidence/README.md)), which `check:evidence-ledger` enforces.

---

## 7. What this audit does not cover

Nine register rows remain open, and none is an audit finding of this pass. They are stated here
because an audit that reports only what it fixed is a sales document:

| ID | Severity | Why it is open |
| :--- | :--- | :--- |
| DEF-028 | RED Critical for distribution | Requires an EV code-signing certificate, which is an owner purchase. The build signs with whatever certificate the machine has, and an unsigned installer is not shippable |
| DEF-043 | ORANGE High | Screen-reader verification needs NVDA and Narrator on a real host. The a11y work is measured by `computeAccessibleName` and the focus-trap probe, but a synthetic name is not a listening session |
| DEF-047 | ORANGE High | The T-WIN VM suite needs a clean Windows VM matrix. The suite is written; the hosts are not provisioned |
| DEF-050 | ORANGE High | Continuous integration needs the repository to exist on a remote with runners. The workflow is written and the chain it runs is green locally |
| DEF-057 | AMBER Medium | Native-speaker review of the Turkish catalogue. The translations are complete and structurally checked; they are not reviewed by a native speaker |
| DEF-058 | AMBER Medium | The ARM64 target needs `aarch64-pc-windows-msvc` std installed, which is a toolchain decision |
| DEF-059 | AMBER Medium | The updater manifest must be signed with the same certificate as DEF-028 |
| DEF-060 | BLUE Low | The `enterprise-telemetry` feature flag is specified in `09-01` and not built. It is a paid-tier capability, deliberately out of 1.0.0 scope |
| DEF-066 | BLUE Low | `chrono` arrives transitively through `serde_with` into `tauri-utils`. Replacing it means patching an upstream dependency graph, and `check:deny` documents the exception |

An audit is a statement about the tree at a moment. This one is paired with a green gate and a
measurement of the shipped artefact, which is the strongest form the statement can take here: the
binary was opened, its DOM measured, and every screen rendered.
