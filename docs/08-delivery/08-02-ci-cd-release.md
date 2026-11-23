# 08-02 - CI/CD, Release & Distribution

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-DLV-002 |
| Version | 2.0.0 |
| Owner | DevOps / Security |
| Closes | DEF-029 (no release pipeline, no signing story, no rollback channel); DEF-063 (uninstall cycle now measured). DEF-028 (signing) stays open - no EV certificate exists on this machine |
| Applies to | Every artefact shipped as Zenith 1.0.0 |

This document specifies how a commit becomes an installer, what is verified at each stage, and - the
part release documents usually omit - which of those stages **exist today** and which are specified
but not yet built.

The rule from `00-01` applies to this document itself: a claim without an artefact is a defect. So
each row carries a status that reflects the repository, not the aspiration.

---

## 1. Pipeline stages

| # | Stage | Command / action | Status today |
| :--- | :--- | :--- | :--- |
| 1 | Fetch | `npm ci`, `cargo fetch --locked` | PASS specified; run manually |
| 2 | Lint | `cargo fmt --all --check` | PASS passes |
| 3 | Lint | `cargo clippy --workspace --all-targets -- -D warnings` | PASS passes |
| 4 | Types | `npx tsc --noEmit` | PASS passes |
| 5 | Tests | `cargo test --workspace` | PASS 255 pass |
| 6 | Tests (FE) | `vitest run` | PASS 110 pass |
| 7 | Contract & policy | `node scripts/*.mjs` × 14 | PASS pass (incl. `check:licenses`, `check:deny`, `check:sbom`, `check:unused-keys`, `check:step-keys`) |
| 8 | Zero-Stub | `zenith-audit --all` | PASS clean |
| 9 | Build | `npx vite build` | PASS 694 kB JS |
| 10 | Bundle | `npm run tauri build` | PASS 3.14 MiB NSIS |
| 11 | Sign | Authenticode (EV) | FAIL **not configured** (DEF-028) |
| 12 | SBOM | `node scripts/generate-sbom.mjs` | PASS generated - 277 components, all lockfile-hashed |
| 13 | Publish | GitHub release + updater manifest | FAIL **no repo/updater** (DEF-050) |

Stages 1-10 are the `npm run verify` chain plus the Tauri bundler. Stage 9 in that table is the
`build` script inside `verify`, so the same chain produces the installer.

> **Why stages 11 and 13 are marked FAIL.** `src-tauri/tauri.conf.json` declares no `bundle.windows.signCommand`
> and no `publish` block. Adding them without a certificate and a release host
> would be configuration with no consumer - a live L3 violation. They are specified here, tracked as
> DEF-028/DEF-050 in `10-02`, and deliberately absent from the tree until the key material
> exists. An unsigned installer that is *honest about being unsigned* is safer than a config that
> pretends to sign. The SBOM (stage 12) needed no such material, so it is generated today.

---

## 2. Build matrix

| Dimension | 1.0.0 |
| :--- | :--- |
| Target triple | `x86_64-pc-windows-msvc` only |
| Installer | NSIS (`installMode: perMachine`) |
| Languages | `English`, `Turkish` (declared in `tauri.conf.json`) |
| Architectures | x64. ARM64 is REQ-N-072 but not built in 1.0.0 (DEF-058) |
| Portable zip | not shipped |

`perMachine` is a security decision, not a packaging preference: it installs under
`C:\Program Files\Zenith` with an ACL that a standard user cannot write, which is what makes the
supply-chain argument in `04-01` §4 hold. A per-user install would let the user replace `zenith.exe`.

---

## 3. Release evidence (measured)

Produced by `npm run tauri build` on 2026-11-24 with `ZENITH_BUILD_COMMIT=release-20261123`
(the UTC day the binary was linked). The build identity is now resolved by
`src-tauri/build.rs` (DEF-075), so a rebuild changes these bytes - re-hash after every build rather
than quoting this table:

| Artefact | Bytes | SHA-256 |
| :--- | ---: | :--- |
| `target/release/zenith.exe` | 6,629,888 | `ede6c34574232407bcffce94c70e83fc018a7b903ed08c437fc810507b8e3f67` |
| `target/release/bundle/nsis/Zenith_1.0.0_x64-setup.exe` | 3,294,723 | `c908ac4c8e02c0ceb9d3d5f6cf816e32ed551e4ad20f06c07331eacb498a37c2` |

