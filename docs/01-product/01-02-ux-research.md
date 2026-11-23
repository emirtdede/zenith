# 01-02 - UX Research, Personas & Usability Protocol

| Field | Value |
| :--- | :--- |
| Document ID | ZEN-UX-001 |
| Version | 2.0.0 |
| Owner | Design / Product |
| Feeds | `05-02-ui-spec.md`, `06-01-i18n-strategy.md`, `02-01-srs-functional.md` |
| Status | Baseline; to be validated by study U-1 before 1.0 GA |
| Closes | No single defect - research baseline feeding `05-02` (DEF-042) and `06-01` (DEF-005) |

---

## 1. Why this document exists

v1.0.0 specified colour tokens and a component file list, then declared the UI "WCAG-verified"
without a single screen description, state, or user test. That is how a utility ends up with a
beautiful empty state and a terrifying confirmation dialog.

This document defines **who** we are designing for, **what they are trying to finish**, and **how
we will know the design works** before code exists.

---

## 2. Research inputs

| Input | Method | Sample | What it tells us |
| :--- | :--- | :--- | :--- |
| R-1 Task inventory | Structured interviews | 12 power users | Which repairs they actually attempt, in what order |
| R-2 Fear inventory | Critical-incident interviews | 9 users burned by cleaners | Which words trigger distrust ("clean", "optimise", "boost") |
| R-3 IT workflow | Shadowing + ticket sampling | 5 SMB IT generalists, 300 tickets | What evidence a ticket needs to close |
| R-4 Comprehension test | 5-second + think-aloud on v1 mockups | 8 participants | Whether "Partially Reversible" is understood |
| R-5 Locale stress test | Pseudo-localisation + native review | 6 locales first | Whether layouts survive German and Arabic |

> R-1..R-4 are the design basis for v2.0.0. Study **U-1** (§8) is the pre-GA validation and is a
> release gate for the *design*, not for this document.

---

## 3. Personas

### P1 - Deniz, 29, full-stack developer (Primary A)

| Attribute | Detail |
| :--- | :--- |
| Machine | 32 GB Windows 11 24H2 laptop, WSL2 + Docker, 4 JetBrains windows |
| Skill | High. Knows `netstat`, dislikes GUI tools that hide things |
| Trigger | "Port 3000 is in use", "Docker is eating 14 GB", "Teams froze" |
| Tolerance for interruption | Very low. Will not read a modal longer than one sentence |
| Trust signal | Sees the exact command or the exact PID before it dies |
| Deal-breaker | A tool that kills the wrong process, or needs an account |
| Success moment | Sees `node.exe (PID 24188) · started 14:02 · port 3000` and clicks Kill |

**Design implication:** the port modal is a *precision instrument*, not a list. Show identity,
start time, memory, redacted command line. Never offer "kill all node".

### P2 - Ayşe, 41, office operations lead (Primary A, low-skill edge)

| Attribute | Detail |
| :--- | :--- |
| Machine | 16 GB Windows 11, Outlook + Teams + Excel all day, OneDrive |
| Skill | Medium-low. Uses Settings, avoids registry |
| Trigger | "Computer is slow", "Printer won't print", "Excel is not responding" |
| Tolerance | Low. Fears deleting work |
| Trust signal | Plain language, a visible undo, and no jargon in the primary path |
| Deal-breaker | Losing an unsaved document, or a reboot she did not schedule |
| Success moment | Clicks one button, sees "Freed 2.4 GB · nothing was deleted that you can't get back" |

**Design implication:** the primary path is three controls: *Diagnose*, *Fix safe things*, *Undo*.
Everything technical lives one level down, never in the way.

### P3 - Murat, 36, sole IT generalist at a 180-person company (Primary B)

| Attribute | Detail |
| :--- | :--- |
| Machine | Windows 11 admin workstation, 40 open RDP sessions, Intune + a ticket queue |
| Skill | Very high on Windows, moderate on scripting |
| Trigger | "Laptop is slow again" ticket #4471, third time this month |
| Tolerance | Medium, but zero tolerance for unverifiable actions |
| Trust signal | An audit line he can paste into the ticket; a script he can read |
| Deal-breaker | Anything that reboots without consent, or writes state to a user profile that vanishes under UAC |
| Success moment | Exports `zenith-maintenance.ps1`, attaches the audit summary, closes the ticket in 4 minutes |

**Design implication:** audit export and script export are first-class, not buried in settings.
The elevation handover must not lose the user's selection (`03-04` §5.4).

### P4 - Lena, 52, compliance-minded IT manager (Buyer, not daily user)

| Attribute | Detail |
| :--- | :--- |
| Cares about | Signed binaries, data leaving the machine, licence terms, uninstall cleanliness |
| Reads | Security page, privacy page, SBOM, EULA - in that order |
| Deal-breaker | A "telemetry on by default" checkbox, or unsigned installers |

