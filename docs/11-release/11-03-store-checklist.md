# Microsoft Store Release Checklist

| Field | Value |
| :--- | :--- |
| Document ID | DOC-11-03 |
| Version | 1.0.0 |
| Owner | Release Engineering |
| Closes | REQ-N-047 |
| Channel | Microsoft Store (MSIX/APPX, Partner Center) |
| Tree under review | `1.0.0`, release commit `feaa12f` on `main` |
| Reviewed on | 2026-11-24 |

The Store channel is not a repackaging of the GitHub channel. A Store package is
MSIX, it is installed per user by the Store service, it cannot carry an NSIS
hook, it cannot write to `Program Files` from its own installer, and it is signed
by Microsoft rather than by Vellium's EV certificate. Every row below is decided
by a file on this machine, a command in this tree, or a Partner Center setting.
A row is `PASS` only when the artifact exists in the reviewed tree; a capability
that is described but not built is `FAIL`, and the reason names the owner action.

Nine rows are `FAIL` today, and they share two causes: **the Store identity is not
reserved** and **nothing has been submitted**. The package itself exists - it is
built by `scripts/pack-msix.mjs` and re-opened by `npm run check:msix` - but a
package assembled with a local test identity is not a Store submission, and this
document says so rather than counting the file as progress.

## 1. Packaging

| ID | Requirement | Verification | Evidence | Result |
| :--- | :--- | :--- | :--- | :--- |
| M-01 | The build generates an MSIX or APPX package | `npm run msix:package`; `npm run check:msix` | `evidence/msix-check.log` | PASS - `pack-msix.mjs` assembles a 3.7 MB MSIX from the release binary and `makeappx unpack` re-opens it; 38 content checks, six tiles measured from their PNG headers |
| M-02 | The MSIX declares the Store identity (name, publisher, publisher display name) | `Get-Content src-tauri/msix/identity.json`; `node scripts/pack-msix.mjs --identity partner-center` | `src-tauri/msix/identity.json` | FAIL - the `partnerCenter` block is null and the script refuses to build from a guessed identity. Owner action: reserve the name in Partner Center and paste the three values. |
| M-03 | The package is signed by Microsoft for Store ingestion | Partner Center | `_test.msix` is unsigned and local | FAIL - signing happens after submission. Owner action: submit the signed package (M-02, M-38). |
| M-04 | The NSIS-only hooks are excluded from the Store package | `src-tauri/installer/hooks.nsh` | file exists and is NSIS-scoped | PASS - the hook is an NSIS include and is not part of an MSIX build. |
| M-05 | The Store package writes only to per-user locations | `src-tauri/installer/hooks.nsh`; `crates/zenith-core/src/config.rs` | `%LOCALAPPDATA%\Vellium\Zenith`, `%APPDATA%\Vellium\Zenith` | PASS - both are per-user; an MSIX install adds no machine-wide path. |
| M-06 | No process launches another executable outside the package without a capability declaration | `npm run check:contract`; `src-tauri/capabilities/default.json` | `evidence/verify-final.log` | PASS - the core runs system tools with an explicit manifest entry per action, and the window capability set is enumerated. |
| M-07 | Elevation does not assume a machine-wide install directory | `src-tauri/src/handover.rs` | relaunch uses the current executable path | PASS |
| M-08 | The package runs after a per-user install with no elevation | manual run from `target/release/zenith.exe` | unprivileged launch succeeds | PASS - diagnostics and read-only screens work unprivileged; a mutating action asks for elevation through the single-use ticket. |

## 2. Icons and packaging assets