| Check | Result |
| :--- | :--- |
| Binary size vs REQ-N-010 (≤ 9 MB) | PASS 6.32 MiB (`6,629,888` B) |
| Installer size vs REQ-N-007 (≤ 18 MB) | PASS 3.14 MiB (`3,294,723` B) |
| Build identity shown in Trust Center | PASS `release-20261123` - the UTC day the binary was built, matched to its own mtime by `check-build-identity.mjs` (DEF-075, DEF-092, DEF-109, DEF-113) |
| Signing status | WARN **unsigned** - `Get-AuthenticodeSignature` returns `NotSigned`; `app_info_get` reports `signature.status = "unknown"`, never "valid". Pipeline built and rehearsed in §3.2; only the EV certificate is missing (DEF-028) |
| `ZENITH_BUILD_COMMIT` | `dev` unless set at build time (honest default, not a fake hash) |

The Trust Center shows the signature field as *"Not verified here"* for an unsigned build
(`trust.signature.unknown`). That is the correct behaviour: a running process cannot verify its own
Authenticode chain, so it reports what it knows. Inventing `valid` would be a false security claim.

### 3.1 Signing pipeline (built; certificate pending - DEF-028)

`scripts/sign-release.ps1` owns everything around the certificate: signtool discovery (SDK 10.0.26100
x64 present on this machine), signer selection from a store thumbprint or a `.pfx`, `SHA256` digest
plus an RFC 3161 timestamp (`/tr … /td SHA256`), and a `Get-AuthenticodeSignature` verdict per file.
A signature without a timestamp dies when the certificate expires, so the timestamp is not optional
here. The password for `-Pfx` comes from `-PfxPassword` or `ZENITH_PFX_PASSWORD`, never a literal in
the invocation.

`-SrcDir`/`-OutDir` exist so a rehearsal signs **copies**; the hashed artefacts in §3 are never
silently replaced by a test signature.

### 3.2 Rehearsal transcript (2026-11-20, self-signed dev cert)

Executed to prove the pipeline end to end, with a certificate that is deliberately *not* a release
certificate:

```
$ powershell -File scripts\sign-release.ps1 -DevSelfSigned -OutDir $env:TEMP\zenith-sign-rehearsal3
signtool: C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe
reusing dev cert: FF5632A9F165856468FDAEB7F925112CC3090A31
Successfully signed: …\zenith-sign-rehearsal3\zenith.exe
Successfully signed: …\zenith-sign-rehearsal3\bundle\nsis\Zenith_1.0.0_x64-setup.exe

File          : zenith.exe
Status        : UnknownError
StatusMessage : A certificate chain processed correctly, but terminated in a root
                certificate which is not trusted by the trust provider.
Signer        : CN=Zenith Dev Signing (DO NOT TRUST)
Thumbprint    : FF5632A9F165856468FDAEB7F925112CC3090A31
TimeStamper   : CN=DigiCert SHA256 RSA4096 Timestamp Responder 2026 1, O="DigiCert, Inc.", C=US
Bytes         : 6151344     (was 6143488 - 7,856 B of signature + timestamp)
Sha256        : E7F5506C35462100F2501AFC73E6DDAA50237B7A75A0B440C79DB211072E6FA7

File          : bundle\nsis\Zenith_1.0.0_x64-setup.exe
Status        : UnknownError
StatusMessage : (same - chain processed correctly, untrusted self-signed root)
TimeStamper   : CN=DigiCert SHA256 RSA4096 Timestamp Responder 2026 1, O="DigiCert, Inc.", C=US
Bytes         : 2908304     (was 2900451 - 7,853 B)
Sha256        : 9F85B9E36793B83C4F9D40C44C100CBDFCF94B0DAAC9718D2F394B5459462B4F

NOT VALID on zenith.exe, bundle\nsis\Zenith_1.0.0_x64-setup.exe
```

What this proves and what it does not:

| Proven | Not proven |
| :--- | :--- |
| signtool signs both artefacts, including the NSIS wrapper | that a **CA-issued** chain terminates in a trusted root |
| SHA-256 digest + DigiCert RFC 3161 timestamp are applied and embedded | SmartScreen reputation, which needs an EV cert and reputation history |
| the PKCS#7 blob is well-formed - the chain *processed correctly* | that the shipped 1.0.0 artefact is signed (it is not) |

