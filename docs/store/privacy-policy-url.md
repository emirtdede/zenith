# Privacy Policy URL

| Field | Value |
| :--- | :--- |
| Document ID | DOC-STORE-005 |
| Version | 1.0.0 |
| Owner | Release Engineering |
| Closes | REQ-N-046 |

## Required public URL

The Store submission requires a public HTTPS URL that resolves without a login
and without a Microsoft account. The policy text is maintained in this repository
at `public/legal/privacy.md`, and the installed application renders the same file
from the in-app Legal reader.

Candidate URLs, in order of preference:

1. `https://vellium.dev/en/legal/zenith-privacy` (Vellium legal hub, to be
   published by the web team)
2. `https://github.com/emirtdede/zenith/blob/main/public/legal/privacy.md`
   (rendered by GitHub over HTTPS, no login for a public repository)

The submission uses the first URL once it is live. The second is the fallback
while the legal hub page is not published. A policy that exists only inside the
installer is not accepted.

## Consistency requirement

The published page, the in-app reader, and the `privacy.md` in the release tag
must be the same text with the same version number. The release checklist includes
a diff step for the three copies.

## Data the policy must keep covering

- Local diagnostic reads and their storage roots.
- Optional telemetry, off by default.
- The GitHub update check.
- The optional user-configured webhook.
- Retention, export, and purge.
- KVKK and GDPR rights.

If a release adds a network path, the policy is updated before the release, not
after.
