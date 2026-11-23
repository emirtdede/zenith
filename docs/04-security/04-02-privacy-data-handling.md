# 04-02 - Privacy, Data Handling & Erasure

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-PRV-001 |
| Version | 2.0.0 |
| Owner | Security / Privacy |
| Closes | DEF-039 (no data inventory, no erasure contract in v1.0.0) |
| Applies to | Every byte the product writes, logs, displays, clips, or exports |
| Review | On any new persisted field, new adapter that reads OS data, or new export surface |

This document is the enforceable half of the privacy claim in `01-01` §6 and `04-01` §6. It
answers four questions with file-level precision: **what is collected, where it goes, how long it
lives, and how it is destroyed.** Every answer names the code that implements it, so a reviewer can
falsify the claim by reading one file.

---

## 1. Data classification

| Class | Definition | Examples | May leave the machine? |
| :--- | :--- | :--- | :--- |
| **C0 - Public** | Product constants, build metadata | version, schema version, action ids | Yes |
| **C1 - Machine state** | Non-identifying facts about this PC | OS build, free disk bytes, service states, port numbers | Only in a user-created support bundle |
| **C2 - Personal** | Values that name a person, account, or machine | `USERNAME`, `USERPROFILE`, `COMPUTERNAME`, hostnames, command lines, profile paths | **Never unredacted** |
| **C3 - Secret** | Credentials and tokens | passwords, API keys, bearer tokens, DSNs, cookies | **Never** - masked at ingress |

The classification is a hard rule, not guidance. `04-01` §2 boundary B5 is the only crossing, and it
passes exclusively through the redactor.

---

## 2. Complete data inventory

Every path below is declared in [`crates/zenith-core/src/config.rs`](../../crates/zenith-core/src/config.rs)
(`Paths`). A path not in that file is not written by the product - which is what makes §6 testable.

