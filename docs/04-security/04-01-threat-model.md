# 04-01 - Threat Model & Security Architecture

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-SEC-001 |
| Version | 2.0.0 |
| Method | STRIDE over a data-flow diagram + attack trees for the four highest-value targets |
| Owner | Security |
| Closes | DEF-007, DEF-008, DEF-009, DEF-017, DEF-018, DEF-029, DEF-038 |
| Review | On every security-relevant change, and annually |

---

## 1. Asset inventory

| ID | Asset | Why it matters | Impact if compromised |
| :--- | :--- | :--- | :--- |
| A1 | Administrator execution context | The app runs elevated by design | Total machine compromise |
| A2 | Snapshot store (`state.db` + archives) | Enables rollback of files, registry, services | Arbitrary file/registry write under admin |
| A3 | HMAC key (`hmac.key.dpapi`) | Authenticates snapshots | Forgery of A2 payloads |
| A4 | User files inside archived scopes | Real user data | Disclosure, loss |
| A5 | Audit log | Trust and compliance evidence | Repudiation |
| A6 | Update channel | Code execution on all installs | Supply-chain compromise |
| A7 | Diagnostic output (command lines, hostnames) | Can contain secrets/PII | Disclosure |
| A8 | Elevation handover channel | Launches an elevated process | Privilege escalation |
| A9 | The user's decision | Confirmation dialogs | Social engineering |

---

## 2. Trust boundaries and data flow

```text
  [Untrusted]                        [Boundary 1]                [Trusted]
  Update server ────────────────────► signature verify ──────────► installer
                                                                      │
  Webview (React) ──── invoke ────► [Boundary 2: IPC validator] ──► Rust core
        ▲                                │                            │
        └──────── events ────────────────┘                            │
                                                                      ▼
  Standard-user process ── handover ──► [Boundary 3: nonce+SID] ──► elevated core
                                                                      │
                                           [Boundary 4: scope resolver]
                                                                      ▼
                                                        OS (files, registry, SCM, WMI, child proc)
                                                                      │
                                                        [Boundary 5: redaction]
                                                                      ▼
                                                     audit log / clipboard / support bundle
```

| Boundary | Direction | What crosses | Control |
| :--- | :--- | :--- | :--- |
| B1 | in | Update manifest + binaries | Signature + hash + downgrade refusal |
| B2 | both | Typed IPC payloads | Schema validation, allowlist commands, no shell strings |
| B3 | in | Elevation request + queue | Nonce, expiry, parent PID + SID check, single use |
| B4 | out | Paths, registry keys, service names | Per-action scope allowlist (`03-05` §4) |
| B5 | out | Log lines, summaries, bundles | Redaction, allowlisted fields, size caps |

---

## 3. Attacker model

| Actor | Capability | Motivation | In scope |
| :--- | :--- | :--- | :--- |
| **T1 Standard local user** | Runs the app, reads its data directory, can write `%LOCALAPPDATA%`, cannot write `%ProgramData%\Vellium` | Escalate to admin, hide activity | ✅ primary |
| **T2 Same-user malware** | Runs as the user, can call the app's CLI, can attempt handover | Escalate via UAC prompt | ✅ |
| **T3 Malicious snapshot** | Crafts a DB row or archive if it can reach the store | Arbitrary admin write | ✅ |
| **T4 Network attacker** | Intercepts update traffic | Distribute modified binary | ✅ |
| **T5 Supplier compromise** | Compromised dependency | Backdoor | ✅ partially (SBOM, lockfile, review) |
| **T6 Admin-level malware** | Full local control | Anything | ❌ out of scope (game over by definition) |
| **T7 Physical access** | Offline disk access | Read user files | ❌ out of scope (BitLocker is the answer) |
| **T8 Remote unauthenticated** | Network only | - | ❌ no listening service |

**Explicitly out of scope** must be stated because a threat model that claims to stop T6 is lying.

---

## 4. STRIDE analysis

