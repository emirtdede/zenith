# 03-05 - Actions Manifest (Single Source of Truth)

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-MAN-001 |
| Version | 2.0.0 |
| Status | Frozen contract |
| Owner | Architecture |
| Closes | DEF-001, DEF-002, DEF-004, DEF-027, DEF-033, DEF-040 |

---

## 1. Why this document is the keystone

v1.0.0 scattered the facts about each action across **six** places - the Rust enum, the TS
catalog, 73 locale files, a table in prose, script snippets referenced but never written, and
inline risk/tier values. It also referenced `exportablePowerShellSnippet` and
`exportableBatchSnippet` for 22 actions (**44 script bodies**) that appeared nowhere.

Result: the implementer had to invent roughly 700 lines of behaviour and every script. That is the
single largest reason v1.0.0 could not be built deterministically.

**v2.0.0 rule:** this document is the source. `actions.manifest.json` is generated from §5 below,
and code is generated from the manifest. Any divergence fails CI (`T-CONTRACT-01`).

---

## 2. Manifest schema

```jsonc
{
  "id": "clean-temp-cache",          // kebab-case, stable forever
  "order": 1,                         // stable display order
  "category": "cleanup",              // cleanup | network | recovery | dev_office
  "risk": "safe",                     // safe | moderate | destructive
  "requiresAdmin": false,
  "safeBatch": true,
  "tier": "irreversible",             // fully_reversible | partially_reversible |
                                      // compensating_recovery | irreversible
  "abortable": false,
  "dependsOn": [],                    // action ids
  "timeoutSecs": 45,
  "severityWeight": 2,                // 1 low, 2 medium, 3 high
  "scope": "temp_dirs",               // allowlist key, see §4
  "diagnoseBudgetMs": 1500,
  "i18nKeys": ["actions.clean-temp-cache.*", "outcomes.cleanTemp.*", "errors.*Action"],
  "ps1": "…# snippet…",
  "bat": "…REM snippet…"
}
```

**Validation rules (build fails otherwise):**

| Rule | Reason |
| :--- | :--- |
| `id` unique, kebab-case, matches `^[a-z0-9]+(-[a-z0-9]+)*$` | generated enum/type names |
| `order` unique and contiguous from 1 | deterministic UI order |
| `safeBatch === true` ⇒ `risk === 'safe'` ∧ `abortable === false` ∧ `readOnly === false` ∧ (`tier !== 'irreversible'` ∨ `noMutation === true` ∨ `scope ∈ {temp_dirs}`) | REQ-F-028 |
| `risk === 'destructive'` ⇒ `safeBatch === false` | REQ-F-031 |
| `readOnly === true` ⇒ `noMutation === true` ∧ `safeBatch === false` | honesty |
| `requiresAdmin` is **not** a batch gate; it is enforced at run time by `plan_batch` + the UAC handover | REQ-F-079 |
| `tier === 'irreversible'` ⇒ `canRollback === false` in UI | honesty |
| `dependsOn` acyclic and references existing ids | REQ-F-030 |
| `scope` exists in §4 allowed list | REQ-O-042 |
| `ps1` and `bat` non-empty and contain no `{placeholder}` | REQ-F-080 |
| `i18nKeys` resolve to existing keys after generation | Law L2 |
| `requiresAdmin` matches the privileged-syscall analysis in `04-01` §5.4 | REQ-F-079 |

---

## 3. Category model

| Category | Purpose | User mental model |
| :--- | :--- | :--- |
| `cleanup` | Reclaim space, apply updates | "My disk / my updates" |
| `network` | DNS, proxy, Winsock, clock | "My connection" |
| `recovery` | Repair Windows, restart shell/services, graphics | "My system health" |
| `dev_office` | Ports, hung apps, caches, WSL | "My working day" |

Ordering inside a category is by `order`. The "All" tab sorts by `risk` then `order` so safe
actions appear first.

---

## 4. Rollback scopes (allowlist)

Rollback may only touch these roots. Anything else aborts with `SCOPE_VIOLATION` (ADR-007).

| `scope` | Allowed filesystem roots | Allowed registry roots |
| :--- | :--- | :--- |
| `temp_dirs` | `%TEMP%`, `%LOCALAPPDATA%\Temp`, `C:\Windows\Temp` | - |
| `recycle_bin` | (shell API only, never direct path) | - |
| `screenshots` | `%USERPROFILE%\Pictures\Screenshots` | - |
| `icon_cache` | `%LOCALAPPDATA%\Microsoft\Windows\Explorer` | `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer` |
| `spooler` | `C:\Windows\System32\spool\PRINTERS` | `HKLM\SYSTEM\CurrentControlSet\Control\Print` |
| `office_cache` | `%LOCALAPPDATA%\Microsoft\Outlook\RoamCache`, `%LOCALAPPDATA%\Microsoft\Teams`, `%LOCALAPPDATA%\Packages\MSTeams_*\LocalCache` | - |
| `internet_settings` | - | `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` |
| `winsock` | `%ProgramData%\Vellium\Zenith\hives\WinSock2_*.hiv` | `HKLM\SYSTEM\CurrentControlSet\Services\WinSock2` (restore via `reg restore` only) |
| `services_only` | - | `HKLM\SYSTEM\CurrentControlSet\Services\{Spooler,bthserv,W32Time}` (start type only) |
| `explorer_session` | - | - (data only: folder paths) |
| `none` | - | - |

Subkey matching is exact string equality against the listed root plus one level, never a prefix
match, and never a wildcard.

---

## 5. The 22 actions (exhaustive)

Legend: **T** = tier, **A** = admin, **SB** = safe batch, **Ab** = abortable, **Sev** = severity.

### 5.1 `clean-temp-cache` - Purge stale temporary caches

| Property | Value |
| :--- | :--- |
| order / category | 1 / cleanup |
| risk / T / A / SB / Ab | safe / irreversible / no / yes / no |
| Sev / timeout / budget | 2 / 45 s / 1500 ms |
| dependsOn / scope | - / `temp_dirs` |

**Diagnose.** Enumerate `%TEMP%`, `%LOCALAPPDATA%\Temp`, and (only when elevated)
`C:\Windows\Temp`. Sum sizes of files with `mtime < now − 24 h` that are not locked (open a
`FILE_READ_ATTRIBUTES` handle to test). `needs_attention` when total ≥ 512 MB. `reclaimableBytes`
= that total. Never counts files < 24 h old.

**Execute.**
1. Re-verify free disk (≥ 1 MB, snapshot-free action).
2. Walk each root, skipping reparse points (`FILE_ATTRIBUTE_REPARSE_POINT`) - never follow
   junctions, because `%TEMP%` inside a junction can point anywhere.
3. Delete files; on `ERROR_SHARING_VIOLATION` / `ERROR_ACCESS_DENIED` / `ERROR_BUSY`, skip and
   count as `skipped_locked`.
4. Delete empty directories bottom-up; never delete the root.
5. Report `bytes_freed`, `files_deleted`, `skipped_locked`.

