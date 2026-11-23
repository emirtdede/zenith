# 00-01 - Document Control, Authority & Delivery Gate

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-GOV-001 |
| Version | 2.0.0 |
| Status | Approved baseline (pending owner signature) |
| Owner | Emir Tarık Dede (Vellium) |
| Applies to | All artifacts in `docs/`, `resources/`, and all future code |
| Supersedes | `.rules` §1-§6 of `zenith_greenfield_master_specification.md` v1.0.0 |
| Closes | No single defect - this is the authority document that defines how every DEF row in `10-02` is judged |

---

## 1. Purpose

Zenith deletes files, edits the registry, restarts services, and runs elevated. Undocumented
behaviour is therefore a safety defect, not a style issue. This document establishes:

1. Which document is authoritative for which question.
2. How documents change after approval.
3. What "done" means, mechanically.
4. The hard gate that prevents implementation before this library is accepted.

---

## 2. Single Configuration Authority (supersedes the `.rules` file)

v1.0.0 mandated a root `.rules` file and forbade competing AI-tool rule files. The intent was
correct; the mechanism was not. A prose file cannot be linted, cannot fail CI, and drifts from
the code within one sprint.

**Decision (ADR-002):** authority is distributed by *domain*, and every authority is machine-checkable.

| Domain | Authority | Enforcement |
| :--- | :--- | :--- |
| Repository conventions, agent rules | `AGENTS.md` at repo root | Reviewed; referenced by all agents |
| Behaviour of the 22 actions | [`03-05-actions-manifest.md`](../03-architecture/03-05-actions-manifest.md) §5 table | Generated Rust enum, TS types, i18n skeleton, docs table must match; CI compares |
| Frontend ↔ backend surface | [`03-04-ipc-contract.md`](../03-architecture/03-04-ipc-contract.md) | Generated TS client and Rust handlers from one schema; CI diffs drift |
| Determinism of dependencies | Lockfiles + `resources/manifest.json` | `npm ci`, `cargo build --locked`, hash verify |
| Quality gates | [`08-02`](../08-delivery/08-02-ci-cd-release.md) §4 | Branch protection, required checks |
| Security invariants | [`04-01`](../04-security/04-01-threat-model.md) §7 | `cargo-deny`, custom lints, review checklist |
| Visual language | [`05-01`](../05-design/05-01-design-system.md) | Token file is the only colour source; a lint rejects raw hex in components |

**Forbidden, permanently:** `.cursorrules`, `.clinerules`, `.windsurfrules`, `.roorules`, or any
second prose rule file. There is exactly one agent-governance file and it is `AGENTS.md`.

---

## 3. The Zero-Stub Law (rewritten)

v1.0.0 said: *"Never use `todo!()`, `unimplemented!()`, TODO comments, or truncated arrays."*
This is unimplementable as written - every real project has a first commit that does not contain
22 working Win32 adapters - and it produced the exact failure it tried to prevent: surfaces were
*declared* in a file tree while their contracts were absent, so the implementer silently invented
them. That is a stub with better marketing.

**v2.0.0 law - three rules, all mechanically checkable:**

| # | Rule | Check |
| :--- | :--- | :--- |
| L1 | **No silent gaps.** Every public symbol either has a complete implementation or returns `ZenithError::NotImplemented { feature }` **and** is listed in `docs/08-delivery/08-03-wbs-roadmap.md` under an open WP. | `cargo run --bin zenith-audit -- --stubs` prints the list; CI requires the list to be empty at release tags and to match the WBS otherwise |
| L2 | **No unbuilt contract.** A command, action, screen, or string may not exist in a manifest unless its detailed contract exists in `docs/`. | `docs:lint` resolves every manifest ID to a heading; missing heading fails |
| L3 | **No dead configuration.** Every feature flag, env var, and CLI switch has a documented consumer. | `docs:lint --flags` greps consumers; unused flag fails |

`todo!()` and `unimplemented!()` remain forbidden in released code. `// TODO(name):` is allowed
only with a linked issue and a WP reference, and is counted by the audit binary.

**The practical consequence:** this library is complete for v1.0.0 scope. Any future scope
(see `01-01-prd.md` §7 Non-Goals) arrives with its own contract, not a placeholder.

---

## 4. Document identity and versioning

Every document carries the header table shown above. Rules:

- **MAJOR** - an externally visible contract changes (IPC shape, DB schema, action semantics,
  requirement removal). Requires owner sign-off and a migration note.
- **MINOR** - new requirement, new ADR, new screen. Requires tech-lead review.
- **PATCH** - wording, typo, clarification with no semantic change.
- Requirements are **append-only**. Removing a requirement means marking it `DEPRECATED by REQ-x`,
  never deleting the number.
