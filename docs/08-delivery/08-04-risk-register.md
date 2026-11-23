# 08-04 - Risk Register

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-DLV-004 |
| Version | 2.0.0 |
| Owner | PM / Executive |
| Closes | DEF-031 (v1.0.0 had a prose risk paragraph, no scoring, no owner, no trigger) |
| Scoring | likelihood (1-5) × impact (1-5); ≥ 15 requires an owner action this quarter |

A risk register is useful only if each row can be falsified. Every entry below has a **trigger** -
the observable event that means the risk has materialised - and a **mitigation artefact** that exists
in the tree or is a named deficiency.

Security-specific risks live in `04-01` §8 (`SEC-01..12`); this register is delivery and product risk
and does not duplicate them.

---

## 1. Scored register

| ID | Risk | L | I | Score | Status | Trigger | Mitigation artefact |
| :--- | :--- | ---: | ---: | ---: | :--- | :--- | :--- |
| RISK-001 | Unsigned installer blocked by SmartScreen | 4 | 4 | 16 | **Open** | > 5% of downloads show "unknown publisher" complaints | EV cert (DEF-028); `08-02` §5 |
| RISK-002 | A mutating Win32 action damages a machine | 2 | 5 | 10 | Controlled | any P1 data-loss report | snapshot-before-mutation, 4-tier honesty, `07-01` T-RUST-05 |
| RISK-003 | Rollback restores the wrong scope | 2 | 5 | 10 | Mitigated | a rollback writes outside the allowlist | `scope::*`, ADR-007, HMAC tag |
| RISK-004 | Wayland-era Windows API removal breaks a probe | 2 | 4 | 8 | Accepted | a probe returns `unknown` on a new build | per-probe `unknown`, `03-06` |
| RISK-005 | i18n drift: a key renders untranslated | 3 | 2 | 6 | Mitigated | `check-locales` fails | 442-key parity gate + `check-unused-keys` + `check-step-keys` |
| RISK-006 | Locale breadth promised, not delivered | 4 | 3 | 12 | **Open** | user sees English in a `de` UI | 2 shipped locales, ADR-023 tiers (DEF-057) |
| RISK-007 | No CI ⇒ regressions merge | 4 | 3 | 12 | **Open** | a red gate lands on `main` | gate definitions in `08-02` §4 (DEF-050) |
| RISK-008 | Headless CLI drifts from `03-04` §8 | 2 | 3 | 6 | Mitigated | a CLI run behaves differently from the GUI | `cli::*` (15) + `headless::*` (3); VM run tracked by DEF-047 |
| RISK-009 | Front-end render regressions | 3 | 2 | 6 | Mitigated | a screen renders blank after a refactor | 66 `vitest` tests: reducer, ICU formatter and 33 component renders (DEF-045 closed) |
| RISK-010 | No VM suite ⇒ Windows 10 22H2 breaks | 3 | 4 | 12 | **Open** | a 22H2 bug report | per-build matrix (DEF-047) |
| RISK-011 | Elevation handover replayed by same-user malware | 2 | 5 | 10 | Mitigated | an unexpected elevated launch | nonce + SID + expiry + single use |
| RISK-012 | Support bundle leaks a credential | 2 | 4 | 8 | Controlled | a token appears in a shared zip | two-pass redaction + identifier scrub (DEF-053 for e2e) |
| RISK-013 | Dependency compromise | 2 | 5 | 10 | Mitigated | an advisory against a pinned crate | lockfiles + `deny.toml`; `check:deny` is clean (DEF-061 closed) |
| RISK-014 | Snapshot store fills the disk | 3 | 3 | 9 | Mitigated | `DISK_HEADROOM` refusal loop | caps + `has_space_for` |
| RISK-015 | Retention deletes a user's only rollback | 2 | 5 | 10 | Mitigated | unrestored snapshot pruned | consent rule, `retention::*` |
| RISK-016 | Performance budgets unmeasured, app feels slow | 3 | 3 | 9 | Partly mitigated | boot > 1.5 s on a reference VM | boot instrumentation shipped + shown in UI (`src/perf.ts`); the p95 run needs the reference VM (DEF-047) |
| RISK-017 | NVDA reveals a broken announcement | 3 | 2 | 6 | **Open** | a screen-reader user cannot complete a task | source-level ARIA only (DEF-043) |
| RISK-018 | 200% zoom clips a control at 960×640 | 3 | 2 | 6 | Mitigated | a zoomed screenshot shows clipping | Measured 2026-11-20 (DEF-044 closed): 320 px / 200 % / 400 % across 6 screens × 3 themes = 54 cells, 0 px overflow. The measurement initially **found** a 368 px overflow, which was fixed in `src/styles/app.css` |
| RISK-019 | Third-party licence notices absent | 3 | 1 | 3 | Mitigated | legal review blocks release | 277 components + 57 texts generated and rendered in Trust Center (DEF-056 closed); `check:licenses` guards freshness |
| RISK-020 | Audit-table export missing | 2 | 2 | 4 | Mitigated | IT ticket needs a CSV of audit rows | Snapshots screen exports RFC 4180 CSV / versioned JSON via `src/export.ts` (DEF-055 closed) |
| RISK-021 | Reproducible-build claim overstated | 2 | 3 | 6 | Controlled | two builds differ in hash | stated as non-deterministic (`08-01` §5.2) |
| RISK-022 | ARM64 users cannot install | 3 | 2 | 6 | Accepted | an ARM64 device refuses x64 | x64 only in 1.0.0 (DEF-058) |
| RISK-023 | Toolchain drift on a contributor machine | 2 | 2 | 4 | Controlled | builds differ between machines | MSRV + lockfiles, ADR-020 |
| RISK-024 | Documentation overstates capability | 2 | 4 | 8 | Controlled | a doc claim fails a command | every claim cites a command; `10-02` tracks gaps |

