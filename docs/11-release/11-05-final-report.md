# Zenith 1.0.0 Release Readiness Report

| Field | Value |
| :--- | :--- |
| Document ID | DOC-11-05 |
| Version | 1.0.0 |
| Owner | Release Engineering |
| Closes | REQ-N-046 |
| Product | Zenith 1.0.0 |
| Tree under review | `v1.0.0` at `85c125a` on `main` |
| Reviewed on | 2026-11-24 |

This report is generated from
[`11-02-github-checklist.md`](11-02-github-checklist.md) and
[`11-03-store-checklist.md`](11-03-store-checklist.md) by
`scripts/generate-release-report.mjs`. Every verdict below is the verdict in one
of those two files; the report adds no opinion of its own, so the three documents
cannot disagree. Both tables list every requirement row, not a sample, because a
release decision has to see the row that failed as clearly as the rows that
passed.

The two channels are decided separately on purpose. The GitHub channel is an
installer that a user downloads and runs; the Microsoft Store channel is an MSIX
that Microsoft signs and the Store service installs. A fact that is true of one
is not automatically true of the other, and neither table borrows a `PASS` from
the other.

## 1. Verdict

| Channel | Requirement rows | `PASS` | `FAIL` |
| :--- | ---: | ---: | ---: |
| GitHub open source | 66 | 64 | 2 |
| Microsoft Store | 42 | 34 | 8 |

Neither channel is 100% today. The GitHub channel is 64 of 66 and the Store
channel is 34 of 42; the rows that are not `PASS` are owner assets - a
code-signing certificate, a reserved Store identity, hosted legal URLs, a
submitted questionnaire, and a real-host Windows matrix - not code this tree
could write. Section 4 lists each one with the action that closes it.

## 2. GitHub open source checklist

| Section | Rows | `PASS` | `FAIL` |
| :--- | ---: | ---: | ---: |
| Source, licence, and repository metadata | 8 | 8 | 0 |
| README and public documentation | 16 | 16 | 0 |
| Security and supply chain | 12 | 12 | 0 |
| Quality gates | 14 | 14 | 0 |
| Build and release assets | 12 | 10 | 2 |
| Release publication | 4 | 4 | 0 |