**Rollback.** Not possible (irreversible). UI shows no rollback affordance.
**Notes.** Never touches `Downloads`, `Documents`, or anything outside the three roots.
**i18n.** `actions.clean-temp-cache.title|description|impact`, `outcomes.cleanTemp.deleted`,
`outcomes.cleanTemp.skipped`.

```powershell
$roots = @($env:TEMP, "$env:LOCALAPPDATA\Temp")
if (Test-Path 'C:\Windows\Temp') { $roots += 'C:\Windows\Temp' }
$cutoff = (Get-Date).AddHours(-24)
$freed = 0
foreach ($root in $roots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -lt $cutoff -and -not $_.Attributes.HasFlag('ReparsePoint') } |
    ForEach-Object {
      try { $size = $_.Length; Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop; $freed += $size } catch { }
    }
}
Write-Host ("Reclaimed {0:N1} MB" -f ($freed / 1MB))
```

```bat
@echo off
setlocal
set CUTOFF=0
for /f %%d in ('powershell -NoProfile -Command "(Get-Date).AddHours(-24).ToString('yyyyMMddHHmmss')"') do set CUTOFF=%%d
echo Purging temp files older than 24 hours...
forfiles /P "%TEMP%" /S /D -1 /C "cmd /c if not @isdir==TRUE del /f /q @path" >nul 2>&1
forfiles /P "%LOCALAPPDATA%\Temp" /S /D -1 /C "cmd /c if not @isdir==TRUE del /f /q @path" >nul 2>&1
echo Done. Some files may be skipped because they are in use.
```

---

### 5.2 `empty-recycle-bin` - Empty Windows Recycle Bin

| Property | Value |
| :--- | :--- |
| order / category | 2 / cleanup |
| risk / T / A / SB / Ab | moderate / irreversible / no / **no** / no |
| Sev / timeout / budget | 2 / 60 s / 800 ms |
| dependsOn / scope | - / `recycle_bin` |

**Diagnose.** `SHQueryRecycleBinW(null, &info)` across drives; propagate non-zero HRESULT as
`SERVICE_UNAVAILABLE` rather than ignoring it. `needs_attention` when `i64Size ≥ 1 GB` or
`i64NumItems ≥ 500`. `reclaimableBytes = i64Size`.

**Execute.**
1. Re-query stats for the confirmation count (the number the user saw).
2. Require `confirmation.acknowledgedTier === 'irreversible'` and `typedCount` equal to the item
   count if the count is ≥ 1000 (extra friction for mass deletion).
3. Call `SHEmptyRecycleBinW(HWND::default(), null, SHERB_NOCONFIRMATION|SHERB_NOPROGRESSUI|SHERB_NOSOUND)`.
4. Treat `S_FALSE` and `0x8000FFFF` as success (already empty); any other HRESULT → error with
   code.
5. Measure freed bytes as `before − after`.

**Rollback.** None. Explicit warning string (`modals.recycleBinWarning`).
**i18n.** `actions.empty-recycle-bin.*`, `outcomes.recycleBin.emptied`.

```powershell
$before = (Get-ChildItem -Path 'C:\$Recycle.Bin' -Recurse -Force -ErrorAction SilentlyContinue |
           Measure-Object -Property Length -Sum).Sum
Clear-RecycleBin -Force -ErrorAction SilentlyContinue
$after = (Get-ChildItem -Path 'C:\$Recycle.Bin' -Recurse -Force -ErrorAction SilentlyContinue |
          Measure-Object -Property Length -Sum).Sum
Write-Host ("Freed {0:N1} MB from the Recycle Bin" -f ((($before - $after)) / 1MB))
```

```bat
@echo off
echo Emptying the Recycle Bin permanently...
powershell -NoProfile -Command "Clear-RecycleBin -Force -ErrorAction SilentlyContinue"
echo Recycle Bin emptied. This cannot be undone.
```

---

### 5.3 `archive-screenshots` - Archive & recycle old screenshots

| Property | Value |
| :--- | :--- |
| order / category | 3 / cleanup |
| risk / T / A / SB / Ab | safe / **fully_reversible** / no / yes / no |
| Sev / timeout / budget | 1 / 300 s / 2500 ms |
| dependsOn / scope | - / `screenshots` |

**Diagnose.** Scan `%USERPROFILE%\Pictures\Screenshots` for `.png/.jpg/.jpeg/.webp` with
`mtime < now − 30 d`. `needs_attention` when count ≥ 100 or bytes ≥ 500 MB.

**Execute (write-ahead, `03-01` §7.1).**
1. Phase 1: `backups/<snapshot_id>.zip.tmp`, relative paths preserved, no `..` entries.
2. Phase 2: reopen, iterate entries (CRC), compute SHA-256, `fsync`, rename to `.zip`.
3. Phase 3: insert `COMMITTED` row + `archive_ledger`.
4. Phase 4: move originals to the Recycle Bin via `trash::delete_all` (recoverable by the user
   even if our DB is lost - belt and braces).

**Rollback.** Verify SHA-256 → extract with `enclosed_name()` guard → restore into the same folder
→ mark restored. Files that were already in the Recycle Bin and gone are reported as
`skippedItems` with `reasonCode: 'recycle_bin_emptied'`.

```powershell
$src = Join-Path $env:USERPROFILE 'Pictures\Screenshots'
$dst = Join-Path $env:USERPROFILE "Pictures\Screenshots_Archive_$(Get-Date -f yyyyMMdd)"
if (-not (Test-Path $src)) { Write-Host 'No Screenshots folder found.'; exit 0 }
$files = Get-ChildItem -LiteralPath $src -File -Include *.png,*.jpg,*.jpeg,*.webp -ErrorAction SilentlyContinue |
         Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) }
if (-not $files) { Write-Host 'No screenshots older than 30 days.'; exit 0 }
New-Item -ItemType Directory -Path $dst -Force | Out-Null
$zip = "$dst.zip"
Compress-Archive -LiteralPath $files.FullName -DestinationPath $zip -CompressionLevel Optimal -Force
$files | Remove-Item -Force
Write-Host ("Archived {0} screenshots to {1}" -f $files.Count, $zip)
```

```bat
@echo off
set SRC=%USERPROFILE%\Pictures\Screenshots
set DST=%USERPROFILE%\Pictures\Screenshots_Archive
if not exist "%SRC%" ( echo No Screenshots folder. & exit /b 0 )
if not exist "%DST%" mkdir "%DST%"
powershell -NoProfile -Command "$s='%SRC%';$d='%DST%';Get-ChildItem -LiteralPath $s -File | Where-Object {$_.LastWriteTime -lt (Get-Date).AddDays(-30)} | ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination $d -Force }; Compress-Archive -Path (Join-Path $d '*') -DestinationPath (Join-Path $d 'archive.zip') -Force -ErrorAction SilentlyContinue"
echo Screenshots older than 30 days archived to %DST%
```

> Note: the portable `.bat`/`.ps1` cannot provide Zenith's verified snapshot; the script header
> states this (REQ-F-082).

---

### 5.4 `winget-upgrade-all` - Silent package upgrades

