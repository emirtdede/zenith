# Age Rating Notes

| Field | Value |
| :--- | :--- |
| Document ID | DOC-STORE-003 |
| Version | 1.0.0 |
| Owner | Release Engineering |
| Closes | REQ-N-047 |

Zenith is a system administration tool. It contains no gameplay, no user
generated content, no advertising, no purchases, and no chat.

## IARC questionnaire answers

| Question | Answer |
| :--- | :--- |
| Violence | No |
| Blood | No |
| Sexual content or nudity | No |
| Profanity | No |
| Drugs, alcohol, or tobacco | No |
| Gambling | No |
| Fear or horror | No |
| User interaction or sharing | No |
| Location sharing | No |
| Personal information sharing | No |
| Digital purchases | No |
| Unrestricted web access | No |

## Expected rating

PEGI 3, ESRB Everyone, USK 0, and the equivalent "all ages" rating in other IARC
territories.

## Justification for the expected rating

The application displays technical measurements: memory, disk, service state,
event log rows, and action results. It does not display user documents. The only
outbound network calls are an update check, optional telemetry counters, and an
optional user-configured webhook; none carries user content or identity.

## One point a reviewer may ask about

The application can delete temporary files and stop services. That is a system
administration capability, not violent or otherwise restricted content. Every
destructive action requires an explicit confirmation, and irreversible actions
require the confirmation word defined in the action manifest.
