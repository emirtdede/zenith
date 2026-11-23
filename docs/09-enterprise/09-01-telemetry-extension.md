# 09-01 - Telemetry Extension (Commercial Tier)

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-ENT-001 |
| Version | 2.0.0 |
| Owner | Commercial / Engineering |
| Status | **Specification only - not implemented in 1.0.0** |
| Closes | DEF-032 (v1.0.0 named a paid telemetry tier and a feature flag, and specified neither) |
| Gap | The `enterprise-telemetry` feature does not exist in `Cargo.toml`; tracked as DEF-060 |

v1.0.0 mentioned an "Enterprise Telemetry" tier in one sentence and a Cargo feature in a file tree,
then never said what it collected, who could see it, or how a Free build proves it contains no
transport. In an open-core product that is both a licensing problem and a privacy claim without a
mechanism.

This document fixes the *specification*. It deliberately does **not** pretend the code exists.

---

## 1. The boundary, stated first

| Tier | Telemetry transport in binary | Behaviour |
| :--- | :--- | :--- |
| **Free** | **None.** No HTTP client for telemetry is linked | App cannot send anything, by construction |
| **Pro** | None | Same as Free |
| **Fleet** | Opt-in only, `enterprise-telemetry` feature | Aggregate counters, no content |

The Free-build claim is structural, not a setting: if the crate that performs transport is behind a
Cargo feature and the feature is off, the symbol is not in the binary. A user can prove it with a
symbol scan (§7) rather than trusting a checkbox. That is the whole reason ADR-013 chose a feature
flag over a runtime toggle.

> **Current reality.** The feature flag is not yet defined, so today the Free binary trivially has no
> telemetry because *no* binary has telemetry. The structural guarantee becomes meaningful the day
> the Fleet build exists. Recorded as DEF-060 rather than claimed as done.

---

## 2. What a Fleet record may contain

Every field is a counter or an enum. There is no free-text field, no path, no hostname, no user name,
no process name.

| Field | Type | Example | Why it is safe |
| :--- | :--- | :--- | :--- |
| `schemaVersion` | int | `1` | contract version |
| `installId` | uuid v4 | `3f2a…` | random per install, not derived from hardware |
| `appVersion` | string | `1.0.0` | no host info |
| `osBuild` | int | `26100` | build number only |
| `periodStart` / `periodEnd` | RFC 3339 | day boundary | aggregate window |
| `diagnoses` | int | `41` | count |
| `actionsRun` | map<actionId,int> | `{"flush-dns-cache":7}` | closed vocabulary from the manifest |
| `actionsFailed` | map<errorCode,int> | `{"ACCESS_DENIED":2}` | closed vocabulary from the error catalogue |
| `rollbacks` | int | `3` | count |
| `safePresetRuns` | int | `11` | count |
| `medianDiagnoseMs` | int | `4200` | duration, no content |

### 2.1 Fields that are forbidden - and why each is a defect

| Forbidden | Reason |
| :--- | :--- |
| Hostname, username, SID | Direct identifier |
| File paths | Reveal document names and folder structure |
| Process names / command lines | Reveal installed software and secrets |
| IP address | Location and network identity |
| Free-text "notes" | Unbounded, unclassifiable, irreversible once sent |
| Crash dumps | Contain memory, which contains everything |

`04-02` §3 already makes these C2/C3 classes with a "never collected" rule. This document does not
weaken it.

---

## 3. Consent model

| Step | Behaviour |
| :--- | :--- |
| Default | **Off.** No Fleet build sends anything until an admin opts in |
| Opt-in | Org-level, written to `HKLM\SOFTWARE\Vellium\Zenith\Policy` (`AllowTelemetry`) |
| Per-user override | A user may opt **out** locally; org policy cannot silently override a local opt-out |
| Revocation | Turning it off stops the next send; already-sent aggregates are not retractable, which is stated in the consent text |
| Consent record | Stored with timestamp and the policy source, shown in Trust Center |

"Silent opt-in by deployment" is refused on purpose. A fleet admin can enable it; a user can always
see and disable it. The asymmetry is deliberate: trust is the product.

---

## 4. Schema and versioning

