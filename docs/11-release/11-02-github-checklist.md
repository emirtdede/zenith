# GitHub Release Checklist

| Field | Value |
| :--- | :--- |
| Document ID | DOC-11-02 |
| Version | 1.0.0 |
| Owner | Release Engineering |
| Closes | REQ-N-046 |
| Channel | GitHub open source (repository, release asset, CI) |
| Tree under review | `1.0.0`, tag `v1.0.0` at `7b4f73b` on `main` |
| Reviewed on | 2026-11-24 |

This is the checklist the repository itself has to satisfy before a public
release is announced. It is a measurement, not a plan: every row names the
command that decides it and the file that holds the output. A row is `PASS` only
when the command exits `0` **and** the evidence file in this tree is the output
of that command; anything that has not been run, or that depends on a setting
outside this machine, is `FAIL` with the reason and the owner action.

`FAIL` rows are the point of the document. A checklist that cannot fail is a
newsletter.

## 1. Source, licence, and repository metadata

| ID | Requirement | Verification | Evidence | Result |
| :--- | :--- | :--- | :--- | :--- |
| G-01 | The licence is OSI-approved MIT and the file is the unmodified canonical text | `Get-Content LICENSE` | `LICENSE` | PASS |
| G-02 | Copyright holder and year are correct for the publishing entity | `Get-Content LICENSE -TotalCount 3` | `LICENSE` | PASS |
| G-03 | Version in `package.json`, `Cargo.toml`, `tauri.conf.json`, and the installer all agree | `node scripts/check-doc-counts.mjs`; `node scripts/check-contract.mjs` | `evidence/verify-final.log` | PASS |
| G-04 | Git tag exists for the released version | `git ls-remote --tags origin`; `git rev-parse "v1.0.0^{commit}"` | `v1.0.0` -> `7b4f73b` | PASS - the annotated `v1.0.0` was moved to the commit CI verified after the DEF-168 fix, and `https://github.com/emirtdede/zenith/tree/v1.0.0` resolves. The older lightweight `1.0.0` tag still points at `755885d` and is left in place because deleting a public tag is a separate decision |
| G-05 | Published repository description and licence are set | `https://github.com/emirtdede/zenith` | repository page | PASS |
| G-06 | Repository topics are set so the project is discoverable | `gh api repos/emirtdede/zenith/topics` | `evidence/repo-settings.log` | PASS - `windows`, `tauri`, `rust`, `diagnostics`, `self-healing`, `open-source` |
| G-07 | The default branch carries the reviewed tree | `git status --porcelain`; `git ls-remote --heads origin`; `git diff --name-only v1.0.0 -- src src-tauri crates assets resources` | `main` and `development` pushed; tag `v1.0.0` names `7b4f73b` | PASS - the tree under review is what `v1.0.0` names, and nothing a user installs differs from it: the third command prints nothing, so every path changed since the tag is under `docs/`, `evidence/`, `scripts/`, `.github/`, or is `package.json`, `README.md`, `CHANGELOG.md`, or a bundled legal document the application displays. A commit count is deliberately not stated: it grows with every evidence commit and would be a claim that keeps expiring |
| G-08 | The last commit on the default branch is green in CI | Actions run for that SHA | run `45328204501` | PASS - `verify` finished `success` on `windows-2022` for `7b4f73b`, the commit `v1.0.0` points at |

## 2. README and public documentation