---

## 2. Distribution

| Band | Count | Meaning |
| :--- | ---: | :--- |
| ≥ 15 (action this quarter) | 1 | RISK-001 signing |
| 12-14 | 6 | process gaps: CI, CLI, FE tests, VMs, locale breadth |
| 8-11 | 8 | mitigated or controlled security/reliability |
| ≤ 7 | 9 | accepted or cosmetic |

Six of the seven highest process risks share one root cause: **no CI and no test harness beyond
`cargo test` + four node gates**. RISK-007 is therefore the parent of RISK-008, -009, -010, -016.
Closing the pipeline closes four risks at once, which is why WP-8 is sequenced last but scored high.

---

## 3. The honest position

Nine risks are marked **Open**, not "monitored". A register where everything is green is a decoration.
Each open row names the deficiency that closes it (`10-02`), so the risk cannot be closed by editing
this table - it closes when the artefact exists.

| Open risk | Closes when |
| :--- | :--- |
| RISK-001 | `10-02` DEF-028: signed installer verifies |
| RISK-006 | DEF-057: a locale ships with a native reviewer |
| RISK-007 | DEF-050: CI enforces `npm run verify` |
| RISK-008 | closed: `--headless` implemented (`cli.rs`, `headless.rs`) |
| RISK-009 | closed: 38 render assertions mount the shipped components in jsdom (DEF-045) |
| RISK-010 | DEF-047: T-WIN suite green on 22H2 + 24H2 |
| RISK-016 | DEF-049 closed (instrument shipped); the p95 measurement is DEF-047 |
| RISK-017 | DEF-043: NVDA script executed |
| RISK-018 | DEF-044: zoom captures reviewed |
| RISK-019 | closed: licence notices render from `resources/licenses/` and `check:licenses` passes |
| RISK-020 | closed: Snapshots screen exports CSV/JSON through `src/export.ts` (DEF-055) |

---

## 4. Review cadence

| When | What |
| :--- | :--- |
| Every release candidate | re-score L and I; a changed score needs a sentence of justification |
| On any P1 | open a new row; do not re-use an existing score |
| Quarterly | retire rows whose trigger cannot occur (e.g. a removed feature) |

A retired risk is deleted with a note in `10-02`, never silently dropped: a register that shrinks
without explanation is indistinguishable from one that was never maintained.