| Category | Threat | Affected asset | Mitigation | Residual |
| :--- | :--- | :--- | :--- | :--- |
| **Spoofing** | Forged `--resume-queue` from T2 impersonates a legitimate handover | A8 | Nonce + SID + expiry + single use (`03-04` §5.13) | Low |
| Spoofing | Forged snapshot row pretending to be from another action | A2 | HMAC over `snapshot_id ‖ action_id ‖ payload` | Low |
| Spoofing | Fake update server | A6 | Signed manifest, pinned public key, TLS | Low |
| **Tampering** | Editing `payload_json` to redirect a rollback | A2/A3 | HMAC verify before any write; scope allowlist | Low |
| Tampering | Swapping an archive file with a crafted ZIP (zip-slip) | A4 | SHA-256 verify + `enclosed_name()` + canonicalised destination | Low |
| Tampering | Modifying the binary on disk | A1 | Authenticode verification at update; OS-level code integrity for enterprise | Medium (user-writable install dir would be bad → install is per-machine) |
| Tampering | Suppressing audit entries | A5 | Append-only API, no delete path in UI except purge with confirm; DB ACL admin-only | Medium (admin can edit - accepted) |
| **Repudiation** | "I never ran that" | A5 | Correlation id, timestamps, `elevated` flag, exportable CSV/JSON | Low |
| **Information disclosure** | Secrets in command lines reach UI/audit | A7 | Multi-pattern redaction, fail-closed for long high-entropy tokens (REQ-F-063) | Low |
| Info disclosure | Support bundle leaks tokens | A7 | Shared redactor + allowlisted file set + seeded-secret test | Low |
| Info disclosure | Cross-user data leaks through machine-wide store | A4 | Store ACL: users read-only, and UI shows only the current run + shared history - documented in `04-02` §7 | Medium (by design: machine history is visible to machine users; configurable) |
| Info disclosure | Clipboard left with hostname/IP | A7 | User-initiated only; documented content | Low |
| **Denial of service** | Filling the disk with snapshots | A2 | Retention caps + free-space pre-check + consent before pruning unrestored | Low |
| DoS | Spawning a child that never exits | A1 | Job object + watchdog timeout (REQ-F-053) | Low |
| DoS | Hammering `action_execute` | A1 | One executing action per process (`ExecutionRegistry`); the second call returns `ALREADY_RUNNING`, and `tauri-plugin-single-instance` keeps a second GUI process from starting | Low |
| **Elevation of privilege** | T1 writes a DB row aimed at `C:\Windows\System32` | A1/A2 | `%ProgramData%` ACL + HMAC key + scope allowlist | Low |
| EoP | T2 asks the app to run a destructive queue via UAC | A1/A8 | Handover nonce; destructive actions still need in-app confirmation by the elevated window; queue contains no authority | Low |
| EoP | User input reaches a command line as a string | A1 | Args as vectors only, allowlisted programs, no `cmd /c` | Low |
| EoP | License/updater writes an executable to a privileged path | A1 | Update verified + written to a versioned dir, activation by installer only | Low |

---

## 5. The four high-severity findings from v1.0.0 and their closures

These are the vulnerabilities that caused the v1.0.0 score's security collapse (3/13 on C4). Each is a real
attack, not a theoretical one.

### 5.1 Finding S-1 - Forgeable snapshots → arbitrary admin file/registry write

**v1.0.0 design.** HMAC key = `"ZENITH_HMAC_V1_" + MachineGuid`, which **every user can read**.
Store in `%ProgramData%` with default ACLs. Rollback applied `target_dir` and `subkey` straight
from the payload.

**Attack (3 steps, no admin needed).**
1. Read `MachineGuid` (readable by all users).
2. Insert a snapshot row with `action_id='archive-screenshots'`, payload
   `{target_dir:"C:\\Windows\\System32", archive_zip_path:"<attacker zip>"}` and a valid HMAC
   computed with the known key.
3. Wait for an admin to open Snapshot History and click Rollback → a DLL lands in System32.

