# Zenith Privacy Policy

Version 1.0.0, effective 23 November 2026.

Publisher: Vellium Teknoloji Anonim Sirketi, Istanbul, Turkiye.
Contact: privacy@vellium.dev.

## 1. Summary

Zenith is a local-first Windows diagnostic and repair tool. It does not require
an account, it does not contain analytics, and it does not send telemetry unless
you turn telemetry on. Every measurement it shows is produced on your computer.

## 2. What Zenith reads

Zenith reads the following categories of data to diagnose a computer:

- Operating system name, build, architecture, and display language.
- Free and total memory, fixed disk capacity and free space, and uptime.
- Windows service states for the services named in the action catalogue.
- Event log entries that the selected diagnostic probe asks for.
- Process identity (name, path, start time, and process id) for processes that a
  running action must stop or that a cleanup action must skip.
- File metadata under the declared cleanup roots, for example modification time,
  size, and path. File contents are not read by cleanup.
- The contents of the folders the user explicitly chooses for a snapshot.

It does not read documents, browser history, keystrokes, the clipboard, or the
contents of arbitrary user files.

## 3. What Zenith stores

Data stays on the machine. The two roots are:

| Path | Contents |
| :--- | :--- |
| `%ProgramData%\Vellium\Zenith` | Machine-wide configuration, logs, snapshots, and the audit database |
| `%LOCALAPPDATA%\Vellium\Zenith` | Per-user preferences, window state, and support bundles |

Preferences are stored as JSON. The optional app lock secret is stored as a
PBKDF2-HMAC-SHA256 record with a random salt. Webhook or API secrets, when that
feature is enabled in a future release, are protected with Windows DPAPI and are
never written into the preferences file.

Support bundles are redacted before they are written: user names, host names,
tokens, passwords, bearer headers, JWTs, and connection strings are removed by the
redaction filter, and the bundle is bounded in size.

## 4. What leaves the computer

By default, nothing. The application works offline.

Three features can make a network request, and each one is off or inert until you
enable it:

1. **Update check.** When the update channel is GitHub Releases and automatic
   checks are on, Zenith asks `api.github.com` for the latest release tag. The
   request contains no identifier, no machine id, and no diagnostic data. Store
   builds use the Microsoft Store update path instead and never download an
   installer themselves.
2. **Telemetry.** Off by default. When enabled, it sends counts and timings for
   the diagnosis itself, never file contents and never a user or machine name.
   The switch is in Settings, Data and Backup, and turning it off stops the
   sender.
3. **Webhook.** Off by default. When configured, an HTTPS endpoint receives a
   signed event for completed, failed, or rolled back actions. The payload is the
   action id, the outcome, the duration, and the error code. It does not include
   file contents or user identity.

## 5. Legal bases under GDPR and KVKK

Where the GDPR applies, the legal basis for local processing is the performance
of the requested service (Article 6(1)(b)) and, for optional telemetry, consent
(Article 6(1)(a)). Under KVKK, the corresponding bases are Article 5(2)(c) for
the performance of a contract and Article 5(1) for explicit consent for optional
transfers. Consent can be withdrawn at any time in Settings.

## 6. Retention

- Snapshots and audit rows are pruned by the retention caps published in
  `docs/03-architecture/03-03-data-model-db.md`.
- Items moved to the trash are deleted after 30 days by default; the user can
  change the window between 7 and 365 days.
- Support bundles are written only when requested. They are not uploaded.

## 7. Your rights

You can inspect every stored file because it is on your disk. You can export the
settings document, import it on another machine, delete individual trash entries,
empty the trash, or purge local data from Settings, Data and Backup. For rights
requests that concern Vellium as a controller, write to privacy@vellium.dev. You
also have the right to complain to your supervisory authority, and in Turkiye to
the Personal Data Protection Authority (KVKK).

## 8. Children

Zenith is an administrative tool for Windows computers. It is not directed at
children and does not knowingly process children's data.

## 9. Changes

A material change to this policy is published with a new version number in the
repository, in the installer release notes, and in the in-app legal reader. The
version shown in the application is the version that applies to the installed
build.
