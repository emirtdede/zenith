# 08-03 - Work Breakdown Structure & Roadmap

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-DLV-003 |
| Version | 2.0.0 |
| Owner | Engineering / PM |
| Closes | DEF-030 (v1.0.0 listed a file tree, not work packages with exit criteria) |
| Rule | A work package is done only when its behavioural gate passes (`00-01` §3, L1) |

This is the plan that produced the shipped tree, and the plan that still has open packages. Both
halves are here because a WBS that shows only completed work is a progress report, not a plan.

Every WP names the requirement ids it closes, the artifact it produces, and the **command** that
proves it. `02-03` maps 118 functional requirements into exactly these nine packages.

---

## 1. Package overview

| WP | Title | Requirements | Status | Gate |
| :--- | :--- | ---: | :--- | :--- |
| WP-1 | Manifest, models, generated catalogue | 9 | ✅ done | `catalog_in_sync`, `manifest::*` |
| WP-2 | i18n engine + `en`/`tr` | 8 | ✅ done | `check-locales` |
| WP-3 | Core engine: db, snapshot, retention, purge | 18 | ✅ done | `cargo test -p zenith-core` |
| WP-4 | Win32 adapters, IPC, elevation handover | 34 | ✅ done (VM suite open) | `cargo test`, `check-contract` |
| WP-5 | Bridge + simulator + store | 6 | ✅ done | `check-simulator`, `tsc` |
| WP-6 | UI: 6 screens, 5 overlays, 3 themes | 23 | ✅ done | `vite build`, `check-contrast`, 38 render tests |
| WP-7 | Safe preset, script export, trust, privacy | 12 | ✅ done | `cargo test`, `05-*` |
| WP-8 | Signing, SBOM, VM matrix, release | 2 | ⚠️ **partial** - pipeline built, certificate/CI/VMs missing | `sign-release.ps1` rehearsed; blockers DEF-028/047/050 (`08-02` §1) |
| WP-9 | Headless CLI, support bundle, log | 6 | ✅ done | `07-02`, `cli::`/`headless::` |

Statuses match `07-01` §3. A ✅ here means the command in the gate column ran and passed; it does not
mean every sub-feature is complete, which is why two rows carry a parenthetical.

---

## 2. Completed packages

### WP-1 - Manifest and generated catalogue

| Deliverable | File |
| :--- | :--- |
| 22-action manifest, single source | `crates/zenith-core/src/manifest.rs` |
| TypeScript renderer (library, testable) | `crates/zenith-core/src/catalog_ts.rs` |
| Generator | `crates/zenith-core/examples/dump_manifest.rs` |
| Drift test | `crates/zenith-core/tests/catalog_in_sync.rs` |

**Gate.** `cargo test -p zenith-core --test catalog_in_sync` → 2 pass. `render()` is called by both the
generator and the test, so an edited manifest without regenerating fails byte comparison.

### WP-2 - i18n

| Deliverable | File |
| :--- | :--- |
| ICU subset formatter, callable translator | `src/i18n/index.tsx` |
| English catalogue (533 keys) | `src/i18n/en.ts` |
| Turkish catalogue (533 keys, exact parity) | `src/i18n/tr.ts` |
| Parity gate | `scripts/check-locales.mjs` |

**Gate.** `node scripts/check-locales.mjs` → `All 2 locales agree with English on 533 keys`, keys/placeholders/ICU branches match.
ADR-023's two-tier locale plan is documented; 1.0.0 ships only the two reviewed locales (see `10-02`
DEF-057 for the 73-locale claim closure). Reachability is gated separately - `check-unused-keys`
(0 of 453 unreachable) and `check-step-keys` (every core-emitted key present in both catalogues) - because
DEF-089 proved that, at the time, parity alone was green while 52 keys could not reach a user.

### WP-3 - Core engine

15 modules, 243 tests. The load-bearing ones:

| Module | Tests | Gate behaviour |
| :--- | ---: | :--- |
| `engine/snapshot` | 15 | HMAC, zip-slip, hash verify |
| `engine/db` | 14 | schema, migration, recovery, quarantine |
| `engine/executor` | 15 | mutex, phases, batch plan, confirmation |
| `engine/retention` | 8 | consent rule, caps |
| `engine/purge` | 2 | token, scope |

**Gate.** `cargo test -p zenith-core` → 243 pass.

### WP-4 - Adapters, IPC, handover

| Deliverable | File |
| :--- | :--- |
| 11 Win32 adapter modules, 106 `unsafe` blocks, each `// SAFETY:`-commented | `crates/zenith-core/src/adapters/` |
| 15 IPC commands | `src-tauri/src/commands.rs` |
| Single-use handover ticket (nonce + SID + expiry) | `src-tauri/src/handover.rs` |
| Contract gate | `scripts/check-contract.mjs` |

**Gate.** `cargo test` → adapter tests pass; `check-contract` → 15 documented = 15 declared = 15
registered = 15 called. The mutating Win32 paths have decision-logic tests, not VM integration
(DEF-047).

### WP-5, WP-6, WP-7

Summarised because their evidence is in `05-*` and `07-01`:

- **WP-5** - `adapter.ts` (interface), `native.ts` (IPC), `simulator.ts` (deterministic PRNG, no
  native import). `check-simulator` proves the 4-module graph reaches nothing native.