| # | Location | Contents | Class | Written by | Retention |
| :--- | :--- | :--- | :--- | :--- | :--- |
| D1 | `%ProgramData%\Vellium\Zenith\state.db` | Snapshot ledger, audit rows, settings, archive ledger | C1, C2 (redacted command lines only) | `engine::db` | See §5 |
| D2 | `…\Vellium\Zenith\hmac.key.dpapi` | 32-byte HMAC key, DPAPI machine scope | C3-adjacent (key material) | `adapters::dpapi` | Until purge/uninstall |
| D3 | `…\Zenith\backups\<id>.zip` | Archived user files inside an allowlisted scope | C2 (user data) | `engine::snapshot` | Until purge/consent prune |
| D4 | `…\Zenith\backups\<id>.zip.sha256` | Archive hash sidecar | C0 | `engine::snapshot` | With D3 |
| D5 | `…\Zenith\hives\WinSock2_*.hiv` | `reg.exe` export for compensating recovery | C1 | `adapters::actions` | Until purge |
| D6 | `…\Zenith\logs\zenith.log[.1..3]` | Structured operation log, redacted | C1, C2-redacted | `engine` + `src-tauri` | 5 MB × 3 (§5) |
| D7 | `…\Zenith\quarantine\` | Corrupt DB / orphan archive, moved aside | C1/C2 | `engine::db`, `engine::retention` | 7 days, then delete |
| D8 | `%LOCALAPPDATA%\Vellium\Zenith\prefs.json` | Locale, theme, motion, telemetry opt-in, pin/hide | C1 | `commands::preferences_set` | Until purge/uninstall |
| D9 | `%LOCALAPPDATA%\Vellium\Zenith\support\Zenith-Support-<stamp>.zip` | User-initiated support bundle | C1, C2-redacted | `engine::support` | Until purge/uninstall |
| D10 | In-memory log ring (5,000 lines) | Live terminal lines | C1/C2-redacted | `src/state/store.ts` (`LOG_LIMIT`) | Process lifetime |
| D11 | Clipboard | Only on explicit "Copy" click | C1/C2-redacted | `src/ui/Console.tsx`, `Dialogs.tsx` | OS-owned |

**There is no D12.** No analytics endpoint, no crash-report upload, no install-id, no licence
ping, no update-check beyond the optional signed updater described in `08-02` §6. This is ADR-016
("No cloud backend in v1").

---

## 3. What is deliberately *not* collected

The strongest privacy control is the schema. Fields that do not exist cannot leak.

| Not collected | Why | Where the absence is enforced |
| :--- | :--- | :--- |
| Raw command lines | They routinely carry tokens and paths | `adapters` calls `redact::redact_command_line` before anything is stored; `engine::db` schema stores no `command_line` column |
| Environment variables | They carry secrets and identity | No adapter reads the ambient environment except `Paths` (two well-known roots) and `support::scrub_identifiers` |
| Free-form OS prose | Cannot be reliably classified | Report `summaryKey` is an i18n key; the schema has no free-text OS field |
| File contents | Not needed to diagnose | Snapshot stores *paths and metadata*, not bytes, except the user-approved archive |
| Browsing history, documents, mail | Out of product scope | No adapter exists; capability set (`src-tauri/capabilities/default.json`) grants no filesystem scope |
| Hostname / username in telemetry | Identity leak | `support::scrub_identifiers` replaces both with `<host>` / `<user>`; a test asserts it |
| Keystrokes | Never | No input hook is linked (`03-06` §2 lists every imported symbol) |

Evidence: `crates/zenith-core/src/engine/db.rs` schema (§1 of `03-03`) has no free-text column;
`crates/zenith-core/src/engine/support.rs` `scrub_identifiers` replaces `USERPROFILE`, `USERNAME`
and `COMPUTERNAME`; `crates/zenith-core/src/adapters/process.rs` routes every command line through
the redactor.

---

## 4. Redaction: the only egress filter

Anything that can reach a log, the UI's process list, the clipboard, or a support bundle passes
through [`crates/zenith-core/src/engine/redact.rs`](../../crates/zenith-core/src/engine/redact.rs).
The module is fail-closed: if a value *looks* like a secret, it is masked.

| Shape | Example (before) | After | Test |
| :--- | :--- | :--- | :--- |
| `--flag value` | `--password hunter2` | `--password ***` | `long_flag_with_space_value` |
| `--flag=value` | `--api-key=abcd1234efgh` | `--api-key=***` | `long_flag_with_equals_value` |
| Short flag | `mysql -pS3cr3tP@ss` | `mysql -p***` | `short_flag_value` |
| Connection string | `Server=db;Password=Pa$$w0rd` | `Server=db;Password=***` | `connection_string` |
| URL userinfo | `https://alice:tok3n@host/x` | `https://***@host/x` | `url_userinfo` |
| Bearer header | `Authorization: Bearer abcDEF…` | `Authorization: Bearer ***` | `bearer_header` |
| GitHub token | `ghp_16C7e42F…` | `***` | `github_token_prefix` |
| AWS key | `AKIAIOSFODNN7EXAMPLE` | `***` | `aws_key_prefix` |
| JWT | `eyJhbGci….eyJzdWI….dBjft…` | `***` | `jwt_literal` |
| Ordinary path (must survive) | `C:\Users\deniz\app\server.js --port 3000` | unchanged | `ordinary_paths_and_ports_survive` |

Properties the tests pin:

- **Idempotent** - redacting twice equals redacting once (`redaction_is_idempotent`). Re-running a
  bundle through the filter never produces `*** ***`.
- **Quoted arguments stay together** - `"My Project"` is one token (`quoted_arguments_stay_together`).
- **Empty input is safe** (`empty_input_is_safe`).
- **Hyphenated flag names** such as `--db-password` are recognised (`hyphenated_flag_names_are_recognised`).
- **The mask replaces the secret**; it is never appended after it - the v1.0.0 bug that leaked the
  token next to the marker is covered by `bearer_header`.

Free-form prose is explicitly **not** covered (`redact.rs` module doc). That is why the product
never stores prose from the OS: the schema stores a key and typed params instead.

---

## 5. Retention and deletion

The constants live in `config.rs` and are asserted by a test (`retention::default_caps_are_the_documented_ones`).

| Data | Cap | Behaviour at the cap | Consent needed? |
| :--- | :--- | :--- | :--- |
| Audit rows (D1) | `AUDIT_MAX_ROWS = 5_000` | Oldest rows pruned; count reported | No (machine-local metadata) |
| Snapshots (D1/D3) | `SNAPSHOT_MAX_ROWS = 200` **and** `SNAPSHOT_MAX_BYTES = 2 GiB`, whichever first | Restored snapshots pruned automatically; **unrestored ones are only proposed** | **Yes** for unrestored (ADR-021) |
| Logs (D6) | `LOG_MAX_BYTES = 5 MB`, `LOG_MAX_FILES = 3` | Oldest rotated file deleted | No |
| Quarantine (D7) | `QUARANTINE_DAYS = 7` | Deleted after 7 days | No |
| Support bundles (D9) | `SUPPORT_BUNDLE_MAX_BYTES = 5 MB`, `SUPPORT_BUNDLE_MAX_FILES = 10` | Bundle is trimmed on creation, never grows | No |
| In-memory log (D10) | `LOG_LIMIT = 5_000` lines | Oldest lines dropped; the drawer prints how many | No |
| Disk headroom before any archive | `DISK_HEADROOM_PERCENT = 10`, floor `64 MB` | Write refused with numbers (`REQ-F-142`) | n/a |

