# Security Policy

Version 1.0.0, effective 23 November 2026.

## 1. Supported versions

| Version | Security fixes |
| :--- | :--- |
| 1.0.x | Yes |
| Older | No; upgrade to 1.0.x |

## 2. Reporting a vulnerability

Do not open a public issue for a vulnerability. Write to security@vellium.dev
with:

- the version and build commit from Settings, About;
- the Windows build and architecture;
- a description, the impact, and the steps that reproduce it;
- any log or support bundle, after you have reviewed the redaction.

If you need encryption, say so in the first message and we will send a key.

## 3. What to expect

- Acknowledgement within two business days.
- An initial assessment within five business days.
- A fix or a mitigation plan within 30 days for a high severity issue.
- Credit in the release notes if you want it.

We do not pay a bounty for the free build. We do not ask a reporter to sign a
non-disclosure agreement before a fix ships.

## 4. Scope

In scope:

- The Tauri command surface and its validation.
- The elevation handover and the single-instance guard.
- Snapshot creation, verification, and restore.
- The redaction filter and support bundle contents.
- The app lock record and its lockout behaviour.
- Installer and uninstaller privilege boundaries.

Out of scope:

- A machine that is already compromised by an administrator.
- Denial of service by deleting the application's own files.
- Third-party tools that Zenith invokes, unless Zenith passes them unsafe input.

## 5. Design rules a report can rely on

- The renderer has no filesystem, shell, or network plugin permission. Every
  file operation is a typed command in the Rust core.
- There are exactly 15 IPC commands, documented in
  `docs/03-architecture/03-04-ipc-contract.md`.
- The core rejects a path outside the declared scope, an archive entry that
  escapes its folder, a snapshot whose hash does not verify, and a handover whose
  nonce does not match.
- Secrets are protected with Windows DPAPI. They are never written to the
  settings JSON.
- The application does not load remote code. The Content Security Policy allows
  only `self` and the IPC origin.
