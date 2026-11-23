# Store Packaging Notes

| Field | Value |
| :--- | :--- |
| Document ID | DOC-STORE-006 |
| Version | 1.0.0 |
| Owner | Release Engineering |
| Closes | REQ-N-047 |

## Current state

`src-tauri/tauri.conf.json` declares `bundle.targets: ["nsis"]`. The icons are
still the Tauri defaults. Both facts block a Store submission and are recorded
as FAIL in the store checklist.

## Steps to produce the Store package

1. Replace the icon set with the Zenith brand set: `icon.ico` containing 16, 24,
   32, 48, 64, 128, and 256 pixel images, the PNG sizes Tauri requires, the
   `Square44x44Logo`, `Square150x150Logo`, `Wide310x150Logo`, `StoreLogo`, and
   `SplashScreen` assets.
2. Add the MSIX target and the Partner Center identity, publisher, and
   `PublisherDisplayName`.
3. Set the default update channel to `store` in the store profile. The renderer
   must not offer a download; it reports that the Store handles the update.
4. Remove any per-machine installer hook from the store package. An MSIX runs
   per user; the NSIS hook is not used.
5. Build, sign with the Partner Center certificate through the Store submission
   flow, and run the Windows App Certification Kit.
6. Capture the package hash and the certification report into `evidence/`.

## What must not differ

- The Rust core, the 15 IPC commands, and the validation rules.
- The privacy policy text and the in-app legal reader.
- The action manifest and its reversibility tiers.

A Store build that changes behaviour beyond the update channel and packaging is a
different product and needs its own review.
