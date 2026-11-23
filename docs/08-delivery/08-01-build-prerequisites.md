# 08-01 - Build Prerequisites & Reproducibility

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-DLV-001 |
| Version | 2.0.0 |
| Owner | Engineering / DevOps |
| Closes | DEF-012 (no toolchain pin, no MSRV, no lockfile discipline) |
| Applies to | Every machine that builds, signs or reproduces a Zenith release |

This document is the difference between "it built on my machine" and "it builds the same way on any
machine". It states the exact tools, what is pinned, what is *not* pinned and why, and how to prove
a build is reproducible.

---

## 1. Tool matrix

| Tool | Required version | Why this floor | Where pinned |
| :--- | :--- | :--- | :--- |
| **Rust** | MSRV **1.90**, edition 2024 | Tauri 2.12.5 requires 1.90 and edition 2024 | `Cargo.toml` → `rust-version = "1.90"` |
| **Cargo** | ships with Rust | - | same |
| **Node.js** | **24.22.3** | Vite 7 and TypeScript 5.9 have narrow Node floors | `.node-version`, `.nvmrc` |
| **npm** | 11.x (bundled with Node 24) | lockfile v3 | `package-lock.json` |
| **Windows SDK** | 10.0.22621 or newer | `windows` / `windows-sys` FFI metadata | install manually (§2) |
| **MSVC toolset** | VS 2022 Build Tools, v143 | linker for `x86_64-pc-windows-msvc` | install manually (§2) |
| **WebView2** | Evergreen runtime (any) | Tauri renderer | vendored offline installer (`resources/`) |
| **NSIS** | 3.11 | Tauri bundler shell-out; different versions change installer bytes | `resources/installers/nsis-3.11.zip` |

Target triple is fixed: **`x86_64-pc-windows-msvc`**. No 32-bit or ARM build ships in 1.0.0.

---

## 2. Fresh-machine setup

```powershell
# 1. Rust (from the vendored bootstrapper; no internet needed after resources/ is present)
.\resources\toolchain\rustup-init.exe -y --default-toolchain 1.90.0-x86_64-pc-windows-msvc `
    --component rustfmt clippy

# 2. Node.js (extract the vendored archive, add to PATH)
Expand-Archive .\resources\toolchain\node-v24.22.3-win-x64.zip -DestinationPath C:\tools\
$env:PATH = "C:\tools\node-v24.22.3-win-x64;$env:PATH"

# 3. Visual Studio Build Tools 2022 with "Desktop development with C++"
#    (Microsoft licence forbids redistribution, so this is a manual step)
winget install Microsoft.VisualStudio.2022.BuildTools `
    --override "--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

# 4. Dependencies
npm ci
cargo fetch --locked
```

### 2.1 What is *not* vendored, and why

| Item | Reason | Mitigation |
| :--- | :--- | :--- |
| Rust crates (~493 packages) | `Cargo.lock` + `--locked` gives determinism without repo bloat | REQ-N-090 |
| npm packages (~43 top-level) | `package-lock.json` + `npm ci` | REQ-N-090 |
| Windows SDK / MSVC | Microsoft licence forbids redistribution | manual install above |
| EV code-signing certificate | secret material, HSM/token only | `08-02` §5 |

---

## 3. Versions actually verified

The versions below produced the evidence in this library. They are **not** the MSRV - they are
what the authoring machine ran. Stating both is the honest position: MSRV conformance is a forward
guarantee, not a record of the compiler used.

| Tool | Minimum supported | Verified-on (this repository) | Match |
| :--- | :--- | :--- | :--- |
| `rustc` | 1.90.0 | **1.100.0** | PASS above MSRV |
| `cargo` | 1.90.0 | **1.100.0** | PASS |
| `node` | 24.22.3 | **v26.13.1** | PASS above pin |
| `npm` | 11.x | **11.20.0** | PASS |
| `typescript` | - | **5.9.3** | PASS |
| `vite` | - | **7.3.8** | PASS |
| Tauri | 2.12.5 | **2.12.5 declared → 2.12.7 locked** | PASS patch update inside the caret range; `Cargo.lock` is the measured version |
| React | 19 | **19.x** | PASS |

> **Why the pin and the verifier differ.** A hard `rust-toolchain.toml` channel pin forces every
> machine to download a second toolchain on first `cargo` call, and fails outright on an air-gapped
> host without it pre-installed. `ADR-020` records this trade-off. The release tag adds an exact
> pin; the working tree states the MSRV and proves the code builds above it.

---

## 4. Dependency graph integrity

| Artefact | Size | Role |
| :--- | ---: | :--- |
| `Cargo.lock` | 128,051 B | exact Rust resolution, 493 packages |
| `package-lock.json` | 69,370 B | exact npm resolution, lockfile v3 |

Rules:

1. `Cargo.lock` and `package-lock.json` are **committed**. A library might omit `Cargo.lock`; an
   application must not.