**Design implication:** the app ships a readable **Trust Center** screen: version, signature
status, exactly what is stored and where, a one-click "delete all Zenith data", and a link to the
privacy document. This screen is a sales asset.

### P5 - Kaan, 24, gamer/streamer (Secondary)

Trigger: stutter, shader cache, GPU driver oddities, "reset graphics driver".
Needs `reset-gpu-driver` and `clean-temp-cache`; will never read documentation.
**Implication:** every action card must be understandable from its title + one-line impact.

---

## 4. Jobs-to-be-done → screen map

| JTBD | Entry screen | Primary control | Confirmation level |
| :--- | :--- | :--- | :--- |
| JTBD-1 diagnose | Health Monitor | "Run full diagnostics" | none |
| JTBD-2 reclaim space | Cleanup tab | card action button | none (safe) / modal (irreversible) |
| JTBD-3 free a port | Dev tab → Port modal | "Terminate selected" | per-row identity check |
| JTBD-4 close hung Office | Dev tab → Hung modal | "Close selected" | warning about AutoRecover |
| JTBD-5 fix network | Network tab | card action | modal for Winsock |
| JTBD-6 repair Windows | Recovery tab | "Repair Windows" chain | modal explaining DISM→SFC order |
| JTBD-7 printer | Recovery tab | card action | none |
| JTBD-8 undo | Snapshot History | "Rollback" | modal with diff preview |
| JTBD-9 fleet | Script Exporter | "Download .ps1" | none |
| JTBD-10 proof | Audit / Copy summary | "Copy summary" | none |

---

## 5. Key journeys

### J-1 First run → first success (target 90 s)

```text
Launch
  │  (first-run only) one-screen orientation: what it does, what it never does, where data lives
  ▼
Health Monitor populates (diagnostics run automatically, read-only)
  │  health ring + 4 metric tiles + "3 issues found"
  ▼
User clicks "Fix safe things" (safe preset)
  │  inline checklist expands: 4 steps, each with tier badge
  ▼
Progress in place (no modal): spinner → check / cross per step, live log collapsed
  ▼
Result banner: "Reclaimed 2.4 GB · 4 of 4 steps succeeded · Undo available for 2"
  │
  ├─→ "View details" opens the log drawer
  └─→ "Undo" opens Snapshot History filtered to this run
```

Failure path: if a step needs admin, the banner says `1 step needs Administrator` and offers one
elevation button that re-launches with the queue preserved.

### J-2 Destructive action with a real warning (J-4, `clean-temp-cache` is not; `empty-recycle-bin` is)

```text
Card → "Empty Recycle Bin" → modal
  ├─ Title: "Permanently delete 1,284 items (3.1 GB)?"
  ├─ Body: what happens, that it cannot be undone, that files are not recoverable
  ├─ Risk badge: IRREVERSIBLE (danger colour, icon + text, never colour alone)
  ├─ Primary button: "Delete permanently" (destructive style, NOT default focus)
  └─ Secondary: "Cancel" (default focus, Esc works)
```

Rule: **the destructive button is never the initial focus and never the Enter key target.**

### J-3 Rollback of a partially reversible action

```text
Snapshot History → row (action, time, tier, status)
  → "Preview" shows: what will be restored, what will NOT be restored, estimated time
  → "Rollback" → progress → result with per-item outcome
  → If HMAC verification fails: refuse, explain, offer support bundle
```

### J-4 Elevation handover (standard user → admin)

```text
Pre-flight panel lists: 5 selected, 2 require admin
  → "Restart as Administrator" (single UAC prompt)
  → app relaunches elevated with --wait-pid + --resume-queue
  → selection is restored, focused on the first pending step
  → original window exits cleanly; elevated window owns the run
```

---

## 6. Information architecture

One window, a persistent rail plus one content column, one overlay system. No nested navigation,
no hamburger. The rail is the only navigation landmark; everything that is not "where can I go"
lives in the workspace column.

```text
┌ Sidebar ──────┬ Toolbar ──────────────────────────────────────────────────┐
│ Z  Zenith     │ [Search or run a command        Ctrl K]   [Admin] [Notices]│
│ Diagnose      ├───────────────────────────────────────────────────────────┤
│ first.        │ [SIMULATION: no OS changes]  (only when no host is bound) │
│ Change        ├───────────────────────────────────────────────────────────┤
│ second.       │ Score 87  Junk 2.4 GB  DNS 62 ms  RAM 71%     [Diagnose]  │
│               ├───────────────────────────────────────────────────────────┤
│ All actions   │ All · Cleanup · Network · Recovery · Dev & Office  [search]│
│ Undo history  ├───────────────────────────────────────────────────────────┤
│ Activity log  │ ActionGrid (1-3 columns by width)                         │
│ Trust Center  │ card  card  card                                          │
│ Settings      │ card  card  card                                          │
│ Help          │                                                           │
│               │                                                           │
│ [Theme]       ├───────────────────────────────────────────────────────────┤
│ [Reduce      │ [Console] 22 actions · 3 issues · last scan 14:02  [Cancel]│
│  motion]      │                                                           │
└───────────────┴───────────────────────────────────────────────────────────┘
Overlays: Console drawer (bottom sheet) · dialogs (confirm, script, candidates,
          purge) · Command palette (Ctrl K). Overlays cover the workspace, never
          the process.
```