The script refuses to pass on this result and exits **1**. Trusting the throwaway root locally would
turn `UnknownError` into `Valid` and manufacture a green tick out of nothing, so it is deliberately not
done. **DEF-028 therefore stays open**: the missing input is a certificate issued to a verified legal
identity, which cannot be generated on this machine.

---

## 4. Quality gates (branch protection, when a repo exists)

| Gate | Required | Enforced by |
| :--- | :--- | :--- |
| G1-G6 (`00-01` §6) | merge blocked | `10-01`, `10-02`, `02-03` |
| `npm run verify` | merge blocked | CI job |
| `cargo test --workspace` | merge blocked | CI job |
| `cargo clippy -- -D warnings` | merge blocked | CI job |
| `zenith-audit --all` | merge blocked | CI job |
| Generated-file drift | merge blocked | `catalog_in_sync` test |

No CI pipeline file exists yet (**DEF-050**). The gate definitions are the contract the pipeline must
implement; they are run manually today and are green.

---

## 5. Signing and SmartScreen

| Property | Value |
| :--- | :--- |
| Certificate | EV code-signing, HSM/token-held |
| Timestamp | RFC 3161, required |
| Unsigned build | packaging fails (REQ-N-028) - *once signing is configured* |
| SmartScreen | EV + Microsoft submission + no packing + documented behaviour |

**Current state.** Packaging does **not** fail on unsigned, because no signing step is configured. That
is DEF-028. The mitigation until it is closed: the installer is built only from a clean tree, its hash
is recorded above, and `04-01` §5 treats "unsigned distribution" as a live residual risk (SEC-03).

---

## 6. Updater and rollout

| Property | 1.0.0 |
| :--- | :--- |
| Auto-update | **Not in 1.0.0.** No `plugins.updater` in `tauri.conf.json` |
| Manual update | user downloads a new installer |
| Rollback channel | supersede by shipping a higher version; no downgrade path |
| Network egress | zero at runtime (`04-02` §2) |

This is a deliberate scope reduction, not an oversight. ADR-016 says no cloud backend in v1, and an
updater is a network touchpoint with its own attack surface (`04-01` B1). Shipping the updater
*unsigned and unmonitored* would be worse than shipping without one. REQ-N-029 (signed manifests,
downgrade refusal) therefore remains a **specified requirement for the first updater build**, tracked
as DEF-050, and `01-01` KPI-11 is a post-signing metric.

> **The honest consequence.** Users must re-download to update. That is a UX cost paid to keep the
> "nothing leaves this PC" promise literally true in 1.0.0.

---

## 7. Third-party notices (REQ-F-135)

Offline, in-app licence visibility is required. It is now generated and rendered, and the
`check:licenses` gate refuses a stale file.

```text
$ node scripts/generate-licenses.mjs
Wrote resources/licenses/THIRD-PARTY-NOTICES.txt (335,560 B) and
resources/licenses/manifest.json: 277 components, 57 licence texts.

$ node scripts/check-licenses.mjs
Third-party notices hold: 277 components (273 cargo, 4 npm), 57 licence texts, 10 SPDX ids, f86aea34b003…
```

| Item | Status |
| :--- | :--- |
| Notices generator | PASS `scripts/generate-licenses.mjs` reads the Windows x64 Cargo graph and the production npm graph |
| `resources/licenses/` populated | PASS `THIRD-PARTY-NOTICES.txt` (335,560 B) + `manifest.json` (machine-checked coverage) |
| Trust Center view | PASS `TrustScreen.tsx` renders the file offline via Vite `?raw`; no filesystem capability needed |
| Freshness | PASS `manifest.sources` pins `Cargo.lock` / `package-lock.json`; `check:licenses` fails when they move |
| Coverage | PASS 273 crates + 4 npm packages; every declared SPDX id has at least one verbatim text |
| REQ-F-135 satisfied | PASS **yes** - DEF-056 closed 2026-11-20 |

The texts are copied from the packages as shipped (deduped by body, with per-component copyright
lines preserved). No licence text was transcribed by hand: when a crate ships no file, the manifest
records that and the appendix labels the canonical text with the crate it came from.

---

## 8. Rollout plan