| ID | Requirement | Verification | Evidence | Result |
| :--- | :--- | :--- | :--- | :--- |
| G-09 | README follows the fixed section order and holds both language halves | inspection | `README.md` | PASS |
| G-10 | README badges state real values (version, stack, licence, languages, palettes) | badge values vs `package.json`, `Cargo.toml`, `src/settings/palettes.json`, `src/i18n/languages.ts` | `README.md` lines 24-40 | PASS |
| G-11 | The CI badge points at the workflow file that exists | `Select-String README.md -Pattern 'verify.yml'` | `README.md` | PASS - the badge previously targeted `ci.yml`, a file this repository does not have |
| G-12 | Every relative link in the README resolves | `node scripts/check-docs.mjs` | `evidence/verify-final.log` | PASS |
| G-13 | No emoji anywhere in the tree | `npm run check:emoji` | `evidence/verify-final.log` | PASS |
| G-14 | No em dash or en dash in authored text | `npm run check:dashes` | `evidence/verify-final.log` | PASS |
| G-15 | The documentation library is complete, numbered, and free of broken links | `npm run check:docs` | `evidence/verify-final.log` | PASS |
| G-16 | Quantitative claims in the docs match the tree | `npm run check:doc-counts` | `evidence/verify-final.log` | PASS |
| G-17 | CHANGELOG records the release | `Get-Content CHANGELOG.md` | `CHANGELOG.md` | PASS |
| G-18 | SECURITY.md gives a private disclosure channel and a response window | `Get-Content SECURITY.md` | `SECURITY.md` | PASS |
| G-19 | Support policy names a channel and a scope | `Get-Content public/legal/support.md` | `public/legal/support.md` | PASS |
| G-20 | Accessibility statement exists and is reachable from the app | `Get-Content public/legal/accessibility.md` | `public/legal/accessibility.md` | PASS |
| G-21 | CONTRIBUTING explains the gate a change must pass | `Get-Content CONTRIBUTING.md` | `CONTRIBUTING.md` | PASS |
| G-22 | CODE_OF_CONDUCT is present | `Get-Content CODE_OF_CONDUCT.md` | `CODE_OF_CONDUCT.md` | PASS |
| G-23 | Issue templates exist | `Get-ChildItem .github/ISSUE_TEMPLATE` | `.github/ISSUE_TEMPLATE/{bug_report,feature_request,config}.yml` | PASS - bug and feature forms ask for version, build commit, and a support bundle; `config.yml` routes security reports to the private advisory channel |
| G-24 | Pull request template exists | `Get-Content .github/pull_request_template.md` | `.github/pull_request_template.md` | PASS - the first checkbox is `npm run verify` |

## 3. Security and supply chain

| ID | Requirement | Verification | Evidence | Result |
| :--- | :--- | :--- | :--- | :--- |
| G-25 | No secret in the working tree or in any commit | `npm run check:secrets` | `evidence/gitleaks.log` | PASS - worktree and the full 14-commit history clean (5.86 MB scanned) under the default rule set |
| G-26 | `.gitignore` excludes certificates, keys, `.env`, and build output | `Get-Content .gitignore` | `.gitignore` | PASS |
| G-27 | Only non-secret configuration is documented in `.env.example` | `Get-Content .env.example` | `.env.example` | PASS |
| G-28 | Dependency advisories are clean | `npm run check:deny` | `evidence/verify-final.log` | PASS |
| G-29 | SBOM is generated from the real dependency graph and is current | `npm run check:sbom` | `evidence/verify-final.log` | PASS |
| G-30 | Third-party licence notices are generated, not hand-written | `npm run check:licenses` | `evidence/verify-final.log` | PASS |
| G-31 | Workflow actions are pinned to commit SHAs | `Select-String .github/workflows/*.yml -Pattern 'uses:'` | `.github/workflows/verify.yml`, `.github/workflows/release.yml` | PASS - seven uses across the two workflows, every one a 40-character commit SHA with the release tag in a comment |
| G-32 | The workflow token is least-privilege | `Select-String .github/workflows/verify.yml -Pattern 'permissions'` | `contents: read` | PASS |
| G-33 | Telemetry is off unless the user consents, and consent is tested | `npm run check:fe` | `evidence/vitest-counts.json` | PASS |
| G-34 | Content Security Policy is restrictive and every remote origin is deliberate | `Select-String src-tauri/tauri.conf.json -Pattern 'csp'` | `src-tauri/tauri.conf.json` | PASS - `self`, `ipc:`, `http://ipc.localhost`, and `https://api.github.com` (the update feed) only |
| G-35 | Secret scanning and push protection are enabled on the repository | `gh api repos/emirtdede/zenith --jq '.security_and_analysis'` | `evidence/repo-settings.log` | PASS - `secret_scanning: enabled`, `secret_scanning_push_protection: enabled`, `dependabot_security_updates: enabled` |
| G-36 | Dependabot is configured for npm and cargo | `Get-Content .github/dependabot.yml` | `.github/dependabot.yml` | PASS - weekly npm, cargo and github-actions updates, grouped by ecosystem, with the action pins kept fresh |

## 4. Quality gates

