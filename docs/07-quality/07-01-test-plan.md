# 07-01 - Test Plan

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-QUA-001 |
| Version | 2.0.0 |
| Owner | QA / Engineering |
| Executed today | `cargo test --workspace --locked` (341 tests), `vitest run` (196 tests in 14 files), 25 node gate scripts in the `verify` chain + `zenith-audit`, `tsc --noEmit`, `vite build`, `scripts/e2e-journeys.mjs` (3 journeys, exit 0) |
| Closes | DEF-010 (v1.0.0 acceptance criteria were "cargo test passes", with no test ids) |

This plan defines every test id referenced by `02-03`, states **how it is executed today**, and marks
honestly which ids have no automated harness yet. A test id that cannot be run is not a test.

---

## 1. How to run everything

```powershell
# 341 Rust tests (282 core lib + 57 app lib + 2 catalog drift)
cargo test --workspace

# Contract: doc ↔ Rust ↔ frontend
node scripts/check-contract.mjs

# Locale parity: keys, placeholders, ICU branches, mojibake
node scripts/check-locales.mjs

# WCAG contrast for 14 palettes (28 palette/mode themes), 520 pairs
node scripts/check-contrast.mjs

# ADR-012: the simulator cannot reach native imports
node scripts/check-simulator.mjs

# Type checking + production bundle
npx tsc --noEmit
npx vite build

# Everything a release requires
npm run verify

# Desktop end-to-end (needs tauri-driver + msedgedriver; drives target/release/zenith.exe)
npm run e2e -- --app target/release/zenith.exe --driver "$env:TEMP\zenith-e2e\msedgedriver.exe"
```

`npm run verify` is `check:locales && check:unused-keys && check:step-keys && check:step-keys-negative && check:contract && check:dashes && check:emoji && check:contrast && check:simulator && check:nonwindows && check:docs && build && check:fe && check:doc-counts && check:evidence-ledger && check:scorecard && check:ffi && check:licenses && check:deny && check:sbom && check:stubs && check:mutate-restore && check:verify-chain && check:resources && check:icons && check:installer && check:workflows && check:msrv && check:lint && check:rust-tests && check:bundle`
The chain is thirty-one steps, each exits non-zero on failure, so it stops at the first broken gate.
`check:resources` verifies `resources/manifest.json` is still a real contract: every asset carries an
id, a path, a byte count, a SHA-256, a source and a licence; ids and paths are unique; no path escapes
the directory; and every asset that happens to be present on the machine hashes to its pin. The
binaries themselves are fetched rather than committed - the WebView2 offline installer alone is 215 MB,
past GitHub's per-file limit - so the manifest is what a rebuild on another machine trusts.
`check:workflows` reads `.github/workflows/verify.yml` as the second copy of this procedure it is, and
checks it against the tree it runs in: every `npm run <script>` names a script in `package.json`, every
`node <path>` names a file, the chain itself is invoked rather than a hand-copied subset, the Node pin
matches `.node-version`, the installed Rust toolchain matches `rust-version`, and no step carries
`continue-on-error: true` or `|| true`, which would turn a gate into a log line. It blanks YAML
comments before matching: the first version of this gate passed a workflow whose `run: npm run verify`
had been replaced, because the header comment still contained the phrase.
`check:bundle` runs last because it inspects the `dist/` that `build` produces: it proves the crate
compiles in the self-contained shape (`tauri/custom-protocol` enabled) and that `frontendDist` holds a
content-hashed production bundle newer than every renderer source. Until DEF-155 nothing checked this,
so a release binary could be linked without the feature and open the browser's connection-refused page.
`check:rust-tests` is `cargo test --workspace`, and it is the last gate before `build`: until DEF-129 the
chain contained no step that executed a test at all. `check:doc-counts` ran `cargo test --workspace --
--list`, which compiles the binaries and enumerates their names; proving it, a planted `assert!(false)`
made `cargo test` exit 101 while `npm run verify` still exited 0. `check:verify-chain` now reads the
chain itself - every step must name an existing script, the Rust step must run tests rather than list
them, and this paragraph's step count must equal the command it describes. `check:mutate-restore`
proves the helper every mutation gate restores through is byte-exact, after a lossy `"utf8"`
round-trip turned a 9 MiB binary into 14 MiB and reported the wreckage as identical (DEF-131).
`check:evidence-ledger` requires every artefact under `evidence/` to have a row in its own ledger,
every row to name a file that exists, no artefact to be empty, and every `evidence/…` path cited by a
document to resolve (DEF-132).

The E2E suite is deliberately outside `verify`: it needs a built release binary and a matching
`msedgedriver`, so it runs as a release gate rather than on every `vite` change. Exit codes are
`0` pass, `1` journey failure, `2` missing prerequisite. The two WebDriver ports are OS-assigned by
default - Windows reserves port blocks, and a hardcoded 4444 fails on any host where that block is
excluded - so `--port` is only needed to pin a known pair.

---

## 2. Current result