- ADRs are **immutable**. A changed decision gets a new ADR that supersedes the old one.

---

## 5. Change control workflow

```text
Proposal (issue)
   │
   ├─ touches a contract? ──yes──► RFC doc + ADR draft + impact list (REQ, IPC, DB, tests)
   │                                   │
   │                                   ├─ security impact?  → 04-01 review
   │                                   ├─ a11y impact?      → 05-03 review
   │                                   └─ i18n impact?      → 06-01 review
   │
   ├─ docs updated → docs:lint → link check → requirement traceability updated
   │
   └─ owner approval (see §6) → version bump → implementation allowed
```

**Review cadence:** PRD and risk register quarterly; threat model on every security-relevant
change plus annually; SRS and IPC on every contract change; design system on every token change.

---

## 6. Delivery gate (the rule the user set)

> **The library must reach ≥95/100 on the rubric and be owner-approved before the product is
> called release-ready.**

This is the *release* gate. It was originally written as a "no source until approved" gate; the
tree has since moved past that, and this section states the actual position rather than the
original intention - see the note below the table.

Mechanical definition:

| Gate | Condition | Evidence artifact | State today |
| :--- | :--- | :--- | :--- |
| G1 | Scorecard total ≥ 95.0 | [`10-01`](../10-audit/10-01-scorecard.md) | PASS 98 (v2.0.0) |
| G2 | Zero open RED defects in `10-02` | [`10-02`](../10-audit/10-02-deficiency-register.md) | FAIL 3 open (028, 047, 050) |
| G3 | Every requirement has a test mapping | [`02-03`](../02-requirements/02-03-traceability-matrix.md) | PASS 118/118 |
| G4 | Every action has diagnose / execute / rollback / i18n / script contract | [`03-05`](../03-architecture/03-05-actions-manifest.md) | PASS 22/22 |
| G5 | Every command has a typed schema and an error table | [`03-04`](../03-architecture/03-04-ipc-contract.md) | PASS 15/15 |
| G6 | Threat model has no unmitigated High finding | [`04-01`](../04-security/04-01-threat-model.md) §8 | PASS |
| G7 | Owner signature | This document §7 | FAIL pending |

**Honest position.** G1, G3-G6 hold; G2 and G7 do not. Implementation proceeded in parallel with
documentation rather than after a freeze, which is a deliberate deviation from the original gate
wording and is recorded as such here. The consequence is stated plainly: **the product is buildable
and testable, but not releasable**, because three blocker-class deficiencies remain. `10-02` §3 is
the authoritative count; this table mirrors it and must not be edited to disagree.

The gate still does its job: it blocks *shipping*, not authoring. A library at 98/100 with three
named blockers is a more useful checkpoint than a 100 with none.

---

## 7. Sign-off block

| Role | Name | Scope | Signature | Date |
| :--- | :--- | :--- | :--- | :--- |
| Owner / Product | Emir Tarık Dede | Entire library, budget, licensing | ☐ pending | - |
| Architecture | to be assigned | SAD, ADRs, IPC, actions | ☐ pending | - |
| Security | to be assigned | Threat model, FFI, release signing | ☐ pending | - |
| Design | to be assigned | Design system, UI spec, a11y | ☐ pending | - |
| QA | to be assigned | SRS, traceability, test plan | ☐ pending | - |

> **Gate G7 is currently OPEN.** The library and the shipped tree are complete enough to build and
> test; release is blocked on the owner signature (G7) and on the three blocker-class deficiencies
> in `10-02` §3 (G2). Until both close, `08-02` §8 phase 3 must not run.

---

## 8. Naming, tone, and writing rules for this library

- Prefer a table over a paragraph when the content is enumerable.
- Every claim about the system is either a requirement ID, an ADR, or a measured value.
- Never write "should be secure". Write the control, the test, and the failure mode.
- Never write "handles errors". Write which errors, which code, which user string.
- Numbers carry units and a source.
- Screens and states are named identically in `05-02`, `06-01`, and the traceability matrix.

---

## 9. Ownership map

| Area | Accountable | Consulted |
| :--- | :--- | :--- |
| Product scope, pricing | Owner | Design, Eng |
| Architecture, IPC, actions | Architecture | Security, QA |
| Win32 adapters | Rust lead | Security |
| UI/UX, design system | Design | A11y reviewer |
| Localization | Localization lead | Native reviewers × 73 |
| Release, signing, updater | DevOps | Security |
| Support tooling | Support lead | Eng |
| This library | Owner | All |
