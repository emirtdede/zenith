# `resources/` - Pinned Offline Assets

| Field | Value |
| :--- | :--- |
| Purpose | Guarantee that the Zenith toolchain, installers and fonts can be rebuilt on a clean, air-gapped Windows machine |
| Manifest | [`manifest.json`](manifest.json) - SHA-256 for every file, plus source URL and licence |
| Requirement | REQ-N-093 ("all downloaded third-party assets are hash-pinned") |
| Verified | 2026-11-18, `Get-FileHash -Algorithm SHA256` |

---

## 1. Contents

```text
resources/
├── manifest.json                                hashes, sources, licences, verification steps
├── README.md                                    this file
├── toolchain/
│   ├── rustup-init.exe                          12.8 MB   Rust 1.90.0 bootstrapper (MSVC x64)
│   └── node-v24.22.3-win-x64.zip                37.8 MB   Node.js LTS "Krypton"
├── installers/
│   ├── MicrosoftEdgeWebView2RuntimeInstallerX64.exe   215.1 MB  offline WebView2 Evergreen
│   └── nsis-3.11.zip                             2.4 MB   exact NSIS the Tauri bundler uses
├── fonts/
│   ├── Inter-4.1.zip                            33.7 MB   UI typeface (OFL-1.1)
│   └── JetBrainsMono-2.304.zip                   5.6 MB   monospace (OFL-1.1)
├── licenses/
│   ├── THIRD-PARTY-NOTICES.txt                  277 components + 57 verbatim licence texts
│   └── manifest.json                            generated coverage manifest, pinned to the lockfiles
├── sbom/
│   └── zenith-1.0.0.cdx.json                    CycloneDX 1.5, 277 components, lockfile-hashed
└── reference/                                   (empty by design - see §4)
```

---

## 2. Why these specific files

| Asset | Why it is vendored rather than fetched at build time |
| :--- | :--- |
| `rustup-init.exe` | A new machine must be able to reach the exact MSRV without trusting "latest". |
| `node-v24.22.3-win-x64.zip` | Vite 8 and TypeScript 7 have narrow Node floors; an unexpected LTS bump breaks the build silently. |
| WebView2 offline installer | Locked-down enterprise images block `go.microsoft.com`. Without this, Zenith shows a blank window on the machines the Fleet tier is sold into. |
| `nsis-3.11.zip` | Tauri's bundler shells out to a specific NSIS; a different version changes installer bytes and defeats reproducibility (REQ-N-091). |
| Inter | The UI must not call a CDN (CSP `default-src 'self'`, REQ-N-030). |
| JetBrains Mono | Terminal/log/byte-count columns need tabular figures to stay aligned. |

---

## 3. Verification (reproduce it yourself)

```powershell
cd resources
Get-ChildItem -Recurse -File |
  Where-Object { $_.Extension -in '.exe','.zip' } |
  ForEach-Object {
    "{0,-58} {1,12:N0}  {2}" -f $_.FullName.Replace((Get-Location).Path + '\',''),
                                $_.Length,
                                (Get-FileHash $_.FullName -Algorithm SHA256).Hash
  }
```

Compare against `manifest.json → assets[].sha256`. A mismatch means a corrupt or substituted
download; **do not** build with it.

Additional validation already performed on these files (recorded in `manifest.json` as
`validated`):

| File | Check | Result |
| :--- | :--- | :--- |
| `rustup-init.exe` | First two bytes | `4D 5A` (PE `MZ`) PASS |
| WebView2 installer | First two bytes | `4D 5A` (PE `MZ`) PASS |
| `node-v24.22.3-win-x64.zip` | Open archive, count entries | 2,459 entries PASS |
| `nsis-3.11.zip` | Open archive, count entries | 441 entries PASS |
| `Inter-4.1.zip` | Open archive, count entries | 157 entries PASS |
| `JetBrainsMono-2.304.zip` | Open archive, count entries | 55 entries PASS |