| Property | Value |
| :--- | :--- |
| order / category | 4 / cleanup |
| risk / T / A / SB / Ab | moderate / irreversible / no / no / no |
| Sev / timeout / budget | 2 / 1800 s / 8000 ms |
| dependsOn / scope | - / `none` |

**Diagnose.** `winget upgrade --accept-source-agreements` with a 20 s cap; parse the count of
upgradable packages from the table. If `winget.exe` is absent → `needs_attention = false`,
`metricKey = 'diag.wingetMissing'` (informational, not an error). `reclaimableBytes = 0` (it is
not a space action).

**Execute.** `winget upgrade --all --accept-package-agreements --accept-source-agreements --silent
--disable-interactivity`, job object, cancel token, 1800 s. Stream lines. Exit code 0 → success;
`-1978335189` (`APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE`) → success with
`noUpdatesAvailable`; anything else → error with the raw code in params.

**Rollback.** None. Before-state table (package/version) is recorded in the audit row for
reference only.

```powershell
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Write-Host 'winget not found.'; exit 0 }
Write-Host 'Upgrading packages. This can take a while...'
winget upgrade --all --accept-package-agreements --accept-source-agreements --silent --disable-interactivity
Write-Host "winget finished with exit code $LASTEXITCODE"
```

```bat
@echo off
where winget >nul 2>&1 || ( echo winget not found. & exit /b 0 )
winget upgrade --all --accept-package-agreements --accept-source-agreements --silent --disable-interactivity
echo winget exit code: %errorlevel%
```

---

### 5.5 `windows-update-scan` - Trigger update scan (read-only)

| Property | Value |
| :--- | :--- |
| order / category | 5 / cleanup |
| risk / T / A / SB / Ab | safe / irreversible / **no** / yes / no |
| Sev / timeout / budget | 2 / 180 s / 6000 ms |
| dependsOn / scope | - / `none` |

**Correction vs v1.0.0.** v1.0.0 marked this `requiresAdmin = true`. `Microsoft.Update.Session`
searches work for standard users; requiring admin broke the safe preset and showed a false lock
badge. **Now: admin = no.**

**Diagnose.** Check `HKLM\...\WindowsUpdate\Auto Update\RebootRequired` and
`HKLM\...\Component Based Servicing\RebootPending`; report `pendingReboot` in params.

**Execute.** PowerShell COM search `IsInstalled=0`, `Search('IsInstalled=0 and Type=''Software''')`,
list titles + KB ids + `IsDownloaded`. Read-only: writes nothing but the audit row.

**Rollback.** Not applicable (no mutation).
**i18n.** `outcomes.updateScan.found {count}` with ICU plural.

```powershell
$session  = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
$result   = $searcher.Search("IsInstalled=0 and Type='Software'")
if ($result.Updates.Count -eq 0) { Write-Host 'Windows reports no missing software updates.' }
foreach ($u in $result.Updates) { Write-Host (" - {0}  [downloaded: {1}]" -f $u.Title, $u.IsDownloaded) }
```

```bat
@echo off
powershell -NoProfile -Command "$s=New-Object -ComObject Microsoft.Update.Session; $q=$s.CreateUpdateSearcher(); $r=$q.Search(\"IsInstalled=0 and Type='Software'\"); Write-Host ('Pending updates: ' + $r.Updates.Count); foreach($u in $r.Updates){ Write-Host (' - ' + $u.Title) }"
```

---

### 5.6 `flush-dns-cache` - Flush DNS resolver cache

| Property | Value |
| :--- | :--- |
| order / category | 6 / network |
| risk / T / A / SB / Ab | safe / irreversible / no / yes / no |
| Sev / timeout / budget | 1 / 20 s / 3000 ms |
| dependsOn / scope | - / `none` |

**Diagnose.** Resolve `one.one.one.one` 5×, take the median in ms. `needs_attention` when
median ≥ 50 ms **or** the last flush is > 7 days old. `latencyMs` = measured median.

**Execute.** Call `DnsFlushResolverCache()` (dnsapi) - no child process; then re-measure and
report `beforeMs`/`afterMs`. If the FFI symbol cannot be resolved, fall back to
`ipconfig /flushdns` with a logged reason (never silently pretend).

**Rollback.** Not needed: Windows repopulates the cache. Tier stays `irreversible` because there
is no prior state to restore, and claiming otherwise would be dishonest.

```powershell
$before = (Measure-Command { Resolve-DnsName one.one.one.one -ErrorAction SilentlyContinue }).TotalMilliseconds
Clear-DnsClientCache
$after  = (Measure-Command { Resolve-DnsName one.one.one.one -ErrorAction SilentlyContinue }).TotalMilliseconds
Write-Host ("DNS cache flushed. Before {0:N0} ms, after {1:N0} ms" -f $before, $after)
```

```bat
@echo off
echo Flushing DNS resolver cache...
ipconfig /flushdns
echo Done.
```

---

### 5.7 `reset-winsock-stack` - Reset Winsock & TCP/IP (compensating recovery)

| Property | Value |
| :--- | :--- |
| order / category | 7 / network |
| risk / T / A / SB / Ab | moderate / **compensating_recovery** / **yes** / no / no |
| Sev / timeout / budget | 3 / 300 s / 2000 ms |
| dependsOn / scope | `flush-dns-cache` / `winsock` |

**Diagnose.** Enumerate `HKLM\SYSTEM\CurrentControlSet\Services\WinSock2\Parameters\Protocol_Catalog9\Catalog_Entries*`
count and check for the well-known corruption signal (catalog entries referencing a missing
provider path). `needs_attention` only on a concrete signal, never "always offer reset".

**Execute (order matters).**
1. `reg.exe save HKLM\SYSTEM\CurrentControlSet\Services\WinSock2 <hives>\WinSock2_<ts>.hiv /y`
2. `Checkpoint-Computer -Description 'Zenith_Winsock_Reset' -RestorePointType MODIFY_SETTINGS`
   (skip with a warning if System Restore is disabled, do **not** fail silently)
3. `netsh winsock reset`
4. `netsh int ip reset`
5. Snapshot `compensating_hive_export` with both paths and `restore_point_created`
6. `requiresReboot = true`

**Rollback.** `reg.exe restore` the hive and prompt reboot; also offer `rstrui.exe` launch. This is
compensating, not exact: TCP/IP parameters changed by `netsh int ip reset` are not restored by the
hive import, and the UI must say so.

```powershell
$stamp = Get-Date -Format yyyyMMdd_HHmmss
$dir   = Join-Path $env:ProgramData 'Vellium\Zenith\hives'
New-Item -ItemType Directory -Path $dir -Force | Out-Null
reg.exe save "HKLM\SYSTEM\CurrentControlSet\Services\WinSock2" (Join-Path $dir "WinSock2_$stamp.hiv") /y | Out-Null
Checkpoint-Computer -Description "Zenith_Winsock_Reset" -RestorePointType MODIFY_SETTINGS -ErrorAction SilentlyContinue
netsh winsock reset | Out-Host
netsh int ip reset   | Out-Host
Write-Host 'A restart is required to finish the reset.'
```

