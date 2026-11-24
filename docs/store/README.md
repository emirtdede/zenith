# Microsoft Store Listing Package

| Field | Value |
| :--- | :--- |
| Document ID | DOC-STORE-000 |
| Version | 1.0.0 |
| Owner | Release Engineering |
| Closes | REQ-N-046, REQ-N-047 |

This folder contains the material a Microsoft Store submission needs. The
package is a draft until the checklists in `docs/11-release` mark every item
PASS.

| File | Purpose |
| :--- | :--- |
| `listing-en.md` | English listing text and product facts |
| `listing-tr.md` | Turkish listing text |
| `privacy-policy-url.md` | Public privacy URL and hosting requirement |
| `age-rating.md` | IARC questionnaire notes and expected rating |
| `capabilities.md` | Declared capabilities and the justification for each |
| `packaging.md` | How the MSIX package is built, what it changes compared with the GitHub build, and the certification note |

## Status

The Store **package** is produced: `npm run msix:package` assembles an MSIX from
the release binary, and `npm run check:msix` re-opens it with the Windows SDK's
own reader and verifies the manifest, the tiles and the file set. What is missing
is everything that needs an account rather than a build: the Partner Center
identity reservation (until it exists the package carries a local test identity
and is named `_test.msix`), Microsoft's signature, the IARC questionnaire, and
the submission itself. Those are recorded as FAIL items in
`docs/11-release/11-03-store-checklist.md`, not as completed work.