| ID | Requirement | Verdict | Verification | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| G-01 | The licence is OSI-approved MIT and the file is the unmodified canonical text | **PASS** | `Get-Content LICENSE` | `LICENSE` |
| G-02 | Copyright holder and year are correct for the publishing entity | **PASS** | `Get-Content LICENSE -TotalCount 3` | `LICENSE` |
| G-03 | Version in `package.json`, `Cargo.toml`, `tauri.conf.json`, and the installer all agree | **PASS** | `node scripts/check-doc-counts.mjs`; `node scripts/check-contract.mjs` | `evidence/verify-final.log` |
| G-04 | Git tag exists for the released version | **PASS** | `git ls-remote --tags origin`; `git rev-parse "v1.0.0^{commit}"` | `v1.0.0` -> `85c125a` |
| G-05 | Published repository description and licence are set | **PASS** | `https://github.com/emirtdede/zenith` | repository page |
| G-06 | Repository topics are set so the project is discoverable | **PASS** | `gh api repos/emirtdede/zenith/topics` | `evidence/repo-settings.log` |
| G-07 | The default branch carries the reviewed tree | **PASS** | `git status --porcelain`; `git ls-remote --heads origin`; `git diff --name-only v1.0.0 -- src src-tauri crates assets resources` | `main` and `development` pushed; tag `v1.0.0` names `85c125a` |
| G-08 | The last commit on the default branch is green in CI | **PASS** | Actions run for that SHA | run `45342289468` |
| G-09 | README follows the fixed section order and holds both language halves | **PASS** | inspection | `README.md` |
| G-10 | README badges state real values (version, stack, licence, languages, palettes) | **PASS** | badge values vs `package.json`, `Cargo.toml`, `src/settings/palettes.json`, `src/i18n/languages.ts` | `README.md` lines 24-40 |
| G-11 | The CI badge points at the workflow file that exists | **PASS** | `Select-String README.md -Pattern 'verify.yml'` | `README.md` |
| G-12 | Every relative link in the README resolves | **PASS** | `node scripts/check-docs.mjs` | `evidence/verify-final.log` |
| G-13 | No emoji anywhere in the tree | **PASS** | `npm run check:emoji` | `evidence/verify-final.log` |
| G-14 | No em dash or en dash in authored text | **PASS** | `npm run check:dashes` | `evidence/verify-final.log` |
| G-15 | The documentation library is complete, numbered, and free of broken links | **PASS** | `npm run check:docs` | `evidence/verify-final.log` |
| G-16 | Quantitative claims in the docs match the tree | **PASS** | `npm run check:doc-counts` | `evidence/verify-final.log` |
| G-17 | CHANGELOG records the release | **PASS** | `Get-Content CHANGELOG.md` | `CHANGELOG.md` |
| G-18 | SECURITY.md gives a private disclosure channel and a response window | **PASS** | `Get-Content SECURITY.md` | `SECURITY.md` |
| G-19 | Support policy names a channel and a scope | **PASS** | `Get-Content public/legal/support.md` | `public/legal/support.md` |
| G-20 | Accessibility statement exists and is reachable from the app | **PASS** | `Get-Content public/legal/accessibility.md` | `public/legal/accessibility.md` |
| G-21 | CONTRIBUTING explains the gate a change must pass | **PASS** | `Get-Content CONTRIBUTING.md` | `CONTRIBUTING.md` |
| G-22 | CODE_OF_CONDUCT is present | **PASS** | `Get-Content CODE_OF_CONDUCT.md` | `CODE_OF_CONDUCT.md` |
| G-23 | Issue templates exist | **PASS** | `Get-ChildItem .github/ISSUE_TEMPLATE` | `.github/ISSUE_TEMPLATE/{bug_report,feature_request,config}.yml` |
| G-24 | Pull request template exists | **PASS** | `Get-Content .github/pull_request_template.md` | `.github/pull_request_template.md` |
| G-25 | No secret in the working tree or in any commit | **PASS** | `npm run check:secrets` | `evidence/gitleaks.log` |
| G-26 | `.gitignore` excludes certificates, keys, `.env`, and build output | **PASS** | `Get-Content .gitignore` | `.gitignore` |
| G-27 | Only non-secret configuration is documented in `.env.example` | **PASS** | `Get-Content .env.example` | `.env.example` |
| G-28 | Dependency advisories are clean | **PASS** | `npm run check:deny` | `evidence/verify-final.log` |
| G-29 | SBOM is generated from the real dependency graph and is current | **PASS** | `npm run check:sbom` | `evidence/verify-final.log` |
| G-30 | Third-party licence notices are generated, not hand-written | **PASS** | `npm run check:licenses` | `evidence/verify-final.log` |
| G-31 | Workflow actions are pinned to commit SHAs | **PASS** | `Select-String .github/workflows/*.yml -Pattern 'uses:'` | `.github/workflows/verify.yml`, `.github/workflows/release.yml` |
| G-32 | The workflow token is least-privilege | **PASS** | `Select-String .github/workflows/verify.yml -Pattern 'permissions'` | `contents: read` |
| G-33 | Telemetry is off unless the user consents, and consent is tested | **PASS** | `npm run check:fe` | `evidence/vitest-counts.json` |
| G-34 | Content Security Policy is restrictive and every remote origin is deliberate | **PASS** | `Select-String src-tauri/tauri.conf.json -Pattern 'csp'` | `src-tauri/tauri.conf.json` |
| G-35 | Secret scanning and push protection are enabled on the repository | **PASS** | `gh api repos/emirtdede/zenith --jq '.security_and_analysis'` | `evidence/repo-settings.log` |
| G-36 | Dependabot is configured for npm and cargo | **PASS** | `Get-Content .github/dependabot.yml` | `.github/dependabot.yml` |
| G-37 | The full release chain is green | **PASS** | `npm run verify` | `evidence/verify-final.log` |
| G-38 | Rust test suite | **PASS** | `cargo test --workspace --locked` | `evidence/verify-final.log` |
| G-39 | Frontend test suite | **PASS** | `npm run check:fe` | `evidence/vitest-counts.json` |
| G-40 | TypeScript type check | **PASS** | `npx tsc --noEmit` | `evidence/verify-final.log` |
| G-41 | Locale parity and placeholder agreement | **PASS** | `npm run check:locales` | `evidence/verify-final.log` |
| G-42 | No catalogue key is dead | **PASS** | `npm run check:unused-keys` | `evidence/verify-final.log` |
| G-43 | IPC contract: docs, attributes, handler, and renderer agree on 15 commands | **PASS** | `npm run check:contract` | `evidence/verify-final.log` |
| G-44 | WCAG contrast across every palette and mode | **PASS** | `npm run check:contrast` | `evidence/verify-final.log` |
| G-45 | Every `unsafe` block pairs with a `SAFETY` comment | **PASS** | `npm run check:ffi` | `evidence/verify-final.log` |
| G-46 | Evidence ledger describes every artefact | **PASS** | `npm run check:evidence-ledger` | `evidence/verify-final.log` |
| G-47 | Negative and mutation gates catch their own regressions | **PASS** | `npm run check:mutate-restore` and the mutation logs | `evidence/def1*.log`, `evidence/evidence-ledger-glob-negative.log` |
| G-48 | A clean clone builds and verifies | **PASS** | `npm run verify` with `dist/` removed | `evidence/def167-clean-clone.log` |
| G-49 | Desktop end-to-end journeys pass against the release binary | **PASS** | `npm run e2e -- --app target/release/zenith.exe --driver %TEMP%\zenith-e2e\msedgedriver.exe` | `evidence/e2e-final.log` |
| G-50 | CI runs the same chain, not a hand-copied subset | **PASS** | `npm run check:workflows` | `evidence/verify-final.log` |
| G-51 | The release binary is built from this tree with the lockfile | **PASS** | `npm run tauri build`; `node scripts/check-build-identity.mjs` | `target/release/zenith.exe` |
| G-52 | The installer is built from the same commit as the binary | **PASS** | `npm run tauri build`; `node scripts/check-build-identity.mjs`; `npm run check:installer` | `target/release/bundle/nsis/Zenith_1.0.0_x64-setup.exe`, `evidence/installer-build.log` |
| G-53 | The installer and the binary are Authenticode-signed | **FAIL** | `Get-AuthenticodeSignature target/release/bundle/nsis/Zenith_1.0.0_x64-setup.exe` | `NotSigned` |
| G-54 | Installer icons are the project set, with no Tauri default | **PASS** | `npm run check:icons` | `evidence/verify-final.log` |
| G-55 | The installer language list matches the 73-locale registry and every declared translation exists in the pinned NSIS archive | **PASS** | `npm run check:installer` | `evidence/installer-languages.log` |
| G-56 | Uninstall deletes user data only when the user asks | **PASS** | `src-tauri/installer/hooks.nsh` | `evidence/verify-final.log` |
| G-57 | SHA-256 checksums are published next to the release asset | **PASS** | `gh release download v1.0.0`; `Get-FileHash` | draft release `Zenith v1.0.0`, `SHA256SUMS.txt`, `evidence/release-verify.log` |
| G-58 | GitHub build-provenance attestation is attached | **PASS** | `gh attestation verify Zenith_1.0.0_x64-setup.exe --repo emirtdede/zenith` | Sigstore bundle in run `45345059565` |
| G-59 | The update check reads GitHub Releases and never downloads in-app | **PASS** | `node scripts/check-update-path.mjs` (inspection of `AboutPanel`) | `src/ui/SettingsScreen.tsx` |
| G-60 | ARM64 build exists | **PASS** | `cargo build --release --target aarch64-pc-windows-msvc --locked`; `node scripts/check-arm64.mjs` | `evidence/arm64-build.log`, `evidence/arm64-check.log` |
| G-61 | Windows 10 and 11 x64 are tested on real hosts | **FAIL** | VM matrix | not run |
| G-62 | MacOS/Linux are explicitly unsupported, not silently broken | **PASS** | `npm run check:nonwindows` | `evidence/verify-final.log` |
| G-63 | Release notes are written from CHANGELOG, not from commit titles | **PASS** | `gh release view v1.0.0` | draft `Zenith v1.0.0`, run `45345059565` |
| G-64 | The published README matches this tree | **PASS** | `gh api repos/emirtdede/zenith/contents/README.md --jq .sha` vs `git rev-parse HEAD:README.md` | both `e091614a` |
| G-65 | A rollback plan exists for a bad release | **PASS** | `Get-Content docs/08-delivery/08-02-ci-cd-release.md` | release document |
| G-66 | Supported versions and their support window are stated | **PASS** | `public/legal/support.md` | support policy |

