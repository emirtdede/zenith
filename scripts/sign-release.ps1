# Release signing (08-02 §3, DEF-028).
#
# The certificate is the one input this repository cannot contain: an EV
# code-signing certificate is issued to a legal identity after a CA's identity
# verification. This script therefore owns everything *around* the certificate:
# locating signtool, selecting the signer, applying SHA-256 + RFC 3161
# timestamping, and verifying the result. Swapping a real certificate in is a
# one-argument change, which is the point.
#
# Modes
#   -Thumbprint <hex>   sign with a cert already in a Windows certificate store
#   -Pfx <path>         sign with a .pfx file (password via -PfxPassword or
#                       the ZENITH_PFX_PASSWORD environment variable, never
#                       on the command line in CI logs)
#   -DevSelfSigned      create a throwaway self-signed code-signing cert and
#                       sign with it. This proves the pipeline and MUST NOT be
#                       mistaken for a release signature: the resulting trust
#                       chain is this machine only.
#
# -SrcDir/-OutDir exist so a rehearsal signs COPIES and cannot silently replace
# the hashed artefacts recorded in 08-02 §3.
param(
    [string]$Thumbprint,
    [string]$Pfx,
    [string]$PfxPassword,
    [switch]$DevSelfSigned,
    [string]$TimestampUrl = "http://timestamp.digicert.com",
    [string]$SrcDir = "target\release",
    [string]$OutDir = "target\sign-rehearsal",
    [string[]]$Files = @("zenith.exe", "bundle\nsis\Zenith_1.0.0_x64-setup.exe")
)

$ErrorActionPreference = "Stop"

function Resolve-SignTool {
    $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $kits = "C:\Program Files (x86)\Windows Kits\10\bin"
    if (-not (Test-Path $kits)) {
        throw "signtool.exe not found and no Windows SDK bin directory at $kits"
    }
    $found = Get-ChildItem $kits -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\' } |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    if (-not $found) { throw "signtool.exe not found under $kits" }
    return $found.FullName
}

$signtool = Resolve-SignTool
"signtool: $signtool"

$signArgs = @()
$mode = $null

if ($DevSelfSigned) {
    $mode = "dev-self-signed"
    $cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert -ErrorAction SilentlyContinue |
        Where-Object { $_.Subject -eq "CN=Zenith Dev Signing (DO NOT TRUST)" } |
        Sort-Object NotAfter -Descending |
        Select-Object -First 1
    if (-not $cert) {
        $cert = New-SelfSignedCertificate `
            -Type CodeSigningCert `
            -Subject "CN=Zenith Dev Signing (DO NOT TRUST)" `
            -KeyUsage DigitalSignature `
            -KeyAlgorithm RSA `
            -KeyLength 3072 `
            -HashAlgorithm SHA256 `
            -CertStoreLocation "Cert:\CurrentUser\My" `
            -NotAfter (Get-Date).AddYears(1)
        "created dev cert: $($cert.Thumbprint)"
    } else {
        "reusing dev cert: $($cert.Thumbprint)"
    }
    $signArgs += @("/sha1", $cert.Thumbprint)
} elseif ($Pfx) {
    $mode = "pfx"
    if (-not $PfxPassword) { $PfxPassword = $env:ZENITH_PFX_PASSWORD }
    if (-not $PfxPassword) { throw "-Pfx requires -PfxPassword or ZENITH_PFX_PASSWORD" }
    if (-not (Test-Path -LiteralPath $Pfx)) { throw "pfx not found: $Pfx" }
    $signArgs += @("/f", (Resolve-Path -LiteralPath $Pfx).Path, "/p", $PfxPassword)
} elseif ($Thumbprint) {
    $mode = "store"
    $cert = Get-ChildItem Cert:\CurrentUser\My, Cert:\LocalMachine\My -ErrorAction SilentlyContinue |
        Where-Object { $_.Thumbprint -eq $Thumbprint }
    if (-not $cert) { throw "no certificate with thumbprint $Thumbprint in CurrentUser\My or LocalMachine\My" }
    if (-not $cert.HasPrivateKey) { throw "certificate $Thumbprint has no private key on this machine" }
    $signArgs += @("/sha1", $Thumbprint)
} else {
    throw "Refusing to run without a signer. Pass -Thumbprint, -Pfx or -DevSelfSigned."
}

# A release signature must be SHA-256 and RFC 3161 timestamped; without a
# timestamp the signature dies when the certificate expires.
$signArgs += @("/fd", "SHA256", "/tr", $TimestampUrl, "/td", "SHA256", "/v")

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$results = @()
foreach ($rel in $Files) {
    $src = Join-Path $SrcDir $rel
    if (-not (Test-Path -LiteralPath $src)) { throw "missing artefact: $src" }
    $dest = Join-Path $OutDir $rel
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    Copy-Item -LiteralPath $src -Destination $dest -Force

    "signing $dest"
    & $signtool sign @signArgs $dest
    if ($LASTEXITCODE -ne 0) { throw "signtool sign failed for $dest (exit $LASTEXITCODE)" }

    $sig = Get-AuthenticodeSignature -LiteralPath $dest
    $results += [pscustomobject]@{
        File = $rel
        Status = $sig.Status
        StatusMessage = $sig.StatusMessage
        Signer = $sig.SignerCertificate.Subject
        Thumbprint = $sig.SignerCertificate.Thumbprint
        TimeStamper = $sig.TimeStamperCertificate.Subject
        Bytes = (Get-Item -LiteralPath $dest).Length
        Sha256 = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash
    }
}

""
"mode: $mode"
"timestamp url: $TimestampUrl"
""
$results | Format-List | Out-String

$bad = @($results | Where-Object { $_.Status -ne "Valid" })
if ($bad.Count -gt 0) {
    "NOT VALID on $(($bad | ForEach-Object { $_.File }) -join ', '): "
    foreach ($b in $bad) { "  $($b.File): $($b.Status) - $($b.StatusMessage)" }
    if ($mode -eq "dev-self-signed") {
        "A self-signed root is untrusted by design. Trusting it locally would turn"
        "this into a fake pass, so it is not done here. DEF-028 needs a CA-issued EV cert."
    }
    exit 1
}

"All signed artefacts verify as Valid."
exit 0