```bat
@echo off
set DIR=%ProgramData%\Vellium\Zenith\hives
if not exist "%DIR%" mkdir "%DIR%"
reg save "HKLM\SYSTEM\CurrentControlSet\Services\WinSock2" "%DIR%\WinSock2_backup.hiv" /y
netsh winsock reset
netsh int ip reset
echo Restart Windows to complete the reset.
```

---

### 5.8 `clear-stuck-proxy-vpn` - Clear orphaned proxy / VPN locks

| Property | Value |
| :--- | :--- |
| order / category | 8 / network |
| risk / T / A / SB / Ab | safe / **fully_reversible** / no / yes / no |
| Sev / timeout / budget | 2 / 30 s / 800 ms |
| dependsOn / scope | - / `internet_settings` |

**Diagnose.** Read `ProxyEnable`, `ProxyServer`, `AutoConfigURL`, `ProxyOverride` from
`HKCU\...\Internet Settings`. `needs_attention` when `ProxyEnable = 1` and the proxy target is
unreachable (TCP connect with 800 ms timeout), or `AutoConfigURL` points to an unreachable host.

**Execute.**
1. Snapshot `registry_backup` with all four values, including `absent` markers.
2. Set `ProxyEnable = 0`; delete `ProxyServer` and `AutoConfigURL` (recorded as present-before).
3. `InternetSetOptionW(null, INTERNET_OPTION_SETTINGS_CHANGED, null, 0)` and
   `INTERNET_OPTION_REFRESH`, checking both HRESULTs.

**Rollback.** Restore exactly: set `ProxyEnable` to prior dword, recreate `ProxyServer` /
`AutoConfigURL` if they existed, delete if they were `absent`, then refresh WinINet.

```powershell
$k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$backup = @{}
foreach ($n in 'ProxyEnable','ProxyServer','AutoConfigURL','ProxyOverride') {
  $backup[$n] = (Get-ItemProperty -Path $k -Name $n -ErrorAction SilentlyContinue).$n
}
$backup | ConvertTo-Json | Set-Content "$env:ProgramData\Vellium\Zenith\proxy-backup.json" -ErrorAction SilentlyContinue
Set-ItemProperty -Path $k -Name ProxyEnable -Value 0 -Type DWord
Remove-ItemProperty -Path $k -Name ProxyServer  -ErrorAction SilentlyContinue
Remove-ItemProperty -Path $k -Name AutoConfigURL -ErrorAction SilentlyContinue
Write-Host 'Proxy settings cleared. Previous values saved to proxy-backup.json'
```

```bat
@echo off
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v AutoConfigURL /f >nul 2>&1
echo Proxy settings cleared. Re-enable in Windows Settings if needed.
```

---

### 5.9 `sync-ntp-time` - Resynchronise system clock

| Property | Value |
| :--- | :--- |
| order / category | 9 / network |
| risk / T / A / SB / Ab | safe / **partially_reversible** / yes / yes / no |
| Sev / timeout / budget | 2 / 60 s / 1500 ms |
| dependsOn / scope | - / `services_only` |

**Correction vs v1.0.0.** v1.0.0 claimed `FullyReversible`. The service state is restorable, but
**the clock change is not undone** - moving the clock back would itself be a mutation with
side-effects (TLS, scheduled tasks). Tier is therefore `partially_reversible`, and the UI states
"service state will be restored; the corrected time will not be reverted".

**Diagnose.** Query `W32Time` via SCM (`QueryServiceStatusEx` + `QueryServiceConfigW`). Measure
absolute offset against `time.windows.com` with a 3 s timeout. `needs_attention` when |offset| >
5 s or the service is stopped/disabled.

**Execute.**
1. Snapshot `service_state_backup` (`was_running`, `start_type`).
2. If `start_type = disabled` → refuse with `SERVICE_UNAVAILABLE` (do not silently change policy).
3. `StartServiceW` if stopped; wait for `SERVICE_RUNNING` up to 10 s.
4. Run `w32tm /resync /force` (no `/nowait` so the exit code is meaningful).

**Rollback.** Restore prior running state and start type. Explicitly do not touch the clock.

```powershell
Start-Service w32time -ErrorAction SilentlyContinue
w32tm /resync /force
if ($LASTEXITCODE -eq 0) { Write-Host 'System clock resynchronised.' }
else { Write-Host "w32tm returned $LASTEXITCODE. Check the time service configuration." }
```

```bat
@echo off
sc query w32time | find "RUNNING" >nul || net start w32time >nul 2>&1
w32tm /resync /force
echo w32tm exit code: %errorlevel%
```

---

### 5.10 `copy-sysadmin-info` - Copy diagnostic summary

| Property | Value |
| :--- | :--- |
| order / category | 10 / network |
| risk / T / A / SB / Ab | safe / irreversible (no mutation) / no / no / no |
| Sev / timeout / budget | 1 / 15 s / 1200 ms |
| dependsOn / scope | - / `none` |

**Diagnose.** Gather hostname, OS display version + build, uptime, RAM used/total, IPv4 adapters
with gateway, open-issue list from the last diagnosis. `needs_attention = false` always.

**Execute.** Compose a plain-text block (no ANSI, no emoji), write to the clipboard via the
clipboard plugin, and return the same text in `clipboardKey` so the UI can show a preview.

**Rollback.** Not applicable.

```powershell
$os = Get-CimInstance Win32_OperatingSystem
$ip = Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' } |
      Select-Object InterfaceAlias, IPAddress
$lines = @(
  "Host: $env:COMPUTERNAME",
  "OS: $($os.Caption) $($os.Version) build $($os.BuildNumber)",
  "Uptime: $((Get-Date) - $os.LastBootUpTime)",
  ("RAM: {0:N1} GB used of {1:N1} GB" -f (($os.TotalVisibleMemorySize-$os.FreePhysicalMemory)/1MB), ($os.TotalVisibleMemorySize/1MB)),
  'IPv4:'
) + ($ip | ForEach-Object { "  $($_.InterfaceAlias): $($_.IPAddress)" })
$text = $lines -join "`r`n"
$text | Set-Clipboard
Write-Host $text
```

```bat
@echo off
powershell -NoProfile -Command "$o=Get-CimInstance Win32_OperatingSystem; $t='Host: '+$env:COMPUTERNAME+\"`r`n\"+'OS: '+$o.Caption+' '+$o.Version+\"`r`n\"+'RAM used MB: '+[math]::Round(($o.TotalVisibleMemorySize-$o.FreePhysicalMemory)/1024); $t | Set-Clipboard; Write-Host $t"
```

---

### 5.11 `dism-restore-health` - Repair component store

| Property | Value |
| :--- | :--- |
| order / category | 11 / recovery |
| risk / T / A / SB / Ab | moderate / irreversible / **yes** / no / no |
| Sev / timeout / budget | 3 / 1800 s / 15000 ms |
| dependsOn / scope | - / `none` |

**Diagnose.** `Dism /Online /Cleanup-Image /CheckHealth` with a 10 s cap (this is the fast
variant, not `ScanHealth`). Parse `No component store corruption detected` vs `The component store
is repairable` vs `not repairable`. `needs_attention` only for the latter two.

