# 03-06 - Win32 FFI Safety Standard

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-FFI-001 |
| Version | 2.0.0 |
| Status | Mandatory coding standard for `adapters/*` |
| Owner | Security + Rust lead |
| Closes | DEF-011, DEF-013, DEF-021..DEF-026, DEF-034, DEF-035 |

> This document defines **rules and invariants**, not an implementation. Illustrative fragments
> are minimal and marked as such; they exist to make a rule unambiguous, not to be pasted.

---

## 1. Why a standard, not "some unsafe code"

v1.0.0 shipped FFI snippets that were presented as "verified" but contained at least seven defects
that would either fail to compile or misbehave at runtime in an elevated process:

| # | v1.0.0 defect | Consequence |
| :--- | :--- | :--- |
| A | `GetExtendedTcpTable(..., false, ...)` passed a Rust `bool` where the crate expects `BOOL` | compile error on `windows` ≥ 0.53 |
| B | Missing crate features (`Win32_NetworkManagement_Dns`, `Win32_System_LibraryLoader`) | the DNS adapter could not build |
| C | `start_time_unix` taken from `sysinfo` with unverified semantics | TOCTOU guard could silently never match |
| D | `child.kill()` described as killing the tree | orphaned `dism`/`winget` children |
| E | gRPC-style "hard timeout" enforced only between blocking `read` calls | cancel/no-output hang |
| F | stderr piped but never drained | 64 KB pipe deadlock |
| G | `MachineGuid` used as HMAC key | zero tamper resistance |

Additionally, `#[cfg(not(windows))] { Ok(()) }` blocks were **silent success stubs** - the exact
anti-pattern the Zero-Stub Law forbids, hidden behind a platform guard.

**Rule 0.** A platform guard must either return `NotImplemented { feature }` or be absent from the
build. It must never pretend success.

Rule 0 is applied literally, including to functions whose Windows signature is not fallible. A
guarded function that could only answer with an invented value was **made fallible** rather than
given a plausible-looking default (`03-01` §5, L1). The conversions, each paired on both branches:

| Guarded function | Old non-Windows answer | Now |
| :--- | :--- | :--- |
| `child::run` (+ `JobGuard`) | ran the process with no job object, so the "tree kill" claim was false | `child::run` → `NotImplemented`; every job-object helper is `#[cfg(windows)]` |
| `system::uptime_ms` | `0` ms (reads as "just booted") | `ZenithResult<u64>` → `NotImplemented` |
| `system::ui_locale` | `"en-US"` (invented locale) | `ZenithResult<String>` → `NotImplemented` |
| `process::find_by_name` | `Vec::new()` (reads as "nothing running") | `ZenithResult<Vec<_>>` → `NotImplemented` |
| `process::is_responding` | `true` (reads as "healthy") | `ZenithResult<bool>` → `NotImplemented` |
| `actions::fixed_drive_roots` | `Vec::new()` (reads as "no drives") | `ZenithResult<Vec<_>>` → `NotImplemented` |

`ui_locale` is the one caller that must stay infallible: `Preferences::default()` in
`src-tauri/src/state.rs` maps the error to `"en"`, which is exactly the fallback `negotiateLocale`
already applies. That is a documented default, not a fabricated measurement.

`process::image_name`, `process::command_line`, `privilege::sid_for_pid` and `privilege::current_sid`
keep their `Option` signatures on both branches: `None` is the documented "unknown" (`03-01` §5), not
a plausible-looking answer, so no conversion is needed. `console::output` is a working implementation
on every platform (stdout is stdout), not a stub.

Two returns remain non-fallible by design and are honest rather than invented: `privilege::is_elevated`
answers `false` on a platform with no elevation concept (and `capability_for` then reports the
capability unavailable), and `terminate_if_identity_matches` answers `AccessDenied`, both of which are
*pessimistic* - they can only cause a refusal, never a false success.

The rule is machine-checked: `scripts/audit-nonwindows.mjs` (`npm run check:nonwindows`, inside
`npm run verify`) enumerates every `#[cfg(not(windows))] fn` and fails when one returns a bare value
that is neither a `Result` nor on the short, documented allowlist above.

