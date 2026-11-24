# 10-01 - Engineering Scorecard

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-AUD-001 |
| Version | 2.0.0 |
| Owner | Emir Tarık Dede (Vellium) |
| Subject | The v1.0.0 single-file specification → the 2.0.0 library + implementation |
| Method | Weighted rubric, scored against commands, files and tests - never against intent |
| Result | **v1.0.0: 45/100 (re-scored; 51/110 = 46.4/100 by the owner's original bands) → 2.0.0: 98/100** |
| Closes | No single defect - the scorecard is the evidence instrument for Gate G1 |

This is the document the whole library exists to satisfy (`00-01` §6, gate G1). It is also the easiest
place to lie, so the method is stated first and the evidence column is mandatory: **a criterion with
no runnable proof scores zero regardless of how good the prose is.**

---

## 1. The rubric

Ten criteria, weighted to reflect what actually protects a user of an elevated repair tool.

| # | Criterion | Weight | What "full marks" means |
| :--- | :--- | ---: | :--- |
| C1 | Requirements engineering | 12 | Numbered, testable, traceable to a design section and a test id |
| C2 | Architecture & decisions | 12 | Boundaries, ADRs with consequences, an enforceable invariant |
| C3 | Safety of the destructive core | 14 | Snapshot-before-mutation, honest tiers, scope allowlist, tamper detection |
| C4 | Security & threat model | 13 | STRIDE, attacker model, four exploitable v1.0.0 designs closed |
| C5 | FFI & memory correctness | 10 | Every `unsafe` justified, HRESULT propagation, no fake success |
| C6 | Data, retention & privacy | 9 | Schema, migrations, consent before deletion, erasure contract |
| C7 | Interface & accessibility | 10 | Every screen and state specified, measured contrast, keyboard, a11y audit |
| C8 | Localization | 6 | ICU plurals, structural parity gate, honest locale tiers |
| C9 | Test strategy & automation | 8 | Test ids that run, contract gates, Zero-Stub audit |
| C10 | Delivery, docs & truthfulness | 6 | Build, signing story, risk register, a register that admits gaps |
| **Total** | | **100** | |

C3 and C4 carry the most weight because this tool deletes files, edits the registry, restarts services
and runs elevated. A beautiful requirements document for a tool that can brick a machine scores high
and is worthless. C10 is deliberately small: delivery ceremony matters less than the product not
lying.

---

## 2. v1.0.0 score (the baseline)

| Criterion | Score | Evidence of failure |
| :--- | ---: | :--- |
| C1 | 5/12 | One prose file; no numbered requirements, no test mapping |
| C2 | 7/12 | A file tree called a plan; no ADRs; six disagreeing definitions of an action |
| C3 | 4/14 | HMAC keyed on readable `MachineGuid`; rollback applied stored paths; recycle bin claimed reversible |
| C4 | 3/13 | No threat model; four exploitable designs (S-1..S-4) |
| C5 | 4/10 | `let _ =` on HRESULTs; misaligned buffers; UTF-16 decoder split chars |
| C6 | 3/9 | No migrations; corruption deleted the DB; no data inventory |
| C7 | 5/10 | Screens listed, no states; inline hex colours |
| C8 | 4/6 | Flat key/value; 73 locales claimed with no QA path |
| C9 | 4/8 | Acceptance = "cargo test passes" |
| C10 | 6/6 | Named a paid tier and a feature flag, specified neither |
| **Total** | **45/100** | |

Two baselines are quoted in this library, and they are not the same measurement. The **owner's original
assessment** awarded **51 raw points** across eight bands whose weights sum to **110**, not 100 (vision
11/15, architecture 9/15, Rust/Win32 8/20, security 4/15, completeness 4/15, i18n 6/10, UI 5/10,
docs/tests/ops 4/10). The raw 51 is preserved wherever it is cited, because it is the owner's judgement
and not ours to rewrite - but it is **51/110, which normalises to 46.4/100**. An earlier revision of this
document printed "51/100" and then claimed the difference from 45 was "six points of rubric shape"; both
were wrong, because 51 and 45 have different denominators and cannot be subtracted. Re-scored under
**this** ten-criterion rubric - whose weights do sum to 100 - the same v1.0.0 artefact earns **45/100**,
so the two independent assessments agree to within **1.4 points**, which is the honest statement about
rubric shape: two different lenses on one artefact produced nearly the same verdict. §3 compares like with
like: 45 → 98 under one rubric, a gain of **+53**.

An earlier revision of this table printed `12/6→6/6` for C10 and a total of 51, then claimed the total
was "the sum with C10 capped at its weight". Both statements could not be true - capping C10 at 6 gives
45. The row and the total are corrected here; the arithmetic is `5+7+4+3+4+3+5+4+4+6 = 45`.

---

## 3. 2.0.0 score

| # | Criterion | v1 | v2 | Evidence (runnable) |
| :--- | :--- | ---: | ---: | :--- |
| C1 | Requirements | 5 | **12** | 118 `REQ-F` + 86 `REQ-N`, each with its own row in `02-03`; `check:docs` asserts 118/118 functional, 86/86 non-functional, and closes all 93 cited test ids against `07-01`, 0 unmapped |
| C2 | Architecture | 7 | **12** | 24 ADRs with consequences; `manifest.rs` → `catalog.generated.ts` drift test; single-source enforced by `catalog_in_sync` |
| C3 | Destructive core | 4 | **14** | `snapshot::*` (15), `executor::*` (16), `scope::*` (11), `retention::*` (8); 4-tier honesty tested; HMAC tag covers action id; cancellation timed under 500 ms on a silent child |
| C4 | Security | 3 | **13** | `04-01` STRIDE + attacker model; S-1..S-4 closed; `dpapi::*`, `handover::*` (3), `redact::*` (18); seeded-secret bundle test builds a real zip and re-reads it; 25 error codes bilingual |
| C5 | FFI | 4 | **9** | 115 `unsafe` blocks plus 2 `unsafe impl`s, each with its own `// SAFETY:` comment (110 comments in total). Two independent proofs: `cargo clippy -D warnings` compiles the real `#[cfg(windows)]` surface on this `x86_64-pc-windows-msvc` host and `clippy::undocumented_unsafe_blocks` is `deny`-level, so a missing comment is a build error (verified with a throwaway crate: the lint fires, exit 101); `check:ffi` independently re-reads the 45 source files and pairs every block with its comment without trusting the compiler. `win32_code` on every HRESULT; `03-06` standard |
| C6 | Data & privacy | 3 | **9** | `03-03` migrations + recovery; `04-02` D1-D11 inventory; consent-before-prune tested; purge with token |
| C7 | Interface & a11y | 5 | **9** | `05-02` 6 screens/5 overlays/key map; `check-contrast` 75×3 all pass; `05-03` assesses **31 criteria, all verified** (1.2.x is N/A - no media) with the live screen-reader session still open as DEF-043, which is the −1 on this row; zoom reflow 1.4.4/1.4.10 measured at 320 px / 200 % / 400 % across 54 cells (DEF-044 closed) |
| C8 | Localization | 4 | **6** | ICU subset; `check-locales` 866×2 exact parity, `check-unused-keys` 0 of 866 unreachable, `check-step-keys` 328 emitted keys present, 0 missing from either catalogue; ADR-023 tiers honest about 2 shipped locales |
| C9 | Tests & automation | 4 | **8** | 341 Rust tests + 196 vitest tests (reducer, ICU formatter, 47 render, 2 render-boundary, 9 focus-trap, 8 controller, 1 diagnose-budget, 11 audit-export, 4 boot-timing, 13 log-text, 17 candidate-wiring); 22-step `npm run verify` (17 node script gates + `check:fe` + `zenith-audit --all` + `cargo test --workspace` + build, the last three being the only steps that execute code rather than read it); contract 15/15/15/15; 3-journey/11-step WebDriver E2E (`scripts/e2e-journeys.mjs`, exit 0, re-run after every UI change) |
| C10 | Delivery & truth | 6 | **6** | `08-02`/`08-03`/`08-04`; 171-row register with 9 admitted-open rows; installer built, hashed, install→uninstall tested (`08-02` §8.1), and the uninstaller now offers data deletion |
| **Total** | | **45** | **98** | |

### 3.1 What running the packaged binary found that the tests did not

Nine defects were found on 2026-11-21 by launching `target/release/zenith.exe` and *looking at it* -
not by a failing test. They are listed here because a rubric that only counts green commands rewards a
suite that measures the wrong thing.

| Defect | Symptom a user would see | Why every gate was green |
| :--- | :--- | :--- |
| DEF-071 | First launch showed `Puan -` and 22 cards reading "Ölçülmedi" until the button was found | The probe layer was tested; the *call* from the shell was not. `02-03` cited T-E2E-01 for REQ-F-002, and T-E2E-01 only counted cards |
| DEF-072 | Changing the theme reverted a locale changed on another screen | Each screen's own test asserted the right payload; the controller merged a stale snapshot in afterwards |
| DEF-073 | The winget measurement ran past the card edge and was clipped | jsdom has no layout, so no render test can see an overflow |
| DEF-074 | `check:deny` failed with a policy error when DNS was down | A transport failure and a policy failure shared exit code 1 |
| DEF-075 | The Trust Center of a **release** build said `Derleme: dev` | `build.rs` never set the variable the getter read. No test asserted the value, and the fallback was documented as intentional |
| DEF-076 | The Snapshot screen's CSV/JSON export buttons rendered as loose text in the middle of the header | `space-between` with three children centres the middle one. jsdom has no flex algorithm, so headless tests could not see it |
| DEF-077 | Settings showed the motion and telemetry toggles directly under the theme radios, with no heading, so they read as two more themes | Nothing asserted the *order and grouping* of a panel; the strings and the dispatch were both correct |
| DEF-078 | The Help screen printed the same paragraph twice and the tagline a third time | The key existed and both renders used it correctly - duplication is not a string error, and jsdom asserts presence, not how many times a paragraph repeats on one screen |
| DEF-079 | The Activity screen's empty state wrapped one word per line and repeated the subtitle | `.log li`'s 76 px time column is invisible without layout, and the empty state reused the subtitle's key |

All nine are now closed with a test or a gate that fails without the fix (`actions.test.tsx`,
`render.test.tsx` including T-FE-16/17/18, `check-deny.mjs` offline path, `src-tauri/build.rs` identity
resolution, E2E REQ-F-002 step, and the L10 screen sweep that checks `#main[data-screen]` and measures
geometry before saving each shot). The lesson is recorded rather than the victory: **jsdom proves
structure, a screenshot proves the product.**

### 3.1.1 What auditing against the library's own rules found

The nine above were found by looking at the running product. Twenty-nine further defects were found by
auditing the shipped code and documents against rules this library states - every one of them had passed
every automated gate, DEF-087 was in the *fix* for DEF-086, and DEF-091 was found by the test written to
close DEF-089:

| Defect | Symptom a reader would see | Why every gate was green |
| :--- | :--- | :--- |
| DEF-080 | §2 scored C10 as `12/6` and printed a total of **51**, while the sentence beneath said the total was "the sum with C10 capped at its weight". Capping gives **45**. §3's own v1 column scored C10 as 6, so the same artefact had two baselines | `check-docs` verifies that DEF, REQ and test ids resolve. Nothing read the scorecard as arithmetic |
| DEF-081 | `05-03`'s summary claimed **28 assessed / 26 pass / 2 not performed**, while its body carried **31 Pass headings plus one N/A**. It also numbered Non-text Content `2.1.1`, colliding with Keyboard, and marked `4.1.2` a bare "pass" while DEF-043 says no screen-reader session has run | Every link resolved and every id existed. A document that contradicts itself in prose is invisible to a reference checker |
| DEF-082 | `05-02` §1 declares `.main` the page's only scroll container, but `.log` carried a global `overflow: auto` and the Activity screen renders inside `.main` with `max-height: 55vh` - a nested scroller hiding rows, the class of defect DEF-077 had already fixed once under a different class name | `vitest` mounts in jsdom, which computes no layout, and `sweep-screens.mjs` measured only *horizontal* overflow. A vertical nested scroller is invisible to both |
| DEF-083 | DEF-079 gave the Activity screen's empty state `li.log-empty`, but the console drawer - which renders the same `ol.log` on every screen - still emitted a bare `<li class="muted">` and inherited the 76 px time column. The class was fixed in one renderer and left in its twin | The Console test asserted `getByText(console.empty)` - that the string existed, never which class carried it. A presence assertion cannot see a layout class |
| DEF-084 | §2 and `README.md` reported the owner's original assessment as **51/100**, but the eight band weights listed are 15+15+20+15+15+10+10+10 = **110**. The measurement is 51/110 = **46.4/100**, and the sentence explaining the gap subtracted 45 from 51 across two denominators | `check-scorecard.mjs` read only the C1-C10 table; the *other* rubric's arithmetic was assumed correct because it was "the owner's number, not ours" |
| DEF-085 | No component in `src/` caught a render throw, so a screen that failed took the **whole window** with it - a blank surface with no text, no retry and no reference number. `App`'s error states covered only *boot*, a different path; React unmounts the tree on a render throw | `tsc` does not execute components, `vitest` had no throwing case, and the L10 sweep measures geometry of a tree that rendered *successfully* - a failing screen simply produces no frame to measure |
| DEF-086 | Every overlay declared `aria-modal="true"` - the promise that the page behind it is inert - but no code trapped `Tab`. A keyboard user could tab out of an open confirmation into the grid behind it and operate controls the dialog had just declared unavailable, and closing it dropped focus to `<body>` instead of the card the user came from. `05-03` marked 2.1.2 "Pass" on the sentence *"overlays do not implement a focus trap that omits the close control"* - a true description of the **absence**, read as the criterion | `vitest` had no case that pressed Tab inside a dialog (a render assertion cannot see focus order), and the L10 sweep measures geometry, not where focus goes. The attribute was asserted; its promise was never checked |
| DEF-087 | The fix for DEF-086 was itself broken: the hook recorded the restore target in an effect, but `autoFocus` moves focus at **commit** and effects run after it, so it recorded the dialog's own input and then failed to restore on close. Focus still landed on `<body>` - the exact symptom DEF-086 claimed to have closed | Nine unit tests passed, all asserting the hook's own mechanism with a trap that had no `autoFocus` child. Nothing drove the **packaged** dialog, where `autoFocus` is real. The row had even been marked closed on the strength of those tests |
| DEF-088 | The console printed `steps.dnsFlush: Success` - a raw catalogue key plus a Rust `Debug` variant - in the middle of a Turkish window. ADR-010 says the core never ships English; this was the one surface a user watches while an action runs, and it broke that rule | `check-locales` proves the *two catalogues agree with each other*. Neither it nor any other gate asked what the renderer actually printed, so a key that was never looked up and an enum formatted with `{:?}` both looked like healthy code |
| DEF-089 | 52 catalogue keys could not be reached by any code path. Parity had been green at 471 keys for the whole session and was read as health | Parity only says `en` and `tr` contain the same keys. No gate asked whether a key was *rendered*, so a string could describe behaviour that did not exist (30 keys) or data the core measured and the UI dropped (22 keys) for as long as it liked |
| DEF-090 | `ports.self` promised "Zenith itself - it will not be stopped", and nothing enforced it. The app's own listening port appeared in its own candidate list, selectable, and `terminate_if_identity_matches` had no self check | The key was unreachable, so no test rendered the promise; and the core's own unit tests used `std::process::id()` as *subject*, which never asserted that self-termination was refused. The safety statement lived only in a string |
| DEF-091 | The candidate dialog's third column heading printed the literal `Unresponsive for ⟦ms⟧`, because a parameterised sentence was used as a column label | `check-locales` matched the placeholder in both catalogues, `check-unused-keys` proved it was referenced, and `tsc` typed it. A heading has no parameters to interpolate - only rendering the table showed it |
| DEF-092 | The rebuilt binary announced `release-20261120` as its build identity while its own file timestamp read 2026-11-21 - a wrong provenance claim on the screen a user consults before trusting the build | `build.rs` emitted only `rerun-if-env-changed`, which **disables** cargo's default "rerun when a package file changes"; the script therefore never re-ran after the first build. No gate read a *date* as an output, and the stale value was also last session's genuinely-correct date, so nothing contradicted anything |
| DEF-093 | The fast-diagnose threshold was typed twice - a bare `3000` in `src/actions.ts` and a separate `FAST_DIAGNOSE_BUDGET_MS` in the shell - so the progress bar announced a total the core had not promised to run. Two numbers that agree today and nothing that notices when they stop | Both values happened to be 3000, so no test could fail; and the constant lived in a module the renderer never imports, so no gate compared them. The same class as DEF-001, reintroduced in the layer meant to end it |
| DEF-094 | The shell's own console lines - a saved bundle path, an exported audit file - shipped English text into a Turkish window, because they carried `text` and no `stepKey`. `logText` falls back to `text` by design, so the fallback did exactly its job and produced a half-translated console | `check-unused-keys` saw the keys referenced elsewhere and counted them healthy; no test asserted the *language* of a line the controller writes rather than the core |
| DEF-095 | Shell log lines were numbered `seq: Date.now()`, so saving a bundle and exporting an audit in the same millisecond produced two identical sequence numbers - and, since both renderers key on `${seq}-${atUtc}`, a duplicate React key | The simulator incremented a counter correctly, so the only broken producer was the one path with no test. `03-04` §4 calls `seq` monotonic per action and nothing checked the producer |
| DEF-096 | `check-doc-counts.mjs` - the gate whose job is catching stale numbers - printed a hard-coded `MEASURED` object under the word "measured". The tree had moved to 445 keys / 132 tests / 12 files while the gate exited 0 still saying 443 / 124 / 11 | It compared the docs against a constant an author typed, so it could only see a document change, never the code. A green gate asserting its own assumption, one level above the dishonesty the scorecard exists to catch |
| DEF-097 | `03-04` §6 promised `telemetry_update` "after diagnosis, and every 30 s while visible". Nothing ever published it after a pass: no `setInterval`, no core timer. A window left open showed the memory figure from its first diagnosis for as long as it stayed open | `check-contract` proves an event is declared, registered and listened to. None of those questions is "is it published on the cadence the same table states", so a one-sided promise looked like a healthy event |
| DEF-098 | A *successful* action's step trace existed only as a best-effort event. `emit` returns `Ok(())` with no listener, `execution_audit` stores one summary row per action, and the only `logging::append` calls were on the failure paths - so a support bundle opened after the window closed carried no record that a repair had run | `04-02` §5 calls the log the artefact a bundle ships and `support.rs` includes `logs/`; both were true. The gap was that the *success* path wrote nothing there, and no gate asked what a bundle contains after a quiet success |
| DEF-099 | `03-04` §6 promised "if the UI is not mounted, the core buffers ≤ 500 lines then drops with a counter". No buffer, counter or drain command ever existed - and `ADR-014` recorded the same never-built design, so two documents agreed with each other and neither with the code | `check-contract` lists events and commands; a queue internal to the core is neither. A promise about a data structure no IPC surface exposes is invisible to every gate the library has |
| DEF-100 | `src-tauri/src/commands.rs` opened with "The thirteen IPC commands of `03-04` §3" while fifteen are registered. The file a maintainer reads first disagreed with the gate that counts them | `check-contract` counts `generate_handler![…]` and reported 15/15/15 correctly. Nothing reads a prose count in a module doc comment, which is exactly why it had been left behind two commands ago |
| DEF-101 | An unreadable memory reading was passed to telemetry as `0 / 0 MB`, so the strip rendered "0 %" and the score awarded full marks on a term nobody had measured - while the DNS term beside it already treated "could not measure" as neither perfect nor broken | `check-contract` proves the field exists; no gate asks whether a sentinel is a measurement. A default value that silently becomes the most reassuring number on the screen is invisible to every schema check |
| DEF-102 | REQ-F-052's 500 ms budget was tested by timing the scheduler: `cancel()` set a flag and the child runner noticed it on its next 40 ms poll. The same logic measured 32 ms idle and 411 ms under load, and crossed the budget once - a release gate that measured the machine | The test *was* the gate, so a flake had no second opinion. Nothing distinguished "the product noticed late" from "the worker was not scheduled", because the effect and the measurement shared one timestamp |
| DEF-103 | `03-04` §5.5 said `action_cancel` "waits ≤ 500 ms, then terminates the job object". The command set a token and returned immediately and never touched a job object - a described design that was never built | `check-contract` counts commands and event names, not prose about timing, so a sentence describing a sleep was as invisible as DEF-099's queue |
| DEF-104 | The numeric-drift gate - the one whose job is catching stale numbers - ignored any difference larger than 12, so **255 Rust tests** beside a measured **272** produced no output at all. Its `tests in N files` pattern also compared the *test* count against the file count | `check-docs` counts ids, not values; `check-scorecard` checks arithmetic, not prose. A plausibility band is an assumption about which numbers matter, and nothing outside the gate can see that assumption |
| DEF-105 | A cancelled action wrote nothing to the durable log: the branch was `if err.code != ErrorCode::Cancelled { append(…) }`, so the one case where the user deliberately intervened left the least trace | `check-stubs` scans for unbuilt contracts; a branch that *deliberately* skips a write is a design decision, not a stub, so no gate could see it. It took reading the branch to notice the exclusion |
| DEF-106 | `diagnose_run` - the read-only operation every first launch runs - wrote nothing durable on any path, and the support bundle carries the logs but not the diagnostic reports, so a bundle filed after a diagnosis showed no evidence it happened | `check-contract` proves a command is registered and its events declared; no gate asks whether a command persists anything. Only reading the three terminal arms revealed that all of them stopped at setting card phases |
| DEF-107 | The candidate dialog printed the literal `[object Object]` into a `role="alert"` when a scan failed - a JavaScript internal in the one place a user was being told what went wrong | The bridge rejects with an `IpcError` **object**, not an `Error`, so `reason instanceof Error` was false and `String(reason)` ran. Every gate was green because the dialog had its own copy of the normaliser; the other two copies were correct, and no test drove a *rejection* through this overlay |
| DEF-108 | Starting a scan silently withdrew a stop the user had just requested for a running diagnosis, and no scan could be stopped at all - the dialog offered "Scan again" while the old walk was still running, so a slow spooler held the window hostage exactly as the core claimed it would not | `state.rs` documents `diagnose_cancel` as separate so one operation cannot cancel another; nothing compared the token `candidates_scan` used against that promise. `candidates.rs` honoured a token between printers and jobs, but no command or button ever cancelled a scan, and two of the four families never received the token - so the promise had no caller and no test could fail |
| DEF-109 | The release gate rejected a correct build: after local midnight on any host east of Greenwich, `check-build-identity.mjs` reported "the binary reports a day it was not built on" about a binary built on exactly the UTC day it embedded | `build.rs` writes a UTC calendar day; the gate rendered the binary's mtime locally. The two agree for most of the day, so reading the code in any timezone looks right - only running it at 00:47 local (UTC+03:00) showed the mismatch, and every other check in the file passed |
| DEF-110 | The mutation test that proves the numeric-drift gate works printed "gate did NOT catch it" about a mutant it had caught, and exited 1 - a false alarm in the one file whose job is to prove the numbers are measured | Its expected string was typed (`measured 445`), five lines after a comment explaining that five of its six expectations are derived. The catalogue grew to 447, the gate said `measured 447`, the literal missed, and the report blamed the gate. Same class as DEF-096, inside DEF-096's own proof |
| DEF-111 | Every selectable row in the candidate dialog exposed its internal key as the checkbox's accessible name, so a screen reader announced a listener as the digits `3000:14208` - a name that identifies neither the port, the process, nor the PID in words | The string was present, the checkbox was reachable, and `check-unused-keys` saw the button keys referenced. Worse, `wiring089.test.tsx` asserted `toBe("3000:14208")`: the test written for DEF-090 had pinned the defect, so the suite certified a label no blind user could act on |
| DEF-112 | The "frozen Office window" dialog could name the wrong window: it reported a document as frozen when a *different* window of that process was the hung one, presented the five-second OS threshold as a measured duration, put a nameless header over its checkboxes, and the contract declared a `windowTitleKey` field no code produced | Hung-ness came from `is_responding` (any hung window of the process) while the caption came from a separate walk (first *titled* window in z-order) - different windows, so the user closed an app believing they knew which file was at risk. The test that should have caught it built a struct by hand and asserted the number it had just written: a tautology |
| DEF-113 | A release binary linked on 2026-11-22 shipped `release-20261121` in its Trust Center, so the app reported the wrong build day with full confidence | Cargo re-runs `build.rs` only when a watched input changes, and the watch list did not include the renderer; a renderer-only rebuild relinks the binary without re-stamping it. DEF-092 was "detection disabled"; this was "detection narrower than the claim". Caught by the identity gate comparing the marker to the binary's own mtime, not by reading the script |
| DEF-114 | The print-queue and WSL candidate tables drew a fourth column headed "Select" with no controls in it, and the source comment above the table still said "three columns" | The selection header and cell were rendered for every family while only two set `terminable`, so a read-only scan announced a column of controls that did not exist. No gate reads a table's header against its body; found by reading the two blocks together |
| DEF-115 | Before any diagnosis had run, the status bar said **"None"** - zero issues - about a machine nothing had measured, and it fed the same catalogue key from a different source than the health strip | `state.reports` is `{}` until a diagnosis lands, so an empty map was counted as zero issues. `HealthStrip` renders `-` for the same key when `telemetry` is null; the bar rendered a measurement. Both were "correct" in isolation, which is why no single-file reading found it |
| DEF-116 | Both Copy buttons put raw support text on the clipboard while the list above them showed the translated sentence, so a Turkish user copied English `steps.dnsFlush: Success` lines that appeared nowhere on screen; the Activity button also gave no confirmation | Two renderers localized the row and two buttons copied the field localization exists to hide. Nothing compares a clipboard payload to a rendered list, so the defect was invisible to every gate - found by reading the handler against the map directly above it |
| DEF-117 | The telemetry checkbox in Settings was controlled by `state.telemetryEnabled` but only persisted, so clicking it left the box unmoved until a full `state_get` round-trip finished - a control that visibly does nothing | Telemetry was the only preference with no `prefs/*` action, so "dispatch optimistically, then persist" (the pattern the theme radios use) could not be followed and its absence looked like design rather than omission |
| DEF-118 | The Undo-history retention pill rendered `retention?.snapshots ?? 0` (and bytes, and audit rows), so it claimed "0 snapshots (0 B), 0 audit rows" about a store nobody had read | `retention` is nullable and `?? 0` collapsed "not measured" into the measurement zero - the exact law `HealthStrip` and DEF-104 exist to enforce, violated in a third file that read the same type |
| DEF-119 | The Undo-history table's fifth column was a bare `<th scope="col" />`, announced as "column 5" over the Undo button - the same nameless header DEF-112 had just fixed | DEF-112 fixed the one table it was reading and did not sweep the others, so the fix was exactly one file wide; the copy sat two screens away from the original |
| DEF-120 | Every action card's pin and hide buttons were announced as "★" and "◌"; three design documents claimed `title` supplied the name, and two of them named glyphs (`✕`/`⊘`) that appear nowhere in `src` | The accessible-name algorithm reads content before `title`, so `title`-only markup cannot name a button that has text. Measured with `computeAccessibleName` against the shipped markup; no test queried those buttons by name, and the documents were never checked against the code they described |
| DEF-121 | Pressing `Ctrl+D` while a diagnosis was already running started a second one: the progress bar reset to 0 with a shrunken total, the core rejected the duplicate with `ALREADY_RUNNING` as an error toast, and `finally` erased the progress display of the scan still running | The core guarded concurrency and the renderer did not, so the two disagreed about who owns "already running". Reading either side alone looks correct; the defect lives in the seam, and `05-02` §7 lists `Ctrl+D` with no "not while running" qualifier |
| DEF-122 | The category bar declared `role="tablist"` / `role="tab"` and omitted every behaviour the role promises: five separate Tab stops, no `aria-controls`, no `tabpanel` anywhere, arrow keys inert, and the search box wrapped inside the tablist | A role is a promise about behaviour, and the markup can be inspected, linted and unit-tested while the promise is empty. The tests asserted exactly the two things that worked (`aria-selected`, clicks), and two documents certified the pattern |
| DEF-123 | `state_get` turned an unreadable database into "0 snapshots (0 B), 0 audit rows", logged nothing, and the wire type could never carry `null`, so the `-` branch DEF-118 had just added was unreachable in production | The display layer was fixed while the layer that produces the number kept collapsing "not measured" into zero. A screen test mounting `retention: null` passes and proves nothing about the core, which is why the dead branch looked covered |
| DEF-124 | No gate compared a table with the total it states: `07-01` §2 listed 243 + 2 + 34 above a total of 286 (rows summed to 279), its module table summed to 243 while the crate held 245 tests, and `02-01` §16 summed to 118 above a stated 108 - all with `check-doc-counts` green | Two gates paid to check numbers both read text outside tables. A document's own arithmetic is the cheapest claim to verify and the easiest to get wrong, and every table edit since v2.0.0 had been unchecked |
| DEF-125 | `08-03` documented its own gate as `cargo test -p zenith --lib logging:: maintenance::` → "9 pass"; cargo accepts one filter, so the command exits 1 with `unexpected argument` and runs zero tests | A gate command quoted as evidence was never executed. The count beside it was written by hand, which is why an unrunnable command could survive a review that only read the number |
| DEF-126 | The startup retention pass had three silent failure paths (`else { return report }`, `unwrap_or(0)`, a dropped `apply_prune` `Err`), so a pass that pruned nothing for a bad reason was indistinguishable from a clean one and logged nothing at all | `unwrap_or(0)` here does not just misreport: it removes the audit-pruning half of the plan, weakening the retention guarantee. And `state.rs` logs only when the report is non-empty, so the failure vanished from the support bundle |
| DEF-127 | `AppInfo.os_build`/`os_display_version` were `u32`/`String` filled with `unwrap_or(0)`/`unwrap_or_default()`, so a failed `os_info()` read rendered as `" (0)"` in the Trust Center - a Windows version invented from nothing | The one screen whose entire purpose is stating measured facts about the machine, where every neighbouring field was already honest (`trust.boot.unknown`, `-` for unknown retention). The honest neighbours made the dishonest row believable |
| DEF-128 | `AppInfo.webview_version` was shipped from Rust as the English literal `"unknown"`, and the Trust Center rendered it verbatim, so a failed WebView read read as `"WebView: unknown"` inside an otherwise Turkish panel | The core's job is identifiers, the catalogue's job is words (ADR-010). Every sibling row on that panel was localised, so the one English word looked like a value rather than a message |
| DEF-129 | `npm run verify` - documented as the release gate, "seventeen steps, each exits non-zero" - contained no step that executed a test; the nearest was `cargo test --workspace -- --list`, which lists test names and runs no test body | A release gate that never runs the suite makes 293 green tests advisory. This is the audit's central concern in one row: a green light that does not measure what it claims. Proved by planting `assert!(false)` - `cargo test` exited 101, the chain exited 0 |
| DEF-130 | `check:deny` treated a killed cargo-deny process (`-1`, no output) as a completed policy verdict, printing "failed with exit 4294967295" | The file's own header says a transport failure must never be reported as a policy failure, because it teaches operators to skip the gate. A killed process is the same category and got the opposite treatment - and it happened on the first run of the new chain |
| DEF-131 | The mutation helper snapshot/restore path used `"utf8"` in and out, and verified with the same lossy decode - turning a 9 MiB binary into 14 MiB and calling it identical | Every mutation gate trusts this helper to leave the tree untouched. A check that cannot see its own damage is worse than no check: it certifies the corruption, and the next gate misreports the cause (which is exactly how DEF-130 was discovered) |
| DEF-132 | `evidence/README.md` - the ledger mapping every claim to the captured output behind it - had drifted from the tree: 74 artefacts on disk, 50 described, 24 undescribed, of which `def121-mutation.log`, `def122-mutation.log` and `vitest-counts.json` are cited by documents or read by a gate | A ledger is the map from a claim to its evidence, and it was maintained by hand while the artefacts multiplied. A document citing a proof the ledger does not explain is a dangling reference; a 0-byte file under a heading called Evidence asserts nothing - the "it looks like it is watching" class, aimed at its own proof |

All fifty-three are closed, and each now has a gate that fails on the original error - not a promise that it
will not recur:

| Defect | Gate that now bites |
| :--- | :--- |
| DEF-080 | `check-scorecard.mjs` recomputes both totals from the rows; shown to bite by `check-scorecard-mutation.mjs` |
| DEF-081 | `05-03`'s summary is a count of its own headings, so a hand-written total can no longer contradict the body |
| DEF-082 | `sweep-screens.mjs` walks `#main *` for computed `overflow` **and** real hidden content, allowlisting only the one scroller `05-02` §1 permits (`.licenses-text`) |
| DEF-083 | T-FE-08 and T-FE-18 both assert the *class*, not the string - the bug was that only one renderer had a test |
| DEF-084 | `check-scorecard.mjs` check 8 parses the owner's eight bands and requires the 110 denominator and the 1.4-point agreement; shown to bite by `check-bands-mutation.mjs` |
| DEF-085 | T-FE-19 (6 unit tests) **and** T-FE-20, which mounts the real `App` - because a boundary that is never mounted is the DEF-083 lesson again |
| DEF-086 | T-FE-21 drives Tab and Shift+Tab through a real dialog; the attribute and its promise are now checked together |
| DEF-087 | `probe-focus-trap.mjs` measures focus in the **packaged** binary (inside-on-open, wrap at both edges, restore to trigger), and `check-focus-trap-mutation.mjs` proves the `autoFocus` regression case fails when the fix is removed |
| DEF-088 | `check-step-keys.mjs` proves every `steps.*`/`error.*`/`remedy.*` key the core can emit exists in both catalogues and no `steps.*` key is emitted-less; `logText.test.ts` (6 cases) pins the one function that turns a line into words |
| DEF-089 | `check-unused-keys.mjs` reports 0 of 866 unreachable and runs as step 2 of `npm run verify`; `wiring089.test.tsx` (14 cases) asserts the *value* each key names reaches the screen |
| DEF-090 | `our_own_process_is_refused_not_terminated` asserts the core returns `RefusedSelf` for its own pid, and `wiring089.test.tsx` asserts the dialog offers no checkbox for the self row |
| DEF-091 | `wiring089.test.tsx` asserts the hung-family heading and cell are distinct strings, so a sentence used as a label fails loudly |
| DEF-092 | `check-build-identity.mjs` reads the embedded `release-YYYYMMDD` out of the binary and requires it to equal the artefact's own date and that no shipped source is newer; `build.rs` also emits `rerun-if-changed=src`, so the stamp cannot survive a source edit |
| DEF-093 | The constant lives once in `crates/zenith-core/src/manifest.rs`; `catalog_ts` emits it into `src/catalog.generated.ts`, and `actions.budget.test.tsx` mocks a *different* budget (900 ms) and requires the announced total to follow it - a literal `3000` reports 18 where the constant selects 4, measured |
| DEF-094 | `LogLine.params` plus `console.bundleSaved` / `console.auditExported` in both catalogues; `logText.test.ts` (9 cases) and `actions.test.tsx` assert the dispatched line's key and parameters, not just its presence |
| DEF-095 | `nextUiSeq()` in `actions.ts` keeps the wall clock when it advances and steps past it when it does not; a test freezes `Date.now()` to one value, dispatches both lines and requires two different, increasing `seq` values |
| DEF-096 | Every number is derived - keys from `src/i18n/en.ts`, vitest from `evidence/vitest-counts.json`, Rust from `cargo test --list`, commands from `generate_handler!`, DEF totals cross-checked against the register's own rows. Its first run found 16 stale claims and now reports 0 |
| DEF-097 | `telemetry.rs` owns a pure `refresh` plus a `spawn` loop on `REFRESH_INTERVAL = 30 s`; three tests cover the empty case (no fabricated 100), the real-report case and the interval value, and `diagnose_run` stores what it measured |
| DEF-098 | `logging::append_steps` writes the same twenty lines through the redacting, rotating writer; five tests cover success, error level, the cap and rotation, and a sixth reads `commands.rs` and fails if the call is removed - proven by deleting it (`FAILED`) and restoring bytes **and** mtime |
| DEF-099 | The contract states what exists: best-effort events, a 5,000-line UI ring, and durability through `append_steps`, naming the earlier draft as a promise never built so it cannot return as fact |
| DEF-100 | The header says fifteen. Deliberately not gate-enforced: the enforced count lives in `check-contract`, and a prose count in a comment is the drift this row records |
| DEF-101 | `memory_used_percent` is `Option<f32>` end to end; three core tests pin the rule (`None` scores neither perfect nor broken, a failed read reaches the wire as `None`, a zero total is treated as unread) and the strip renders `-` for `null` |
| DEF-102 | `CancelToken::register_hook` runs the killer inside `cancel()`; tests prove it fires before `cancel()` returns, that a dropped guard never fires, and that `reset()` clears the clock. The child test asserts the token's recorded latency (0 ms under load) plus a separate liveness bound; `action_execute` writes it into the durable log, so a cancelled action is a visible event rather than a silence |
| DEF-103 | The section states the measured bound (`CancelToken::latency_ms()`) instead of a sleep the command never took |
| DEF-104 | No window: a non-historical number must equal the measurement exactly, and history must be declared (phrase or `| DEF-nnn |` row). `check-doc-counts-mutation.mjs` proves six mutations bite, including "a history marker is required", restoring every file byte- and mtime-identical |
| DEF-105 | The cancelled branch persists `action <id> cancelled after <n> ms`; `single_instance_tests` asserts both the line and that the old skip condition is gone |
| DEF-106 | All three terminal paths persist a line; `a_diagnosis_is_recorded_in_the_durable_log_on_every_terminal_path` pins the success, cancel and failure format strings, so deleting any one fails the suite |
| DEF-107 | One `asIpcError` in `src/bridge/adapter.ts` for all three callers; two jsdom tests reject a scan with a real `IpcError` and assert the catalogue sentence and remedy render while `[object Object]` is absent from the document. Proven by mutation: restoring `<p>{String(error)}</p>` fails the suite |
| DEF-108 | Five registry tests (`commands::scan_registry_tests`) plus a source guard that strips comments before asserting the command's *code* never mentions `diagnose_cancel` or `.reset()`; two candidate tests prove all four families honour a pre-requested stop; three jsdom assertions cover the Stop button's label, scope and quiet outcome. Four mutations - borrow the diagnosis token, no-op the stop, print the raw value, press the wrong scope - each fail the suite |
| DEF-109 | `dateKey` now reads the same UTC calendar `build.rs` writes, so the comparison cannot disagree by an offset. `evidence/def109-mutation.log` restores the old local expression, observes exit 1 with the DEF-092 message, and restores the file byte- and mtime-identical; the proof measures its own precondition and prints `SKIP` on a host where both calendars coincide rather than claiming a catch it did not make |
| DEF-110 | The expected text is built from the run's own `measured:` object, so it follows the catalogue instead of drifting from it. `evidence/doc-counts-mutation.log` shows all six mutations caught - including the un-marked-history case reporting `"keys: 471 (measured 447)"` - with every file restored byte- and mtime-identical |
| DEF-111 | The checkbox name is a catalogue sentence rendered through `t()`, so it speaks the user's language; `wiring089.test.tsx` asserts the rendered sentence **and** requires it to contain the port and the process name, so a label that merely differs from the key cannot pass. Both locales carry `ports.select` / `hung.select` at parity (451 keys), `check-unused-keys` reports 0 unreachable |
| DEF-112 | `process::hung_window` answers "is it hung" and "which window is it" in one enumeration of the same window, and `is_responding` is now a thin reading of it - so the probe that counts and the dialog that names cannot disagree. `HUNG_WINDOW_FLOOR_MS` is a named constant, the catalogue says "at least", the checkbox column is `misc.selectRow`, an empty caption renders `hung.untitled` in cell and accessible name, and the phantom `windowTitleKey` is gone. A source guard fails if the producer re-splits the enumerations or types the floor; `wiring089.test.tsx` asserts "at least", the named column header, and the untitled fallback |
| DEF-113 | `build.rs` names a path that never exists (`FORCE_RESTAMP_EVERY_BUILD`), which cargo treats as permanently out of date, so the stamp is rewritten on every build. `check-build-identity.mjs` now also fails if that line is missing, so the defect cannot return silently; `evidence/def113-mutation.log` removes the line and observes the gate reject the tree |
| DEF-114 | The header and the selection cell are both rendered only when `terminable`, so the print queue and WSL tables are three-column tables with no control column. `wiring089.test.tsx` asserts exactly three `columnheader`s, no "Select" header and zero checkboxes for the print queue |
| DEF-115 | The bar reads `state.telemetry.issueCount` - the same source as the health strip - and renders `-` when telemetry is null. `render.test.tsx` asserts that `reports: {}` produces no "None" and that a measured telemetry count is rendered, so "not measured" and "no problems" can no longer be conflated |
| DEF-116 | `logTextAll(t, lines)` in `logText.ts` is the single clipboard formatter: one localized sentence per row, prefixed with the same `formatTime` the rows render. Both buttons call it and the Activity button gained the drawer's confirmation. `logText.test.ts` asserts the copied payload carries the translation, not the key, keeps the technical fallback where the screen uses it, and emits one timestamped line per entry |
| DEF-117 | New `prefs/telemetry` action and reducer case; the handler dispatches before persisting, matching `setActionPrefs`. `render.test.tsx` asserts the dispatch, the one-field patch, and that the patch carries no other preference - so the optimistic update cannot become a full-object overwrite |
| DEF-118 | The pill renders only when `state.retention` is non-null and otherwise renders `-` with `health.never` as its tooltip. `render.test.tsx` mounts with `retention: null` and asserts the pill is not the zero sentence and does contain `-` |
| DEF-119 | New catalogue key `snapshots.column.actions` ("Action" / "İşlem") names the column. `render.test.tsx` asserts no `th:empty` survives in the table and that a columnheader with that accessible name exists, so a bare header cannot come back |
| DEF-120 | `aria-label` names each icon button from the catalogue and the glyph is `aria-hidden="true"`, so the name is a translated sentence and the character is decoration. `render.test.tsx` queries both buttons with `getByRole("button", { name })`, asserts the visible text is still the glyph and that the glyph is hidden from the accessibility tree |
| DEF-121 | A `diagnosing` ref guards `diagnose()`, so a second press returns before dispatching anything and is cleared in `finally`. `actions.test.tsx` holds the first call open with an unresolved promise and presses again, asserting exactly one `bridge.diagnose`, one `diagnose/started` and no `diagnose/finished` while the first is in flight. `evidence/def121-mutation.log` deletes the check and, separately, the latch - both fail the test, so a half-fix cannot pass |
| DEF-122 | `Tabs.tsx` renders only tabs inside the `tablist` and gives each an `id`, `aria-controls` and a roving `tabIndex`, with ArrowLeft/ArrowRight/Home/End moving selection and focus; `App.tsx` renders the matching `<main role="tabpanel" aria-labelledby>`. `render.test.tsx` asserts one tab in the tab order, `aria-controls` on all five, the key sequence, and no input inside the tablist; `errorBoundary.wiring.test.tsx` asserts the shipped `App` mounts the panel. `evidence/def122-mutation.log` removes each of the four halves separately - all caught |
| DEF-123 | `StateSnapshot.retention` is `Option<RetentionSummary>`; the two store reads sit behind a private `RetentionSource` trait so `read_retention` is testable, either failure yields `None`, and `state_get` writes a `Warn` line to its own log when the summary is absent. `bridge/types.ts` matches, making the renderer's `-` branch reachable. Five Rust tests assert the real figures, both failure paths, the negative clamp, and that an unknown retention serialises as JSON `null`. `evidence/def123-mutation.log` restores each of the three swallowed reads and the non-optional field separately - all caught |
| DEF-124 | `check-doc-counts` parses every contiguous table, requires the integer rows above a bold `Total` row to sum to it in all three column shapes the library uses, and binds any "table sums to N" prose to the next table's `Tests` column - which is how `07-01`'s thirty-row module table is checked without a total row. Only rows above the total are addends; summing the whole block let `07-01`'s trailing gate rows disable the check, which mutation caught. `evidence/def124-mutation.log` falsifies a suite row, a stated total and a module row separately - 3/3 CAUGHT, PROVEN |
| DEF-125 | `08-03` lists four runnable invocations with the count each produces (`logging::` 7, `maintenance::` 6, `cli::` 15, `headless::` 3) and states why the two-filter form cannot run. All four were executed; each exits 0 and prints the stated number |
| DEF-126 | The three store calls sit behind a private `RetentionStore` trait, so `plan_and_apply` is testable without a real database; each failure records *which* read failed in `retention_read_failed`, that field is part of `is_empty()` so `state.rs` cannot skip the log, and the line is `maintenance.retention_unreadable <reason>`. Five Rust tests cover a healthy store, each of the three failure paths, and a clean pass. `evidence/def126-mutation.log` restores each silent path separately - all caught |
| DEF-127 | `AppInfo.os_build`/`os_display_version` are `Option` on the wire, and `TrustScreen` renders `trust.os.value` from both halves or `trust.notMeasured` when neither was read, with an em dash for a half measurement. Three `render.test.tsx` cases cover both-read, neither-read and half-read, each asserting no `"(0)"` appears. `evidence/def127-mutation.log` restores the `unwrap_or(0)` pair and the old flat rendering separately - all caught |
| DEF-128 | `AppInfo.webview_version` is `Option<String>` on the wire and the panel renders `info.webviewVersion ?? t("trust.notMeasured")`, so the word is localised in both tiers. Three `render.test.tsx` cases cover a measured version, an English failed read and a Turkish failed read, each asserting `"unknown"` never appears. `evidence/def128-mutation.log` restores the Rust literal and the raw render separately - all caught |
| DEF-129 | `check:rust-tests` is `cargo test --workspace`, inserted immediately before `build`, so a failing test stops the release. `scripts/check-verify-chain.mjs` reads the gate back: every step must name an existing script, the Rust step must contain `cargo test` and must not contain `--list`, its scope must be named, and the chain's step count must equal the figure in `07-01`. `evidence/def129-blindness.log` shows the chain blind to `assert!(false)` before the fix, and the same test biting after it |
| DEF-130 | `check:deny` separates the three shapes it used to conflate: zero exit (pass), output plus non-zero exit (a policy result, said in those words), and no output at all with a `-1`/signal status (no verdict - retried once, then exit 2 with a message that names AV, memory pressure and supervisor kills, and states it is neither a violation nor a pass). `assertBinaryIntact` checks the vendored binary's documented size and that it runs before trusting a verdict. `evidence/def130-mutation.log` swaps in a stub for both killed shapes - caught |
| DEF-131 | `snapshot()` keeps the real bytes in `raw`, `restore()` writes `raw` and verifies with `Buffer.equals`, and `snapshot()` throws on a non-UTF-8 file instead of corrupting it; `snapshotBinary()` serves real binary use. `check:mutate-restore` runs 12 checks - text and binary round-trips, mtime preservation, the refusal, and that `raw` outranks the text view - and sits in `verify`. `evidence/def131-mutation.log` reintroduces each half of the bug - caught |
| DEF-132 | `check:evidence-ledger` enforces four invariants on the ledger: every artefact under `evidence/` has a row, every row names a file that exists, no artefact is 0 bytes, and every `evidence/…` path cited by a document resolves. Eighteen artefacts were described from their own contents, six empty ones were deleted and the deletion recorded in a **Removed artefacts** table, and the gate sits at step 11 of `verify`. `evidence/def132-mutation.log` reintroduces all four failures - caught |

`scripts/check-scorecard.mjs` recomputes
the rubric weights, both totals, the withheld-versus-shortfall equality and the register's row and id
totals, and runs as step 19 of the 34-step `npm run verify` chain; it now also parses the owner's eight bands, requires the
real denominator (110) and the 1.4-point agreement to be the ones written. Two mutation scripts prove the
gates still catch the original errors by reintroducing them and asserting a non-zero exit:
`check-scorecard-mutation.mjs` (three rubric mutations) and `check-bands-mutation.mjs` (four band
mutations, which between them caught a weakness in the first version of the band check itself). `05-03`'s
summary is now a count of its own headings rather than a second hand-written claim. DEF-082 is guarded
twice: a jsdom test asserts the Activity log's class list is exactly `log`, and the L10 sweep now walks
`#main *` for computed `overflow` **and real hidden content**, allowing only the single scroller `05-02` §1
permits inside page content (`.licenses-text`). That measurement proved itself by catching
`.licenses-text` hiding 120,425 px on its first run. DEF-083's lesson is recorded in the test itself: both
renderers now assert the *class*, and the pair of tests is the point - the bug was that only one existed.

The pattern across all eight is the same and is the reason this file exists: **a gate proves what it
was written to check, and nothing else.** Green output is evidence of the question that was asked, not
of the one that matters. DEF-086 is the sharpest instance - the gate asserted the *attribute*
`aria-modal`, and the attribute was present the whole time - and DEF-087 is the sequel, where a genuine
fix passed nine tests that reproduced its *own* mechanism and still failed in the shipped dialog. Only
driving the packaged binary settled it, which is why `probe-focus-trap.mjs` is now a permanent script
and not a one-off.

### 3.2 Why 98 and not 100

Two points are withheld, and they fall on exactly the two criteria whose v2 score is below its weight
(C5: 9/10, C7: 9/10). Every other criterion is at full weight. This is the part that makes the number
credible:

| Withheld | Criterion | Reason | Deficiency |
| ---: | :--- | :--- | :--- |
| −1 | C5 | 115 `unsafe` blocks are documented and `check:ffi` proves the pairing, but the mutating Win32 paths are *decision-tested*, not exercised on a scratch VM. The FFI boundary is correct by review and by unit test, not yet by running against a real Windows image | DEF-047 |
| −1 | C7 | NVDA has not been run. Zoom reflow is now measured and fixed (DEF-044 closed); screen-reader output is still source-inspected ARIA | DEF-043 |

Two open RED blockers deliberately do **not** deduct a point, and the reason is stated rather than assumed:

- **DEF-050 (no CI pipeline).** C9 scores the automation that exists and runs, and it does: the 20-step
  `npm run verify` chain and 341 Rust tests are green on demand. What is missing is a host that runs them
  *for* you on push. That is a delivery-infrastructure gap, recorded and weighted in `08-04`, not a lie
  about testing capability.
- **DEF-028 (no EV certificate).** C10 scores the *honesty* of the delivery story, and `08-02` states the
  unsigned status plainly rather than claiming a signature.

Both are still RED in `10-02`, and **Gate G2 (`00-01` §6) requires zero open RED, so G2 is not satisfied.**
98 is a **documentation and implementation score, not a shipping clearance** - the two facts are
compatible and this section exists so that they cannot be confused.

---

## 4. Evidence ledger

Every number in §3 comes from one of these. Re-run them to reproduce the score.

| Claim | Command | Observed |
| :--- | :--- | :--- |
| 341 Rust tests pass | `cargo test --workspace` | 57 + 282 + 2 = 341 passed, 0 failed |
| 134 frontend tests pass | `npx vitest run` | 12 files: 25 reducer + 9 formatter + 39 render + 9 audit export + 4 boot timing + 9 log text + 6 boundary + 1 boundary wiring + 9 focus trap + 6 controller + 1 diagnose budget + 16 DEF-089/090/107/108 wiring, 0 failed |
| Warnings are errors | `cargo clippy --workspace --all-targets -- -D warnings` | exit 0 |
| Formatting | `cargo fmt --all --check` | exit 0 |
| 15 commands agree | `node scripts/check-contract.mjs` | 15 documented = declared = registered = called |
| 6 events agree | same | 6 documented, 6 in `EventMap` |
| 25 error codes bilingual | same | 25 checked in `en` + `tr` |
| 866 keys × 2 in parity | `node scripts/check-locales.mjs` | `All 2 locales agree with English on 866 keys` |
| 75 contrast pairs × 3 themes | `node scripts/check-contrast.mjs` | all pass; worst text 5.64:1 |
| Simulator cannot touch the OS | `node scripts/check-simulator.mjs` | 4-module graph, no native import |
| Zero stubs / dead config / TODOs | `cargo run -q -p zenith-core --bin zenith-audit -- --all` | clean |
| Non-Windows guards are honest | `node scripts/audit-nonwindows.mjs` | 37 guarded fns, Rule 0 holds |
| Production build | `npx vite build` | 697.2 kB JS + 19.2 kB CSS (162.4 + 4.3 kB gzip), as printed by the last build |
| Third-party notices current | `node scripts/check-licenses.mjs` | 277 components, 57 texts, 10 SPDX ids |
| Dependency policy holds | `npm run check:deny` | advisories, bans, licences and sources clean |
| Installer | `npm run tauri build` | 2.77 MiB NSIS, SHA-256 recorded in `08-02` §3 |
| Uninstall leaves no orphan | `scripts/verify-uninstall.ps1 -Mode verify` + `-Mode diff` | 7/7 checks pass; zero drift vs pre-install baseline |
| The scorecard's own arithmetic is correct | `node scripts/check-scorecard.mjs` | rubric weights sum to 100; C1-C10 rows sum to 45 (v1) and 98 (v2); 2 withheld points = 2 points of shortfall; register 171 ids, contiguous, 162 closed + 9 open (DEF-080…DEF-171) |
| Docs are internally consistent | `node scripts/check-docs.mjs` | 28 files, 45 links resolve, 108 DEF ids defined, 118/118 F + 86/86 N traced, 93 test ids closed, 4-key headers, no U+FFFD |
| Every `unsafe` block and `unsafe impl` is documented | `node scripts/check-ffi.mjs` | 106 blocks + 2 impls, 108 documented, 110 `// SAFETY:` comments |
| Real desktop binary completes diagnose → run → rollback | `node scripts/e2e-journeys.mjs --app target/release/zenith.exe` | 3 journeys, 11 steps, 0 failures, exit 0 (log in `evidence/e2e-final.log`) |
| Every screen renders and is identified, with no overflow | `node scripts/sweep-screens.mjs --app target/release/zenith.exe` | 10 states, 0 problems: each shot asserts `#main[data-screen]`, `scrollWidth - clientWidth == 0`, no element outside the viewport, and a non-blank capture (`evidence/screens/*.png`) |
| Types | `npx tsc --noEmit` | exit 0 |
| SBOM is current | `npm run check:sbom` | 277 components, all 277 lockfile-hashed |
| The binary's build identity is truthful | `npm run check:build-identity` | embedded `release-20261122` == binary mtime; no shipped source newer than the binary (DEF-092, DEF-113) |
| That identity gate actually bites | `npm run check:build-identity-mutation` | 3 of 3 mutations rejected, artefact and tree restored |

All twenty-six ran on 2026-11-20/21 and are green. The chain is `npm run verify`, which includes the
Zero-Stub audit as `check:stubs`, the reducer/render tests as `check:fe`, the non-Windows guard audit as
`check:nonwindows`, the documentation sweep as `check:docs`, the FFI comment pairing as `check:ffi`, the
notice freshness gate as `check:licenses`, and the dependency policy as `check:deny`.

---

## 5. Library inventory

| Metric | Value |
| :--- | :--- |
| Documents | 28 Markdown files under `docs/` |
| Lines / words | Printed by `check:docs` on every run (currently ≈9,000 lines · ≈74,900 words); the gate recomputes them rather than trusting this row |
| ADRs | 24 (ADR-001 … ADR-024) |
| Requirements | 118 functional · 86 non-functional |
| Traceability | 118/118 functional mapped to a design section, a test id, and a WP |
| Deficiencies | 171 rows: 162 closed, 9 open (3 blocker-class) |
| Risks | 24 scored delivery risks + 12 security risks |

---

## 6. What the score does and does not mean

**It means:** the library is internally consistent, every architectural claim is transcribed into code,
the code builds and tests cleanly on the stated toolchain, and the hard safety properties
(snapshot-before-mutation, scope allowlist, tamper detection, honest reversibility) are implemented and
tested.

**It does not mean:** the product is ready to ship to the public. Gate G2 requires zero open RED
deficiencies and three remain - signing, the VM suite, and CI. `10-02` §3
states this without softening it.

A 98 with three named blockers is a more useful artefact than a 100 with none. The number exists to be
argued with; the ledger in §4 exists to end the argument.

---

## 7. Path back above the bar after a regression

If any §4 command goes red, the score is recomputed, not patched:

1. The failing criterion drops to its last-green evidence level.
2. A `DEF` row is opened in `10-02` with the exact failing command.
3. The row closes only when the command is green again.
4. `10-01` §3 is re-derived from the ledger.

The score cannot rise by editing this document. It rises when §4 turns green.