| Phase | Cohort | Gate to advance |
| :--- | :--- | :--- |
| 0 | Authoring machine | `npm run verify` green, installer built |
| 1 | Internal (≤ 5 machines) | 7 days, zero P1 |
| 2 | Closed beta (≤ 50) | 30 days, crash-free ≥ 99.5% (REQ-N-011) |
| 3 | Public 1.0.0 | G1-G6 hold, signed installer, VMs pass |

Phase 3 is gated on DEF-028 (signing) and DEF-050 (pipeline). Until both close, 1.0.0 cannot be
published as a public release; it can be built and tested.

### 8.1 Install → uninstall cycle (measured 2026-11-20)

Run on the authoring machine against the installer built on 2026-11-20 (2,900,451 B). That is the
**previous** build of the same source: the only change since is the build-identity string that
DEF-075 added to `src-tauri/build.rs`, which alters the Trust Center's `Derleme` field and the
installer's byte count, not the install/uninstall contract (§8.2 lists the surfaces it asserts, and
none of them involve the build stamp). The transcript is therefore evidence about *the uninstaller*,
not about the current bytes - stated plainly rather than papered over by pasting the new hash into a
transcript that was never produced with it. **Before a public release, re-run the two
`-Mode capture`/`-Mode verify` invocations below against the installer in §3**; DEF-050 (CI) exists so
that this stop becomes automatic rather than a thing someone remembers.
The harness is `scripts/verify-uninstall.ps1`; it captures the six filesystem surfaces
and the ARP (Add/Remove Programs) entry, then asserts the post-uninstall contract from `04-02` §6.2:
the uninstaller owns the binary, shortcuts and registry entry; the **checkbox on its confirm page**
offers data deletion (DEF-064), and a **silent** uninstall never deletes data.

```
$ powershell -File scripts\verify-uninstall.ps1 -Mode capture -Path $env:TEMP\zenith-pre-install4.json
  InstallDir    exists=False files=0
  StartMenu     exists=False files=0
  PublicDesktop exists=False files=0
  UserDesktop   exists=False files=0
  ProgramData   exists=True  files=16       # state.db + WAL, hmac key, logs, snapshots
  LocalAppData  exists=True  files=3        # prefs.json + two support-bundle zips
  uninstall keys: 0

$ Start-Process Zenith_1.0.0_x64-setup.exe -ArgumentList '/S' -Verb RunAs -Wait
$ $p.ExitCode
0
$ Get-ChildItem 'C:\Program Files\Zenith'
uninstall.exe    80092
zenith.exe     6143488
  ARP: DisplayName=Zenith  DisplayVersion=1.0.0  Publisher=vellium
       InstallLocation="C:\Program Files\Zenith"
       UninstallString="C:\Program Files\Zenith\uninstall.exe"
       EstimatedSize=6077 (KiB)

$ Start-Process 'C:\Program Files\Zenith\uninstall.exe' -ArgumentList '/S' -Verb RunAs -Wait
$ $p.ExitCode
0

$ powershell -File scripts\verify-uninstall.ps1 -Mode verify -Path $env:TEMP\zenith-pre-install4.json
  PASS  InstallDir    removed
  PASS  StartMenu     removed
  PASS  PublicDesktop removed
  PASS  UserDesktop   removed
  PASS  ProgramData   byte-identical (16 file(s) preserved by policy)
  PASS  LocalAppData  byte-identical (3 file(s) preserved by policy)
  PASS  ARP           no Zenith uninstall key remains
checks: 7, failures: 0

$ powershell -File scripts\verify-uninstall.ps1 -Mode diff -Path $env:TEMP\zenith-pre-install4.json
  InstallDir    exists False -> False; +0 -0 ~0
  StartMenu     exists False -> False; +0 -0 ~0
  PublicDesktop exists False -> False; +0 -0 ~0
  UserDesktop   exists False -> False; +0 -0 ~0
  ProgramData   exists True  -> True;  +0 -0 ~0
  LocalAppData  exists True  -> True;  +0 -0 ~0
  uninstall keys 0 -> 0
```