The retention planner ([`engine/retention.rs`](../../crates/zenith-core/src/engine/retention.rs)) is a
**plan first, act second** design:

- `plan()` returns `automatic` (restored snapshots) and `needs_consent` (unrestored), plus
  `bytes_reclaimed` and `audit_rows_to_delete`.
- It sorts restored-before-unrestored and oldest-first inside each class, so the newest undo point
  survives longest (`row_cap_prunes_restored_first`, `pruning_is_stable_regardless_of_input_order`).
- `PrunePlan::requires_consent()` is what the UI gates on; there is no code path that deletes an
  unrestored snapshot without `force`.

Orphan handling (`classify_orphan`): a `.zip.tmp` is deleted immediately (the writer crashed before
commit); a `.zip` with no ledger row is quarantined for 7 days, never deleted on sight.

---

## 6. Erasure: purge and uninstall

Two mechanisms must agree, and both are tested.

### 6.1 In-app purge (`app_data_purge` → `engine::purge`)

| Scope | Deletes | Keeps |
| :--- | :--- | :--- |
| `support` | Every file in D9 | Directory itself |
| `logs` | Every file in D6 | Directory itself |
| `snapshots` | Snapshot rows + archives D3/D4 | Quarantine unless `all` |
| `all` | D1, D3-D7, D9 | Nothing; layout is recreated empty |

Rules enforced **in the core**, not only in the dialog:

1. The confirm token is the literal `PURGE` (`purge::CONFIRM_TOKEN`). A caller that skips the UI
   still cannot purge - `purge_requires_the_exact_token` asserts `"purge"`, `""` and any other
   string fail with `CONFIRMATION_REQUIRED`.
2. `snapshots`/`all` refuse while any committed, unrestored snapshot exists unless `force` is set.
   The error carries the count (`ensure_snapshots_removable`).
3. Failures are warnings, not aborts: a locked log file is reported as `locked:<path>` and the rest
   of the purge proceeds.

### 6.2 Uninstall

The NSIS per-machine uninstaller removes the binary, shortcuts and the ARP entry, and **offers**
to delete the data store (REQ-F-134) through Tauri's existing "delete app data" checkbox on the
confirm page. `src-tauri/installer/hooks.nsh` - wired via
`bundle.windows.nsis.installerHooks` - supplies the `NSIS_HOOK_POSTUNINSTALL` body that makes that
checkbox act on the directories the product actually writes:

| Checkbox | Deletes | Keeps |
| :--- | :--- | :--- |
| Unchecked (default) | Binary, shortcuts, ARP entry | The whole data store |
| Checked | The above **and** `%ProgramData%\Vellium\Zenith` + `%LOCALAPPDATA%\Vellium\Zenith` | Other user profiles' per-user stores |

The stock Tauri template pointed that checkbox at `%APPDATA%\com.vellium.zenith`, which Zenith never
writes - so before DEF-064 the box deleted nothing. The hook now targets `Paths::resolve`'s real roots,
and `uninstall_hook_targets_the_real_data_roots` in `src-tauri/src/lib.rs` fails if the hook stops
naming them or starts naming the bundle-id path again.

**Silent uninstall never deletes data.** `/S` skips the confirm page, so the checkbox state is never
set and the hook is inert. This is deliberate: automated removal must not be able to destroy snapshots
behind a user's back. The guarantee is written as a test: every directory the product may create is
returned by `Paths::owned_directories()`, and `layout_is_under_declared_roots` asserts all of them live
under the declared roots, while `no_path_escapes_the_root` asserts no path contains `..`.

The machine-level half is `scripts/verify-uninstall.ps1`, which captures the six filesystem surfaces
the product may touch plus the ARP entry and asserts the split of responsibility above: binary,
shortcuts and registry entry must be gone; under `/S` the data store must be **byte-identical**.
Executed on 2026-11-20 against the DEF-064 build with `-Mode verify` → 7 checks, 0 failures, and
`-Mode diff` against the pre-install baseline reported zero change on every surface (`08-02` §8.1
holds the transcript). The interactive path is covered by the source-level guard test rather than a
clicked screenshot, which is stated rather than implied.