> An earlier attempt to fetch NSIS from SourceForge returned an HTML error page named
> `nsis-3.11.zip` (2 KB, not a ZIP). It was detected by opening the archive, discarded, and
> replaced with the Tauri binary-release mirror. This is exactly the failure mode a hash manifest
> exists to catch - the byte count alone would not have caught it.

---

## 4. Why `reference/` is empty

The original plan reserved `reference/` for Microsoft documentation PDFs (SFC/DISM/Winsock
semantics). Those documents are **not** redistributable under Microsoft's terms, and copying them
into a repository creates a licensing problem for no engineering benefit.

Instead, every normative Microsoft behaviour Zenith depends on is cited inline in the document that
needs it, with the exact command or API named:

| Behaviour | Where it is specified | Primary source cited |
| :--- | :--- | :--- |
| `DISM /RestoreHealth` before `SFC /scannow` | `03-05` §5.11-5.12, REQ-F-070 | Microsoft Learn: *Use the System File Checker tool* |
| `netsh winsock reset` / `netsh int ip reset` ordering | `03-05` §5.7 | Microsoft Learn: *Netsh commands for Interface IP* |
| SCM state transitions (`STOP_PENDING` → `STOPPED`) | `03-06` §8 | Microsoft Learn: *QueryServiceStatusEx* |
| `MIB_TCPTABLE_OWNER_PID` layout and byte order | `03-06` §3.1 | Microsoft Learn: *GetExtendedTcpTable* |
| `CryptProtectData` machine scope | `04-01` §5.1, ADR-006 | Microsoft Learn: *CryptProtectData* |
| WDDM driver reset chord | `03-06` §5 | Microsoft Learn: *Display driver timeout detection and recovery* |

This keeps the repository free of third-party binaries it has no right to ship, while remaining
fully traceable.

---

## 5. Licences of redistributed material

| Component | Licence | Redistribution in this repo |
| :--- | :--- | :--- |
| Rust toolchain installer | MIT OR Apache-2.0 | PASS permitted |
| Node.js | MIT + bundled third-party notices | PASS permitted |
| NSIS | zlib/libpng | PASS permitted |
| Inter | SIL OFL 1.1 | PASS permitted with licence text |
| JetBrains Mono | SIL OFL 1.1 | PASS permitted with licence text |
| WebView2 Runtime | Microsoft proprietary redistributable | PASS permitted as an unmodified installer, **not** as extracted binaries |

Files are stored unmodified. No licence text has been altered. If a component's licence is found
to forbid redistribution in a future version, remove it from `resources/` and replace it with a
documented fetch step in `08-01`.

The **shipped binary's** dependency graph is a separate list from the bootstrap assets above. It is
generated, not hand-maintained: `npm run licenses:generate` walks the Windows x64 Cargo graph and the
production npm graph and writes `licenses/THIRD-PARTY-NOTICES.txt` (277 components, 57 distinct texts)
plus `licenses/manifest.json`. `npm run check:licenses` fails when a lockfile changes without
regeneration, and the Trust Center renders the text offline (REQ-F-135, `08-02` §7).

The same graph produces `sbom/zenith-1.0.0.cdx.json` (CycloneDX 1.5) via `npm run sbom:generate`:
277 components, every one carrying the hash from `Cargo.lock` or `package-lock.json`. The file is
byte-stable (no timestamp; the serial number is derived from the component list), so `check:sbom` can
refuse a stale one exactly as `check:licenses` does. It is not attached to a release yet - there is no
release host (DEF-050) - and `08-02` §10 says so explicitly.

---

## 6. Adding an asset

1. Download it.
2. Validate it (magic bytes for binaries, open-and-count for archives).
3. Compute SHA-256.
4. Add an entry to `manifest.json` with `id`, `path`, `bytes`, `sha256`, `source`, `kind`,
   `validated`, `purpose`, `licence`, `usedBy`.
5. Reference it from the document that depends on it.
6. CI fails if a file in `resources/` has no manifest entry (`T-CONTRACT-10`, now implemented as
   `scripts/check-licenses.mjs` for `licenses/`; the asset manifest check remains future work).