## 3. Microsoft Store checklist

| Section | Rows | `PASS` | `FAIL` |
| :--- | ---: | ---: | ---: |
| Packaging | 8 | 6 | 2 |
| Icons and packaging assets | 5 | 5 | 0 |
| Capabilities and privacy | 9 | 7 | 2 |
| Listing content | 8 | 8 | 0 |
| Store build behaviour | 6 | 6 | 0 |
| Certification and submission | 6 | 2 | 4 |

| ID | Requirement | Verdict | Verification | Evidence |
| :--- | :--- | :--- | :--- | :--- |
| M-01 | The build generates an MSIX or APPX package | **PASS** | `npm run msix:package`; `npm run check:msix` | `evidence/msix-check.log` |
| M-02 | The MSIX declares the Store identity (name, publisher, publisher display name) | **FAIL** | `Get-Content src-tauri/msix/identity.json`; `node scripts/pack-msix.mjs --identity partner-center` | `src-tauri/msix/identity.json` |
| M-03 | The package is signed by Microsoft for Store ingestion | **FAIL** | Partner Center | `_test.msix` is unsigned and local |
| M-04 | The NSIS-only hooks are excluded from the Store package | **PASS** | `src-tauri/installer/hooks.nsh` | file exists and is NSIS-scoped |
| M-05 | The Store package writes only to per-user locations | **PASS** | `src-tauri/installer/hooks.nsh`; `crates/zenith-core/src/config.rs` | `%LOCALAPPDATA%\Vellium\Zenith`, `%APPDATA%\Vellium\Zenith` |
| M-06 | No process launches another executable outside the package without a capability declaration | **PASS** | `npm run check:contract`; `src-tauri/capabilities/default.json` | `evidence/verify-final.log` |
| M-07 | Elevation does not assume a machine-wide install directory | **PASS** | `src-tauri/src/handover.rs` | relaunch uses the current executable path |
| M-08 | The package runs after a per-user install with no elevation | **PASS** | manual run from `target/release/zenith.exe` | unprivileged launch succeeds |
| M-09 | APPX tile assets exist at the exact Store-required sizes | **PASS** | `npm run check:msix` | `evidence/msix-check.log` |
| M-10 | Tiles are generated from the brand SVG, not hand-drawn per size | **PASS** | `npm run check:icons` | `evidence/verify-final.log` |
| M-11 | No Tauri default icon survives anywhere in the set | **PASS** | `npm run check:icons` | `evidence/verify-final.log` |
| M-12 | The package icon is transparent where the tile requires it | **PASS** | inspection of a generated PNG | `src-tauri/icons/Square150x150Logo.png` |
| M-13 | Store listing artwork (screenshots) meet the size rules | **PASS** | `node scripts/capture-settings.mjs` | `evidence/screens/store/*.png` at 1366x768; `evidence/screens/locales/*.png` |
| M-14 | Every declared capability has a written justification | **PASS** | `Get-Content docs/store/capabilities.md` | `docs/store/capabilities.md` |
| M-15 | The app requests no capability it does not use | **PASS** | `src-tauri/capabilities/default.json` vs the command list | `evidence/verify-final.log` |
| M-16 | The privacy policy is published on a public URL | **FAIL** | `Get-Content docs/store/privacy-policy-url.md` | the document states the URL is required but not yet hosted |
| M-17 | The Store privacy declaration matches the app's actual data handling | **PASS** | `public/legal/privacy.md` vs `crates/zenith-core/src/telemetry.rs` | `public/legal/privacy.md` |
| M-18 | No network call happens without a user action, except the documented update check | **PASS** | `Select-String src-tauri/tauri.conf.json -Pattern 'connect-src'` | `self`, `ipc:`, `http://ipc.localhost`, `https://api.github.com` |
| M-19 | Sign-in, if any, uses Microsoft identity | **PASS** | not applicable | none |
| M-20 | The app does not collect advertising identifiers | **PASS** | `npm run check:fe`; `public/legal/privacy.md` | `evidence/vitest-counts.json` |
| M-21 | Children's data handling is declared | **PASS** | `docs/store/age-rating.md` | IARC notes |
| M-22 | Age rating is declared through IARC | **FAIL** | `docs/store/age-rating.md` | questionnaire notes only |
| M-23 | The English listing is complete and free of claims the product does not meet | **PASS** | `Get-Content docs/store/listing-en.md` | `docs/store/listing-en.md` |
| M-24 | The Turkish listing is complete and matches the English facts | **PASS** | `Get-Content docs/store/listing-tr.md` | `docs/store/listing-tr.md` |
| M-25 | The listing names no feature that is absent from the package | **PASS** | cross-check against `docs/03-architecture/03-05-actions-manifest.md` | 22 actions listed, 22 in the manifest |
| M-26 | No emoji in the listing text | **PASS** | `npm run check:emoji` | `evidence/verify-final.log` |
| M-27 | No em dash or en dash in the listing text | **PASS** | `npm run check:dashes` | `evidence/verify-final.log` |
| M-28 | The support contact in the listing is monitored | **PASS** | `docs/store/listing-en.md`; `public/legal/support.md` | `support@vellium.dev` |
| M-29 | The screenshots show the shipped UI, not a mock | **PASS** | `evidence/screens/store/*.png` | five captures from the release binary |
| M-30 | The listing's minimum Windows version matches the package manifest | **PASS** | `src-tauri/tauri.conf.json` | Windows 10 1809 or newer in the manifest |
| M-31 | The in-app updater is disabled on the Store channel and defers to the Store | **PASS** | `src/ui/SettingsScreen.tsx` `check()` | the Store branch returns the Store-managed message and performs no fetch |
| M-32 | The app does not attempt to download and execute an installer | **PASS** | `scripts/check-update-path.mjs` equivalent inspection (no `open` of a release asset) | `src/ui/SettingsScreen.tsx` |
| M-33 | Uninstall leaves user data in place unless the user removes it | **PASS** | `src-tauri/installer/hooks.nsh` | `evidence/verify-final.log` |
| M-34 | The Store package has no background task and no startup registration it cannot justify | **PASS** | `src-tauri/tauri.conf.json`; `src/settings/model.ts` | the startup toggle writes an HKCU Run entry |
| M-35 | A single instance is enforced | **PASS** | `src-tauri/src/lib.rs` | single-instance plugin |
| M-36 | The app is fully functional on a machine with no Visual C++ runtime installed separately | **PASS** | `cargo build --release`; WebView2 bootstrapper in `resources/manifest.json` | `evidence/verify-final.log` |
| M-37 | Windows App Certification Kit passes on the package | **FAIL** | `"C:\Program Files (x86)\Windows Kits\10\App Certification Kit\appcert.exe" test -packagepath <msix> -reportoutputpath <xml>` | `appcert.exe` refuses to start without elevation |
| M-38 | Partner Center account is verified and the publisher is reserved | **FAIL** | Partner Center | not available from this machine |
| M-39 | The package passes the Store's static analysis without a suppression file | **FAIL** | Partner Center report | not submitted |
| M-40 | The submission declares a support URL and a privacy URL that both resolve | **FAIL** | `curl` of both URLs | neither resolves |
| M-41 | The submission has a written certification note for reviewers explaining the elevation handover | **PASS** | `docs/store/packaging.md` | the document describes the flow |
| M-42 | The GitHub channel remains the primary distribution and the Store listing does not contradict it | **PASS** | `README.md` vs `docs/store/listing-en.md` | both name MIT and free |