The non-Windows branch exists only so the crate can be checked off-target; it is not a shipped target
(`01-01` §6: macOS and Linux are never targets). It is verified by source audit here. Cross-compiling
it needs a Linux C toolchain for `rusqlite`'s bundled SQLite, which this machine does not have, so this
document does not claim a compiled non-Windows build.

---

## 2. Unsafe code policy

| ID | Rule |
| :--- | :--- |
| U1 | `unsafe` is permitted **only** in `adapters/*` and in one clearly named `ffi` module. Zero `unsafe` in `engine/`, `ipc/`, `models.rs`. |
| U2 | Every `unsafe` block carries a comment naming the invariant(s) it relies on, using the form `// SAFETY: <invariant>`; a lint fails the build without it. |
| U3 | `unsafe` LOC must stay ≤ 8% of Rust LOC (REQ-N-032); CI reports the ratio. |
| U4 | No `transmute`, no `mem::uninitialized`, no `static mut`. Zero exceptions. |
| U5 | All raw pointers are derived from a live, correctly aligned owner for the whole call; no pointer escapes the block. |
| U6 | Every Win32 call's return value is inspected. `let _ =` is forbidden for calls that can fail; a lint enumerates the exceptions (`CloseHandle`, `LocalFree` are checked for handle validity where it matters). |
| U7 | Buffers passed to "size in/out" APIs are re-validated against the returned count before pointer arithmetic. |
| U8 | Any value from the OS that indexes memory is clamped: `entries.min((bytes - header) / row_size)`. |
| U9 | Strings crossing the boundary are UTF-16, NUL-terminated, and owned by a `Vec<u16>` that outlives the call. |
| U10 | Thread affinity is explicit: COM calls happen on an initialised STA/MTA thread, documented per adapter. |

---

## 3. Process and port APIs

### 3.1 TCP listener table

**Required pattern:**

1. First call with `None` buffer to obtain `size`; treat a non-`ERROR_INSUFFICIENT_BUFFER` failure
   as a real error, not "no ports".
2. Allocate **8-byte aligned** storage (`Vec<u64>` sized `(size + 7) / 8`), because
   `MIB_TCPTABLE_OWNER_PID` requires pointer alignment the allocator does not promise for `Vec<u8>`.
3. Retry up to 3 times on `ERROR_INSUFFICIENT_BUFFER`, growing the buffer.
4. Compute `capacity_bytes = buf.len() * 8`; reject if `capacity_bytes < size_of::<u32>()`.
5. Clamp `dwNumEntries` to `(capacity_bytes - 4) / size_of::<MIB_TCPROW_OWNER_PID>()`.
6. Convert the port: `u16::from_be(row.dwLocalPort as u16)` - the field is network byte order.
7. Filter by state `MIB_TCP_STATE_LISTEN` even when the table type already implies listeners
   (defensive: the table is a snapshot, not a guarantee).
8. Do not assume IPv4 only; IPv6 (`AF_INET6`, `MIB_TCP6TABLE_OWNER_PID`) is a separate table and
   must be queried if the UI claims "all listeners".

**Pitfall to encode as a test:** a table with `dwNumEntries` larger than the buffer can describe
must not read past the allocation. Test with a synthetic oversized count.

**Crate note:** `windows` 0.62 takes `BOOL` for the `bOrder` parameter - pass `BOOL(0)`/`BOOL(1)`,
never a bare Rust `bool`.

### 3.2 Process identity (TOCTOU)

Identity is a **triple**, never a PID alone:

```text
(pid: u32, image_name: String lowercased, creation_time: u64 unix_ms)
```

- Creation time comes from `GetProcessTimes` (`ftCreationTime` → FILETIME → Unix ms), **not** from
  `sysinfo`.
- Comparison is exact equality on all three.
- The check and the `TerminateProcess` call happen in the same function with no `await` and no
  user interaction between them.