| Suite | Count | Result |
| :--- | ---: | :--- |
| `zenith-core` unit tests | 282 | 282 passed |
| `zenith-core` integration (`catalog_in_sync`) | 2 | 2 passed |
| `zenith` binary (handover, logging, maintenance, telemetry, guards, scan registry, retention, app-info, launch mode, integrations) | 57 | 57 passed |
| Doc tests | 0 | - |
| **Rust total** | **341** | **341 passed, 0 failed** |
| `check-contract` | 15 commands / 6 events / 25 error codes | pass |
| `check-locales` | 866 keys × 2 | pass |
| `check-contrast` | 520 pairs × 14 palettes | pass |
| `check-simulator` | 4-module import graph | pass |
| `check-emoji` | 251 files scanned, no `Emoji_Presentation` character | pass |
| `check-secrets` | worktree + full git history, 0 findings | pass |
| `check-icons` | 17 files reproduced byte-for-byte from `assets/zenith-mark.svg` | pass |
| `check-installer` | 73 language rows, 52 NSIS names present in the pinned archive, 10 icon paths | pass |
| `check-ffi` | 115 unsafe blocks + 2 unsafe impls, SAFETY pairing | pass |
| `check-docs` | 118 F / 86 N traced, 93 test ids, 134 DEF ids | pass |
| `check-doc-counts` | every "<n> tests/keys/rows" claim in the docs matched against the measured tree (168 rows / 159 closed / 196 vitest / 866 keys / 341 Rust); historical closure rows pass only when marked "at the time" | pass |
| `check-evidence-ledger` | every artefact under `evidence/` has a ledger row, every row names a file that exists, no artefact is 0 bytes, and every `evidence/…` path a document cites resolves (DEF-132) | pass |
| `check-scorecard` | rubric sums to 100; C1-C10 rows sum to 45 (v1) and 98 (v2); 2 withheld = 2 shortfall; owner's eight bands sum to 110 → 46.4/100, 1.4-point gap; register 168 ids, 1..168, 159+9 | pass |
| `check-unused-keys` | every one of the 858 catalogue keys is referenced by `src/` (DEF-089 found 52 that were not) | 0 of 858 unreachable, pass |
| `check-step-keys` | every `steps.*`/`error.*`/`remedy.*` key the core emits exists in both catalogues, and no `steps.*` key is emitted-less (DEF-088, DEF-090) | 39 catalogue keys, 0 missing, 0 orphaned, pass |
| `check-scorecard-mutation` | 3 rubric mutations of `10-01` each rejected, file restored byte-identical | pass (exit 0, `evidence/scorecard-mutation.log`) |
| `check-bands-mutation` | 4 eight-band mutations each rejected, file restored byte-identical | pass (exit 0, `evidence/scorecard-bands-mutation.log`) |
| `probe-focus-trap` | release gate (not in `verify`) - drives the **packaged** binary over WebDriver: focus enters the dialog on open, Tab/Shift+Tab wrap at both edges, focus is pulled back from the background, closing restores the trigger, and the palette gets the same guarantee (DEF-086, DEF-087) | before release; after any overlay change | PASS (`evidence/focus-trap.log`) |
| `check-focus-trap-mutation` | release gate (not in `verify`) - deletes the render-time capture in `useFocusTrap.ts` and requires the `autoFocus` regression case to go red (observed 8 passed / 1 failed), then restores the file byte-identically (DEF-087) | before release | PASS (`evidence/focus-trap-mutation.log`) |
| `vitest` (setup surface) | included in the count above - 17 tests over the six installer states, the language list, RTL, and the launch-mode parser | pass (`src/setup/*.test.ts*`) |
| `capture:setup` | release gate (not in `verify`) - drives the packaged setup page and writes six state captures plus four overflow states at 1328x888 | pass (`evidence/screens/setup/*.png`) |
| `capture:settings` | release gate (not in `verify`) - drives the release binary over WebDriver, opens all 12 settings leaves, checks zero horizontal overflow, and writes 12 tab captures plus 5 Store screens at 1366x768 | pass (`evidence/settings-capture.log`) |
| `check-build-identity` | release gate (not in `verify`) - proves the binary's embedded `release-YYYYMMDD` matches its own mtime, that exactly one such marker exists, and that no shipped source is newer than the binary; the check behind DEF-092 | pass (`release-20261122`, 4 roots older) |
| `check-build-identity-mutation` | release gate (not in `verify`) - three mutations of the artefact/date relationship, each required to fail the gate, tree restored byte- and mtime-identical | pass (3 of 3 bite, tree restored) |
| `vitest` | 196 tests in 14 files: reducer and store, ICU formatting, locale parity, settings model and parsers, PIN derivation, shortcuts, notification routing and delivery, the setup surface (17), and the render suite (67) | pass |
| `npm run e2e` | 3 journeys / 11 steps | pass (exit 0) |
| `tsc --noEmit` | whole `src/` | pass |
| `vite build` | 697.2 kB JS + 19.2 kB CSS (162.4 + 4.3 kB gzip) | pass |