## 4. Every failing row and the action that closes it

10 rows are not `PASS`. None of them is a defect that code in
this tree can fix, and none is marked `PASS` on the strength of being close.

| ID | Channel | Blocker | Owner action |
| :--- | :--- | :--- | :--- |
| G-53 | GitHub | The installer and the binary are Authenticode-signed | DEF-028, no EV certificate on this machine. Owner action: supply the certificate and re-run `npm run tauri build`. |
| G-61 | GitHub | Windows 10 and 11 x64 are tested on real hosts | open register row (DEF-047). |
| M-02 | Store | The MSIX declares the Store identity (name, publisher, publisher display name) | the `partnerCenter` block is null and the script refuses to build from a guessed identity. Owner action: reserve the name in Partner Center and paste the three values. |
| M-03 | Store | The package is signed by Microsoft for Store ingestion | signing happens after submission. Owner action: submit the signed package (M-02, M-38). |
| M-16 | Store | The privacy policy is published on a public URL | `https://vellium.dev/zenith/privacy` does not resolve. Owner action: publish `public/legal/privacy.md` at that URL. |
| M-22 | Store | Age rating is declared through IARC | the questionnaire has not been submitted. Owner action: complete the IARC questionnaire in Partner Center. |
| M-37 | Store | Windows App Certification Kit passes on the package | the kit needs an elevated prompt and a signed package. Owner action: sign the package (M-02, M-03) and run the kit on a clean host. |
| M-38 | Store | Partner Center account is verified and the publisher is reserved | owner action: complete account verification and reserve the name `Zenith`. |
| M-39 | Store | The package passes the Store's static analysis without a suppression file | follows from M-37. |
| M-40 | Store | The submission declares a support URL and a privacy URL that both resolve | follows from M-16. |

