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
| `packaging.md` | What the Store build must change compared with the GitHub build |

## Status

The Store build is not yet produced. `src-tauri/tauri.conf.json` targets NSIS
only. Store submission requires an MSIX/APPX target, a Partner Center identity,
and a package signed by Microsoft. These are recorded as FAIL items in
`docs/11-release/11-03-store-checklist.md`, not as completed work.
