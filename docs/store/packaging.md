# Store Packaging Notes

| Field | Value |
| :--- | :--- |
| Document ID | DOC-STORE-006 |
| Version | 1.0.0 |
| Owner | Release Engineering |
| Closes | REQ-N-047 |

## Current state

Tauri 2 has no MSIX target, so the Store package is assembled by
`scripts/pack-msix.mjs` from the same release binary the NSIS installer uses:

```powershell
npm run tauri build          # produces target/release/zenith.exe
npm run msix:package         # assembles target/release/bundle/msix/Zenith_1.0.0_x64_test.msix (about 3.7 MB)
npm run check:msix           # unpacks it with makeappx and verifies the contents
```

The manifest lives in `src-tauri/msix/AppxManifest.template.xml` and is rendered
with the identity from `src-tauri/msix/identity.json`. `makeappx pack` validates
the rendered manifest against the Windows schema, so the package cannot be built
from a manifest this project invented.

`check:msix` is deliberately not a step in `npm run verify`: it measures the
release binary and the packaged tiles, which only exist after `tauri build`. A
clean CI clone has neither, so putting it in the chain would either fail there or
be skipped there - and a skipped gate is the shape this project keeps removing.
It runs after the build instead, and its output is `evidence/msix-check.log`.

**Two identities, on purpose.** The default build uses
`Vellium.Zenith.LocalTest` and writes a file whose name ends in `_test.msix`.
That package proves the layout, the tiles, and the manifest, and it is not
submittable. `--identity partner-center` reads the reserved identity and refuses
to run while any of `name`, `publisher`, or `publisherDisplayName` is null,
because a package built from a guessed identity is rejected at ingestion and
produces nothing but a false sense of progress.

The icon set is the Zenith brand set generated from `assets/zenith-mark.svg`
(`npm run icons:generate`), not the Tauri defaults. `npm run check:msix` measures
each tile from its PNG header, so a tile that is one pixel off the size the
manifest names fails the gate instead of failing certification.

## Steps to produce the submittable package

1. Reserve the product name in Partner Center and copy the three identity values
   into the `partnerCenter` block of `src-tauri/msix/identity.json`.
2. Build the release binary with a release identity:
   `$env:ZENITH_BUILD_COMMIT = "release-YYYYMMDD"; npm run tauri build`.
3. Build the package: `node scripts/pack-msix.mjs --identity partner-center`.
4. Sign it with the certificate Partner Center issues for the publisher, using
   `signtool sign /fd SHA256 /a /f <pfx> /p <password> <package>`.
5. Install the signed package on a clean Windows 10 1809 host and a Windows 11
   host, then run the Windows App Certification Kit:
   `"C:\Program Files (x86)\Windows Kits\10\App Certification Kit\appcert.exe" test -packagepath <msix> -reportoutputpath <xml>`.
   The kit needs an elevated prompt and a signed package.
6. Submit the package with the certification note below and attach the report to
   `evidence/`.

Steps 1, 4, 5, and 6 are owner actions recorded as FAIL in
`docs/11-release/11-03-store-checklist.md`. Steps 2 and 3 are implemented and
measured by `evidence/msix-check.log`.

## Certification note for reviewers

Zenith is a Windows maintenance utility. Read-only diagnosis runs unprivileged.
Actions that change the system (`sfc /scannow`, component-store repair, service
reconfiguration, temp and cache cleanup) require administrator rights, which a
packaged application cannot obtain for itself.

The package therefore declares the single restricted capability `runFullTrust`
and runs as a desktop bridge application. Elevation is requested per action
through a single-use handover ticket: the app relaunches itself elevated with a
nonce, the elevated instance performs exactly one action, writes the result, and
exits. No long-lived elevated process exists, and no action runs without an
explicit confirmation dialog that names it, states whether it is reversible, and
offers Cancel first.

Every mutating action writes a snapshot before it changes anything. Snapshots are
HMAC-signed, stored under `%LOCALAPPDATA%\Vellium\Zenith`, and restorable from the
Undo History screen. The Trash screen soft-deletes for 30 days before anything is
removed permanently.

There is no account, no sign-in, and no advertising identifier. Telemetry is off
by default and, when enabled, is written locally and never uploaded. The only
remote request the app can make is the update version check against
`https://api.github.com`; on the Store channel even that is answered locally and
the app tells the user the Store handles updates.

## What must not differ from the GitHub channel

- The Rust core, the 15 IPC commands, and the validation rules.
- The privacy policy text and the in-app legal reader.
- The action manifest and its reversibility tiers.

A Store build that changes behaviour beyond the update channel and packaging is a
different product and needs its own review.