**Closure.**
- Key = 32 random bytes under `CryptProtectData` machine scope, file ACL Administrators+SYSTEM
  only (ADR-006).
- Store directory ACL: `Administrators:(OI)(CI)F`, `SYSTEM:(OI)(CI)F`, `Users:(OI)(CI)RX`
  (ADR-005).
- Rollback target resolves through `scope_id` → allowlist, never a stored free path (ADR-007).
  Any mismatch aborts before writing (REQ-F-042).
- Tag covers `action_id` and `schema_version`, so an action cannot be swapped either.

**Verification:** T-SEC-01 (key requires admin), T-SEC-02 (crafted payload → `SCOPE_VIOLATION`),
T-RUST-07 (tamper → `INTEGRITY_ERROR`).

### 5.2 Finding S-2 - `--resume-queue` privilege-escalation injection

**v1.0.0 design.** Any process could run `zenith.exe --resume-queue controlled-reboot`; if the user
approved UAC, the mapped actions ran with no in-app confirmation. `relaunch_elevated_with_queue`
also called `exit(0)` unconditionally, so a failed elevation left no window at all.

**Closure.**
- Handover requires a single-use nonce written to a machine-scoped record readable only by
  Administrators+SYSTEM, plus a parent-PID/SID match, within a 120 s window (REQ-F-112).
- The queue is *pre-selection only*: every destructive action still requires an in-app confirmation
  in the elevated window, with the destructive button unfocused (REQ-F-023).
- A watchdog replaces `exit(0)`: if the elevated process does not signal readiness within 5 s,
  the original window reports the failure and stays usable (REQ-F-113).

**Verification:** T-SEC-03 (forged nonce rejected), T-SEC-07 (standard token cannot execute an
admin action), T-E2E-06 (decline → app usable).

### 5.3 Finding S-3 - Unsigned, multi-instance elevated binary

**v1.0.0 design.** `perMachine` install, no Authenticode, no publisher, no updater, no single
instance. Two elevated instances could run `netsh winsock reset` and write the same DB
concurrently.

**Closure.**
- Authenticode with an EV certificate, timestamped; packaging fails if unsigned (REQ-N-028).
- Signed update manifest, downgrade refusal (REQ-N-029).
- `tauri-plugin-single-instance` (a second launch focuses the first and exits) + the process-wide
  `ExecutionRegistry` that admits one executing action (REQ-N-020, REQ-F-005). There is **no**
  hand-rolled named mutex; a `src-tauri/src/lib.rs` test (`single_instance_guard_is_wired`) fails if
  the plugin call or the claim is removed.
- SmartScreen/AV reputation plan: EV + submission + no packing + documented behaviour (`08-02` §5).

**Verification:** release gate step "signature verify on clean VM"; T-RUST-12 (second instance
rejected).

### 5.4 Finding S-4 - Unvalidated privilege checks and secret leakage

**v1.0.0 design.** Elevation checks existed only in the UI; redaction matched only `key=` and
`token=`; audit store ACL undocumented.

**Closure.**
- Every privileged command re-checks `TokenElevation` server-side (REQ-F-079).
- Redaction covers `--flag value`, `--flag=value`, `-p<value>`, URL userinfo, bearer tokens,
  connection strings, and high-entropy literals (fail closed).
- Audit table has no column for contents or environment; ACL is admin-write (REQ-F-098).

**Verification:** T-SEC-05 (12 seeded secret patterns), T-SEC-09 (schema has no content columns).

---

## 6. Attack trees

### 6.1 Goal: write a file into `C:\Windows\System32` as admin without the user noticing

```text
OR
├── Craft a snapshot payload
│    ├── Need valid HMAC ──► blocked: key requires DPAPI unprotect as SYSTEM/Admin   [S-1]
│    ├── Need to write the DB ──► blocked: ProgramData ACL is admin-write only        [S-1]
│    └── Need the admin to press Rollback
│         └── scope resolver rejects target before any write                          [ADR-007]
├── Abuse exported script
│    └── Script is generated from a fixed manifest; user reviews it; no path input    [§8]
├── Abuse elevation handover
│    ├── Need to write the nonce record ──► blocked: ACL                              [S-2]
│    └── Need to survive SID check ──► blocked                                        [S-2]
└── Supply chain
     ├── Modify the installer ──► signature verify fails                             [S-3]
     └── Modify a dependency ──► lockfile + cargo-deny + SBOM review                 [§9]
```

