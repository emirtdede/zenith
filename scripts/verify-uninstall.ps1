# Uninstall verification harness (08-02 §8, REQ-F-134, P8, 04-02 §6.2).
#
# Captures the machine surface the product may touch so an install/uninstall
# cycle can be diffed instead of eyeballed. Modes:
#
#   capture  - write a JSON baseline of the current machine state.
#   diff     - compare a baseline with the live machine (report only; exit 2
#              when any file was removed, which is suspicious for a baseline
#              taken after install).
#   verify   - assert the post-uninstall contract exactly:
#                * install dir, Start Menu shortcut, Public Desktop shortcut,
#                  user Desktop shortcut and the ARP entry are gone;
#                * every uninstall key we can see is not a Zenith key;
#                * the data store (ProgramData + LocalAppData) is byte-identical
#                  to the post-install baseline, because 04-02 §6.2 says the
#                  NSIS uninstaller removes the binary and the in-app purge owns
#                  the data. Deleting it here would be a policy violation.
#
# Read-only: it never writes to the locations it inspects.
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("capture", "diff", "verify")]
    [string]$Mode,
    [Parameter(Mandatory = $true)]
    [string]$Path
)

$ErrorActionPreference = "Stop"

$surfaces = [ordered]@{
    InstallDir    = "C:\Program Files\Zenith"
    StartMenu     = "C:\ProgramData\Microsoft\Windows\Start Menu\Programs\Zenith.lnk"
    PublicDesktop = "C:\Users\Public\Desktop\Zenith.lnk"
    UserDesktop   = Join-Path $env:USERPROFILE "Desktop\Zenith.lnk"
    ProgramData   = "C:\ProgramData\Vellium\Zenith"
    LocalAppData  = Join-Path $env:LOCALAPPDATA "Vellium\Zenith"
}

# Surfaces the uninstaller must clean up, and surfaces it must preserve.
$removed_by_uninstall = @("InstallDir", "StartMenu", "PublicDesktop", "UserDesktop")
$preserved_by_uninstall = @("ProgramData", "LocalAppData")

function Get-Tree([string]$root) {
    if (-not (Test-Path -LiteralPath $root)) { return @() }
    $item = Get-Item -LiteralPath $root -Force
    if (-not $item.PSIsContainer) {
        return @([pscustomobject]@{
            Path = $root
            Bytes = $item.Length
            Sha256 = (Get-FileHash -LiteralPath $root -Algorithm SHA256).Hash
        })
    }
    return @(Get-ChildItem -LiteralPath $root -Recurse -Force -File -ErrorAction SilentlyContinue |
        ForEach-Object {
            [pscustomobject]@{
                Path = $_.FullName
                Bytes = $_.Length
                Sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
            }
        })
}

function Get-UninstallKeys {
    $out = @()
    foreach ($hive in @("HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
                        "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall")) {
        Get-ChildItem -LiteralPath $hive -ErrorAction SilentlyContinue | ForEach-Object {
            $props = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
            if ($props.DisplayName -match "Zenith") {
                $out += [pscustomobject]@{
                    Key = $_.PSPath
                    DisplayName = $props.DisplayName
                    DisplayVersion = $props.DisplayVersion
                    InstallLocation = $props.InstallLocation
                    UninstallString = $props.UninstallString
                }
            }
        }
    }
    return $out
}

function Get-State {
    $state = [ordered]@{
        CapturedAtUtc = (Get-Date).ToUniversalTime().ToString("o")
        Elevated = ([Security.Principal.WindowsPrincipal] `
            [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
                [Security.Principal.WindowsBuiltInRole]::Administrator)
        Surfaces = [ordered]@{}
        UninstallKeys = @(Get-UninstallKeys)
    }
    foreach ($name in $surfaces.Keys) {
        $target = $surfaces[$name]
        $state.Surfaces[$name] = [ordered]@{
            Path = $target
            Exists = (Test-Path -LiteralPath $target)
            Files = @(Get-Tree $target)
        }
    }
    return $state
}

function Get-FileMap($surface) {
    $map = @{}
    foreach ($f in $surface.Files) { $map[$f.Path] = $f.Sha256 }
    return $map
}

function Format-Changes($before, $after) {
    $beforeSet = Get-FileMap $before
    $afterSet = Get-FileMap $after
    $added = @($afterSet.Keys | Where-Object { -not $beforeSet.ContainsKey($_) })
    $removed = @($beforeSet.Keys | Where-Object { -not $afterSet.ContainsKey($_) })
    $changed = @($afterSet.Keys | Where-Object {
        $beforeSet.ContainsKey($_) -and $beforeSet[$_] -ne $afterSet[$_]
    })
    foreach ($f in $added) { "      + $f" }
    foreach ($f in $removed) { "      - $f" }
    foreach ($f in $changed) { "      ~ $f" }
    return @{ Added = $added; Removed = $removed; Changed = $changed }
}

$state = Get-State

if ($Mode -eq "capture") {
    $json = $state | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($Path, $json, [Text.UTF8Encoding]::new($false))
    "captured -> $Path"
    foreach ($name in $surfaces.Keys) {
        $s = $state.Surfaces[$name]
        "  {0,-13} exists={1} files={2}" -f $name, $s.Exists, $s.Files.Count
    }
    "  uninstall keys: {0}" -f $state.UninstallKeys.Count
    exit 0
}

$before = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json

if ($Mode -eq "diff") {
    $exit = 0
    foreach ($name in $surfaces.Keys) {
        $b = $before.Surfaces.$name
        $a = $state.Surfaces[$name]
        $d = Format-Changes $b $a
        "  {0,-13} exists {1} -> {2}; +{3} -{4} ~{5}" -f `
            $name, $b.Exists, $a.Exists, $d.Added.Count, $d.Removed.Count, $d.Changed.Count
        if ($d.Removed.Count -gt 0) { $exit = 2 }
    }
    "  uninstall keys {0} -> {1}" -f $before.UninstallKeys.Count, $state.UninstallKeys.Count
    exit $exit
}

# ---- verify ---------------------------------------------------------------
$failures = @()
$checks = 0

foreach ($name in $removed_by_uninstall) {
    $checks += 1
    $a = $state.Surfaces[$name]
    if ($a.Exists) {
        $failures += "$name still exists at $($a.Path) ($($a.Files.Count) file(s))"
    } else {
        "  PASS  {0,-13} removed" -f $name
    }
}

foreach ($name in $preserved_by_uninstall) {
    $checks += 1
    $b = $before.Surfaces.$name
    $a = $state.Surfaces[$name]
    $d = Format-Changes $b $a
    if ($d.Added.Count -ne 0 -or $d.Removed.Count -ne 0 -or $d.Changed.Count -ne 0) {
        $failures += "$name changed: +$($d.Added.Count) -$($d.Removed.Count) ~$($d.Changed.Count)"
    } elseif ($a.Files.Count -eq 0) {
        $failures += "$name is empty; the baseline had $($b.Files.Count) file(s) and 04-02 §6.2 says uninstall must not touch data"
    } else {
        "  PASS  {0,-13} byte-identical ({1} file(s) preserved by policy)" -f $name, $a.Files.Count
    }
}

$checks += 1
if ($state.UninstallKeys.Count -ne 0) {
    $failures += "ARP entry survived: $($state.UninstallKeys.Key -join ', ')"
} else {
    "  PASS  ARP        no Zenith uninstall key remains"
}

"checks: $checks, failures: $($failures.Count)"
foreach ($f in $failures) { "  FAIL  $f" }
exit ($(if ($failures.Count -eq 0) { 0 } else { 1 }))