| ID | Requirement | Verification | Evidence | Result |
| :--- | :--- | :--- | :--- | :--- |
| G-37 | The full release chain is green | `npm run verify` | `evidence/verify-final.log` | PASS - 34 steps, exit 0, on the tree that produced `release-20261124` |
| G-38 | Rust test suite | `cargo test --workspace --locked` | `evidence/verify-final.log` | PASS - 341 tests |
| G-39 | Frontend test suite | `npm run check:fe` | `evidence/vitest-counts.json` | PASS - 196 tests in 14 files |
| G-40 | TypeScript type check | `npx tsc --noEmit` | `evidence/verify-final.log` | PASS |
| G-41 | Locale parity and placeholder agreement | `npm run check:locales` | `evidence/verify-final.log` | PASS - 866 keys in each full catalogue |
| G-42 | No catalogue key is dead | `npm run check:unused-keys` | `evidence/verify-final.log` | PASS |
| G-43 | IPC contract: docs, attributes, handler, and renderer agree on 15 commands | `npm run check:contract` | `evidence/verify-final.log` | PASS |
| G-44 | WCAG contrast across every palette and mode | `npm run check:contrast` | `evidence/verify-final.log` | PASS - 520 checks, 14 palettes |
| G-45 | Every `unsafe` block pairs with a `SAFETY` comment | `npm run check:ffi` | `evidence/verify-final.log` | PASS - 115 blocks, 2 impls |
| G-46 | Evidence ledger describes every artefact | `npm run check:evidence-ledger` | `evidence/verify-final.log` | PASS - 146 artefacts at every depth under `evidence/`, 97 described by name and the rest covered by eight glob rows; each glob must now match at least one real file, which is the check whose absence let `screens/locales/*.png` be described while the directory did not exist |
| G-47 | Negative and mutation gates catch their own regressions | `npm run check:mutate-restore` and the mutation logs | `evidence/def1*.log`, `evidence/evidence-ledger-glob-negative.log` | PASS - every gate that could silently stop measuring has a mutation case, including the two added in this revision: the checklist parser (five cases: joined rows, a missing closing pipe, an undecided verdict, count drift, a dropped register row) and the evidence ledger (a missing glob directory and a zero-byte file below the top level) |
| G-48 | A clean clone builds and verifies | `npm run verify` with `dist/` removed | `evidence/def167-clean-clone.log` | PASS |
| G-49 | Desktop end-to-end journeys pass against the release binary | `npm run e2e -- --app target/release/zenith.exe --driver %TEMP%\zenith-e2e\msedgedriver.exe` | `evidence/e2e-final.log` | PASS - 3 journeys, 11 steps, 0 failures against the `release-20261124` binary |
| G-50 | CI runs the same chain, not a hand-copied subset | `npm run check:workflows` | `evidence/verify-final.log` | PASS |

## 5. Build and release assets

| ID | Requirement | Verification | Evidence | Result |
| :--- | :--- | :--- | :--- | :--- |
| G-51 | The release binary is built from this tree with the lockfile | `npm run tauri build`; `node scripts/check-build-identity.mjs` | `target/release/zenith.exe` | PASS - the local rebuild from this tree is 6,628,864 bytes with embedded identity `release-20261124`, and `check-build-identity` finds no shipped source newer than it. The asset users download was built by CI from the same tree and is a different size (its own build stamp and compression), which is why the two numbers are not made to agree |
| G-52 | The installer is built from the same commit as the binary | `npm run tauri build`; `node scripts/check-build-identity.mjs`; `npm run check:installer` | `target/release/bundle/nsis/Zenith_1.0.0_x64-setup.exe`, `evidence/installer-build.log` | PASS - one `npm run tauri build` produced both artefacts under identity `release-20261124` and `check-build-identity` passes against the pair. The bundle is 3,255,256 bytes and was built on an NSIS cache holding only the pinned archive's own 67 language files, so its 52 declared translations resolve on a machine that has never had a language file added by hand |
| G-53 | The installer and the binary are Authenticode-signed | `Get-AuthenticodeSignature target/release/bundle/nsis/Zenith_1.0.0_x64-setup.exe` | `NotSigned` | FAIL - DEF-028, no EV certificate on this machine. Owner action: supply the certificate and re-run `npm run tauri build`. |
| G-54 | Installer icons are the project set, with no Tauri default | `npm run check:icons` | `evidence/verify-final.log` | PASS - 17 files reproduced byte-for-byte |
| G-55 | The installer language list matches the 73-locale registry and every declared translation exists in the pinned NSIS archive | `npm run check:installer` | `evidence/installer-languages.log` | PASS - 73 registry rows, 52 translations the pinned NSIS 3.11 archive actually contains, 21 rows declared as English-installer fallbacks; six self-test cases including the DEF-168 shape, and the gate reads the archive inventory rather than this machine's cache |
| G-56 | Uninstall deletes user data only when the user asks | `src-tauri/installer/hooks.nsh` | `evidence/verify-final.log` | PASS - gated on `$DeleteAppDataCheckboxState` |
| G-57 | SHA-256 checksums are published next to the release asset | `gh release download v1.0.0`; `Get-FileHash` | draft release `Zenith v1.0.0`, `SHA256SUMS.txt` | PASS - the release carries `SHA256SUMS.txt` with one line per binary, and the downloaded installer hashes to `a6989e5d...1c71e93`, which is the line the file states |
| G-58 | GitHub build-provenance attestation is attached | `gh attestation verify Zenith_1.0.0_x64-setup.exe --repo emirtdede/zenith` | Sigstore bundle in run `45330291458` | PASS - `gh attestation verify` exits 0 on the downloaded installer and returns a Sigstore bundle whose certificate names `release.yml` at `refs/tags/v1.0.0` |
| G-59 | The update check reads GitHub Releases and never downloads in-app | `node scripts/check-update-path.mjs` (inspection of `AboutPanel`) | `src/ui/SettingsScreen.tsx` | PASS - semver comparison only; the Store channel is answered locally |
| G-60 | ARM64 build exists | `cargo build --release --target aarch64-pc-windows-msvc --locked`; `node scripts/check-arm64.mjs` | `evidence/arm64-build.log`, `evidence/arm64-check.log` | PASS - clean compile in 6m 08s and a 6,319,616-byte binary whose PE machine field is `0xAA64`, distinct from the x64 build |
| G-61 | Windows 10 and 11 x64 are tested on real hosts | VM matrix | not run | FAIL - open register row (DEF-047). |
| G-62 | MacOS/Linux are explicitly unsupported, not silently broken | `npm run check:nonwindows` | `evidence/verify-final.log` | PASS |