**Execute.** `Dism.exe /Online /Cleanup-Image /RestoreHealth`, job object, 1800 s, stream both
pipes, decode with the stateful decoder (DISM emits UTF-16LE on some builds). Parse the final
percentage and result line. Exit codes 0, 3010 (reboot required) → success; others → error with
code.

**Rollback.** None (official Microsoft repair; it only replaces corrupted payload files with
Microsoft-signed copies).

```powershell
Dism.exe /Online /Cleanup-Image /RestoreHealth
Write-Host "DISM exit code: $LASTEXITCODE  (3010 means restart required)"
```

```bat
@echo off
Dism.exe /Online /Cleanup-Image /RestoreHealth
echo DISM exit code: %errorlevel%  (3010 means restart required)
```

---

### 5.12 `sfc-system-scan` - System file integrity scan

| Property | Value |
| :--- | :--- |
| order / category | 12 / recovery |
| risk / T / A / SB / Ab | moderate / irreversible / yes / no / no |
| Sev / timeout / budget | 3 / 1800 s / 15000 ms |
| dependsOn / scope | `dism-restore-health` / `none` |

**Diagnose.** Read the `CBS.log` last-write time and the tail of `CBS.log` for `[SR]` repair
markers; report age and last result. `needs_attention` when the last scan is > 30 days old or the
tail contains an unrepaired corruption marker.

**Execute.** `sfc.exe /scannow`, job object, 1800 s, **UTF-16LE stateful decode**, stream to the
console. Parse the four documented outcome sentences. Exit code 0 with "did not find any integrity
violations" → healthy; "successfully repaired" → success with `repaired`; "unable to fix" → error
`REPAIR_INCOMPLETE` with a remedy pointing at DISM.

**Rollback.** None.
**Dependency.** Enforced client-side and server-side: attempting SFC alone when DISM has never run
returns `DEPENDENCY_NOT_MET` with a one-click "run the chain" affordance.

```powershell
sfc.exe /scannow
Write-Host "SFC exit code: $LASTEXITCODE"
```

```bat
@echo off
echo This scan can take 10-30 minutes. Do not close the window.
sfc.exe /scannow
echo SFC exit code: %errorlevel%
```

---

### 5.13 `restart-explorer` - Restart Windows Explorer shell

| Property | Value |
| :--- | :--- |
| order / category | 13 / recovery |
| risk / T / A / SB / Ab | safe / **partially_reversible** / no / no / no |
| Sev / timeout / budget | 1 / 60 s / 2000 ms |
| dependsOn / scope | - / `explorer_session` |

**Correction vs v1.0.0.** v1.0.0 claimed nothing about window restoration limits; tier is
`partially_reversible` because open windows are reopened but their scroll position, selection, and
unsaved view state are not restored.

**Diagnose.** Count `explorer.exe` processes; read memory and `IsHungAppWindow` for the shell
window. `needs_attention` only when the shell window is unresponsive.

**Execute.**
1. Snapshot `explorer_session_backup` = folder paths from `Shell.Application.Windows()`.
2. Gracefully request shell restart via `ExitExplorer`-equivalent (WM_QUERYENDSESSION on the shell
   window), wait 3 s, then start `explorer.exe` if not present.
3. Reopen saved folder paths (max 12; beyond that, log and skip).

**Rollback.** Reopen the saved folder set (best effort). Explicitly not a state restoration.

```powershell
$shell = New-Object -ComObject Shell.Application
$paths = @($shell.Windows() | ForEach-Object { $_.Document.Folder.Self.Path } | Where-Object { $_ })
$paths | Set-Content "$env:TEMP\zenith-explorer-paths.txt"
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }
foreach ($p in $paths) { if (Test-Path $p) { Start-Process explorer.exe $p } }
Write-Host "Explorer restarted; reopened $($paths.Count) folders."
```

```bat
@echo off
echo Restarting Windows Explorer...
taskkill /f /im explorer.exe >nul 2>&1
timeout /t 2 /nobreak >nul
start explorer.exe
echo Explorer restarted.
```

---

### 5.14 `rebuild-icon-cache` - Rebuild corrupted icon cache

| Property | Value |
| :--- | :--- |
| order / category | 14 / recovery |
| risk / T / A / SB / Ab | safe / **partially_reversible** / no / no / no |
| Sev / timeout / budget | 1 / 120 s / 1500 ms |
| dependsOn / scope | - / `icon_cache` |

**Correction vs v1.0.0.** v1.0.0 claimed `FullyReversible`. Deleting the cache forces regeneration
from application resources; the *previous* cache bytes are restored, but the regenerated icons may
differ in thumbnail appearance. Hence `partially_reversible`.

**Diagnose.** Enumerate `%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache_*.db` and
`thumbcache_*.db`; sum sizes and newest mtime. `needs_attention` when total ≥ 200 MB or the user
reported broken icons (no reliable OS signal - the probe reports size only and says so).

**Execute.**
1. Archive the `*.db` files to a verified ZIP (locked files are copied with `FILE_SHARE_READ` and
   may be partially readable - those are recorded as `skipped_locked`).
2. Stop the shell (required to release handles) - record that the shell will restart.
3. Delete cache files.
4. Start the shell; run `ie4uinit.exe -show`.
5. **Guarantee:** the shell is started in a `finally` block even if deletion fails (REQ-F-077).

**Rollback.** Stop shell, extract archive, start shell. Warning shown that thumbnails regenerate.

```powershell
$dir = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Explorer'
$bak = Join-Path $env:ProgramData 'Vellium\Zenith\iconcache-backup'
New-Item -ItemType Directory -Path $bak -Force | Out-Null
Copy-Item "$dir\iconcache_*.db" $bak -Force -ErrorAction SilentlyContinue
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Remove-Item "$dir\iconcache_*.db" -Force -ErrorAction SilentlyContinue
Remove-Item "$dir\thumbcache_*.db" -Force -ErrorAction SilentlyContinue
Start-Process explorer.exe
Start-Process ie4uinit.exe '-show'
Write-Host "Icon cache rebuilt. Backup in $bak"
```

```bat
@echo off
set DIR=%LOCALAPPDATA%\Microsoft\Windows\Explorer
taskkill /f /im explorer.exe >nul 2>&1
timeout /t 2 /nobreak >nul
del /f /q "%DIR%\iconcache_*.db" >nul 2>&1
del /f /q "%DIR%\thumbcache_*.db" >nul 2>&1
start explorer.exe
ie4uinit.exe -show
echo Icon cache rebuilt.
```

---

### 5.15 `restart-bluetooth` - Restart Bluetooth Support Service

| Property | Value |
| :--- | :--- |
| order / category | 15 / recovery |
| risk / T / A / SB / Ab | safe / **fully_reversible** / yes / yes / no |
| Sev / timeout / budget | 1 / 60 s / 900 ms |
| dependsOn / scope | - / `services_only` |

**Diagnose.** `bthserv` status + start type via SCM; count paired devices via
`HKLM\SYSTEM\CurrentControlSet\Services\BTHPORT\Parameters\Devices` subkeys.
`needs_attention` when the service is stopped but start type is not disabled, or when the service
is running and the last error indicates a fault.

