# Support Policy

Version 1.0.0, effective 23 November 2026.

## 1. Channels

| Channel | Address | Use for |
| :--- | :--- | :--- |
| GitHub Issues | `github.com/emirtdede/zenith/issues` | Reproducible bugs and feature requests in the free build |
| Support email | support@vellium.dev | Installation, licensing, and commercial questions |
| Security email | security@vellium.dev | Vulnerabilities, never a public issue |
| Privacy email | privacy@vellium.dev | Data protection requests |

## 2. Response targets

| Severity | Definition | First response |
| :--- | :--- | :--- |
| Critical | Data loss, privilege escalation, or the application cannot start for any user | 1 business day |
| High | A core action fails, or a snapshot cannot be restored | 2 business days |
| Normal | A screen is wrong, a label is missing, a non-core action fails | 5 business days |
| Request | A new action, language, or integration | Triaged monthly; not a promise |

These are targets for the free build. A commercial agreement can define a
shorter window and a named engineer.

## 3. What a useful report contains

1. Zenith version and build commit, from Settings, About, Copy technical detail.
2. Windows edition, build number, and architecture.
3. Whether the session was elevated.
4. The exact action or screen, and what you expected instead.
5. A support bundle if the report concerns a failure. Review it before sending:
   the bundle is redacted, but you should still read what you attach.

## 4. What support does not cover

- A machine that is already infected or administratively compromised.
- Recovering files that were deleted outside Zenith's snapshot scope.
- Third-party antivirus blocking the installer; we will name the block, not
  disable the product.
- A modified build. Reproduce on the published installer first.

## 5. End of support

A release receives security fixes for 12 months after the next minor release.
Windows versions below Windows 10 1809 are not supported. The Trust Center reports
a Windows build that is out of Microsoft support, and Zenith does not pretend the
machine is healthy when the operating system itself is unsupported.