### 6.2 Goal: exfiltrate secrets from the developer's machine

```text
OR
├── Read the audit log ──► redaction at write time + no raw argv storage              [S-4]
├── Read a support bundle ──► allowlisted files + redactor + seeded-secret test
├── Read the clipboard ──► only the diagnostic summary, user-initiated
└── Network egress ──► no transport in Free builds; telemetry opt-in only             [ADR-013]
```

---

## 7. Security invariants (release blockers)

| ID | Invariant | Enforced by |
| :--- | :--- | :--- |
| SI-1 | No user-supplied string is ever executed as a shell command | REQ-N-025, review |
| SI-2 | Every privileged operation re-validates elevation in the core | REQ-F-079 |
| SI-3 | Every destructive target resolves through the scope allowlist | ADR-007 |
| SI-4 | Every rollback verifies HMAC before writing | REQ-F-041 |
| SI-5 | Every archive is hashed and every entry path-checked | REQ-F-043 |
| SI-6 | Every child process lives in a job object | REQ-F-050 |
| SI-7 | Process termination requires the identity triple | REQ-F-062 |
| SI-8 | Secrets never reach logs, clipboard, audit, or bundles | REQ-N-033 |
| SI-9 | Elevation requests are authenticated and single-use | REQ-F-112 |
| SI-10 | Release artifacts are signed; unsigned builds cannot package | REQ-N-028 |
| SI-11 | The Free build contains no telemetry transport symbol | ADR-013 |
| SI-12 | No remote content is loaded in the webview (CSP `default-src 'self'`) | REQ-N-030 |

---

## 8. Risk register (security)

| ID | Risk | L | I | Score | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| SEC-01 | Snapshot forgery → admin file write | 2 | 5 | 10 | **Mitigated** (S-1) |
| SEC-02 | Handover queue injection | 3 | 5 | 15 | **Mitigated** (S-2) |
| SEC-03 | Unsigned binary distribution | 4 | 4 | 16 | **Mitigated** (S-3) |
| SEC-04 | Secret leakage via argv/audit | 3 | 3 | 9 | **Mitigated** (S-4) |
| SEC-05 | Dependency compromise | 2 | 5 | 10 | Controlled (SBOM, deny, review) |
| SEC-06 | Zip-slip during rollback | 2 | 5 | 10 | **Mitigated** (§6.2) |
| SEC-07 | TOCTOU kill of the wrong process | 2 | 5 | 10 | **Mitigated** (ADR-017) |
| SEC-08 | AV false positive blocks install | 4 | 3 | 12 | Controlled (EV, submission) |
| SEC-09 | Admin-level malware | 3 | 5 | 15 | **Accepted, out of scope** |
| SEC-10 | Cross-user history visibility | 3 | 2 | 6 | Accepted, documented + toggle |
| SEC-11 | Update key compromise | 1 | 5 | 5 | Controlled (HSM, rotation runbook) |
| SEC-12 | Social engineering of a confirmation | 3 | 3 | 9 | Reduced (unfocused destructive, explicit counts) |

No unmitigated **High** finding remains. Gate G6 satisfied.

---

## 9. Supply chain controls