**Execute.** Snapshot `service_state_backup`; `ControlService(STOP)` → wait `SERVICE_STOPPED` ≤ 10 s
→ `StartServiceW` → wait `SERVICE_RUNNING` ≤ 10 s.

**Rollback.** Restore prior running state and start type.

```powershell
$svc = Get-Service bthserv -ErrorAction SilentlyContinue
if (-not $svc) { Write-Host 'Bluetooth Support Service is not present.'; exit 0 }
Restart-Service bthserv -Force -ErrorAction SilentlyContinue
Write-Host "bthserv status: $((Get-Service bthserv).Status)"
```

```bat
@echo off
net stop bthserv >nul 2>&1
timeout /t 3 /nobreak >nul
net start bthserv >nul 2>&1
sc query bthserv | find "STATE"
```

---

### 5.16 `reset-print-spooler` - Reset spooler & clear stuck jobs

| Property | Value |
| :--- | :--- |
| order / category | 16 / recovery |
| risk / T / A / SB / Ab | safe / **fully_reversible** / yes / yes / no |
| Sev / timeout / budget | 2 / 120 s / 1200 ms |
| dependsOn / scope | - / `spooler` |

**Diagnose.** `Spooler` status; count `.SPL`/`.SHD` files and bytes in
`C:\Windows\System32\spool\PRINTERS`. `needs_attention` when the service is stopped unexpectedly or
≥ 5 stuck job files older than 10 minutes.

**Execute.**
1. Snapshot service state.
2. Stop `Spooler`; wait ≤ 15 s.
3. Archive `*.SPL`/`*.SHD` via verified ZIP → commit snapshot.
4. Delete the archived files only (never the directory).
5. Start `Spooler` - in a `finally` block (REQ-F-078).

**Rollback.** Stop spooler → extract archive → start spooler.

```powershell
$spool = "$env:SystemRoot\System32\spool\PRINTERS"
$bak   = Join-Path $env:ProgramData 'Vellium\Zenith\spooler-backup'
New-Item -ItemType Directory -Path $bak -Force | Out-Null
Stop-Service Spooler -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$jobs = Get-ChildItem $spool -Include *.SPL,*.SHD -File -ErrorAction SilentlyContinue
if ($jobs) {
  Compress-Archive -LiteralPath $jobs.FullName -DestinationPath "$bak\spool-$(Get-Date -f yyyyMMddHHmmss).zip" -Force
  $jobs | Remove-Item -Force -ErrorAction SilentlyContinue
}
Start-Service Spooler -ErrorAction SilentlyContinue
Write-Host "Spooler restarted. Archived $($jobs.Count) job files."
```

```bat
@echo off
set SPOOL=%SystemRoot%\System32\spool\PRINTERS
net stop spooler >nul 2>&1
timeout /t 2 /nobreak >nul
del /f /q "%SPOOL%\*.SPL" >nul 2>&1
del /f /q "%SPOOL%\*.SHD" >nul 2>&1
net start spooler >nul 2>&1
echo Print spooler reset.
```

---

### 5.17 `reset-gpu-driver` - Reset WDDM graphics driver

| Property | Value |
| :--- | :--- |
| order / category | 17 / recovery |
| risk / T / A / SB / Ab | safe / irreversible / no / no / no |
| Sev / timeout / budget | 1 / 20 s / 1500 ms |
| dependsOn / scope | - / `none` |