Rust coverage by module (counted from `#[test]` in `crates/zenith-core/src`; 254 core tests, table sums to 245):

| Module | Tests | What it protects |
| :--- | ---: | :--- |
| `engine/redact` | 18 | every secret shape, URL-embedded tokens, log-line assignments, idempotence |
| `engine/executor` | 18 | mutex, phases, batch planning, confirmation, documented rollback path |
| `engine/snapshot` | 15 | HMAC, zip-slip, hash verify, extraction |
| `engine/db` | 14 | schema, migration, recovery, quarantine, purge |
| `engine/health` | 16 | score formula boundaries, unknown DNS |
| `engine/scope` | 11 | traversal, registry comparison, capability |
| `engine/dag` | 9 | cycles, ordering stability, dependents |
| `engine/retention` | 8 | consent rule, byte/row caps, orphans |
| `engine/audit` | 7 | correlation ids, fixed-width timestamps, UTC normalisation, durations |
| `engine/pipeline` | 4 | entry names, safe join, payload roots |
| `engine/support` | 4 | scraper, redaction order, budget trim, seeded-secret end-to-end bundle |
| `engine/headless` | 3 | CLI dispatch, refusal rules, exit codes |
| `engine/purge` | 2 | token, scope parsing |
| `engine/keystore` | 1 | key material path |
| `cli` | 15 | grammar, refusal predicate, argument validation before disk |
| `adapters/child` | 13 | timeout, cancel budget, deadlock, redaction |
| `adapters/process` | 12 | FILETIME, PID recycle, listeners, self-refusal (DEF-090) |
| `adapters/cleanup` | 10 | age selection, real bytes freed |
| `adapters/services` | 10 | state polling, idempotence |
| `adapters/actions` | 9 | every action has a path, code not prose |
| `adapters/system` | 7 | memory arithmetic, build matrix |
| `adapters/candidates` | 5 | kinds, cancel ≠ empty, hung lower bound, single-enumeration hung detection (DEF-112) |
| `adapters/dpapi` | 3 | round trip, corrupt ciphertext |
| `adapters/console` | 2 | detached-console plumbing |
| `adapters/privilege` | 2 | honest capability |
| `manifest` | 11 | 22 actions, SAFE_PRESET, constraints |
| `models` | 5 | kebab-case round trip, tier honesty |
| `config` | 5 | roots, headroom, no escape |
| `error` | 3 | distinct codes, IPC shape |
| `i18n` | 3 | locale negotiation parity |

The app crate contributes 39: `handover` (3), `logging` (7), `maintenance` (6),
`telemetry` (6 - the 30 s visibility-gated refresh), `single_instance_tests` (7 - the
mutex/plugin guard, the uninstall-hook root check, the phase-recording guard, the durable
step trace, the cancelled-action log line and the diagnosis log line), and
`commands::retention_tests` (5 - the store reads that used to report a failure as zero,
DEF-123) plus `commands::scan_registry_tests` (5). The
`crates/zenith-core/tests/catalog_in_sync.rs` integration test adds 2. That is the
282 + 50 + 2 = 334 total; `cargo test --workspace` prints the split.

---

## 3. Test layers

| Layer | Tooling | Runs in | Status |
| :--- | :--- | :--- | :--- |
| **L1 unit** | `cargo test` | every push | PASS 341 (282 core + 57 app + 2 catalog drift) |
| **L2 integration** | `cargo test --tests` | every push | PASS 2 |
| **L3 contract** | `node scripts/*.mjs` | every push | 22 node gates in `verify` (34 scripts on disk, the rest standalone checks) |
| **L4 type/build** | `tsc`, `vite build` | every push | PASS |
| **L5 UI behaviour** | `vitest run` (196 tests in 14 files: reducer, formatter, render, render boundary, focus trap, controller, fast-diagnose budget, export, boot timing, log text, DEF-089/090/091 wiring) | every push | PASS (`check:fe`) |
| **L6 Win32 smoke** | manual on a real VM | release | FAIL DEF-047 |
| **L7 E2E** | `scripts/e2e-journeys.mjs` - `tauri-driver` 2.1.0 + `msedgedriver` 157.0.4341.60 over WebView2 | release | PASS 3 journeys / 11 steps, exit 0 (DEF-048 closed) |
| **L8 performance** | boot marks + `bootMs` readout (T-PERF-01); per-probe timing in the audit log (T-PERF-02) | every run | WARN instrumented, p95 needs DEF-047 |
| **L9 fault injection** | in-code only (db recovery) | every push | WARN partial |
| **L10 screen sweep** | `scripts/sweep-screens.mjs` - 10 states through WebDriver, screenshots + live geometry + nested-scroller measurement | release | PASS 10/10 states, 0 problems (DEF-075…DEF-079, DEF-082 found here) |
| **L11 setup surface** | `vitest run src/setup` - the installer page as a second Vite entry: six states, the 73-language list with a working search, RTL, the progress model, and the launch-mode parser | every push (inside `check:fe`) | PASS 17 tests |
| **L12 screenshot capture** | `scripts/capture-setup.mjs` and `scripts/capture-settings.mjs` - drive the packaged binary over WebDriver and save its own pixels, once per screen and per settings leaf, with an overflow assertion per capture | release | PASS 10 setup states at 1328x888, 12 settings leaves and 5 Store screens at 1366x768 |