- **WP-6** - 6 screens, 5 overlays, 3 themes, full keyboard map (`05-02` §7). `check-contrast` 75
  pairs × 3 themes all pass.
- **WP-7** - `SAFE_PRESET` (8 hand-written ids), script exporter, Trust Center, purge flow.

---

## 3. Partial packages

### WP-9 - Support, logging, CLI

| Deliverable | Status | Evidence |
| :--- | :--- | :--- |
| Log writer (redaction, rotation, bounds) | ✅ | `logging::*` (3 tests) |
| Retention/quarantine maintenance caller | ✅ | `maintenance::*` (6 tests) |
| Support bundle (allowlist, budget, redaction) | ✅ | `support::*` (3 tests) |
| Audit export (CSV/JSON via `file_save_text`) | ✅ done | Snapshots screen buttons → `src/export.ts`; RFC 4180 CSV + versioned JSON (DEF-055 closed) |
| Headless CLI (`--headless`, `--dry-run`, `--json`) | ✅ | `cli::*` (15), `headless::*` (3) |

**Gate for the completed parts.** Cargo accepts one test-name filter, so these are four
invocations, not two - the previous form failed with `unexpected argument`, which is a gate
that cannot run:

```powershell
cargo test -p zenith --lib logging::        # 7 pass
cargo test -p zenith --lib maintenance::    # 6 pass
cargo test -p zenith-core --lib cli::       # 15 pass
cargo test -p zenith-core --lib headless::  # 3 pass
``` Every part of WP-9 now has an
implementation and a test; what remains is a VM run of the real binary, which belongs to the
T-WIN suite (DEF-047), not a missing feature.

---

## 4. Open packages

### WP-8 - Signing, SBOM, VMs, release

| Task | Blocker | Owner |
| :--- | :--- | :--- |
| EV certificate + HSM | procurement | Owner |
| `signCommand` in `tauri.conf.json` | certificate | DevOps |
| ~~CycloneDX SBOM per release~~ | **done 2026-11-20** - `generate-sbom.mjs` + `check:sbom` | DevOps |
| Windows 10 22H2 + 11 24H2 VM suite (T-WIN) | VMs | QA |
| CI pipeline enforcing `npm run verify` | repo host | DevOps |
| Updater + signed manifest | after signing | DevOps |
| Attach the SBOM to a release | after a release host exists | DevOps |

**Why WP-8 is a whole package.** The remaining items each depend on material that cannot be authored in
the tree: a certificate, a build host, and Windows images. Writing the config before the material exists
would create configuration with no consumer - an L3 violation. WP-8 is blocked on procurement, not on
engineering, which is why the one item that needed no external material (the SBOM) is already done.

---

## 5. Sequencing (what order and why)

```text
WP-1 (manifest)  ─┬─> WP-3 (engine)   ─┬─> WP-4 (adapters/IPC) ─┬─> WP-7
                  └─> WP-2 (i18n)     ─┘                         ├─> WP-5 ─> WP-6
                                                                 └─> WP-9
WP-8 last: it consumes a finished, tested artefact.
```

Three ordering constraints are load-bearing:

1. **`dist/` before `cargo check`.** `tauri::generate_context!()` panics at compile time if the
   front-end bundle is missing. WP-2's `vite build` must precede WP-3's first `cargo check` - the
   v1.0.0 build order bug that this sequence fixes.
2. **Manifest before everything.** WP-1 is the single source; WP-3 and WP-6 both read from it.
3. **Adapters before UI.** The bridge types in WP-5 come from the Rust models in WP-3/4.

---

## 6. Definition of done (per package)

A package is done when **all** hold:

1. The gate command in §1 exits 0 on a clean checkout.
2. Every requirement mapped to it in `02-03` has a test id with an executable form, or a `DEF` entry.
3. No `todo!()` / `unimplemented!()` reaches the package (`zenith-audit --stubs` clean).
4. No published constant or flag introduced by the package lacks a consumer (`zenith-audit --flags`).
5. The package's public symbols are documented (`REQ-N-064`).

Rules 3 and 4 are machine-checked by `zenith-audit`, wired into `npm run verify` as `check:stubs`.

---

## 7. What remains after 1.0.0

| Item | Why deferred | Tracked |
| :--- | :--- | :--- |
| ~~Render-level FE tests~~ | **Closed 2026-11-20:** Testing Library + jsdom added; 38 render assertions in `render.test.tsx` | DEF-045 (closed) |
| E2E (tauri-driver) | no harness | DEF-048 |
| Performance instrumentation | **Closed 2026-11-20:** `src/perf.ts` boot marks, `TrustScreen` readout; p95 still needs the reference VM | DEF-049 (closed), DEF-047 |
| ARM64 build | x64 only in 1.0.0 | DEF-058 |
| Additional locales | only reviewed locales ship | DEF-057 |

---

## 8. Verification

```powershell
# Per-package gates
cargo test --workspace
node scripts/check-contract.mjs
node scripts/check-locales.mjs
node scripts/check-contrast.mjs
node scripts/check-simulator.mjs
cargo run -q -p zenith-core --bin zenith-audit -- --all

# Whole chain
npm run verify
```