```json
{
  "schemaVersion": 1,
  "installId": "3f2a4c1e-...",
  "appVersion": "1.0.0",
  "osBuild": 26100,
  "periodStart": "2026-11-01T00:00:00Z",
  "periodEnd": "2026-11-02T00:00:00Z",
  "diagnoses": 41,
  "actionsRun": { "flush-dns-cache": 7, "clean-temp-cache": 3 },
  "actionsFailed": { "ACCESS_DENIED": 2 },
  "rollbacks": 3,
  "safePresetRuns": 11,
  "medianDiagnoseMs": 4200
}
```

Rules:

1. `schemaVersion` is required; a collector rejects unknown schemas rather than guessing (REQ-N-085).
2. Unknown fields are rejected server-side, jamais ignored - an ignored field is an unintended data
   channel.
3. Adding a field is a schema bump; removing one requires a MAJOR.
4. `installId` is a random UUID stored under the machine store, never derived from `MachineGuid` or
   hardware (a derived id is a fingerprint).

---

## 5. Transport

| Property | Value |
| :--- | :--- |
| Protocol | HTTPS POST, TLS 1.2+ |
| Endpoint | operator-configured; no hard-coded vendor URL |
| Cadence | once per 24 h, jittered |
| Batching | one record per send |
| Failure | silent retry next window; never blocks the UI |
| Payload cap | 16 KiB (well above the schema's real size) |

No long-poll, no websocket, no command channel. Fleet is **report-only**: a dashboard that could push
actions would be a remote-code-execution surface on an elevated binary, which `01-01` §6.2 lists as
out of scope.

---

## 6. Policy registry (the contract `04-01` §10 depends on)

Read from `HKLM\SOFTWARE\Vellium\Zenith\Policy` (admin-only; a standard user cannot write it).

| Value | Type | Effect |
| :--- | :--- | :--- |
| `AllowTelemetry` | DWORD | `0` hard-disables transport even in a licensed Fleet build |
| `RequireAdminForAllActions` | DWORD | forces elevation for every action |
| `BlockedActions` | REG_SZ (csv) | action ids refused at validation |
| `RetentionDays` | DWORD | overrides snapshot retention window |
| `UpdateChannel` | REG_SZ | `stable` \| `pinned` |
| `DisableSnapshotHistorySharing` | DWORD | per-machine history visibility |

Every one of these is read by a consumer or is not documented here. `UpdateChannel` is read by the
updater described in `08-02` §6, which is itself not yet built - so it is listed here as a *future*
consumer and flagged in `10-02` rather than presented as live configuration.

---

## 7. Proving the Free build has no transport

The claim is only credible if it is checkable on a shipped binary:

```powershell
# The telemetry transport symbol must be absent from a Free build.
Select-String -Path target\release\zenith.exe -Pattern "telemetry_transport" -Encoding Byte -SimpleMatch
# Expected: no match, exit 1

# Cargo feature must be off in the default build graph.
cargo tree -e features -p zenith --no-default-features | Select-String "enterprise-telemetry"
# Expected: no match
```

Today these run and succeed trivially (nothing is built). The commands are the acceptance test for
the day the Fleet variant exists; they are listed so the guarantee is falsifiable, not rhetorical.

---

## 8. Commercial boundary

| Tier | Price | Telemetry | What the customer actually buys |
| :--- | :--- | :--- | :--- |
| Free | $0 | none | The complete repair tool |
| Pro | $19 once | none | Scheduled safe-preset runs, 90-day retention, priority support |
| Fleet | $6/seat/mo, min 25 | opt-in aggregates | Cross-machine visibility, policy profiles, MSI transforms |

What is **not** sold: faster repairs, locked actions, downgraded safety. `01-01` §10 states the free
tier must solve the problem completely; telemetry sells *visibility*, not capability. A tier that
withholds diagnostics to upsell would contradict the product's reason to exist.

---

## 9. Implementation status

| Component | Status |
| :--- | :--- |
| Schema (this document) | ✅ specified, versioned |
| Consent model | ✅ specified |
| Policy registry contract | ✅ specified |
| `enterprise-telemetry` Cargo feature | ❌ **absent** (DEF-060) |
| Transport crate | ❌ absent (gated on DEF-060) |
| Collector / dashboard | ❌ out of scope for the client repo |
| Free-build symbol proof | ⚠️ command defined; trivially true today |

This is a specification document, and it says so. When the feature ships, `10-02` DEF-060 closes and
this table changes - not before.