Frontend evidence comes from `tsc --noEmit` (types), `vite build` (module graph, CSS),
`vitest run` (196 tests: render suites through `@testing-library/react` plus pure-logic assertions in `.test.ts` files, including the 17 setup-surface tests), the fourteen node gate scripts in the `verify` chain plus `zenith-audit --all` and the production build
(locale parity, unreachable-key reachability, core-emitted step keys, IPC contract, contrast, simulator graph, non-Windows guards, docs integrity, numeric doc counts, scorecard
arithmetic, FFI safety, licence notices, dependency policy, SBOM freshness), the Zero-Stub audit, the L10 sweep and the
source inspection recorded in `05-*`.

**Why L10 exists.** jsdom has no layout engine: it cannot see a clipped string, a card that escapes
its grid, or a screen that navigates nowhere. L10 drives the packaged binary, asserts
`#main[data-screen]` reports the screen the shot claims to be, measures
`scrollWidth - clientWidth` and every element's `getBoundingClientRect` against the viewport, walks
every descendant of `#main` for a computed `overflow` **with real hidden content** (only `.licenses-text`
is allowed to scroll inside page content, per `05-02` §1), and saves the renderer's own
pixels. It found six defects no unit test could have seen, because in each case the code was behaving
exactly as written: DEF-075 (`Derleme: dev` on a release build), DEF-076 (three children under
`space-between` stranding the Snapshot header), DEF-077 (settings toggles reading as two more themes),
DEF-078 (the Help paragraph printed twice), DEF-079 (the console empty state squeezed into the 76 px
time column) and DEF-082 (the Activity screen rendering a vertically nested scroller inside `.main`,
which the earlier horizontal-only check could not see - and which the new check found again as
`.licenses-text` hiding 120,425 px the instant it was switched on).

Two single-purpose probes sit beside the sweep for questions a screenshot cannot answer:

| Probe | Question it answers | Evidence |
| :--- | :--- | :--- |
| `scripts/probe-layout.mjs` | Do cards in a row share one bottom edge, and does any child overflow its card horizontally? A compositor frame can be stale; `getBoundingClientRect` cannot | exit 0 = every row aligned, nothing clipped |
| `scripts/probe-overlay-scroll.mjs` | Does any scroll box nest inside `.dialog`? Measured on the script and palette overlays at the 780 px default **and** the 640 px minimum, where a double scrollbar would appear | `evidence/overlay-scroll.log` - 0 nested containers at both heights |

Both are manual (they launch the packaged binary through WebDriver) and both are measurement, not
assertion: `probe-overlay-scroll` exists because the sweep only walks `#main *` and overlays are siblings
of it. It ran, found no nesting at either height, and so *confirmed* `05-02` §1 rather than assuming it.

Still unproven: screen-reader output (DEF-043), p95 performance on a clean VM (DEF-047), and the
uninstaller/VM matrix - §5.7 states which id each belongs to.

### 3.1 The setup surface and the launch mode

The installer UI is not a route inside the main window. `setup.html` is a second
Vite entry (`src/setup/*`) and the binary chooses it at startup from a launch
mode: `--setup` for the install wizard, `--uninstall` for the removal wizard,
and no argument for the application. The split exists for three reasons:

1. **Capabilities.** The setup page needs window control and drag and nothing
   else. It gets its own capability file (`src-tauri/capabilities/setup.json`),
   so a compromised installer page cannot reach a single IPC command that the
   application declares.
2. **Bundle.** The application's window is created in `.setup()` with
   `create: false` in `tauri.conf.json`, so a setup run never builds an
   application window it will not use.
3. **Testability.** The six states are a pure state machine with no IPC in the
   loop, which is what makes 17 unit tests possible against a surface that a
   screenshot can only sample.

The parser is unit tested (`launch_mode`), the surface is unit tested, and the
rendered result is captured by `capture:setup` in six states plus four overflow
cases at the two window heights the wizard allows.

---

## 4. The T-CONTRACT family (all automated)