| Control | Implementation |
| :--- | :--- |
| Dependency pinning | `Cargo.lock`, `package-lock.json`, `cargo build --locked`, `npm ci` |
| Advisory scanning | `cargo audit` + `npm audit --production` on every PR and nightly; `cargo-deny` advisories run in `npm run verify` today |
| Licence policy | `deny.toml` allowlist (0BSD, MIT, MIT-0, Apache-2.0, BSD-2/3, ISC, CC0-1.0, Unicode-3.0, Unlicense, Zlib, MPL-2.0); copyleft denied. Enforced by `check:deny` |
| Banned crates | `deny.toml`: `openssl-sys`, `time` < 0.3.37, wildcard versions, unknown registries/git; duplicate majors fail except 13 reviewed Tauri/RustCrypto overlaps |
| SBOM | CycloneDX 1.5 generated per release by `scripts/generate-sbom.mjs` into `resources/sbom/`; `check:sbom` fails when stale. Attaching it to a release waits on DEF-050 |
| Provenance | Builds only on CI, never on a developer machine for release; artefacts hashed and attested |
| Review | Any new dependency requires a one-paragraph justification in the PR |
| Assets | Third-party downloads pinned by SHA-256 in `resources/manifest.json` |

---

## 10. Enterprise hardening profile

For Fleet customers, documented knobs (no code changes):

| Setting | Effect |
| :--- | :--- |
| `DisableSnapshotHistorySharing=false` | Default machine-visible history; set false per policy if multi-user machines must not share |
| `RequireAdminForAllActions=true` | Forces elevation for every action (kiosk/shared PCs) |
| `AllowTelemetry=false` | Hard-disables the Fleet transport even if licensed |
| `BlockedActions=<csv>` | Policy-level refusal of specific actions |
| `RetentionDays=<n>` | Overrides snapshot retention |
| `UpdateChannel=pinned` | Pins a version; updater refuses newer |

These are read from `HKLM\SOFTWARE\Vellium\Zenith\Policy` (admin-only), documented in `09-01` §6.

---

## 11. Security testing plan

| Test | Type | Asserts |
| :--- | :--- | :--- |
| T-SEC-01 | Unit + manual | HMAC key unreadable without admin (ACL + DPAPI) |
| T-SEC-02 | Integration | Crafted payload with `..\Windows` → `SCOPE_VIOLATION`, no writes |
| T-SEC-03 | Integration | Forged/expired/replayed nonce → `ELEVATION_HANDOVER_INVALID` |
| T-SEC-04 | Integration | Diagnosis performs zero writes (Procmon diff) |
| T-SEC-05 | Unit | 12 seeded secret patterns never appear in audit/UI/bundle |
| T-SEC-06 | End-to-end | Bundle contains no file contents, no tokens, no usernames beyond hostname |
| T-SEC-07 | Integration | Standard token → admin action refused server-side |
| T-SEC-08 | End-to-end | Full run with network capture: zero egress |
| T-SEC-09 | Static | Schema has no content/env columns; grep gate |
| T-SEC-10 | Fuzz | ZIP parser with 1,000 malformed archives: no panic, no escape |
| T-SEC-11 | Static | `cargo deny` + `npm audit` clean |
| T-SEC-12 | Release | Signature verify + timestamp + publisher on clean VMs |

---

## 12. Incident response (security)

```text
1 Detect      advisory, researcher report, or telemetry anomaly
2 Triage      severity per CVSS; does it need admin? is it remote? data impact?
3 Contain      if update-channel compromise: revoke manifest key, publish advisory
4 Fix          patch on a private branch, security review, regression test T-SEC-*
5 Release      out-of-band patch; signed; advisory with CVE if applicable
6 Disclose     within 90 days of fix (coordinated), credit the reporter
7 Learn        add a T-SEC case so the class of bug cannot return silently
```

Contact and SLA: `SECURITY.md` at repo root; 72-hour acknowledgement, 30-day fix target for High.

---

## 13. Accepted residual risks

1. **Admin-level malware** can read the HMAC key and forge snapshots. Accepted: it already has the
   privileges the forgery would gain.
2. **Machine-wide history is visible to all users of the machine.** Accepted with a policy toggle;
   the alternative (per-user store) reintroduces the UAC split-brain that loses data.
3. **Synthetic input cannot reach the secure desktop.** Documented; the GPU action is advisory.
4. **Native CLI tool output is localised**, so sentence parsing can fail. Exit codes are primary;
   text is a hint.