2. Builds use `cargo build --locked` and `npm ci`. `--locked` fails if the lockfile would change;
   `npm ci` fails if `package.json` and the lock disagree.
3. `cargo update` and `npm update` are deliberate, reviewed PRs - never an implicit side effect.
4. Dependency versions are pinned in `Cargo.toml` `[workspace.dependencies]` and exact in
   `package.json` ranges backed by the lock.

---

## 5. Reproducibility

### 5.1 What is deterministic

| Input | Mechanism |
| :--- | :--- |
| Rust dependencies | `Cargo.lock` + `--locked` |
| npm dependencies | `package-lock.json` + `npm ci` |
| Rust compiler | MSRV + release-tag pin |
| Generated catalog | `catalog_ts::render()` - byte-identical, drift-tested |
| Fonts | vendored WOFF2, no CDN, CSP blocks remote |
| Installer tooling | vendored NSIS 3.11 |

### 5.2 What is *not* deterministic, and is therefore stated

| Non-determinism | Impact | Handling |
| :--- | :--- | :--- |
| PE timestamps | binary hash differs between builds | reproducible-build flag at release |
| Authenticode timestamp | signature bytes differ | expected; signature verifies regardless |
| OS build in telemetry | data, not build | n/a |

Requesting "identical binary hash" without a reproducible-build linker flag would be a false claim.
REQ-N-091 asks for "same toolchain ⇒ identical hash"; that is achievable only with the flag, and
the flag is a release-tag step, not a working-tree default. Stated, not hidden.

---

## 6. Verification commands

```powershell
# Versions
rustc --version; cargo --version; node --version; npm --version

# The lockfiles must not change
git status --porcelain Cargo.lock package-lock.json   # empty = clean

# Locked builds
cargo build --workspace --locked
npm ci

# Generated catalog has not drifted
cargo test -p zenith-core --test catalog_in_sync

# Full gate chain
npm run verify
```

`npm run verify` = `check:locales && check:unused-keys && check:step-keys && check:contract && check:dashes && check:contrast && check:simulator && check:nonwindows && check:docs && check:fe && check:doc-counts && check:evidence-ledger && check:scorecard && check:ffi && check:licenses && check:deny && check:sbom && check:stubs && check:mutate-restore && check:verify-chain && check:rust-tests && build`.
It exits non-zero at the first broken gate. `check:dashes` forbids U+2014 and U+2013 in
first-party text, including their escape forms, because the placeholder for "not measured" is one
named constant rather than a glyph repeated per screen (DEF-118). `check:verify-chain` reads that command back - every step
must name an existing script, and `check:rust-tests` must run `cargo test --workspace` rather than list
tests - because until DEF-129 the chain contained no step that executed one. `check:mutate-restore`
proves the snapshot helper every mutation gate restores through is byte-exact (DEF-131).
`check:evidence-ledger` keeps the ledger in `evidence/README.md` honest - every artefact described,
no empty artefact, every citation resolving (DEF-132). `check:stubs` runs `zenith-audit --all` (Zero-Stub
law L1/L3 from `00-01` §3). `check:licenses` refuses a stale third-party notice file and `check:deny`
runs the vendored `cargo-deny` 0.22.0 under `tools/cargo-deny/` against `deny.toml` - vendored so the
security gate still runs on an air-gapped machine (download URL and SHA-256 are in `tools/cargo-deny/`).

---

## 7. `resources/` integrity

Six assets are hash-pinned in `resources/manifest.json`:

| Asset | Bytes | Purpose |
| :--- | ---: | :--- |
| `rustup-init.exe` | 12,839,424 | Rust 1.90 bootstrapper |
| `node-v24.22.3-win-x64.zip` | 37,762,649 | Node runtime |
| `MicrosoftEdgeWebView2RuntimeInstallerX64.exe` | 215,116,512 | offline WebView2 |
| `nsis-3.11.zip` | 2,361,546 | bundler tooling |
| `Inter-4.1.zip` | 33,707,794 | UI typeface |
| `JetBrainsMono-2.304.zip` | 5,622,857 | monospace face |

Verify:

```powershell
cd resources
Get-ChildItem -Recurse -File | Where-Object { $_.Extension -in '.exe','.zip' } |
  ForEach-Object { "{0}  {1}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash, $_.Name }
```

Any mismatch means a corrupt or substituted download; do not build with it. The `README.md` in
`resources/` records the SourceForge HTML-error incident that this manifest caught.

---

## 8. Known deviations

| Deviation | Status | Note |
| :--- | :--- | :--- |
| Verified-on compiler above MSRV | Accepted | §3; forward guarantee, not a record |
| No `rust-toolchain.toml` in working tree | Accepted | ADR-020; added at release tag |
| No CI pipeline yet | Open (**DEF-050**) | `T-CONTRACT-09` cannot pass until it exists |
| No reproducible-build linker flag in tree | Open | release-tag step |