| ID | Asserts | Executed by | Result |
| :--- | :--- | :--- | :--- |
| T-CONTRACT-01 | Manifest id set == generated TS union == 22 actions | `catalog_in_sync::generated_catalog_matches_the_manifest` | PASS |
| T-CONTRACT-02 | ActionDef fields match the manifest table | `manifest::manifest_is_structurally_sound` | PASS |
| T-CONTRACT-03 | Category / tier / risk enums are closed and stable | `models::action_ids_round_trip_through_the_wire_form` | PASS |
| T-CONTRACT-04 | Every action declares a scope | `manifest::scope_of_every_action_is_declared` | PASS |
| T-CONTRACT-05 | Health formula constants are the published ones | `health::five_gigabytes_of_junk_costs_exactly_thirty_points` | PASS |
| T-CONTRACT-06 | Batch eligibility ⇔ safe preset membership | `manifest::safe_preset_is_eight_ordered_eligible_steps` | PASS |
| T-CONTRACT-07 | Script snippets are non-empty and placeholder-free | `manifest::no_snippet_contains_a_todo_marker` | PASS |
| T-CONTRACT-08 | Doc = Rust registry = frontend bridge (commands, events, 25 error keys) | `scripts/check-contract.mjs` | PASS |
| T-CONTRACT-09 | Release artifacts are reproducible and hash-pinned | - | FAIL DEF-050 (no CI yet) |
| T-CONTRACT-10 | Third-party notices exist, are current, and cover every component | `scripts/check-licenses.mjs` | PASS |
| T-CONTRACT-11 | Dependency policy: advisories, bans, licences, sources | `scripts/check-deny.mjs` + `deny.toml` | PASS |

T-CONTRACT-01 and -02 are byte-level drift tests: `catalog_ts::render()` is called by both the example
that writes `src/catalog.generated.ts` and the integration test that compares the file's bytes. Any
manifest edit without regenerating fails the test, and the fixture includes the `ActionId` union shape
(separators precede each line, last line gets `;`) so a hand-edit is caught.

---

## 5. Requirement test ids: status and method

Legend: PASS automated today · WARN partially covered by a lower layer · FAIL no harness yet

### 5.1 T-UNIT

| ID | Requirement | Method | Status |
| :--- | :--- | :--- | :--- |
| T-UNIT-01 | REQ-F-017 - health score is a published formula | `health::*` (13 tests: boundaries, saturation, unknown DNS) | PASS |

### 5.2 T-RUST (core behaviour)

| ID | Requirement | Method | Status |
| :--- | :--- | :--- | :--- |
| T-RUST-01 | F-054 - job object kills the child tree | `child::a_timeout_kills_the_child_and_reports_it` | PASS (tree kill itself needs a spawned grandchild; DEF-047) |
| T-RUST-03 | F-030 - dependency ordering | `dag::dism_runs_before_sfc`, `ordering_is_stable_across_input_permutations` | PASS |
| T-RUST-04 | F-062 - elevation is detected honestly | `privilege::capability_reflects_elevation_honestly` | PASS |
| T-RUST-05 | F-007 / F-045 - snapshot written before mutation | `db::snapshot_lifecycle_pending_then_committed` | PASS |
| T-RUST-06 | F-021 - snapshot commits atomically | `db::committing_an_unknown_snapshot_fails` | PASS |
| T-RUST-07 | F-041 - rollback integrity | `snapshot::extraction_refuses_a_hash_mismatch` | PASS |
| T-RUST-08 | F-043 - scope allowlist | `scope::*` (11 tests incl. traversal, registry) | PASS |
| T-RUST-09 | F-044 - tamper detection | `snapshot::a_changed_payload_invalidates_the_tag` | PASS |
| T-RUST-10 | F-050 / F-053 - timeout + watchdog | `child::a_timeout_kills_the_child_and_reports_it` | PASS |
| T-RUST-11 | F-051 / F-052 - cancellation ≤500 ms | `child::cancellation_stops_a_running_child`, `executor::cancel_token_reports_and_resets`, `child::cancellation_lands_within_the_500ms_budget_on_a_silent_child` | PASS timed against the 500 ms budget |
| T-RUST-12 | F-005 - machine-wide single execution | `executor::only_one_action_runs_at_a_time`, `single_instance_tests::single_instance_guard_is_wired` | WARN process-wide registry is tested; cross-process enforcement is the single-instance plugin, asserted at source level rather than launched twice |
| T-RUST-13 | F-066 / F-067 - error codes, not prose | `error::every_code_has_distinct_stable_text`, `actions::a_failed_execution_carries_the_error_code_not_prose` | PASS |
| T-RUST-14 | F-016 - unsafe only in adapters | `cargo clippy -- -D warnings` + `03-06` audit | WARN no `cargo-geiger` gate |
| T-RUST-15 | F-033 - event schema versioning | `adapter.ts` `EventMap` + `check-contract` | PASS |
| T-RUST-16 | F-047 / F-096 - retention with consent | `retention::unrestored_snapshots_require_consent` | PASS |
| T-RUST-17 | F-093 - degraded store fallback | `config::layout_is_under_declared_roots` | WARN fallback path not forced in a test |
| T-RUST-18 | F-094 - schema migration | `db::opening_a_newer_schema_refuses_to_run`, `a_fresh_store_has_schema_version_one` | PASS |
| T-RUST-19 | F-095 - corruption quarantined, not deleted | `db::a_corrupt_database_is_quarantined_not_deleted` | PASS |
| T-RUST-20 | F-142 - disk headroom | `config::disk_headroom_is_enforced`, `headroom_has_a_floor_for_tiny_archives` | PASS |
| T-RUST-21 | F-144 - correlation id in every error | `audit::correlation_ids_are_unique_and_url_safe`, `error::error_serialises_to_the_ipc_shape` | PASS |