## 5. Evidence pack

The checklists cite 39 evidence artefacts under `evidence/`, each described in
[`evidence/README.md`](../../evidence/README.md). The set a reviewer needs first:

| Artefact | What it proves |
| :--- | :--- |
| `evidence/verify-final.log` | the 34-step gate ran green on this tree |
| `evidence/vitest-counts.json` | 196 renderer tests in 14 files, measured, not counted by hand |
| `evidence/e2e-final.log` | three end-to-end journeys driven through the built binary |
| `evidence/msix-check.log` | the Store package re-opened with the Windows SDK and measured |
| `evidence/arm64-build.log`, `evidence/arm64-check.log` | the ARM64 binary compiles and its PE machine field is `0xAA64` |
| `evidence/installer-languages.log` | 52 installer translations against the pinned NSIS archive |
| `evidence/release-verify.log` | the published draft downloaded back, hashed and attested |
| `evidence/screens/` | main screens, all 12 settings tabs, boot skeleton beside loaded, six setup states, eleven script and RTL samples |

## 6. How to reproduce this report

```powershell
npm run verify
npm run e2e
npm run check:msix
npm run check:arm64
node scripts/generate-release-report.mjs
```

The first four commands repopulate the evidence files the tables cite. The last
one re-reads the two checklists and rewrites this report, so editing a verdict in
`11-02` or `11-03` and re-running it is the only supported way to change a row
here.