| ID | Requirement | Verification | Evidence | Result |
| :--- | :--- | :--- | :--- | :--- |
| M-09 | APPX tile assets exist at the exact Store-required sizes | `npm run check:msix` | `evidence/msix-check.log` | PASS - 50x50, 44x44, 71x71, 150x150, 310x310, 310x150, each measured from the PNG header rather than the file name |
| M-10 | Tiles are generated from the brand SVG, not hand-drawn per size | `npm run check:icons` | `evidence/verify-final.log` | PASS - all 17 files are reproduced byte-for-byte from `assets/zenith-mark.svg` |
| M-11 | No Tauri default icon survives anywhere in the set | `npm run check:icons` | `evidence/verify-final.log` | PASS |
| M-12 | The package icon is transparent where the tile requires it | inspection of a generated PNG | `src-tauri/icons/Square150x150Logo.png` | PASS - generated with an alpha channel from the source SVG |
| M-13 | Store listing artwork (screenshots) meet the size rules | `node scripts/capture-settings.mjs` | `evidence/screens/store/*.png` at 1366x768; `evidence/screens/locales/*.png` | PASS - five Store captures at the minimum 1366x768, plus eleven script and direction samples for the listing's international claims |

## 3. Capabilities and privacy

| ID | Requirement | Verification | Evidence | Result |
| :--- | :--- | :--- | :--- | :--- |
| M-14 | Every declared capability has a written justification | `Get-Content docs/store/capabilities.md` | `docs/store/capabilities.md` | PASS |
| M-15 | The app requests no capability it does not use | `src-tauri/capabilities/default.json` vs the command list | `evidence/verify-final.log` | PASS - 15 commands, and the capability set names only window, event, and drag |
| M-16 | The privacy policy is published on a public URL | `Get-Content docs/store/privacy-policy-url.md` | the document states the URL is required but not yet hosted | FAIL - `https://vellium.dev/zenith/privacy` does not resolve. Owner action: publish `public/legal/privacy.md` at that URL. |
| M-17 | The Store privacy declaration matches the app's actual data handling | `public/legal/privacy.md` vs `crates/zenith-core/src/telemetry.rs` | `public/legal/privacy.md` | PASS - telemetry is opt-in, local, and the document says so |
| M-18 | No network call happens without a user action, except the documented update check | `Select-String src-tauri/tauri.conf.json -Pattern 'connect-src'` | `self`, `ipc:`, `http://ipc.localhost`, `https://api.github.com` | PASS - the only remote origin is the release feed; nothing else can load |
| M-19 | Sign-in, if any, uses Microsoft identity | not applicable | none | PASS - the app has no account and no sign-in |
| M-20 | The app does not collect advertising identifiers | `npm run check:fe`; `public/legal/privacy.md` | `evidence/vitest-counts.json` | PASS |
| M-21 | Children's data handling is declared | `docs/store/age-rating.md` | IARC notes | PASS - the listing states no data is collected from any user |
| M-22 | Age rating is declared through IARC | `docs/store/age-rating.md` | questionnaire notes only | FAIL - the questionnaire has not been submitted. Owner action: complete the IARC questionnaire in Partner Center. |

## 4. Listing content

| ID | Requirement | Verification | Evidence | Result |
| :--- | :--- | :--- | :--- | :--- |
| M-23 | The English listing is complete and free of claims the product does not meet | `Get-Content docs/store/listing-en.md` | `docs/store/listing-en.md` | PASS |
| M-24 | The Turkish listing is complete and matches the English facts | `Get-Content docs/store/listing-tr.md` | `docs/store/listing-tr.md` | PASS |
| M-25 | The listing names no feature that is absent from the package | cross-check against `docs/03-architecture/03-05-actions-manifest.md` | 22 actions listed, 22 in the manifest | PASS - MCP, CLI, and the webhook are described as local integrations and all three exist |
| M-26 | No emoji in the listing text | `npm run check:emoji` | `evidence/verify-final.log` | PASS |
| M-27 | No em dash or en dash in the listing text | `npm run check:dashes` | `evidence/verify-final.log` | PASS |
| M-28 | The support contact in the listing is monitored | `docs/store/listing-en.md`; `public/legal/support.md` | `support@vellium.dev` | PASS |
| M-29 | The screenshots show the shipped UI, not a mock | `evidence/screens/store/*.png` | five captures from the release binary | PASS |
| M-30 | The listing's minimum Windows version matches the package manifest | `src-tauri/tauri.conf.json` | Windows 10 1809 or newer in the manifest | PASS |

## 5. Store build behaviour