### 5.3 T-SEC (security regression)

| ID | Requirement | Method | Status |
| :--- | :--- | :--- | :--- |
| T-SEC-01 | F-040 - HMAC key is DPAPI-protected | `dpapi::protected_bytes_round_trip`, `snapshot::a_different_key_cannot_forge_a_tag` | PASS |
| T-SEC-02 | F-042 - forged snapshot rejected | `snapshot::a_swapped_action_id_invalidates_the_tag`, `malformed_tags_are_rejected_without_panicking` | PASS |
| T-SEC-03 | F-112 - handover ticket is single-use | `handover` (3 tests) | PASS |
| T-SEC-04 | F-013 - IPC schema validation | `error::error_serialises_to_the_ipc_shape` + `check-contract` | WARN no fuzz input |
| T-SEC-05 | F-063 - secrets redacted | `redact::*` (18 tests) | PASS |
| T-SEC-06 | F-088 - support bundle leaks nothing | `support::seeded_secrets_do_not_survive_into_the_written_bundle` - real log → real zip → re-read | PASS |
| T-SEC-07 | F-079 - admin enforced at run time | `executor::admin_actions_require_elevation` | PASS |
| T-SEC-08 | F-008 / F-130 - no silent deletion | `retention::*`, `purge::purge_requires_the_exact_token` | PASS |
| T-SEC-09 | F-098 / F-132 - nothing identifiable stored | `support::identifier_scrubbing_replaces_identity_but_not_short_names`, schema audit in `04-02` §3 | WARN inspection + 1 test |

### 5.4 T-WIN (real Win32 integration)

| ID | Requirement | Method | Status |
| :--- | :--- | :--- | :--- |
| T-WIN-01..12 | F-060..F-089 (probes, services, ports, spooler, Winsock, GPU, reboot) | Not implemented. Some adapter tests do touch the live OS (`services::querying_the_spooler_succeeds`, `system::real_machine_reports_an_os_build`, `process::identifying_our_own_process_succeeds`, `cleanup::recycle_bin_query_never_fails_on_a_real_drive`) | FAIL DEF-047 |

The four live-OS tests above are the only real-machine evidence in the suite. They are deliberately
few and non-mutating. Every mutating Win32 path (service restart, Winsock reset, GPU reset, reboot)
has unit-level coverage of its *decision* logic but no integration test that performs the change -
because a test suite that resets Winsock on the build machine is not a test suite, it is an outage.
The VM suite in `08-02` §5 is the intended home for T-WIN; it does not exist yet.

### 5.5 T-FE (frontend logic)