**Diagnose.** Enumerate adapters via `EnumDisplayDevicesW`; report adapter description + driver
version + a driver-reset counter read from the event log (Event ID 4101 "Display driver stopped
responding") in the last 24 h. `needs_attention` only when that counter ≥ 1.

**Execute.** Synthesize `Win+Ctrl+Shift+B` with `SendInput` (8 events: 4 down, 4 up in reverse).
Verify `SendInput` returned the full count. The screen will flash and blank briefly; the UI shows a
`gpu-reset-flash` effect and explains it before running.

**Rollback.** None; the reset is non-destructive and self-healing.

```powershell
Write-Host 'Sending the graphics driver reset shortcut (Win+Ctrl+Shift+B). The screen will flash.'
$sig = '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);'
$t = Add-Type -MemberDefinition $sig -Name KB -Namespace Zen -PassThru
$down = 0x0000; $up = 0x0002
foreach ($vk in 0x5B,0x11,0x10,0x42) { $t::keybd_event($vk,0,$down,[UIntPtr]::Zero); Start-Sleep -Milliseconds 40 }
foreach ($vk in 0x42,0x10,0x11,0x5B) { $t::keybd_event($vk,0,$up,[UIntPtr]::Zero); Start-Sleep -Milliseconds 40 }
Write-Host 'Graphics driver reset signal sent.'
```

```bat
@echo off
echo A .bat file cannot safely synthesize Win+Ctrl+Shift+B.
echo Use the PowerShell version, or press Win+Ctrl+Shift+B manually.
echo This step is skipped so the script does not do something unexpected.
```

> The batch snippet deliberately refuses rather than faking it. That is contract behaviour
> (REQ-F-083: no empty or misleading step).

---

### 5.18 `controlled-reboot` - Controlled restart with abort

| Property | Value |
| :--- | :--- |
| order / category | 18 / recovery |
| risk / T / A / SB / Ab | **destructive** / irreversible / yes / **no** / **yes** |
| Sev / timeout / budget | 3 / 30 s / 700 ms |
| dependsOn / scope | - / `none` |

**Correction vs v1.0.0.** v1.0.0 called this `FullyReversible`. It is **abortable within the
countdown**, and irreversible after the machine restarts. The model now separates `abortable` from
`tier`.

**Diagnose.** Report pending-reboot signals and uptime; `needs_attention` when a pending-reboot
flag exists (i.e. a restart is actually needed).

**Execute.**
1. Begin an in-app countdown overlay (default 30 s, user can extend to 60 s or cancel).
2. At T-0, `shutdown.exe /r /t 10 /c "Zenith Controlled Restart" /d p:2:4`.
3. Return `abortable = true` and `triggerEffect = 'reboot-countdown'` while the abort window is open.

**Rollback / abort.** `shutdown.exe /a`. If already rebooting, return `CANCELLED` with
`reason: 'too_late'` and no false promise.

```powershell
shutdown.exe /r /t 30 /c "Restart scheduled by Zenith" /d p:2:4
Write-Host 'Restart scheduled in 30 seconds. Run "shutdown /a" to abort.'
```

```bat
@echo off
shutdown /r /t 30 /c "Restart scheduled by Zenith" /d p:2:4
echo Restart scheduled in 30 seconds. Run "shutdown /a" to abort.
```

---

### 5.19 `unlock-dev-ports` - Inspect and free dev ports

| Property | Value |
| :--- | :--- |
| order / category | 19 / dev_office |
| risk / T / A / SB / Ab | moderate / irreversible / no / no / no |
| Sev / timeout / budget | 1 / 30 s / 1200 ms |
| dependsOn / scope | - / `none` |

**Diagnose.** `GetExtendedTcpTable(TCP_TABLE_OWNER_PID_LISTENER)` with an 8-byte-aligned buffer,
retry on `ERROR_INSUFFICIENT_BUFFER`, clamp `dwNumEntries` to buffer capacity, convert the port
from big-endian. Filter 3000-9999. Join with process identity (`GetProcessTimes` for start time,
per ADR-017). `needs_attention` only when at least one listener belongs to a process whose name
matches a known dev-server pattern **and** it has been running > 8 h (likely stale).

**Execute.** Open the port modal; the user selects rows; the backend verifies each
`(pid, expectedName, expectedStartTimeUnixMs)` immediately before `TerminateProcess`, per-target,
never all-or-nothing.

**Rollback.** None. Audit records PID, redacted command line, and outcome.

```powershell
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -ge 3000 -and $_.LocalPort -le 9999 } |
  ForEach-Object {
    $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
    [pscustomobject]@{ Port = $_.LocalPort; PID = $_.OwningProcess; Name = $p.ProcessName; Started = $p.StartTime }
  } | Sort-Object Port | Format-Table -AutoSize
```

```bat
@echo off
netstat -ano | findstr LISTENING
echo Find the PID listening on your port in the last column, then use Task Manager or:
echo   taskkill /PID ^<pid^> /F
```

---

### 5.20 `close-hung-office` - Close unresponsive Office apps

| Property | Value |
| :--- | :--- |
| order / category | 20 / dev_office |
| risk / T / A / SB / Ab | moderate / irreversible / no / no / no |
| Sev / timeout / budget | 2 / 45 s / 2000 ms |
| dependsOn / scope | - / `none` |

**Diagnose.** `EnumWindows` (callback returns `BOOL(1)` to continue), filter to visible top-level
windows owned by `WINWORD.EXE`, `EXCEL.EXE`, `POWERPNT.EXE`, `OUTLOOK.EXE`, call `IsHungAppWindow`.
Report window title, PID, hung duration (from first observation, persisted in memory), memory.
`needs_attention` when ≥ 1 hung window.

**Execute.** Show the hung-window modal; only explicitly checked rows are terminated, each with
identity verification. Show the AutoRecover path for the affected app
(`%APPDATA%\<App>\AutoRecovery` or the UNC path) after the kill.

**Rollback.** None. Warning explains AutoRecover may not include unsaved changes.

```powershell
Add-Type @"
using System; using System.Runtime.InteropServices;
public class Hung {
  [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr h);
}
"@
Get-Process WINWORD,EXCEL,POWERPNT,OUTLOOK -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and [Hung]::IsHungAppWindow($_.MainWindowHandle) } |
  Select-Object Id, ProcessName, MainWindowTitle
```

```bat
@echo off
echo Listing Office processes. A frozen window shows "Not Responding" in Task Manager.
tasklist /fi "imagename eq WINWORD.EXE"
tasklist /fi "imagename eq EXCEL.EXE"
echo Close the frozen window from Task Manager to let Office AutoRecover run.
```

---

### 5.21 `clear-teams-outlook-cache` - Clean Outlook RoamCache & Teams cache

| Property | Value |
| :--- | :--- |
| order / category | 21 / dev_office |
| risk / T / A / SB / Ab | safe / **fully_reversible** / no / no / no |
| Sev / timeout / budget | 1 / 300 s / 2500 ms |
| dependsOn / scope | - / `office_cache` |

**Diagnose.** Measure `%LOCALAPPDATA%\Microsoft\Outlook\RoamCache` and Teams cache roots
(`%LOCALAPPDATA%\Microsoft\Teams`, `%LOCALAPPDATA%\Packages\MSTeams_*\LocalCache`).
`needs_attention` when combined ≥ 2 GB.

**Execute.** Archive both roots (relative paths, verified ZIP) → commit → delete unlocked files
only. Warn that Outlook will rebuild the AutoComplete cache and that recent-address suggestions may
briefly disappear.

**Rollback.** Extract both roots. Note in the UI that Outlook may hold locks; files locked during
restore are reported individually.

```powershell
$targets = @(
  (Join-Path $env:LOCALAPPDATA 'Microsoft\Outlook\RoamCache'),
  (Join-Path $env:LOCALAPPDATA 'Microsoft\Teams')
)
$bak = Join-Path $env:ProgramData 'Vellium\Zenith\office-cache-backup'
New-Item -ItemType Directory -Path $bak -Force | Out-Null
foreach ($t in $targets) {
  if (-not (Test-Path $t)) { continue }
  $name = Split-Path $t -Leaf
  Compress-Archive -Path (Join-Path $t '*') -DestinationPath (Join-Path $bak "$name-$(Get-Date -f yyyyMMddHHmmss).zip") -Force -ErrorAction SilentlyContinue
  Get-ChildItem -LiteralPath $t -Recurse -File -Force -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
}
Write-Host "Caches cleared. Backups in $bak"
```

```bat
@echo off
echo Close Outlook and Teams before running this.
set ROAM=%LOCALAPPDATA%\Microsoft\Outlook\RoamCache
set TEAMS=%LOCALAPPDATA%\Microsoft\Teams
if exist "%ROAM%" del /f /q "%ROAM%\*.*" >nul 2>&1
if exist "%TEAMS%" rmdir /s /q "%TEAMS%" >nul 2>&1
echo Caches cleared. Both apps will rebuild them on next start.
```

---

### 5.22 `reclaim-wsl-docker-ram` - Reclaim WSL2 / Docker memory

| Property | Value |
| :--- | :--- |
| order / category | 22 / dev_office |
| risk / T / A / SB / Ab | moderate / irreversible / no / no / no |
| Sev / timeout / budget | 2 / 120 s / 2000 ms |
| dependsOn / scope | - / `none` |

**Diagnose.** Find `vmmem` / `vmmemWSL` processes and their working set; run
`wsl.exe --list --running --quiet` (3 s cap) to count running distros. `needs_attention` when
`vmmem` ≥ 2 GB. `reclaimableBytes` = current vmmem RSS (the ceiling of what can be returned).

**Execute.** Confirmation explains that all running Linux distributions and Docker containers will
stop and unsaved container state is lost. Then `wsl.exe --shutdown`, wait for vmmem to exit (≤ 20 s),
re-measure, report the delta. If measurement fails → `reclaimedMb: null`, displayed as
"unknown" rather than `0`.

**Rollback.** None; the user restarts WSL/Docker. Docker Desktop's "start on login" is untouched.

```powershell
$before = (Get-Process vmmem,vmmemWSL -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum
wsl.exe --shutdown
Start-Sleep -Seconds 5
$after = (Get-Process vmmem,vmmemWSL -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum
Write-Host ("WSL shut down. Freed {0:N0} MB" -f ((($before - $after)) / 1MB))
```

```bat
@echo off
echo This stops all WSL distributions and Docker containers. Unsaved container state is lost.
wsl.exe --shutdown
echo WSL shut down.
```

---

## 6. Manifest-derived matrices

### 6.1 Safe preset (exactly 8 steps, in this order)

| # | Action | Why safe |
| :--- | :--- | :--- |
| 1 | `flush-dns-cache` | no mutation, no admin, instant |
| 2 | `clean-temp-cache` | only > 24 h, only temp roots |
| 3 | `clear-stuck-proxy-vpn` | fully reversible, only if a broken proxy is detected |
| 4 | `windows-update-scan` | read-only |
| 5 | `sync-ntp-time` | service state reversible; clock correction is beneficial |
| 6 | `restart-bluetooth` | service state reversible |
| 7 | `reset-print-spooler` | jobs archived before deletion |
| 8 | `archive-screenshots` | fully reversible archive before recycle |

Validation: all entries satisfy `isBatchEligible` - `risk=safe`, `safeBatch=true`, `abortable=false`,
`readOnly=false`, and either `tier != 'irreversible'` or `noMutation=true` or `scope=temp_dirs`.
`requiresAdmin` is deliberately **not** part of the predicate: `sync-ntp-time`,
`restart-bluetooth` and `reset-print-spooler` are elevated, and the runner either elevates once up
front or reports them as `elevation_required` in `plan_batch.skipped`. No step reboots. No step
empties a bin. `manifest::verify()` asserts all eight members against this predicate, so the preset
cannot drift from the table.

### 6.2 Admin matrix

| Requires admin (7) | Does not (15) |
| :--- | :--- |
| `reset-winsock-stack`, `sync-ntp-time`, `dism-restore-health`, `sfc-system-scan`, `restart-bluetooth`, `reset-print-spooler`, `controlled-reboot` | the remaining 15 |

### 6.3 Tier matrix

| Tier | Count | Actions |
| :--- | ---: | :--- |
| fully_reversible (5) | 5 | archive-screenshots, clear-stuck-proxy-vpn, restart-bluetooth, reset-print-spooler, clear-teams-outlook-cache |
| partially_reversible (3) | 3 | sync-ntp-time, restart-explorer, rebuild-icon-cache |
| compensating_recovery (1) | 1 | reset-winsock-stack |
| irreversible (13) | 13 | clean-temp-cache, empty-recycle-bin, winget-upgrade-all, windows-update-scan, flush-dns-cache, copy-sysadmin-info, dism-restore-health, sfc-system-scan, reset-gpu-driver, controlled-reboot, unlock-dev-ports, close-hung-office, reclaim-wsl-docker-ram |

`sfc-system-scan` is **irreversible**: repaired system files are replaced by Microsoft originals
with no user-visible snapshot. It writes a CBS log we retain, but retaining a log is not a rollback,
so the tier is `irreversible` and the UI must not offer `canRollback`. Totals: 5 + 3 + 1 + 13 = 22.

### 6.4 Severity and timeout

| Severity 3 (5) | Severity 2 (9) | Severity 1 (8) |
| :--- | :--- | :--- |
| reset-winsock-stack, dism-restore-health, sfc-system-scan, controlled-reboot, winget-upgrade-all* | clean-temp-cache, empty-recycle-bin, windows-update-scan, clear-stuck-proxy-vpn, sync-ntp-time, reset-print-spooler, close-hung-office, reclaim-wsl-docker-ram, copy-sysadmin-info* | archive-screenshots, flush-dns-cache, restart-explorer, rebuild-icon-cache, restart-bluetooth, reset-gpu-driver, unlock-dev-ports, clear-teams-outlook-cache |

---

## 7. Adding an action (the 8-step checklist)

1. Add the entry to `actions.manifest.json` (all fields).
2. Implement `diagnose`, `execute`, `rollback` in a new adapter module.
3. Add the scope (or `none`) to §4 and to the scope resolver.
4. Add i18n keys to `en.json` **and** `tr.json` (Tier A), then regenerate skeletons.
5. Write the `ps1` and `bat` snippets and add golden-file tests.
6. Add the action to the appropriate DAG position and to the category list.
7. Update §5 here (generated) and the traceability matrix.
8. Run `docs:lint`, `manifest:verify`, and the full gate.

Forgetting any step fails CI. That is the point.

---

## 8. Script export contract

| Rule | Detail |
| :--- | :--- |
| Ordering | Topological sort of the selected set (REQ-F-081) |
| Header | Mandatory lines: tool name + version, generation timestamp, "no snapshot exists", elevation requirement, destructive warning if any |
| Encoding | `ps1` UTF-8 **with BOM** (Windows PowerShell 5.1 misreads UTF-8 without BOM), CRLF; `bat` ASCII/CP1252-safe with CRLF |
| Forbidden in `.bat` | Non-ASCII characters, `powershell -Command` with unescaped quotes, any step whose only implementation needs a keyboard chord |
| Refusal | If any selected action lacks a snippet → export fails with a listed reason (REQ-F-083) |
| Destructive | `controlled-reboot` and `empty-recycle-bin` are refused in batch export (REQ-F-084) |

Generated `.ps1` header:

```powershell
#Requires -Version 5.1
<#
  Zenith 1.0.0 - portable maintenance script
  Generated: 2026-11-18T14:02:11Z
  Actions: flush-dns-cache, clean-temp-cache, archive-screenshots

  READ THIS FIRST
  - This script is NOT the Zenith application. Zenith is not installed on this machine.
  - There is NO snapshot and NO rollback. Anything deleted here is gone for good
    (except items moved to the Recycle Bin).
  - Run it as Administrator only if a step asks for it.
#>
```

---

## 9. Generated artifacts

| Artifact | Generated from | Checked by |
| :--- | :--- | :--- |
| `models::ActionId` + `as_str()` + metadata methods | manifest | `crates/zenith-core/tests/catalog_in_sync.rs` |
| `src/catalog.generated.ts` (ids, tiers, categories, newline-delimited rows) | `zenith_core::catalog_ts::render()` | `catalog_in_sync::generated_catalog_matches_the_manifest` (byte drift) |
| `src/i18n/en.ts` / `src/i18n/tr.ts` action keys | manifest (hand-translated text) | `scripts/check-locales.mjs` + `check-contract.mjs` |
| Docs §5, §6 tables | manifest | `scripts/check-docs.mjs` |
| Script golden files | manifest snippets | snapshot tests |
| Support-bundle action list | manifest | T-SEC-06 |

The renderer is Rust (`catalog_ts::render`) and the integration test calls the same function, so a
manifest edit that is not regenerated fails the suite rather than drifting silently. There is no
separate `src/types/` or `src/data/` tree and no `master/en.json`; the files above are the whole set.

---

## 10. Contract tests

| Test | Asserts |
| :--- | :--- |
| T-CONTRACT-01 | Manifest ids == Rust enum == TS union == docs table (22) |
| T-CONTRACT-03 | Every action's documented threshold matches its implementation constant |
| T-CONTRACT-04 | `reclaimableBytes = 0` for all non-space actions |
| T-CONTRACT-06 | Safe-preset predicate holds for all entries; destructive never batchable |
| T-CONTRACT-07 | Every action has non-empty `ps1` and `bat`; golden files match |
| T-FE-02 | Generated scripts contain the mandatory header and correct order |