- Open with the narrowest rights: `PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION`.
- Report per-target outcomes; never abort the batch on the first mismatch (`REQ-F-066`).

**Anti-pattern for the record:** `sysinfo::Process::start_time()` has platform-defined semantics
and was used in v1.0.0 as if it were epoch seconds. After ADR-017, it is display-only.

### 3.3 Hung windows

- `EnumWindows` callback must return `BOOL(1)` to continue; returning `true` (Rust `bool`) is a
  compile error and returning `BOOL(0)` stops enumeration after the first window.
- `IsHungAppWindow` is the only accepted signal. CPU time and "no main window" are not.
- Window titles are untrusted text: escape for display, never log raw into a structured field
  without length limits, never use in a path.

### 3.4 Privilege

`OpenProcess` failing with `ERROR_ACCESS_DENIED` is **information**, not a generic failure: it
means the target is owned by another user or is protected. Map to `ACCESS_DENIED` with the remedy
"elevate or close it from Task Manager", and continue with the other targets.

---

## 4. Child process management

**Mandatory lifecycle:**

```text
create suspended
  → assign to a new job object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  → create both pipes (stdout, stderr) as non-blocking or read on dedicated threads
  → resume thread
  → loop: check cancel token, check deadline, drain both pipes
  → on exit: wait, read remaining buffered output, close job
```

| Rule | Reason |
| :--- | :--- |
| Both stdout **and** stderr are drained concurrently | prevents the classic 64 KB deadlock (F) |
| Cancellation and timeout are checked independently of `read()` returning | F/E: a silent child must still be killable |
| Timeout is enforced by a watchdog, not by the read loop only | a blocking read can hang past the budget |
| `TerminateJobObject` (or closing the job) is the kill primitive | D: `child.kill()` leaves grandchildren |
| No `cmd.exe /c` for anything the app can call directly | shell interposition and quoting bugs |
| Args are a `Vec<&str>`, never a composed string | no injection surface (REQ-N-025) |
| Exit code is captured and mapped per action | actions need different success codes (e.g. DISM 3010) |

**Test obligation:** a child that spawns a grandchild and then blocks must die completely within
500 ms of cancel, and the grandchild must not survive (T-RUST-10).

---

## 5. Input synthesis (GPU reset)

`SendInput` with the WDDM chord (`Win+Ctrl+Shift+B`):

| Rule | Detail |
| :--- | :--- |
| Struct layout | `INPUT` must be constructed with the correct anonymous union variant and `type = INPUT_KEYBOARD` |
| Ordering | All key-downs in order, then all key-ups in **reverse** order |
| Verification | The return of `SendInput` must equal the number of `INPUT` entries; otherwise `Win32ApiFailure` |
| Preconditions | The session must be interactive; a locked or secure-desktop session will not receive synthetic input. Detect and report instead of claiming success |
| Side effects | The display blanks briefly. The UI must warn before running (`05-02` §7.5) |
| Alternative rejected | `ChangeDisplaySettingsExW(CDS_RESET)` - v1.0.0's placebo; it does not reset the driver |

**Test obligation:** unit-test the 8-element sequence construction; integration-test only the
delivery count (never assert on visual outcome in CI).

---

## 6. Filesystem, archives, recycle bin

### 6.1 Archive writing

| Rule | Detail |
| :--- | :--- |
| Streaming | Copy with a bounded buffer; never `read_to_end` a multi-GB file (v1.0.0 defect) |
| Path safety | Entry name = relative path with `/` separators; reject any entry whose components include `..` or an absolute prefix |
| Write-then-verify | Write `.zip.tmp`, `sync_all`, reopen, iterate all entries (forces CRC check), then hash and rename |
| Rename semantics | `rename` on the same volume is atomic on NTFS; the temp file must be in the same directory as the final file |
| Free space | Pre-check `available ≥ estimated_archive_size + 10%` before Phase 1 |

### 6.2 Extraction (rollback)

