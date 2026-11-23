# Zenith 1.0.0

| Field | Value |
| :--- | :--- |
| Document ID | DOC-11-04 |
| Version | 1.0.0 |
| Owner | Release Engineering |
| Closes | REQ-N-046 |

Zenith measures what is actually wrong with a Windows computer, explains the
result in plain language, and repairs only what you approve. Every action
declares how far it can be undone, and a reversible change takes a snapshot
first.

This file is the release text. It is written from `CHANGELOG.md` and
`public/legal/changelog.md`, not from commit titles; the two must say the same
thing.

## What is in this release

- **Diagnosis that measures.** 22 actions, a health score built from measured
  inputs rather than an estimate, and a plain-language reason for every finding.
- **Repairs with a way back.** A snapshot is taken before a reversible change,
  and the Trust Center shows exactly what a permanent action will destroy before
  it runs.
- **14 palettes, light and dark,** including a custom hex spectrum, with a
  520-check contrast gate over every palette in both modes.
- **73 languages.** English and Turkish ship complete catalogues; twelve more
  translate the application chrome; the remaining languages fall back to English
  and the picker says so.
- **A 12-leaf settings surface** whose tab name and panel heading are the same
  string, so the two cannot drift apart.
- **Local integrations.** A read-only MCP server over stdio, a loopback-only API
  with origin and token checks, a headless mode with `--json`, and an
  HMAC-SHA256 webhook that reports completed, failed, and rolled-back runs.
- **No account, no advertising, and no telemetry unless you turn it on.**

## Install

Download `Zenith_1.0.0_x64-setup.exe` below and verify it against
`SHA256SUMS.txt`. Windows 10 1809 or a later Windows 11 build is required.

The installer is a per-machine NSIS package and will ask for elevation. The
uninstaller removes your settings and snapshots only if you tick the box that
says so.

## Signature status

This build is **not Authenticode-signed**. The Trust Center reports the signature
as unverified rather than valid, because a running process cannot verify its own
chain and inventing a green tick would be a false security claim. Verify the
checksum before you run the installer. Code signing is tracked as an open item
and will be named in the next release's notes.

## Checksums

`SHA256SUMS.txt` contains one line per attached binary. Check it with:

```powershell
Get-FileHash .\Zenith_1.0.0_x64-setup.exe -Algorithm SHA256
```

## Known limitations

- The Microsoft Store package is not produced yet; this release is the GitHub
  channel only.
- 71 of the 73 languages fall back to English outside the translated chrome.
- The real-host Windows 10 and Windows 11 matrix is not complete.