At `max-width: 900px` the rail collapses to a 3.75 rem icon strip. The labels are clipped
visually but stay in the accessibility tree through `aria-label`, so 400% zoom still offers all
six destinations to a pointer user (WCAG 1.4.10).

Rationale: the object of the app is an **action**, so actions own the canvas. Health is a
persistent strip because it is the answer to "should I be here at all". Everything else is an
overlay so the mental model never changes.

---

## 7. Cognitive and trust design rules

| # | Rule | Rationale | Enforcement |
| :--- | :--- | :--- | :--- |
| T1 | Never use the words *boost*, *optimise*, *speed up*, *tune* | R-2: these words caused distrust in 9/9 incidents | Copy lint in `06-01` §9 |
| T2 | Every destructive verb appears next to its object and its count | "Delete 1,284 items", not "Clean now" | Design review checklist |
| T3 | Reversibility is stated in the card, before interaction | P1/P3 need to decide without opening anything | `05-02` §4.3 |
| T4 | Colour is never the only carrier of meaning | WCAG 1.4.1 | `05-03` §4 |
| T5 | Progress is shown where the action lives, not in a global spinner | Prevents "is it frozen?" | `05-02` §4.4 |
| T6 | Numbers carry units and a timestamp | "2.4 GB · measured 14:02" | Copy spec |
| T7 | No modal for anything reversible and fast (< 2 s) | Modal fatigue | `05-02` §6 |
| T8 | The default focused control is never destructive | Error prevention | `05-03` §5.3 |
| T9 | Errors say what happened, what was preserved, what to do next | Support load | `05-02` §7 |
| T10 | The Trust Center is reachable in ≤ 2 clicks from anywhere | Buyer requirement P4 | IA |

---

## 8. Usability validation protocol (study U-1)

**Status:** defined, not yet run. Blocks GA, not implementation.

| Element | Definition |
| :--- | :--- |
| Participants | 12: 6 power users, 4 office users, 2 IT generalists. Screen-share, 45 min, unmoderated tasks + moderated debrief |
| Tasks | T1 find what is wrong; T2 run safe preset; T3 free port 3000; T4 undo a change; T5 export script; T6 find where data is stored; T7 identify which action needs admin |
| Metrics | Task success (binary), time on task, error count, SUS score, single-ease question (SEQ) |
| Pass thresholds | Task success ≥ 90% for T1-T3, T7; ≥ 80% for T4-T6. Median SEQ ≥ 6.0/7. SUS ≥ 80 |
| Comprehension check | 5/6 participants must correctly explain "Partially Reversible" after reading the card |
| Localisation check | Same T1-T3 in `de` (long strings) and `ar` (RTL) with 4 native speakers; zero clipped controls |
| Artifacts | `docs/05-design/research/U-1-report.md` - **does not exist yet; written after the study runs** (the study is `defined, not yet run` above, so this row is a plan, not a deliverable) - plus a revised `05-02` if any task fails |

**Failure handling:** any failed threshold creates a `DEF` entry in `10-02`, a design change, and a
re-run of the affected task with 4 participants.

---

## 9. Content design principles

Voice: **a competent colleague**, not a mascot and not a lawyer.

| Situation | Bad (v1.0.0 style) | Good (v2.0.0) |
| :--- | :--- | :--- |
| Cleanup card | "Boost your PC performance!" | "Delete Windows temp files older than 24 hours" |
| Irreversible warning | "This action cannot be undone." | "These 1,284 files are permanently deleted. Windows will not keep a copy." |
| Progress | "Please wait…" | "Repairing component store · 42% · about 6 min left" |
| Error | "Win32ApiFailure: 0x80070005" | "Windows denied access to the print spooler. Nothing was deleted. Restart Zenith as Administrator and try again." |
| Success | "Done!" | "Freed 2.4 GB. 214 files skipped because they were in use." |
| Empty state | "No data" | "Nothing found on ports 3000-9999. That is a good sign." |

**Rule:** every user-facing string is a key in `06-01`, never an inline literal, and every string
is written at ≤ 8th-grade reading level in English before translation.

---

## 10. What this document changes in the build

| Consequence | Artifact |
| :--- | :--- |
| 6 screens + 5 overlays must be specified with states | `05-02` |
| Copy must be externalised with ICU support | `06-01` |
| Trust Center is a required screen, not optional | REQ-F-110 |
| Destructive focus rule is testable | REQ-N-041 |
| U-1 study is a GA gate | `08-02` §6 |
| Persona-driven acceptance criteria are testable | `02-01` §9 |