| Rule | Detail |
| :--- | :--- |
| Hash first | Verify file SHA-256 against the snapshot before opening the archive |
| Entry guard | `entry.enclosed_name()` (or an equivalent component-by-component check); reject on `None` |
| Destination root | Join to the scope-resolved root, then canonicalise and assert the result is still under that root (defence in depth against symlinks) |
| Existing files | Overwrite only files that the snapshot claims to have archived; never delete extra files during restore |
| Partial failure | Continue per item, report `skippedItems` with reasons; never leave a half-written file (write to `.tmp` then rename) |

### 6.3 Recycle bin

| Rule | Detail |
| :--- | :--- |
| Query | `SHQueryRecycleBinW` returns an `HRESULT`; a failure is an error, not "(0 bytes)" |
| Empty | `SHEmptyRecycleBinW` returns `S_OK`; `S_FALSE` means already empty; `E_UNEXPECTED (0x8000FFFF)` is treated as "already empty" with a warning log |
| Signedness | `i64Size`/`i64NumItems` are `i64`; clamp negatives to 0 rather than casting (casting a negative to `u64` produces an astronomically wrong number, a real v1.0.0 bug shape) |
| Scope | Never delete `$Recycle.Bin` directories directly; the shell API owns the semantics |

---

## 7. Registry

| Rule | Detail |
| :--- | :--- |
| Hive scope | Writes restricted to the `scope` roots in `03-05` §4 |
| Absence is data | A missing value is recorded as `Absent` and rollback **deletes** rather than writes a default |
| Type fidelity | Preserve `REG_DWORD`, `REG_SZ`, `REG_EXPAND_SZ`, `REG_QWORD`, `REG_BINARY`, `REG_MULTI_SZ`; do not normalise to string |
| 32/64 view | Use the explicit `KEY_WOW64_64KEY` when reading machine policy keys; document the choice per adapter |
| Bulk export | `reg.exe save` writes a hive file; verify the file exists and has non-zero size before treating the backup as valid |
| Restore | `reg.exe restore` requires the hive not be in use for the target key; schedule/describe the reboot requirement honestly |
| Denied access | `ERROR_ACCESS_DENIED` maps to `ELEVATION_REQUIRED`/`ACCESS_DENIED` with the exact key in params (never silently skipped) |

---

## 8. Services (SCM)

| Rule | Detail |
| :--- | :--- |
| Handle | `OpenSCManagerW` with `SC_MANAGER_CONNECT`; `OpenServiceW` with the minimum rights needed |
| Query | `QueryServiceStatusEx` for state; `QueryServiceConfigW` for start type; both, because state alone cannot be restored |
| Transition | After `ControlService(STOP)` or `StartServiceW`, poll `SERVICE_STOP_PENDING`/`SERVICE_START_PENDING` with a deadline; do not assume synchronous completion |
| Disabled services | Never silently change a `disabled` start type; refuse with a remedy (policy decision belongs to IT) |
| Guarantee | Any action that stops a service must restart it in a `finally`-equivalent path, including on error and cancellation |
| Ownership | Service state snapshots are `service_state_backup` payloads with `was_running` **and** `start_type` |

---

## 9. Elevation

| Rule | Detail |
| :--- | :--- |
| Launch | `ShellExecuteW` with `runas`; success is `> 32` (the return is an `HINSTANCE`-shaped integer, not an `HRESULT`) |
| Failure | `<= 32` includes "user declined" (5) and "file not found"; map distinctly, never to a generic error |
| Handover | Nonce + parent SID check (`03-04` §5.13); the queue is data, never authority |
| Watchdog | If the elevated instance exits within 5 s without signalling readiness, the original process reports the failure instead of exiting into a void (v1.0.0 called `exit(0)` unconditionally) |
| Duplicate | `tauri-plugin-single-instance` makes a second launch focus the first and exit; the process-wide execution registry then guarantees one executing action |

---

## 10. Cryptography