| ID | Requirement | Method | Status |
| :--- | :--- | :--- | :--- |
| T-FE-01 | F-029 - the shell renders and boots | `render.test.tsx` (mounts components under `I18nProvider`) | PASS |
| T-FE-02 | F-080..F-084 - health strip reports measured values only | `HealthStrip` cases: "never measured" vs measured, progress, cancel, diagnose | PASS |
| T-FE-03 | F-009 - category tabs and search | 5 tabs, `aria-selected`, dispatch on click, Escape clears search | PASS |
| T-FE-04 | F-107 - every catalog action has a card | card count equals `ACTIONS.length` | PASS |
| T-FE-05 | F-110 - status bar counts | action count built with the shipped translator | PASS |
| T-FE-06 | F-055 - unmeasured metric is "unknown" | `card.unknown` on every card with no report | PASS |
| T-FE-07 | F-022 - hidden/pinned preferences | hidden cards suppressed unless `showHidden` | PASS |
| T-FE-08 | F-046 - console drawer is bounded and honest | null when closed, dropped-line notice, empty state, clear | PASS |
| T-FE-09 | F-071 - navigation via `aria-current` | active screen marked, click dispatches `screen/set` | PASS |
| T-FE-10 | F-100 - command palette keyboard | ArrowDown moves `aria-selected`, Enter runs, empty state | PASS |
| T-FE-11 | F-101 - destructive dialog gating | button disabled until the exact word is typed | PASS |
| T-FE-12 | F-103 - the attestation is passed to the core | `execute(actionId, typed)` called with the typed word | PASS |
| T-FE-13 | F-104 / F-106 - locale switch | Turkish renders from `tr`, `<html lang>` negotiated (`tr-TR`→`tr`, `de-DE`→`en`) | PASS |
| T-FE-14 | F-108 / F-133 / F-125 - ICU formatting in the UI | `format.test.ts` (9 tests) + rendered plural values | PASS |
| T-FE-15 | F-090 - audit export has a stable schema | `export.test.ts` (9 tests): RFC 4180 quoting, unquoted numbers, CRLF endings, `{v:1,kind,columns,rows}` envelope, JSON round-trip, unknown action id preserved | PASS |
| T-FE-19 | F-029 - a render fault shows a recovery screen, not a blank window (DEF-085) | `errorBoundary.test.tsx` (6 tests): recovery copy instead of nothing, the fault named in the detail line, `--support-bundle` hint, retry re-renders the child, `resetKey` clears a caught fault, children untouched when nothing throws | PASS |
| T-FE-20 | F-029 - the boundary is actually mounted around the screens (DEF-083's lesson) | `errorBoundary.wiring.test.tsx` mounts the real `App` with a screen mocked to throw: the panel is *inside* `#main`, `.shell`/`.appbar` still render and the window buttons survive, retry is offered in the active locale | PASS |
| T-FE-21 | F-023 / WCAG 2.1.2 - `aria-modal` is a real promise, not an attribute (DEF-086, DEF-087) | `useFocusTrap.test.tsx` (9 tests): focus moves in on mount, Tab wraps first↔last, focus outside is pulled back, an empty dialog keeps focus, the trigger is restored on close, **the trigger is still restored when the dialog contains an `autoFocus` field** (the case that failed in the packaged binary - DEF-087), a deliberate inner focus survives re-render, the listener is removed. Proven in the **packaged binary** by `probe-focus-trap.mjs`, and the `autoFocus` case shown to bite by `check-focus-trap-mutation.mjs` | PASS |
| T-FE-22 | F-014 / ADR-010 - a log line is localized from its `stepKey`, never from the core's English (DEF-088) | `ui/logText.test.ts` (6 tests): a known key resolves through the catalogue, params interpolate, an unknown key falls back to the core's `text`, a missing key uses `text`, both empty, and a wire status token is not treated as a sentence | PASS |
| T-FE-23 | F-066 / F-015 - the measurement a catalogue key names actually reaches the screen (DEF-089, DEF-090, DEF-091) | `ui/wiring089.test.tsx` (14 tests) mounts the shipped components with contract-shaped payloads: port memory and redacted command line, the self row badged with **no** checkbox, the terminate summary count, print page/owner, WSL VM bytes, the hung-window sentence, bundle path/size/files/redaction, the error `detail` disclosure (and its absence), the abortable badge, and script-copy feedback. Each asserts a *value*, so a key that is present but unbound fails | PASS |

`vitest` runs **132 tests in twelve files**. Measured split: `state/store.test.ts` (25 reducer
transitions), `i18n/format.test.ts` (9 formatter cases), `ui/render.test.tsx` (39 render assertions
in jsdom), `export.test.ts` (9 audit-export cases), `perf.test.ts` (4 boot-timing cases, including
"absent mark yields null, never 0"), `ui/logText.test.ts` (9 log-line cases - DEF-088 and DEF-094),
`ui/errorBoundary.test.tsx` (6 boundary assertions), `ui/errorBoundary.wiring.test.tsx` (1 assertion
that the **shipped `App`** mounts the boundary around the screen layer), `ui/useFocusTrap.test.tsx`
(9 containment cases, including the `autoFocus` trigger-restore that DEF-087 broke),
`actions.test.tsx` (6 controller assertions against a fake bridge), `actions.budget.test.tsx`
(1 case proving the fast-diagnose threshold comes from the generated catalogue - DEF-093), and
`ui/wiring089.test.tsx` (14 cases pinning the DEF-089/090/091 wiring). 76 of the 132 live in
`.test.tsx` files that render through Testing Library; 56 are pure-logic assertions in `.test.ts` files.


Structural properties the same run depends on, each with its own gate:

| Property | Gate |
| :--- | :--- |
| Every translation key used by a component exists | `tsc` (`MessageKey` union) |
| Every action id used by a component exists | `tsc` (`ActionId` union) |
| The simulator cannot import native code | `check-simulator.mjs` |
| Every documented command is callable | `check-contract.mjs` |
| Colour pairs meet WCAG | `check-contrast.mjs` |
| The production bundle builds | `vite build` |

What the render suite deliberately does **not** do: snapshots (a snapshot makes a wrong render look
correct forever), real network/IPC (the `ActionsApi` stub has one spy per method), and pixel layout.
Focus *order* is exercised through `data-action-card` traversal in the card's own key handler; CSS
layout and screen-reader output are outside what jsdom can observe, which is why `10-01` still withholds
a point for NVDA (DEF-043).

Writing these tests paid for itself immediately: the first run found that `format()` emitted the literal
`#` inside ICU plural branches, so a measured count rendered as "# items". `format.ts` now substitutes
the formatted count and `format.test.ts` guards it (DEF-065, closed).

### 5.6 T-CLI

| ID | Requirement | Method | Status |
| :--- | :--- | :--- | :--- |
| T-CLI-01..04 | F-085..F-087, F-090 | `cargo test -p zenith-core --lib cli:: headless::` (18 tests) covers grammar, exit-code mapping, `--dry-run` non-mutation and the irreversible-refusal rule | PASS pass |

The CLI was the one contract/code gap in the 2.0.0 draft. It is now implemented and tested:
`crates/zenith-core/src/cli.rs` owns the grammar, `engine/headless.rs` owns dispatch, and
`src-tauri/src/lib.rs::entry` selects CLI vs GUI. DEF-054 is therefore **closed**; the remaining
verification is a VM run of the real binary, which belongs to the T-WIN suite (DEF-047).

### 5.7 T-E2E / T-PERF / T-A11Y / T-I18N / T-FAULT

| Group | Status | Notes |
| :--- | :--- | :--- |
| T-E2E-01..09 | PASS (DEF-048 closed) | `scripts/e2e-journeys.mjs` drives the installed desktop binary (not the simulator) over WebView2: T-E2E-01 diagnose boot+22 cards, T-E2E-02 `__TAURI_INTERNALS__` present, T-E2E-03 diagnostics rendered, T-E2E-04 confirmation dialog, T-E2E-05 run executes through IPC, T-E2E-06 snapshot committed, T-E2E-07 rollback restores bytes (SHA-256 matched), T-E2E-08 card settles to `rolled_back`, T-E2E-09 host left clean. 3 journeys / 11 steps, exit 0 on 2026-11-20; T-E2E-01 also proves the first-launch diagnosis runs with no click (REQ-F-002) and that the manual re-run still works |
| T-PERF-01..05 | WARN | T-PERF-01 (boot to interactive) is instrumented and displayed; T-PERF-02 records per-probe `latencyMs` in the audit row. The p95 half runs on the reference VM, which is DEF-047 |
| T-A11Y-01..05 | WARN | contrast is measured (T-A11Y-01 holds); zoom reflow (1.4.4/1.4.10) is now **measured** across 54 cells at 320 px / 200% / 400% (DEF-044 closed); an NVDA session is still not run (`05-03` §8, DEF-043) |
| T-I18N-01..06 | WARN | keys/placeholders/branches are automated; plural *rendering* is not snapshot-tested; RTL is N/A (no RTL locale ships) |
| T-FAULT-01..02 | WARN | DB recovery paths are tested (`recovery_aborts_pending_rows`, `recovery_marks_missing_archives_broken`, `recovery_removes_temp_files_and_quarantines_orphans`); other 9 crash points are not injected |

---

## 6. Fault injection: what exists

`engine::db::recovery` is the only subsystem with genuine crash simulation, because it is the one where
a crash is expected:

| Crash point | Simulated by | Test |
| :--- | :--- | :--- |
| Crash after `PENDING` insert | leave a pending row, reopen | `recovery_aborts_pending_rows` |
| Crash after commit, archive missing | delete the zip, reopen | `recovery_marks_missing_archives_broken` |
| Crash during archive write | leave `.zip.tmp`, reopen | `recovery_removes_temp_files_and_quarantines_orphans` |
| Corrupt DB file | write garbage, reopen | `a_corrupt_database_is_quarantined_not_deleted` |
| Newer schema | set `user_version = 99` | `opening_a_newer_schema_refuses_to_run` |

The other crash points REQ-F-140 names (service stop, half-written hives, held locks) are not injected.
That requirement is therefore **partially** covered and is not marked complete.

---

## 7. Closing the gaps (order matters)

| Priority | Deficiency | First step |
| :--- | :--- | :--- |
| 1 | DEF-047 no T-WIN suite | Windows VM + a `--test-profile` build that redirects mutations to a sandbox |
| 2 | ~~DEF-048 no E2E~~ closed 2026-11-20: `scripts/e2e-journeys.mjs` drives the real desktop binary over WebView2 for diagnose → run → rollback (3 journeys / 11 steps, exit 0). First use found two genuine product defects (DEF-068 dead phase machine, DEF-069 unreachable rollback transition), both fixed |
| 3 | ~~DEF-053 bundle secrets~~ closed 2026-11-20: `support::seeded_secrets_do_not_survive_into_the_written_bundle` seeds three credential shapes, builds the zip and re-reads it - it found two real redactor holes, both fixed |
| 4 | ~~DEF-049 no perf~~ closed 2026-11-20: `src/perf.ts` marks boot start before React and measures to first commit, `TrustScreen` shows the result; the p95 half needs the DEF-047 reference VM |
| 5 | ~~DEF-045 no focus/zoom check~~ closed 2026-11-20: `scrollIntoView` asserted in `render.test.tsx`; ~~DEF-044 zoom~~ closed 2026-11-20 by measuring 320 px / 200 % / 400 % across 54 cells and fixing the 368 px overflow the measurement exposed |

Each is a deficiency entry in `10-02`, so the plan and the register cannot disagree.

---

## 8. What this plan refuses to do

- It does not map a requirement to a test id that has no executable form and call it covered. Where
  coverage is partial, the row says WARN and names the gap.
- It does not count a test twice because it touches two requirements. The 255 count is test functions,
  not assertions.
- It does not claim performance numbers. `01-01`'s 1.5 s cold start is a **budget**; it is not measured
  here and is not reported as achieved.
- It does not treat "the simulator works in a browser" as E2E evidence for the desktop app.