## 6. Release publication

| ID | Requirement | Verification | Evidence | Result |
| :--- | :--- | :--- | :--- | :--- |
| G-63 | Release notes are written from CHANGELOG, not from commit titles | `gh release view v1.0.0` | draft `Zenith v1.0.0`, run `45330291458` | PASS - the draft body is `docs/11-release/11-04-release-notes-1.0.0.md`, which is written from `CHANGELOG.md` and `public/legal/changelog.md`; it is a draft because the installer is unsigned (DEF-028), not because the notes are unfinished |
| G-64 | The published README matches this tree | `gh api repos/emirtdede/zenith/contents/README.md --jq .sha` vs `git rev-parse HEAD:README.md` | both `3537f450` | PASS - the default branch carries this README, blob for blob |
| G-65 | A rollback plan exists for a bad release | `Get-Content docs/08-delivery/08-02-ci-cd-release.md` | release document | PASS |
| G-66 | Supported versions and their support window are stated | `public/legal/support.md` | support policy | PASS |

## 7. Summary

| Measure | Value |
| :--- | :--- |
| Requirement rows | 66 |
| `PASS` | 64 |
| `FAIL` | 2 |
| Tree under review | `v1.0.0` at `7b4f73b` on `main` |
| Release | draft `Zenith v1.0.0` from run `45330291458`: installer 3,287,840 bytes, `SHA256SUMS.txt`, Sigstore attestation. The local rebuild in G-51 and G-52 is a separate artefact of the same tree, so its sizes differ |
| Commands re-run for this revision | `npm run verify` (34 steps), `npm run check:secrets` over the full history, `npm run e2e` (3 journeys), `npm run check:msix`, `npm run check:arm64`, `gh attestation verify` |

Two `FAIL` rows remain, and neither is a defect in this tree: one needs a
certificate this project cannot issue to itself, and one needs hardware that is
not this machine. Both are listed below with the owner action that closes them.
No row is `PASS` because it looks likely to work: every one names a command and a
file, and the file is the output of that command against this tree.

### 7.1 FAIL register

| ID | Blocker | Owner action |
| :--- | :--- | :--- |
| G-53 | Installer unsigned | Supply the EV certificate (DEF-028) |
| G-61 | No real-host Windows matrix | Run the T-WIN matrix on Windows 10 22H2 and 11 24H2 (DEF-047) |

Both are owner assets, not code. Everything that can be built, measured and
published from this tree has been: the installer, the MSIX package, the ARM64
binary, the checksums and the attestation all exist, and the last two were
verified by downloading the released bytes back and hashing and attesting them.

### 7.2 What would move this checklist

1. Buy an EV code-signing certificate, set `ZENITH_SIGN_THUMBPRINT`, and re-run
   `release.yml` so the installer and the binary are signed (G-53, DEF-028).
2. Boot the T-WIN matrix on Windows 10 22H2 and Windows 11 24H2 and record the
   run against `08-02` §9 (G-61, DEF-047).

Neither step needs a code change, and both are recorded as open in
`docs/10-audit/10-02-deficiency-register.md` rather than quietly passing here.