> **Honest limitation.** An NSIS uninstaller cannot delete `state.db` while another user session has
> it open; `RMDir /r` skips the locked file and removes the rest, which is reported by the uninstaller
> as a partial removal. The in-app purge remains available (and can coordinate the open handle) for the
> case where the check must be provable rather than best-effort.

---

## 7. Cross-user visibility

`state.db` is machine-wide (ADR-005, to defeat UAC split-brain). Consequence, stated plainly:

- Any local user who can read `%ProgramData%\Vellium\Zenith` can see **snapshot metadata and audit
  rows for the whole machine** (action id, timestamps, byte counts, redacted params).
- They cannot read payloads into a form that grants privilege: rollback re-verifies the HMAC with a
  DPAPI machine key and enforces the scope allowlist (`04-01` §5.1).
- Preferences are per-user (`%LOCALAPPDATA%`), so pin/hide/theme never leak between users.

This is a deliberate trade-off, recorded as a residual "Medium" in `04-01` §4 (Info disclosure).
A single-user install can opt into the per-user fallback (`Paths::degraded`), which the UI surfaces
as `storeMode.user`.

---

## 8. Support bundle: what a recipient can learn

`engine::support::create` builds the bundle from a fixed, allowlisted set - never from a glob:

| Entry | Contents | Redaction |
| :--- | :--- | :--- |
| `manifest.json` | schema version, app version, OS build, elevated flag, store mode, file list | n/a (C0) |
| `audit.json` | Last 200 audit rows (keys + counters) | `redact_text` |
| `snapshots.json` | Ledger metadata only - **no payloads, no archive paths** | `redact_text` |
| `environment.json` | OS build/UBR/arch, schema version | no hostname, no user |
| `logs/*.log` | Last 256 KiB per log file, trimmed on a line boundary | `redact_text` + identifier scrub |
| `user-note.txt` | The reporter's own words, optional | `redact_text` + identifier scrub |

Bounds are checked *before* writing (`SUPPORT_BUNDLE_MAX_BYTES`, `SUPPORT_BUNDLE_MAX_FILES`), and the
archive is written `.tmp` then renamed, so a crash never leaves a half-shareable zip. The returned
`RedactionReport` counts masked values and scrubbed paths so the UI can show the user what happened.

Tests: `identifier_scrubbing_replaces_identity_but_not_short_names`,
`redaction_happens_before_identifier_scrubbing` (asserts a Bearer token is gone before identity
scrub), `trimming_drops_whole_entries_until_the_budget_is_met`.

---

## 9. GDPR / KVKK mapping

| Obligation | Article | Zenith control | Evidence |
| :--- | :--- | :--- | :--- |
| Lawful basis | GDPR 6 / KVKK 5 | Local-only processing; no transfer; support bundle is explicit, per-incident consent | §2, §8 |
| Data minimisation | GDPR 5(1)(c) | Schema stores keys + counters; no free text (§3) | `03-03` §1 |
| Storage limitation | GDPR 5(1)(e) | Caps in §5, consent before unrestored prune | `retention.rs` tests |
| Right of access | GDPR 15 | Everything is on the user's disk; bundle export lists it | §8 |
| Right to erasure | GDPR 17 | In-app purge + uninstall (§6) | `purge.rs` tests |
| Integrity/confidentiality | GDPR 5(1)(f) | DPAPI key, ACL, redaction, allowlists | `04-01` §4 |
| Breach notification | GDPR 33 | No server holds data, so no processor breach surface | ADR-016 |
| KVKK transfer rules | KVKK 9 | No cross-border transfer exists | ADR-016 |

Residual: a user who shares a support bundle shares whatever they wrote in `user-note.txt`. The
dialog states this; the file is optional and redacted.

---

## 10. Verification commands

```powershell
# Redaction behaviour (18 tests)
cargo test -p zenith-core redact::

# Retention + consent rules (8 tests)
cargo test -p zenith-core retention::

# Purge token and scope parsing (2 tests)
cargo test -p zenith-core purge::

# Support bundle bounds and scrubbing (4 tests)
cargo test -p zenith-core support::

# The only paths the product may create
Select-String -Path crates\zenith-core\src\config.rs -Pattern "pub fn owned_directories"
```

Every claim in §4, §5, §6 and §8 corresponds to a named test above. No privacy statement here is
asserted without one.
