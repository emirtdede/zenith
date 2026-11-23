# KVKK and GDPR Notice

Version 1.0.0, effective 23 November 2026.

This notice explains the personal data processing that applies to Zenith under
the Turkish Personal Data Protection Law (KVKK, Law No. 6698) and, where it
applies, the EU General Data Protection Regulation (GDPR).

## 1. Data controller

Vellium Teknoloji Anonim Sirketi, Istanbul, Turkiye.
Privacy contact: privacy@vellium.dev.

For the local diagnostic data described below, Vellium is not a controller
because the data never reaches Vellium. The organisation or person who owns the
computer is the controller of that local data.

## 2. Categories of data

| Category | Where it lives | Recipient |
| :--- | :--- | :--- |
| Operating system facts, memory, disk, uptime | Local SQLite and memory | Nobody |
| Service state and event log entries selected by a probe | Local SQLite and logs | Nobody |
| Process identity for a stop or skip decision | Memory and the audit row | Nobody |
| File metadata under declared cleanup roots | Memory and the audit row | Nobody |
| Preferences and app lock record | Local JSON file | Nobody |
| Optional telemetry counters and timings | Sent to the configured collector only when enabled | Vellium or the operator's collector |
| Optional webhook event | Sent to the HTTPS endpoint the user configures | The user's endpoint |

## 3. Purposes

Local data is processed to perform the diagnosis or repair the user requested,
to keep an audit trail of what changed, and to allow a rollback. Optional
telemetry is processed to prioritise reliability work. It is not used for
advertising or profiling.

## 4. Transfers

Zenith does not transfer personal data abroad. An update check contacts GitHub,
which is a separate controller for the request metadata it receives. Enabling a
webhook sends the event to the endpoint the user chose, and the user is
responsible for that endpoint's location and terms.

## 5. Retention and deletion

Retention is bounded by the caps in `docs/03-architecture/03-03-data-model-db.md`.
The user can purge local data from Settings, Data and Backup. Uninstalling the
application offers to keep or delete `%ProgramData%\Vellium\Zenith` and
`%LOCALAPPDATA%\Vellium\Zenith`.

## 6. Rights

Under KVKK Article 11 and GDPR Articles 15 to 22, a data subject may request
access, correction, deletion, restriction, portability, and objection, and may
withdraw consent. Because local data is on the user's own disk, most of these
rights are exercised directly in the application. Requests concerning Vellium as
a controller can be sent to privacy@vellium.dev and are answered within 30 days.

## 7. Security measures

Local preference and audit files are written atomically. Secrets are protected
with Windows DPAPI. The app lock uses PBKDF2-HMAC-SHA256 with 600,000 iterations
and a per-record salt. Logs and support bundles pass a redaction filter before
they are written. The IPC surface is a fixed list of 15 typed commands, and the
renderer has no filesystem or shell access.

## 8. Complaints

You may complain to the Turkish Personal Data Protection Authority (KVKK) or to
the supervisory authority of your EU member state. We ask that you contact us
first so that we can resolve the issue.