`/S` is the case measured here, and it is the case that has to stay inert: the confirm page is
skipped in passive mode, so `$DeleteAppDataCheckboxState` is never set and the DEF-064 hook does not
run. That is why the data directories come back byte-identical. The *interactive* checked path is
bound by `uninstall_hook_targets_the_real_data_roots` (`src-tauri/src/lib.rs`), which asserts the hook
deletes `%ProgramData%\Vellium\Zenith` and `%LOCALAPPDATA%\Vellium\Zenith` and refuses the bundle-id
path - a source-level guard rather than a clicked screenshot, stated as such rather than implied.

The last block is the part that matters for P8 (*uninstall leaves no orphaned state*): after the cycle
the machine is **indistinguishable from its pre-install state**, with the two documented data
directories unchanged because they are the user's data, not the product's litter.

One artefact fact worth writing down rather than hiding: the installed `zenith.exe` is **not**
byte-identical to `target/release/zenith.exe`. In the 2026-11-21 cycle the two differed in exactly
3 bytes at offsets 4,726,311-4,726,313, and they were Tauri's bundle-type marker - the bare binary keeps
the `UNK` (unknown bundle) placeholder while the NSIS payload is rewritten to `NSS`. Both files were
`6,145,024` B: same size, same code, one different marker (`…TYPE_VAR_UNKtext/css` →
`…TYPE_VAR_NSStext/css`). That offset belongs to that build and no longer describes the tree.

In the current build the same pair sits at the end of the marker block: `TYPE_VAR_NSS` at offset
4,735,987 and `TYPE_VAR_UNK` at 4,736,014, both inside `…__TAURI_BUNDLE_TYPE_VAR_NSS__TAURI_BUNDLE…`
in the bare binary. The three-byte difference is a property of Tauri's bundler, not of this project's
code, so the *fact* is stable while the *offset* moves with every build.

What cannot be re-measured here: the installed-vs-bare byte delta of the **current** artefact. Comparing
them needs an elevated `perMachine` install, and this session runs at medium integrity
(`S-1-16-8192`), so the §8.1 cycle above is the last measured one and its numbers are labelled as such
rather than pasted forward. Recording the release hash is correct for `target/release`, and the installed
copy is legitimately a distinct build of the same source.

TEMP hygiene was measured too, because "no orphaned state" should not stop at the six surfaces. The
machine holds 118 `ns<hex>.tmp` directories left by NSIS tooling across earlier builds; the newest
predates the cycle (18:17 vs the 21:20 uninstall) and the cycle created **none**. They are build-host
staging directories, not paths the product owns, and §8.1 does not claim they are the product's.

**Still open:** the installer is unsigned (DEF-028), so this proves behaviour, not provenance.

---

## 9. Verification commands

```powershell
# Full gate chain (stages 2-9)
npm run verify

# Release gates that need the built artefact, so they run *after* the build
npm run check:build-identity          # embedded release-YYYYMMDD == binary mtime, no stale source (DEF-092)
npm run check:build-identity-mutation # proves the gate above bites on all three claims

# Installer build + artefact hashes
npm run tauri build
Get-FileHash target\release\bundle\nsis\Zenith_1.0.0_x64-setup.exe -Algorithm SHA256

# Signature state (unsigned today => no signer)
Get-AuthenticodeSignature target\release\zenith.exe | Select-Object Status, SignerCertificate

# Signing, once an EV certificate exists (§3.1). Signs the real artefacts, not copies.
scripts\sign-release.ps1 -Thumbprint <EV_THUMBPRINT> -SrcDir target\release -OutDir target\release
# or, from a .pfx held in CI:
$env:ZENITH_PFX_PASSWORD = '<from the secret store>'
scripts\sign-release.ps1 -Pfx C:\certs\zenith-ev.pfx -SrcDir target\release -OutDir target\release
```

> Signing in place (`-OutDir` = `-SrcDir`) rewrites the artefacts, so §3's hashes must be re-measured
> afterwards. A rehearsal leaves `target\sign-rehearsal\` and touches nothing in §3.

Expected today: `Status = NotSigned`. That is the documented state of 1.0.0, not a build failure.

---

## 10. What this document refuses to claim

- It does not claim the installer is signed.
- It does not claim an updater exists.
- It does not claim the SBOM is *attached* to a GitHub release - there is no release host yet
  (DEF-050). It claims the SBOM is generated from the lockfiles, current, and gate-checked.
- It does not claim CI enforces the gates.

Each is a named deficiency with a closure path. A release document that overstates readiness is how
unsigned binaries reach users while everyone believes they are signed.