| Rule | Detail |
| :--- | :--- |
| HMAC key | 32 random bytes, `CryptProtectData` machine scope, stored with restrictive ACL (ADR-006) |
| Tag scope | `snapshot_id ‖ 0x00 ‖ action_id ‖ 0x00 ‖ payload_json ‖ 0x00 ‖ schema_version` |
| Comparison | Constant-time comparison for tags (use the `hmac` crate's `verify_slice`, not `==` on hex strings) |
| File hash | SHA-256 over the closed archive file, streamed (not read into memory) |
| Never | Custom crypto, MD5, SHA-1, `rand::random` for keys, keys in logs, keys in the DB |

---

## 11. OS build and capability detection

| Rule | Detail |
| :--- | :--- |
| Build number | Read `CurrentBuildNumber` from `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion`. Never `GetVersionExW` (lies without a manifest) |
| Display version | `DisplayVersion` (`24H2`) and `UBR` for patch level; show both in Trust Center |
| ESU | Detect the documented ESU/consumer-ESU signal; absence → informational banner only |
| Elevation | `TokenElevation` via `GetTokenInformation` on the current process token; never infer from username |
| Capability probes | "Can I do X?" is answered by attempting the cheapest safe operation (e.g. open the key for read) and mapping the error, not by guessing from build number |

---

## 12. Review checklist (required on every unsafe PR)

```text
[ ] Every unsafe block has a // SAFETY: invariant comment
[ ] No transmute / mem::uninitialized / static mut
[ ] All Win32 return values inspected; no `let _ =` on fallible calls
[ ] Size-in/out buffers re-clamped before indexing
[ ] Pointer arithmetic bounded by a computed capacity
[ ] UTF-16 buffers NUL-terminated and outlive the call
[ ] Handles closed on every path, including error and panic (RAII wrapper)
[ ] Cancellation and timeout paths tested
[ ] Job object used for any child process
[ ] Both pipes drained
[ ] Identity triple verified immediately before termination
[ ] Registry/file targets resolved through the scope resolver
[ ] Error mapped to a documented code with params
[ ] No `#[cfg(not(windows))]` silent success (`npm run check:nonwindows`)
[ ] Test added or updated; unsafe ratio unchanged or lower
```

---

## 13. Test obligations

| Test | Focus |
| :--- | :--- |
| T-RUST-01 | UTF-16/UTF-8 decoder across 1-byte chunks and odd splits |
| T-RUST-04 | PID identity triple: match kills, recycled PID refuses |
| T-RUST-10 | Job object kills grandchildren; timeout kills; cancel ≤ 500 ms |
| T-RUST-11 | stderr flood (10 MB) does not deadlock |
| T-RUST-13 | Per-target outcomes; one denial does not abort the batch |
| T-WIN-01 | Port table matches `netstat -ano` for 3000-9999 |
| T-WIN-02 | Hung detection true/false positives |
| T-WIN-04 | Service state round-trip |
| T-WIN-05 | Explorer left running after induced failure |
| T-WIN-06 | Spooler running after induced failure |
| T-WIN-10 | Winsock backup artifacts exist and are non-zero |
| T-WIN-11 | GPU reset delivers 8/8 events |
| T-SEC-02 | Zip-slip and scope escape blocked |
| T-SEC-05 | Secret redaction over 12 seeded patterns |

---

## 14. Known limitations (documented, not hidden)

| Limitation | Consequence | Mitigation |
| :--- | :--- | :--- |
| Synthetic input is ignored on the secure desktop / lock screen | GPU reset may report delivered but do nothing visible | Detect non-interactive session and warn |
| `reg restore` of a hive may require a reboot to take effect | Rollback of Winsock is "compensating" | UI states reboot requirement |
| Some files in `%TEMP%` are permanently locked | Skipped, reported | Counts shown, never silently ignored |
| `sfc` output text is localised on non-English Windows | Parsing outcome sentences is fragile | Prefer exit codes + CBS log; treat sentence parsing as a hint, not the source of truth |
| ARM64 builds: some third-party shell tools are x64-only | Actions may fail with a clear error | Detect arch, label the action, do not attempt |
| WebView2 missing on locked-down images | Blank window | Bootstrapper + documented offline installer |