| ID | Requirement | Verification | Evidence | Result |
| :--- | :--- | :--- | :--- | :--- |
| M-31 | The in-app updater is disabled on the Store channel and defers to the Store | `src/ui/SettingsScreen.tsx` `check()` | the Store branch returns the Store-managed message and performs no fetch | PASS |
| M-32 | The app does not attempt to download and execute an installer | `scripts/check-update-path.mjs` equivalent inspection (no `open` of a release asset) | `src/ui/SettingsScreen.tsx` | PASS - the update check compares a version string only |
| M-33 | Uninstall leaves user data in place unless the user removes it | `src-tauri/installer/hooks.nsh` | `evidence/verify-final.log` | PASS - the NSIS path asks; an MSIX uninstall removes app data by Windows policy and the privacy document states it. |
| M-34 | The Store package has no background task and no startup registration it cannot justify | `src-tauri/tauri.conf.json`; `src/settings/model.ts` | the startup toggle writes an HKCU Run entry | PASS - user-controlled, off by default, and named in the listing |
| M-35 | A single instance is enforced | `src-tauri/src/lib.rs` | single-instance plugin | PASS |
| M-36 | The app is fully functional on a machine with no Visual C++ runtime installed separately | `cargo build --release`; WebView2 bootstrapper in `resources/manifest.json` | `evidence/verify-final.log` | PASS - the MSVC runtime is statically linked and WebView2 is an OS component on Windows 11 |

## 6. Certification and submission

| ID | Requirement | Verification | Evidence | Result |
| :--- | :--- | :--- | :--- | :--- |
| M-37 | Windows App Certification Kit passes on the package | `"C:\Program Files (x86)\Windows Kits\10\App Certification Kit\appcert.exe" test -packagepath <msix> -reportoutputpath <xml>` | `appcert.exe` refuses to start without elevation | FAIL - the kit needs an elevated prompt and a signed package. Owner action: sign the package (M-02, M-03) and run the kit on a clean host. |
| M-38 | Partner Center account is verified and the publisher is reserved | Partner Center | not available from this machine | FAIL - owner action: complete account verification and reserve the name `Zenith`. |
| M-39 | The package passes the Store's static analysis without a suppression file | Partner Center report | not submitted | FAIL - follows from M-37. |
| M-40 | The submission declares a support URL and a privacy URL that both resolve | `curl` of both URLs | neither resolves | FAIL - follows from M-16. |
| M-41 | The submission has a written certification note for reviewers explaining the elevation handover | `docs/store/packaging.md` | the document describes the flow | PASS - the note is written; it is attached to the submission in M-38 |
| M-42 | The GitHub channel remains the primary distribution and the Store listing does not contradict it | `README.md` vs `docs/store/listing-en.md` | both name MIT and free | PASS |

## 7. Summary

<!-- STATS -->

### 7.1 FAIL register

| ID | Blocker | Owner action |
| :--- | :--- | :--- |
| M-02 | Store identity not reserved | Reserve the name in Partner Center and paste the three values into `src-tauri/msix/identity.json` |
| M-03 | Package unsigned by Microsoft | Submit the signed package |
| M-16 | Privacy URL not hosted | Publish the policy at `https://vellium.dev/zenith/privacy` |
| M-22 | IARC questionnaire not submitted | Complete it in Partner Center |
| M-37 | WACK not run | Sign the package, then run the kit from an elevated prompt on a clean host |
| M-38 | Partner Center not verified | Complete account verification |
| M-39 | No static analysis report | Follows from submission |
| M-40 | Support and privacy URLs do not resolve | Follows from M-16 |

Nine FAIL rows, eight of them blocked on Partner Center or on hosting, and none of
them on code in this tree: the package builds, and `check:msix` verifies its
contents against the manifest. Two of them (M-16 and M-40) are also GitHub
blockers, because a public privacy URL is owed to every user, not only to the
Store.

### 7.2 What would move this checklist

The shortest honest path is one work package, not a set of rows:

1. Reserve the Store name and paste the identity into `src-tauri/msix/identity.json`.
2. Build with `node scripts/pack-msix.mjs --identity partner-center` and sign the result.
3. Run the Windows App Certification Kit from an elevated prompt on a clean host.
4. Publish the privacy policy at the URL the listing already names.
5. Submit, then replace each FAIL above with the Partner Center reference.
