# ZENITH - DETERMINISTIC SYSTEM DIAGNOSTIC & SELF-HEALING ENGINE

**Greenfield Master Engineering Specification v1.0.0**  
*(PRD + SRS + SAD + Exact Rust/TypeScript Contracts + Win32 FFI Safety + Zero-API-Key 73-Locale Agent-Native i18n + Work Packages)*

* **Project Name:** Zenith
* **Organization / Owner:** Vellium - Emir Tarık Dede (`emirtdede@gmail.com`)
* **Version:** `1.0.0` (Greenfield Initial Release)
* **Date:** 18 November 2026
* **Target AI Execution Engine:** Gemini 4 Hydrogen (1M Context Window, Declarative Zero-Stub Synthesis)
* **Distribution & Licensing:** Open-Core (Core Desktop & CLI Engine: MIT License | Enterprise Fleet Telemetry Extension: Vellium Commercial License, separated via Cargo feature flag `enterprise-telemetry` disabled by default)
* **Supported Operating Systems:**
  1. **Primary Support:** Windows 11 23H2 (Build 22631), 24H2 (Build 26100), 25H2 (Build 26200), and 26H2 (Build 26300+).
  2. **Legacy Support:** Windows 10 22H2 (Build 19045) with explicit ESU (Extended Security Updates) status detection (Mainstream Windows 10 support ended 14 October 2025; Zenith detects non-ESU Build 19045 systems and displays an informational lifecycle banner).
  3. **Browser Preview Simulator Mode:** Deterministic UI/UX preview mode when `window.__TAURI_INTERNALS__` is absent (explicitly badged in UI as `"SIMULATION MODE - NO OS CHANGES"`).

---

## SECTION 0: MANDATORY AI CODING AGENT DIRECTIVES (`.rules` ENFORCEMENT)

> **DECLARATIVE EXECUTION MANDATE FOR GEMINI 4 HYDROGEN:**
> You are building **Zenith v1.0.0** from scratch in an empty repository. Obey these immutable engineering laws:
>
> 1. **Single Configuration Authority:** The repository MUST rely exclusively on a single root-level `.rules` file. Creating `.cursorrules`, `.clinerules`, `.roorules`, `.windsurfrules`, or any tool-specific configuration file is strictly forbidden.
> 2. **Zero Stub / Zero Placeholder Policy:** Using `todo!()`, `unimplemented!()`, `// TODO`, `// placeholder`, or truncated arrays to mark a phase complete is strictly forbidden.
> 3. **Zero-API-Key Agent-Native 73-Locale Translation:** Do NOT use `@google/genai` or any external translation API key. You (Gemini 4 Hydrogen) MUST directly author and populate the native translation files for all 73 locales in `src/i18n/locales/<code>.json` during **WP-2**, and verify 100% key parity, placeholder parity (`{count}`, `{sizeMb}`, `{port}`), and non-English translation completeness via `npm run i18n:validate` (`scripts/validate-i18n.ts`).
> 4. **Zero-Trust IPC & TOCTOU Protection:** The React frontend must NEVER transmit raw shell commands over Tauri IPC. Process termination requests (`TerminatePidsRequest`) MUST carry `{ pid, expectedName, expectedStartTimeUnix }` and the Rust backend MUST verify all three fields before calling `TerminateProcess` to prevent PID-reuse TOCTOU kills.
> 5. **Strict JSON Compliance:** Never insert `//` or `/* */` comments inside `.json` files (`package.json`, `tsconfig.json`, `tauri.conf.json`, `capabilities/default.json`, or `src/i18n/**/*.json`).

---

## SECTION 1: ENGINEERING AUDIT CLOSURES & ARCHITECTURAL DECISIONS

This specification directly resolves every failure mode identified in prior architecture reviews:

1. **Build Order & `tauri::generate_context!()` Guarantee:**
   `tauri::generate_context!()` panics at compile time if `frontendDist` (`../dist`) does not exist on disk. Therefore, **WP-1** and **WP-2** build a complete minimal `dist/` bundle (`npm run build`) *before* **WP-3** runs `cargo check` or `cargo test`.
2. **Honest 4-Tier Reversibility Model (`ReversibilityTier`):**
   Actions never claim fake 100% rollback. Every action declares one of four honest tiers:
   * `FullyReversible`: Exact prior state (Registry values, service startup/running state, or archived files) is restored atomically from SQLite + verified ZIP backups.
   * `PartiallyReversible`: Primary config is restored, but secondary caches rebuild dynamically.
   * `CompensatingRecovery`: OS-level catalog resets (`reset-winsock-stack`) create a Windows System Restore Point (`Checkpoint-Computer`) and export raw registry hives (`reg.exe save`) prior to execution, requiring an OS reboot to finalize or revert.
   * `Irreversible`: Destructive cache/temp/recycle-bin purges (`clean-temp-cache`, `empty-recycle-bin`) or official system repair tools (`dism-restore-health`, `sfc-system-scan`). `empty-recycle-bin` is classified as `moderate` risk, excluded from `Safe Batch`, and requires explicit user confirmation.
3. **UAC Split-Brain Prevention (`C:\ProgramData\Vellium\Zenith`):**
   Storing SQLite state in `%LOCALAPPDATA%` breaks during "Over-the-Shoulder" UAC elevation (where a standard user enters an Administrator account's credentials, causing the elevated process to resolve a different user profile's `%LOCALAPPDATA%`). Zenith resolves its shared storage directory to `C:\ProgramData\Vellium\Zenith` (falling back to `%LOCALAPPDATA%\Vellium\Zenith` only if `ProgramData` creation fails in restricted sandboxes) and supports multi-action batch handover via `--wait-pid <PID> --resume-queue <CSV_ACTION_IDS>`.
4. **Crash-Safe 4-Phase Transactional File Archiving & Path-Traversal Guard:**
   File archiving (`archive-screenshots`, `rebuild-icon-cache`, `reset-print-spooler`, `clear-teams-outlook-cache`) uses a strict write-ahead sequence:
   * **Phase 1:** Write files with relative path preservation into `<archive>.zip.tmp`.
   * **Phase 2:** Flush, close, re-open `<archive>.zip.tmp`, iterate entries to verify CRC32 integrity, compute SHA-256 over the closed ZIP file, and atomically rename `<archive>.zip.tmp` $\to$ `<archive>.zip`.
   * **Phase 3:** Insert `snapshots` row in SQLite with `status = 'COMMITTED'` and HMAC-SHA256 integrity tag (keyed with machine-local `MachineGuid`).
   * **Phase 4:** Move original files to the Recycle Bin (`trash::delete_all`) or remove unlocked cache files. On startup, `recover_incomplete_transactions()` deletes any orphaned `*.zip.tmp` files and marks uncommitted rows as `ABORTED`. During rollback extraction, every ZIP entry is sanitized via `entry.enclosed_name()` to prevent Zip-Slip (`../`) path traversal.
5. **Memory-Aligned Win32 FFI (`Vec<u64>`) & Explicit HRESULT Propagation:**
   * `GetExtendedTcpTable` allocates an 8-byte aligned buffer (`vec![0u64; (size as usize + 7) / 8]`), retries in a loop on `ERROR_INSUFFICIENT_BUFFER (122)`, and clamps `dwNumEntries` against actual byte capacity before pointer arithmetic.
   * `SHQueryRecycleBinW` and `SHEmptyRecycleBinW` propagate non-zero `HRESULT` failures explicitly (`S_OK` / `0x8000FFFF` empty-bin distinction) instead of discarding return values with `let _ =`.
6. **Stateful UTF-16LE Stream Decoder & Cancellable Child Processes with Timeouts:**
   * `sfc.exe` and `dism.exe` output streams use a stateful `Utf16LeStreamDecoder` that handles BOM (`0xFF 0xFE`) and carries trailing odd bytes across `read()` chunks so line splits never corrupt character alignment.
   * Every child process is spawned with an `AtomicBool` cancellation token and a per-action hard timeout (`cancel_running_action` IPC command kills the process tree cleanly).
7. **Real GPU Driver Reset (`SendInput` Win+Ctrl+Shift+B):**
   Instead of a placebo `ChangeDisplaySettingsExW(CDS_RESET)` call, `reset-gpu-driver` synthesizes the official Windows kernel graphics driver reset chord (`VK_LWIN + VK_CONTROL + VK_SHIFT + 0x42 ('B')`) via Win32 `SendInput`, which instructs DWM and the WDDM display driver to reinitialize the display surface natively.

---

## SECTION 2: EXACT REPOSITORY FILE TREE & CONFIGURATION FILES

### 2.1 Repository File Tree

```
zenith/
├── .rules
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
├── public/
│   └── app-icon.svg
├── scripts/
│   └── validate-i18n.ts
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── styles/
│   │   └── index.css
│   ├── types/
│   │   └── zenith.ts
│   ├── data/
│   │   └── actionsCatalog.ts
│   ├── utils/
│   │   ├── dagSort.ts
│   │   ├── healthScore.ts
│   │   ├── deepMerge.ts
│   │   └── scriptGenerator.ts
│   ├── i18n/
│   │   ├── registry.ts
│   │   ├── engine.ts
│   │   ├── master/
│   │   │   ├── tr.json
│   │   │   └── en.json
│   │   └── locales/
│   │       └── [73 agent-translated locale JSON files: tr.json, en.json, ko.json, ...]
│   ├── adapters/
│   │   ├── bridge.ts
│   │   ├── tauriAdapter.ts
│   │   └── simulatorAdapter.ts
│   ├── store/
│   │   └── useZenithStore.ts
│   ├── components/
│   │   ├── TitleBar.tsx
│   │   ├── HealthMonitor.tsx
│   │   ├── CategoryTabs.tsx
│   │   ├── ActionCard.tsx
│   │   ├── TerminalLogDrawer.tsx
│   │   ├── PortProcessModal.tsx
│   │   ├── ScriptExporterModal.tsx
│   │   ├── SnapshotHistoryModal.tsx
│   │   ├── CommandPalette.tsx
│   │   └── EffectsOverlay.tsx
│   └── __tests__/
│       └── zenith.test.ts
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json
    ├── capabilities/
    │   └── default.json
    ├── icons/
    │   └── [Generated via npm run icons:gen]
    └── src/
        ├── main.rs
        ├── lib.rs
        ├── models.rs
        ├── error.rs
        ├── engine/
        │   ├── mod.rs
        │   ├── db.rs
        │   ├── dag.rs
        │   └── telemetry.rs
        └── adapters/
            ├── mod.rs
            ├── uac.rs
            ├── fs_clean.rs
            ├── net.rs
            ├── scm.rs
            ├── proc.rs
            └── shell_iso.rs
```

### 2.2 Root `.rules` File

```markdown
# VELLIUM PROJECT GOVERNANCE (.rules)
1. Single Configuration Authority: Only this root `.rules` file governs AI coding assistants. Never create `.cursorrules`, `.clinerules`, `.roorules`, or `.windsurfrules`.
2. Zero Stub Policy: Never use `todo!()`, `unimplemented!()`, placeholder comments, or truncated dictionaries.
3. Agent-Native 73-Locale Translation: Populate all 73 locale JSON files directly using native translations and verify with `npm run i18n:validate`. Never copy English strings into non-English locale files.
4. Zero-Trust IPC & TOCTOU Safety: Never send raw shell strings over IPC. Verify `(pid, expected_name, expected_start_time_unix)` before terminating any process.
5. Non-Blocking IPC: Wrap all synchronous Rust OS/DB work in `tokio::task::spawn_blocking`.
6. Build Verification Order: Always run `npm run build` before `cargo test` or `cargo check` so `../dist` exists for `tauri::generate_context!()`.
```

### 2.3 Root `package.json` (Exact Pinned Versions, Zero External AI SDK Dependencies)

```json
{
  "name": "zenith",
  "private": true,
  "version": "1.0.0",
  "description": "Deterministic Windows System Diagnostic, Self-Healing & Telemetry Engine",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "i18n:validate": "tsx scripts/validate-i18n.ts",
    "icons:gen": "tauri icon public/app-icon.svg",
    "tauri": "tauri",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build"
  },
  "dependencies": {
    "@tauri-apps/api": "2.2.0",
    "@tauri-apps/plugin-clipboard-manager": "2.2.0",
    "@tauri-apps/plugin-dialog": "2.2.0",
    "@tauri-apps/plugin-fs": "2.2.0",
    "clsx": "2.1.1",
    "lucide-react": "0.475.0",
    "motion": "12.4.2",
    "react": "19.0.0",
    "react-dom": "19.0.0",
    "tailwind-merge": "3.0.1",
    "zustand": "5.0.3"
  },
  "devDependencies": {
    "@tailwindcss/vite": "4.0.6",
    "@tauri-apps/cli": "2.2.0",
    "@types/node": "22.13.4",
    "@types/react": "19.0.8",
    "@types/react-dom": "19.0.3",
    "@vitejs/plugin-react": "4.3.4",
    "jsdom": "26.0.0",
    "tsx": "4.19.2",
    "typescript": "5.7.3",
    "vite": "6.1.0",
    "vitest": "3.0.5"
  }
}
```

### 2.4 Root `tsconfig.json` & `vite.config.ts` (`vitest/config` Typed)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["vite/client", "vitest/globals", "node"]
  },
  "include": ["src", "scripts", "vite.config.ts"]
}
```

```typescript
// vite.config.ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'esnext',
    minify: 'esbuild',
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
```

### 2.5 Backend `src-tauri/Cargo.toml` & `src-tauri/build.rs`

```toml
[package]
name = "zenith"
version = "1.0.0"
description = "Zenith Deterministic System Diagnostic and Remediation Engine"
authors = ["Emir Tarık Dede <emirtdede@gmail.com>"]
license = "MIT"
edition = "2021"

[features]
default = []
enterprise-telemetry = []

[build-dependencies]
tauri-build = { version = "=2.0.5", features = [] }

[dependencies]
tauri = { version = "=2.2.0", features = [] }
tauri-plugin-dialog = "=2.2.0"
tauri-plugin-fs = "=2.2.0"
tauri-plugin-clipboard-manager = "=2.2.0"
serde = { version = "=1.0.217", features = ["derive"] }
serde_json = "=1.0.138"
thiserror = "=2.0.11"
tokio = { version = "=1.43.0", features = ["full"] }
sysinfo = "=0.33.1"
rusqlite = { version = "=0.32.1", features = ["bundled", "chrono"] }
chrono = { version = "=0.4.39", features = ["serde"] }
sha2 = "=0.10.8"
hmac = "=0.12.1"
hex = "=0.4.3"
zip = { version = "=2.2.2", default-features = false, features = ["deflate"] }
walkdir = "=2.5.0"
trash = "=5.2.1"
clap = { version = "=4.5.28", features = ["derive"] }

[target.'cfg(windows)'.dependencies]
winreg = "=0.52.0"
windows = { version = "=0.58.0", features = [
    "Win32_Foundation",
    "Win32_Security",
    "Win32_System_Services",
    "Win32_System_Threading",
    "Win32_System_Registry",
    "Win32_System_Com",
    "Win32_System_SystemInformation",
    "Win32_NetworkManagement_IpHelper",
    "Win32_Networking_WinSock",
    "Win32_Networking_WinInet",
    "Win32_UI_Shell",
    "Win32_UI_WindowsAndMessaging",
    "Win32_UI_Input_KeyboardAndMouse",
    "Win32_Graphics_Gdi"
] }
```

```rust
// src-tauri/build.rs
fn main() {
    tauri_build::build()
}
```

### 2.6 Master Vector Icon (`public/app-icon.svg`)

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="112" fill="#09090B" />
  <rect x="24" y="24" width="464" height="464" rx="92" fill="none" stroke="#27272A" stroke-width="8" />
  <path d="M128 144H384L208 368H384" fill="none" stroke="#F4F4F6" stroke-width="44" stroke-linecap="round" stroke-linejoin="round" />
  <circle cx="384" cy="144" r="24" fill="#22C55E" />
</svg>
```

### 2.7 Strict Comment-Free `src-tauri/tauri.conf.json` & `src-tauri/capabilities/default.json`

`src-tauri/tauri.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Zenith",
  "version": "1.0.0",
  "identifier": "com.vellium.zenith",
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  },
  "app": {
    "macOSPrivateApi": false,
    "windows": [
      {
        "label": "main",
        "title": "Zenith - System Diagnostic & Self-Healing Engine",
        "width": 1180,
        "height": 800,
        "minWidth": 960,
        "minHeight": 680,
        "decorations": false,
        "transparent": true,
        "center": true,
        "resizable": true
      }
    ],
    "security": {
      "csp": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: asset:; media-src 'self' data:; connect-src ipc: http://ipc.localhost"
    }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis", "msi"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "windows": {
      "webviewInstallMode": {
        "type": "downloadBootstrapper"
      },
      "nsis": {
        "installMode": "perMachine"
      }
    }
  }
}
```

`src-tauri/capabilities/default.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Default ACL capabilities for Zenith main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:event:default",
    "core:window:default",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
    "core:window:allow-start-dragging",
    "clipboard-manager:default",
    "clipboard-manager:allow-write-text",
    "dialog:default",
    "dialog:allow-save",
    "fs:default",
    "fs:allow-write-text-file"
  ]
}
```

---

## SECTION 3: COMPLETE DATA MODELS, ERROR CONTRACTS, SQLITE WAL & WIN32 FFI

### 3.1 Complete Rust Domain Models (`src-tauri/src/models.rs`)

```rust
// src-tauri/src/models.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActionId {
    CleanTempCache,
    EmptyRecycleBin,
    ArchiveScreenshots,
    WingetUpgradeAll,
    WindowsUpdateScan,
    FlushDnsCache,
    ResetWinsockStack,
    ClearStuckProxyVpn,
    SyncNtpTime,
    CopySysadminInfo,
    DismRestoreHealth,
    SfcSystemScan,
    RestartExplorer,
    RebuildIconCache,
    RestartBluetooth,
    ResetPrintSpooler,
    ResetGpuDriver,
    ControlledReboot,
    UnlockDevPorts,
    CloseHungOffice,
    ClearTeamsOutlookCache,
    ReclaimWslDockerRam,
}

impl ActionId {
    pub fn as_str(&self) -> &'static str {
        match self {
            ActionId::CleanTempCache => "clean-temp-cache",
            ActionId::EmptyRecycleBin => "empty-recycle-bin",
            ActionId::ArchiveScreenshots => "archive-screenshots",
            ActionId::WingetUpgradeAll => "winget-upgrade-all",
            ActionId::WindowsUpdateScan => "windows-update-scan",
            ActionId::FlushDnsCache => "flush-dns-cache",
            ActionId::ResetWinsockStack => "reset-winsock-stack",
            ActionId::ClearStuckProxyVpn => "clear-stuck-proxy-vpn",
            ActionId::SyncNtpTime => "sync-ntp-time",
            ActionId::CopySysadminInfo => "copy-sysadmin-info",
            ActionId::DismRestoreHealth => "dism-restore-health",
            ActionId::SfcSystemScan => "sfc-system-scan",
            ActionId::RestartExplorer => "restart-explorer",
            ActionId::RebuildIconCache => "rebuild-icon-cache",
            ActionId::RestartBluetooth => "restart-bluetooth",
            ActionId::ResetPrintSpooler => "reset-print-spooler",
            ActionId::ResetGpuDriver => "reset-gpu-driver",
            ActionId::ControlledReboot => "controlled-reboot",
            ActionId::UnlockDevPorts => "unlock-dev-ports",
            ActionId::CloseHungOffice => "close-hung-office",
            ActionId::ClearTeamsOutlookCache => "clear-teams-outlook-cache",
            ActionId::ReclaimWslDockerRam => "reclaim-wsl-docker-ram",
        }
    }

    pub fn requires_admin(&self) -> bool {
        matches!(
            self,
            ActionId::WindowsUpdateScan
                | ActionId::ResetWinsockStack
                | ActionId::SyncNtpTime
                | ActionId::DismRestoreHealth
                | ActionId::SfcSystemScan
                | ActionId::RestartBluetooth
                | ActionId::ResetPrintSpooler
                | ActionId::ControlledReboot
        )
    }

    pub fn timeout_secs(&self) -> u64 {
        match self {
            ActionId::DismRestoreHealth | ActionId::SfcSystemScan | ActionId::WingetUpgradeAll => 1800,
            ActionId::WindowsUpdateScan => 180,
            _ => 45,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReversibilityTier {
    FullyReversible,
    PartiallyReversible,
    CompensatingRecovery,
    Irreversible,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionPhase {
    Idle,
    Diagnosing,
    Healthy,
    NeedsAttention,
    Running,
    Success,
    Error,
    SkippedDependency,
    Cancelled,
    RolledBack,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticReport {
    pub action_id: ActionId,
    pub needs_attention: bool,
    pub severity_weight: u8,
    pub metric_summary: String,
    pub reclaimable_bytes: u64,
    pub latency_ms: Option<u32>,
    pub can_rollback: bool,
    pub latest_snapshot_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionOutcome {
    pub action_id: ActionId,
    pub phase: ExecutionPhase,
    pub success: bool,
    pub duration_ms: u64,
    pub summary_message: String,
    pub snapshot_id: Option<String>,
    pub reversibility: ReversibilityTier,
    pub requires_reboot_prompt: bool,
    pub trigger_visual_effect: Option<String>,
    pub clipboard_text: Option<String>,
    pub before_state_summary: String,
    pub after_state_summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RegistryValueData {
    Dword { value: u32 },
    Sz { value: String },
    Absent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegistryEntryBackup {
    pub hive: String,
    pub subkey: String,
    pub value_name: String,
    pub data: RegistryValueData,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SnapshotPayload {
    RegistryBackup {
        entries: Vec<RegistryEntryBackup>,
    },
    ServiceStateBackup {
        service_name: String,
        was_running: bool,
        start_type: u32,
    },
    FilesystemArchive {
        target_dir: String,
        archive_zip_path: String,
        zip_sha256: String,
        file_count: usize,
        total_bytes: u64,
    },
    ExplorerSessionBackup {
        open_folder_paths: Vec<String>,
    },
    CompensatingHiveExport {
        hive_export_path: String,
        restore_point_created: bool,
    },
}

impl SnapshotPayload {
    pub fn kind_name(&self) -> &'static str {
        match self {
            SnapshotPayload::RegistryBackup { .. } => "registry_backup",
            SnapshotPayload::ServiceStateBackup { .. } => "service_state_backup",
            SnapshotPayload::FilesystemArchive { .. } => "filesystem_archive",
            SnapshotPayload::ExplorerSessionBackup { .. } => "explorer_session_backup",
            SnapshotPayload::CompensatingHiveExport { .. } => "compensating_hive_export",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRecord {
    pub snapshot_id: String,
    pub action_id: ActionId,
    pub created_at_utc: String,
    pub os_build: u32,
    pub snapshot_type: String,
    pub is_restored: bool,
    pub restored_at_utc: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevPortListener {
    pub port: u16,
    pub protocol: String,
    pub pid: u32,
    pub process_name: String,
    pub start_time_unix: u64,
    pub command_line_redacted: String,
    pub memory_mb: f64,
    pub local_address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HungProcessItem {
    pub pid: u32,
    pub executable_name: String,
    pub start_time_unix: u64,
    pub window_title: String,
    pub memory_mb: f64,
    pub is_not_responding: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedPidTarget {
    pub pid: u32,
    pub expected_name: String,
    pub expected_start_time_unix: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminatePidsRequest {
    pub action_id: ActionId,
    pub targets: Vec<VerifiedPidTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackRequest {
    pub snapshot_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemHealthTelemetry {
    pub health_score: u8,
    pub junk_bytes: u64,
    pub dns_latency_ms: u32,
    pub memory_usage_percent: f32,
    pub memory_used_mb: u64,
    pub memory_total_mb: u64,
    pub detected_issue_count: u32,
    pub os_build: u32,
    pub is_win10_esu_warning: bool,
    pub is_admin: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalLogEvent {
    pub id: String,
    pub timestamp: String,
    pub action_id: Option<ActionId>,
    pub level: String,
    pub message: String,
}
```

### 3.2 Complete Error Contract (`src-tauri/src/error.rs`)

```rust
// src-tauri/src/error.rs
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ZenithError {
    #[error("ElevationRequired: Action '{0}' requires Administrator privileges.")]
    ElevationRequired(String),

    #[error("ActionAlreadyRunning: Another operation is currently active.")]
    ActionAlreadyRunning,

    #[error("OperationCancelled: Action '{0}' was cancelled by the user.")]
    OperationCancelled(String),

    #[error("OperationTimedOut: Action '{0}' exceeded its timeout of {1}s.")]
    OperationTimedOut(String, u64),

    #[error("PidVerificationFailed: PID {0} no longer matches expected process '{1}' (TOCTOU guard triggered).")]
    PidVerificationFailed(u32, String),

    #[error("Win32ApiFailure: {api} failed with HRESULT/code {code}: {message}")]
    Win32ApiFailure {
        api: &'static str,
        code: String,
        message: String,
    },

    #[error("SnapshotIntegrityError: Snapshot '{0}' failed HMAC-SHA256 verification.")]
    SnapshotIntegrityError(String),

    #[error("ZipTraversalBlocked: Archive entry '{0}' attempted path traversal.")]
    ZipTraversalBlocked(String),

    #[error("CyclicDependencyDetected: Action dependency graph contains a cycle.")]
    CyclicDependencyDetected,

    #[error("LockPoisoned: Internal synchronization mutex was poisoned.")]
    LockPoisoned,

    #[error("DatabaseError: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("IoError: {0}")]
    Io(#[from] std::io::Error),

    #[error("SerializationError: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("ZipError: {0}")]
    Zip(#[from] zip::result::ZipError),
}
```

### 3.3 Machine-Wide SQLite WAL Repository with Crash Recovery & HMAC-SHA256 (`src-tauri/src/engine/db.rs`)

To prevent UAC profile split-brain, `SnapshotDb::resolve_storage_dir()` targets `C:\ProgramData\Vellium\Zenith` first. Snapshots are authenticated with HMAC-SHA256 using the machine's `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` so an attacker or corrupted writer cannot trivially alter `payload_json` without invalidating the keyed MAC:

```rust
// src-tauri/src/engine/db.rs
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use rusqlite::{params, Connection};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use chrono::Utc;
use crate::error::ZenithError;
use crate::models::{ActionId, SnapshotPayload, SnapshotRecord};

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
pub struct SnapshotDb {
    conn: Arc<Mutex<Connection>>,
    pub backup_dir: PathBuf,
    hmac_key: Vec<u8>,
}

impl SnapshotDb {
    pub fn resolve_storage_dir() -> PathBuf {
        let prog_data = std::env::var("PROGRAMDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(r"C:\ProgramData"))
            .join("Vellium")
            .join("Zenith");

        if std::fs::create_dir_all(prog_data.join("backups")).is_ok() {
            return prog_data;
        }
        std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("Vellium")
            .join("Zenith")
    }

    fn read_machine_hmac_key() -> Vec<u8> {
        #[cfg(windows)]
        {
            use winreg::enums::HKEY_LOCAL_MACHINE;
            use winreg::RegKey;
            if let Ok(hklm) = RegKey::predef(HKEY_LOCAL_MACHINE)
                .open_subkey(r"SOFTWARE\Microsoft\Cryptography")
            {
                if let Ok(guid) = hklm.get_value::<String, _>("MachineGuid") {
                    return format!("ZENITH_HMAC_V1_{}", guid).into_bytes();
                }
            }
        }
        b"ZENITH_FALLBACK_MACHINE_KEY_V1".to_vec()
    }

    pub fn init() -> Result<Self, ZenithError> {
        let base_dir = Self::resolve_storage_dir();
        let backup_dir = base_dir.join("backups");
        std::fs::create_dir_all(&backup_dir)?;

        let db_path = base_dir.join("state.db");
        let conn = Connection::open(db_path)?;

        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
             PRAGMA foreign_keys = ON;

             CREATE TABLE IF NOT EXISTS snapshots (
                 snapshot_id TEXT PRIMARY KEY NOT NULL,
                 action_id TEXT NOT NULL,
                 created_at_utc TEXT NOT NULL,
                 os_build INTEGER NOT NULL,
                 snapshot_type TEXT NOT NULL,
                 tx_status TEXT NOT NULL DEFAULT 'COMMITTED',
                 payload_json TEXT NOT NULL,
                 hmac_sha256 TEXT NOT NULL,
                 is_restored INTEGER NOT NULL DEFAULT 0,
                 restored_at_utc TEXT
             );

             CREATE INDEX IF NOT EXISTS idx_snapshots_action_id
                 ON snapshots(action_id, created_at_utc DESC);

             CREATE TABLE IF NOT EXISTS execution_audit_log (
                 log_id INTEGER PRIMARY KEY AUTOINCREMENT,
                 action_id TEXT NOT NULL,
                 started_at_utc TEXT NOT NULL,
                 completed_at_utc TEXT NOT NULL,
                 duration_ms INTEGER NOT NULL,
                 status TEXT NOT NULL,
                 snapshot_id TEXT,
                 summary_message TEXT NOT NULL,
                 error_code TEXT
             );"
        )?;

        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
            backup_dir,
            hmac_key: Self::read_machine_hmac_key(),
        };
        db.recover_incomplete_transactions()?;
        db.prune_old_audit_logs(500)?;
        Ok(db)
    }

    pub fn compute_hmac(&self, snapshot_id: &str, action_str: &str, payload_json: &str) -> String {
        let mut mac = HmacSha256::new_from_slice(&self.hmac_key)
            .expect("HMAC accepts any key size");
        mac.update(snapshot_id.as_bytes());
        mac.update(b"|");
        mac.update(action_str.as_bytes());
        mac.update(b"|");
        mac.update(payload_json.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    pub fn recover_incomplete_transactions(&self) -> Result<(), ZenithError> {
        if let Ok(entries) = std::fs::read_dir(&self.backup_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("tmp") {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
        let guard = self.conn.lock().map_err(|_| ZenithError::LockPoisoned)?;
        guard.execute(
            "DELETE FROM snapshots WHERE tx_status != 'COMMITTED'",
            [],
        )?;
        Ok(())
    }

    pub fn prune_old_audit_logs(&self, keep_latest: usize) -> Result<(), ZenithError> {
        let guard = self.conn.lock().map_err(|_| ZenithError::LockPoisoned)?;
        guard.execute(
            "DELETE FROM execution_audit_log WHERE log_id NOT IN (
                 SELECT log_id FROM execution_audit_log ORDER BY log_id DESC LIMIT ?1
             )",
            params![keep_latest as i64],
        )?;
        Ok(())
    }

    pub fn save_snapshot(
        &self,
        action_id: ActionId,
        os_build: u32,
        payload: &SnapshotPayload,
    ) -> Result<String, ZenithError> {
        let payload_json = serde_json::to_string(payload)?;
        let now = Utc::now().to_rfc3339();
        let snapshot_id = format!("snap_{}_{}", action_id.as_str(), Utc::now().timestamp_millis());
        let hmac_tag = self.compute_hmac(&snapshot_id, action_id.as_str(), &payload_json);

        let guard = self.conn.lock().map_err(|_| ZenithError::LockPoisoned)?;
        guard.execute(
            "INSERT INTO snapshots (snapshot_id, action_id, created_at_utc, os_build, snapshot_type, tx_status, payload_json, hmac_sha256)
             VALUES (?1, ?2, ?3, ?4, ?5, 'COMMITTED', ?6, ?7)",
            params![
                snapshot_id,
                action_id.as_str(),
                now,
                os_build,
                payload.kind_name(),
                payload_json,
                hmac_tag
            ],
        )?;
        Ok(snapshot_id)
    }

    pub fn get_snapshot(&self, snapshot_id: &str) -> Result<(ActionId, SnapshotPayload), ZenithError> {
        let guard = self.conn.lock().map_err(|_| ZenithError::LockPoisoned)?;
        let (action_str, payload_json, stored_hmac): (String, String, String) = guard.query_row(
            "SELECT action_id, payload_json, hmac_sha256 FROM snapshots WHERE snapshot_id = ?1 AND tx_status = 'COMMITTED'",
            params![snapshot_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;

        let computed_hmac = self.compute_hmac(snapshot_id, &action_str, &payload_json);
        if computed_hmac != stored_hmac {
            return Err(ZenithError::SnapshotIntegrityError(snapshot_id.to_string()));
        }

        let action_id: ActionId = serde_json::from_str(&format!("\"{}\"", action_str))?;
        let payload: SnapshotPayload = serde_json::from_str(&payload_json)?;
        Ok((action_id, payload))
    }

    pub fn mark_restored(&self, snapshot_id: &str) -> Result<(), ZenithError> {
        let guard = self.conn.lock().map_err(|_| ZenithError::LockPoisoned)?;
        guard.execute(
            "UPDATE snapshots SET is_restored = 1, restored_at_utc = ?1 WHERE snapshot_id = ?2",
            params![Utc::now().to_rfc3339(), snapshot_id],
        )?;
        Ok(())
    }

    pub fn get_latest_unrestored_snapshot_id(&self, action_id: ActionId) -> Option<String> {
        let guard = self.conn.lock().ok()?;
        guard.query_row(
            "SELECT snapshot_id FROM snapshots WHERE action_id = ?1 AND is_restored = 0 AND tx_status = 'COMMITTED' ORDER BY created_at_utc DESC LIMIT 1",
            params![action_id.as_str()],
            |row| row.get(0),
        ).ok()
    }

    pub fn list_snapshots(&self) -> Result<Vec<SnapshotRecord>, ZenithError> {
        let guard = self.conn.lock().map_err(|_| ZenithError::LockPoisoned)?;
        let mut stmt = guard.prepare(
            "SELECT snapshot_id, action_id, created_at_utc, os_build, snapshot_type, is_restored, restored_at_utc
             FROM snapshots WHERE tx_status = 'COMMITTED' ORDER BY created_at_utc DESC LIMIT 100"
        )?;
        let rows = stmt.query_map([], |row| {
            let action_str: String = row.get(1)?;
            let action_id: ActionId = serde_json::from_str(&format!("\"{}\"", action_str))
                .unwrap_or(ActionId::CleanTempCache);
            Ok(SnapshotRecord {
                snapshot_id: row.get(0)?,
                action_id,
                created_at_utc: row.get(2)?,
                os_build: row.get(3)?,
                snapshot_type: row.get(4)?,
                is_restored: row.get::<_, i32>(5)? != 0,
                restored_at_utc: row.get(6)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }
}
```

### 3.4 Verified Win32 FFI Implementations (Memory-Aligned, Bounds-Checked, TOCTOU-Safe)

#### A. Memory-Aligned `GetExtendedTcpTable` & TOCTOU-Protected Process Termination (`src-tauri/src/adapters/proc.rs`)

*(Fixes `Vec<u8>` alignment UB by allocating `Vec<u64>`, loops on `ERROR_INSUFFICIENT_BUFFER (122)`, clamps `dwNumEntries` to allocated byte capacity, redacts secrets in command lines, and verifies `(pid, expected_name, expected_start_time_unix)` prior to termination.)*

```rust
// src-tauri/src/adapters/proc.rs
use std::collections::{HashMap, HashSet};
use sysinfo::{Pid, ProcessesToUpdate, System};
use crate::error::ZenithError;
use crate::models::{DevPortListener, HungProcessItem, VerifiedPidTarget};

#[cfg(windows)]
pub fn get_listening_tcp_ports() -> Vec<(u16, u32)> {
    use windows::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, MIB_TCPTABLE_OWNER_PID, MIB_TCP_STATE_LISTEN,
        TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows::Win32::Networking::WinSock::AF_INET;

    let mut size = 0u32;
    unsafe {
        let _ = GetExtendedTcpTable(
            None,
            &mut size,
            false,
            AF_INET.0 as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        );
        if size == 0 {
            return Vec::new();
        }

        // Allocate 8-byte aligned u64 buffer to guarantee proper alignment for MIB_TCPTABLE_OWNER_PID
        let mut aligned_buf: Vec<u64> = Vec::new();
        for _attempt in 0..3 {
            let u64_len = ((size as usize) + 7) / 8;
            aligned_buf.resize(u64_len.max(16), 0u64);
            let status = GetExtendedTcpTable(
                Some(aligned_buf.as_mut_ptr() as *mut std::ffi::c_void),
                &mut size,
                false,
                AF_INET.0 as u32,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            );
            if status == 0 {
                let total_bytes = aligned_buf.len() * std::mem::size_of::<u64>();
                if total_bytes < std::mem::size_of::<u32>() {
                    return Vec::new();
                }
                let table = &*(aligned_buf.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
                let requested_entries = table.dwNumEntries as usize;
                let row_size = std::mem::size_of::<MIB_TCPROW_OWNER_PID>();
                let max_possible_entries = total_bytes.saturating_sub(std::mem::size_of::<u32>()) / row_size;
                let safe_entries = requested_entries.min(max_possible_entries);

                let rows_ptr = table.table.as_ptr();
                let mut results = Vec::with_capacity(safe_entries);
                for i in 0..safe_entries {
                    let row: &MIB_TCPROW_OWNER_PID = &*rows_ptr.add(i);
                    if row.dwState == MIB_TCP_STATE_LISTEN.0 as u32 {
                        let port = u16::from_be(row.dwLocalPort as u16);
                        results.push((port, row.dwOwningPid));
                    }
                }
                return results;
            } else if status != ERROR_INSUFFICIENT_BUFFER.0 {
                return Vec::new();
            }
        }
        Vec::new()
    }
}

#[cfg(not(windows))]
pub fn get_listening_tcp_ports() -> Vec<(u16, u32)> {
    Vec::new()
}

fn redact_sensitive_args(raw_cmd: &str) -> String {
    raw_cmd
        .split_whitespace()
        .map(|token| {
            let lower = token.to_lowercase();
            if lower.contains("key=") || lower.contains("token=") || lower.contains("password=") || lower.contains("secret=") {
                if let Some((k, _)) = token.split_once('=') {
                    return format!("{}=***REDACTED***", k);
                }
            }
            token.to_string()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn scan_dev_ports_detailed() -> Vec<DevPortListener> {
    let mut sys = System::new_all();
    sys.refresh_processes(ProcessesToUpdate::All, true);

    let mut out = Vec::new();
    for (port, pid_u32) in get_listening_tcp_ports() {
        if (3000..=9999).contains(&port) {
            if let Some(proc_info) = sys.process(Pid::from_u32(pid_u32)) {
                let raw_cmd = proc_info
                    .cmd()
                    .iter()
                    .map(|s| s.to_string_lossy().to_string())
                    .collect::<Vec<_>>()
                    .join(" ");
                out.push(DevPortListener {
                    port,
                    protocol: "TCP".to_string(),
                    pid: pid_u32,
                    process_name: proc_info.name().to_string_lossy().to_string(),
                    start_time_unix: proc_info.start_time(),
                    command_line_redacted: redact_sensitive_args(&raw_cmd),
                    memory_mb: (proc_info.memory() as f64) / (1024.0 * 1024.0),
                    local_address: format!("127.0.0.1:{}", port),
                });
            }
        }
    }
    out.sort_by_key(|d| d.port);
    out
}

pub fn terminate_verified_pids(targets: &[VerifiedPidTarget]) -> Result<usize, ZenithError> {
    let mut sys = System::new_all();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let mut killed = 0usize;

    for target in targets {
        let proc_info = sys.process(Pid::from_u32(target.pid)).ok_or_else(|| {
            ZenithError::PidVerificationFailed(target.pid, target.expected_name.clone())
        })?;

        let actual_name = proc_info.name().to_string_lossy().to_lowercase();
        let expected_name = target.expected_name.to_lowercase();
        let actual_start = proc_info.start_time();

        // Strict TOCTOU check: both executable name and creation timestamp must match
        if actual_name != expected_name || actual_start != target.expected_start_time_unix {
            return Err(ZenithError::PidVerificationFailed(
                target.pid,
                target.expected_name.clone(),
            ));
        }

        if proc_info.kill() {
            killed += 1;
        }
    }
    Ok(killed)
}
```

#### B. Real WDDM GPU Reset via Win32 `SendInput` (`Win+Ctrl+Shift+B`) (`src-tauri/src/adapters/scm.rs`)

```rust
// src-tauri/src/adapters/scm.rs (Real WDDM Graphics Driver Reset Shortcut Injection)
#[cfg(windows)]
pub fn trigger_wddm_gpu_driver_reset() -> Result<(), crate::error::ZenithError> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY,
        VK_CONTROL, VK_LWIN, VK_SHIFT,
    };

    const VK_B: VIRTUAL_KEY = VIRTUAL_KEY(0x42);
    let keys = [VK_LWIN, VK_CONTROL, VK_SHIFT, VK_B];
    let mut inputs: Vec<INPUT> = Vec::with_capacity(8);

    // Key-down sequence
    for &vk in &keys {
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: Default::default(),
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        });
    }
    // Key-up sequence in reverse order
    for &vk in keys.iter().rev() {
        inputs.push(INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        });
    }

    unsafe {
        let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        if sent != inputs.len() as u32 {
            return Err(crate::error::ZenithError::Win32ApiFailure {
                api: "SendInput(Win+Ctrl+Shift+B)",
                code: sent.to_string(),
                message: "Failed to inject complete WDDM driver reset key sequence.".to_string(),
            });
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn trigger_wddm_gpu_driver_reset() -> Result<(), crate::error::ZenithError> {
    Ok(())
}
```

#### C. Stateful UTF-16LE / UTF-8 Stream Decoder & Cancellable Process Runner (`src-tauri/src/adapters/shell_iso.rs`)

*(Solves the odd-byte chunk alignment bug when reading `sfc.exe` pipes by maintaining an internal `carry_byte: Option<u8>` and detecting UTF-16LE on the first chunk.)*

```rust
// src-tauri/src/adapters/shell_iso.rs
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use crate::error::ZenithError;

pub struct StatefulStreamDecoder {
    is_utf16le: Option<bool>,
    carry_byte: Option<u8>,
    line_buffer: String,
}

impl StatefulStreamDecoder {
    pub fn new() -> Self {
        Self {
            is_utf16le: None,
            carry_byte: None,
            line_buffer: String::new(),
        }
    }

    pub fn push_chunk(&mut self, mut chunk: &[u8]) -> Vec<String> {
        if chunk.is_empty() {
            return Vec::new();
        }

        if self.is_utf16le.is_none() {
            if chunk.starts_with(&[0xFF, 0xFE]) {
                self.is_utf16le = Some(true);
                chunk = &chunk[2..];
            } else {
                // Check if odd byte indices in the first even-aligned window are predominantly 0x00
                let sample_len = chunk.len().min(64);
                let odd_zeros = chunk[..sample_len]
                    .iter()
                    .skip(1)
                    .step_by(2)
                    .filter(|&&b| b == 0)
                    .count();
                self.is_utf16le = Some(sample_len >= 4 && odd_zeros >= sample_len / 4);
            }
        }

        let decoded_str = if self.is_utf16le == Some(true) {
            let mut working = Vec::with_capacity(chunk.len() + 1);
            if let Some(prev) = self.carry_byte.take() {
                working.push(prev);
            }
            working.extend_from_slice(chunk);
            if working.len() % 2 == 1 {
                self.carry_byte = working.pop();
            }
            let u16_words: Vec<u16> = working
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            String::from_utf16_lossy(&u16_words)
        } else {
            String::from_utf8_lossy(chunk).into_owned()
        };

        self.line_buffer.push_str(&decoded_str);
        let mut completed_lines = Vec::new();
        while let Some(pos) = self.line_buffer.find('\n') {
            let line = self.line_buffer[..pos].trim_matches('\r').trim().to_string();
            self.line_buffer.drain(..=pos);
            if !line.is_empty() {
                completed_lines.push(line);
            }
        }
        completed_lines
    }

    pub fn flush_remaining(&mut self) -> Option<String> {
        let rem = self.line_buffer.trim().to_string();
        self.line_buffer.clear();
        if rem.is_empty() { None } else { Some(rem) }
    }
}

pub fn run_cancellable_command<F>(
    action_name: &str,
    program: &str,
    args: &[&str],
    timeout: Duration,
    cancel_flag: Arc<AtomicBool>,
    mut on_line: F,
) -> Result<i32, ZenithError>
where
    F: FnMut(String),
{
    use std::process::{Command, Stdio};
    let mut child = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let mut stdout = child.stdout.take().expect("stdout piped");
    let start = Instant::now();
    let mut decoder = StatefulStreamDecoder::new();
    let mut buf = [0u8; 1024];

    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            let _ = child.kill();
            return Err(ZenithError::OperationCancelled(action_name.to_string()));
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            return Err(ZenithError::OperationTimedOut(
                action_name.to_string(),
                timeout.as_secs(),
            ));
        }

        let n = stdout.read(&mut buf)?;
        if n == 0 {
            break;
        }
        for line in decoder.push_chunk(&buf[..n]) {
            on_line(line);
        }
    }

    if let Some(last) = decoder.flush_remaining() {
        on_line(last);
    }

    let status = child.wait()?;
    Ok(status.code().unwrap_or(-1))
}
```

#### D. Crash-Safe Atomic Archiver, Safe Zip-Slip Rollback & Explicit `HRESULT` Recycle Bin (`src-tauri/src/adapters/fs_clean.rs`)

```rust
// src-tauri/src/adapters/fs_clean.rs
use std::io::{Read, Write};
use std::path::Path;
use sha2::{Digest, Sha256};
use crate::error::ZenithError;

#[cfg(windows)]
pub fn query_recycle_bin_stats() -> Result<(u64, u64), ZenithError> {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{SHQueryRecycleBinW, SHQUERYRBINFO};
    unsafe {
        let mut info = SHQUERYRBINFO {
            cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32,
            i64Size: 0,
            i64NumItems: 0,
        };
        let hr = SHQueryRecycleBinW(PCWSTR::null(), &mut info);
        if hr.is_ok() {
            Ok((info.i64Size.max(0) as u64, info.i64NumItems.max(0) as u64))
        } else {
            Err(ZenithError::Win32ApiFailure {
                api: "SHQueryRecycleBinW",
                code: format!("0x{:08X}", hr.0),
                message: "Failed to query Windows Recycle Bin metrics.".to_string(),
            })
        }
    }
}

#[cfg(not(windows))]
pub fn query_recycle_bin_stats() -> Result<(u64, u64), ZenithError> {
    Ok((0, 0))
}

#[cfg(windows)]
pub fn empty_recycle_bin_native() -> Result<(), ZenithError> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::{
        SHEmptyRecycleBinW, SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI, SHERB_NOSOUND,
    };
    unsafe {
        let (bytes, items) = query_recycle_bin_stats()?;
        if bytes == 0 && items == 0 {
            return Ok(());
        }
        let flags = SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND;
        let hr = SHEmptyRecycleBinW(HWND::default(), PCWSTR::null(), flags);
        // 0x8000FFFF (E_UNEXPECTED) is returned by Windows when the bin is already empty
        if hr.is_ok() || (hr.0 as u32) == 0x8000FFFF {
            Ok(())
        } else {
            Err(ZenithError::Win32ApiFailure {
                api: "SHEmptyRecycleBinW",
                code: format!("0x{:08X}", hr.0),
                message: "Windows Recycle Bin purge returned an error.".to_string(),
            })
        }
    }
}

#[cfg(not(windows))]
pub fn empty_recycle_bin_native() -> Result<(), ZenithError> {
    Ok(())
}

/// Phase 1 & 2 of Transactional Archiving:
/// Preserves relative paths, writes to `.zip.tmp`, verifies archive readability, computes SHA-256,
/// and atomically renames to `.zip` BEFORE any caller commits SQLite or deletes/recycles originals.
pub fn create_verified_zip_backup(
    base_dir: &Path,
    files: &[std::path::PathBuf],
    final_zip_path: &Path,
) -> Result<(String, usize, u64), ZenithError> {
    let tmp_zip_path = final_zip_path.with_extension("zip.tmp");
    let zip_file = std::fs::File::create(&tmp_zip_path)?;
    let mut zip_writer = zip::ZipWriter::new(zip_file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let mut total_bytes = 0u64;
    let mut archived_count = 0usize;

    for file_path in files {
        let rel_path = file_path.strip_prefix(base_dir).unwrap_or(file_path.as_path());
        let rel_str = rel_path.to_string_lossy().replace('\\', "/");
        if rel_str.contains("..") || rel_str.is_empty() {
            continue;
        }
        zip_writer.start_file(&rel_str, options)?;
        let mut f = std::fs::File::open(file_path)?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;
        total_bytes += buf.len() as u64;
        zip_writer.write_all(&buf)?;
        archived_count += 1;
    }

    let finished_file = zip_writer.finish()?;
    finished_file.sync_all()?;
    drop(finished_file);

    // Re-open and verify every entry in the archive before moving originals
    {
        let verify_file = std::fs::File::open(&tmp_zip_path)?;
        let mut verify_archive = zip::ZipArchive::new(verify_file)?;
        if verify_archive.len() != archived_count {
            let _ = std::fs::remove_file(&tmp_zip_path);
            return Err(ZenithError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "ZIP entry count mismatch during verification",
            )));
        }
        for i in 0..verify_archive.len() {
            let mut entry = verify_archive.by_index(i)?;
            std::io::copy(&mut entry, &mut std::io::sink())?;
        }
    }

    let raw_zip_bytes = std::fs::read(&tmp_zip_path)?;
    let mut hasher = Sha256::new();
    hasher.update(&raw_zip_bytes);
    let zip_sha256 = hex::encode(hasher.finalize());

    std::fs::rename(&tmp_zip_path, final_zip_path)?;
    Ok((zip_sha256, archived_count, total_bytes))
}

/// Safe ZIP extraction with Zip-Slip path traversal protection and SHA-256 verification.
pub fn extract_verified_zip_backup(
    zip_path: &Path,
    expected_sha256: &str,
    target_dir: &Path,
) -> Result<usize, ZenithError> {
    let raw_bytes = std::fs::read(zip_path)?;
    let mut hasher = Sha256::new();
    hasher.update(&raw_bytes);
    let actual_sha256 = hex::encode(hasher.finalize());
    if actual_sha256 != expected_sha256 {
        return Err(ZenithError::SnapshotIntegrityError(
            zip_path.to_string_lossy().to_string(),
        ));
    }

    let file = std::fs::File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut restored = 0usize;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let safe_rel = entry.enclosed_name().ok_or_else(|| {
            ZenithError::ZipTraversalBlocked(entry.name().to_string())
        })?;
        let out_path = target_dir.join(safe_rel);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out_file = std::fs::File::create(&out_path)?;
        std::io::copy(&mut entry, &mut out_file)?;
        restored += 1;
    }
    Ok(restored)
}
```

#### E. OS Build Detection via Registry (`CurrentBuildNumber`) & Multi-Action UAC Queue Handover (`src-tauri/src/adapters/uac.rs`)

*(Never uses `GetVersionExW` which lies without an explicit compatibility manifest; reads `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\CurrentBuildNumber` directly.)*

```rust
// src-tauri/src/adapters/uac.rs
pub fn get_accurate_os_build() -> u32 {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_LOCAL_MACHINE;
        use winreg::RegKey;
        if let Ok(nt_key) = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
        {
            if let Ok(build_str) = nt_key.get_value::<String, _>("CurrentBuildNumber") {
                if let Ok(build) = build_str.trim().parse::<u32>() {
                    return build;
                }
            }
        }
    }
    26100
}

#[cfg(windows)]
pub fn relaunch_elevated_with_queue(resume_queue_csv: Option<&str>) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
    let current_pid = std::process::id();
    let args = match resume_queue_csv {
        Some(csv) if !csv.is_empty() => format!("--wait-pid {} --resume-queue {}", current_pid, csv),
        _ => format!("--wait-pid {}", current_pid),
    };

    let verb_w: Vec<u16> = std::ffi::OsStr::new("runas").encode_wide().chain(Some(0)).collect();
    let file_w: Vec<u16> = exe_path.as_os_str().encode_wide().chain(Some(0)).collect();
    let args_w: Vec<u16> = std::ffi::OsStr::new(&args).encode_wide().chain(Some(0)).collect();

    unsafe {
        let res = ShellExecuteW(
            HWND::default(),
            PCWSTR(verb_w.as_ptr()),
            PCWSTR(file_w.as_ptr()),
            PCWSTR(args_w.as_ptr()),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        );
        if (res.0 as isize) <= 32 {
            return Err("UAC elevation was cancelled or declined by user.".to_string());
        }
    }
    std::process::exit(0);
}
```

---

## SECTION 4: UI/UX DESIGN SYSTEM (WCAG-VERIFIED OFF-WHITE & TRUE PITCH BLACK)

### 4.1 Contrast-Corrected Color Tokens (`src/styles/index.css`)

*(Fixes the muted-text contrast deficit identified in audit: `--text-muted` is darkened to `#57554F` on Off-White `#F6F5F0` for a **6.6:1 WCAG AA/AAA** ratio, and lightened to `#94949E` on True-Black `#000000` for a **6.8:1 WCAG AA/AAA** ratio. Primary text achieves $>16:1$ AAA contrast.)*

```css
@import "tailwindcss";

:root,
[data-theme="off-white"] {
  --bg-canvas: #F6F5F0;
  --bg-surface: #ECEAE2;
  --bg-elevated: #E2DFD5;
  --bg-glass: rgba(246, 245, 240, 0.90);
  --border-subtle: #CFCBC0;
  --border-focus: #141413;
  --text-primary: #141413;
  --text-secondary: #383734;
  --text-muted: #57554F;
  --accent-primary: #141413;
  --accent-foreground: #F6F5F0;
  --status-healthy: #14532D;
  --status-warning: #78350F;
  --status-danger: #991B1B;
  --status-info: #1E3A8A;
}

[data-theme="true-black"] {
  --bg-canvas: #000000;
  --bg-surface: #09090B;
  --bg-elevated: #121215;
  --bg-glass: rgba(0, 0, 0, 0.92);
  --border-subtle: #232329;
  --border-focus: #FAFAFA;
  --text-primary: #F4F4F6;
  --text-secondary: #C4C4CC;
  --text-muted: #94949E;
  --accent-primary: #F4F4F6;
  --accent-foreground: #000000;
  --status-healthy: #4ADE80;
  --status-warning: #FBBF24;
  --status-danger: #F87171;
  --status-info: #60A5FA;
}

[data-theme="spatial-glass"] {
  --bg-canvas: rgba(5, 5, 7, 0.78);
  --bg-surface: rgba(18, 18, 22, 0.68);
  --bg-elevated: rgba(32, 32, 38, 0.82);
  --bg-glass: rgba(12, 12, 16, 0.86);
  --border-subtle: rgba(255, 255, 255, 0.14);
  --border-focus: rgba(255, 255, 255, 0.50);
  --text-primary: #FAFAFA;
  --text-secondary: #D4D4DC;
  --text-muted: #9E9EA8;
  --accent-primary: #FFFFFF;
  --accent-foreground: #000000;
  --status-healthy: #34D399;
  --status-warning: #FBBF24;
  --status-danger: #F87171;
  --status-info: #60A5FA;
}
```

* **RTL Logical Property Law:** All 10 React components MUST use Tailwind CSS logical properties (`ms-*`, `me-*`, `ps-*`, `pe-*`, `text-start`, `text-end`, `border-s-*`, `border-e-*`) instead of physical `ml-*`, `mr-*`, `pl-*`, `pr-*`, `text-left`, or `text-right` so Arabic (`ar`), Hebrew (`he`), Persian (`fa`), and Urdu (`ur`) mirror cleanly.

---

## SECTION 5: ZERO-API-KEY 73-LANGUAGE AGENT-NATIVE i18n ENGINE

### 5.1 Complete 73-Locale Registry Including Korean (`ko`) (`src/i18n/registry.ts`)

*(Includes Korean `ko` at index 13; languages 51 `ar`, 52 `he`, 53 `fa`, and 54 `ur` are `rtl`.)*

```typescript
// src/i18n/registry.ts
export interface LocaleEntry {
  index: number;
  code: string;
  nativeName: string;
  englishName: string;
  dir: 'ltr' | 'rtl';
}

export const SUPPORTED_LOCALES: readonly LocaleEntry[] = [
  { index: 1, code: 'tr', nativeName: 'Türkçe', englishName: 'Turkish', dir: 'ltr' },
  { index: 2, code: 'en', nativeName: 'English', englishName: 'English', dir: 'ltr' },
  { index: 3, code: 'de', nativeName: 'Deutsch', englishName: 'German', dir: 'ltr' },
  { index: 4, code: 'fr', nativeName: 'Français', englishName: 'French', dir: 'ltr' },
  { index: 5, code: 'es', nativeName: 'Español', englishName: 'Spanish', dir: 'ltr' },
  { index: 6, code: 'it', nativeName: 'Italiano', englishName: 'Italian', dir: 'ltr' },
  { index: 7, code: 'pt', nativeName: 'Português (PT)', englishName: 'Portuguese (Portugal)', dir: 'ltr' },
  { index: 8, code: 'pt-BR', nativeName: 'Português (Brasil)', englishName: 'Portuguese (Brazil)', dir: 'ltr' },
  { index: 9, code: 'nl', nativeName: 'Nederlands', englishName: 'Dutch', dir: 'ltr' },
  { index: 10, code: 'pl', nativeName: 'Polski', englishName: 'Polish', dir: 'ltr' },
  { index: 11, code: 'ru', nativeName: 'Русский', englishName: 'Russian', dir: 'ltr' },
  { index: 12, code: 'uk', nativeName: 'Українська', englishName: 'Ukrainian', dir: 'ltr' },
  { index: 13, code: 'ko', nativeName: '한국어', englishName: 'Korean', dir: 'ltr' },
  { index: 14, code: 'sv', nativeName: 'Svenska', englishName: 'Swedish', dir: 'ltr' },
  { index: 15, code: 'no', nativeName: 'Norsk', englishName: 'Norwegian', dir: 'ltr' },
  { index: 16, code: 'da', nativeName: 'Dansk', englishName: 'Danish', dir: 'ltr' },
  { index: 17, code: 'fi', nativeName: 'Suomi', englishName: 'Finnish', dir: 'ltr' },
  { index: 18, code: 'el', nativeName: 'Ελληνικά', englishName: 'Greek', dir: 'ltr' },
  { index: 19, code: 'cs', nativeName: 'Čeština', englishName: 'Czech', dir: 'ltr' },
  { index: 20, code: 'hu', nativeName: 'Magyar', englishName: 'Hungarian', dir: 'ltr' },
  { index: 21, code: 'ro', nativeName: 'Română', englishName: 'Romanian', dir: 'ltr' },
  { index: 22, code: 'bg', nativeName: 'Български', englishName: 'Bulgarian', dir: 'ltr' },
  { index: 23, code: 'sk', nativeName: 'Slovenčina', englishName: 'Slovak', dir: 'ltr' },
  { index: 24, code: 'sl', nativeName: 'Slovenščina', englishName: 'Slovenian', dir: 'ltr' },
  { index: 25, code: 'hr', nativeName: 'Hrvatski', englishName: 'Croatian', dir: 'ltr' },
  { index: 26, code: 'sr', nativeName: 'Српски', englishName: 'Serbian', dir: 'ltr' },
  { index: 27, code: 'bs', nativeName: 'Bosanski', englishName: 'Bosnian', dir: 'ltr' },
  { index: 28, code: 'mk', nativeName: 'Македонски', englishName: 'Macedonian', dir: 'ltr' },
  { index: 29, code: 'sq', nativeName: 'Shqip', englishName: 'Albanian', dir: 'ltr' },
  { index: 30, code: 'et', nativeName: 'Eesti', englishName: 'Estonian', dir: 'ltr' },
  { index: 31, code: 'lv', nativeName: 'Latviešu', englishName: 'Latvian', dir: 'ltr' },
  { index: 32, code: 'lt', nativeName: 'Lietuvių', englishName: 'Lithuanian', dir: 'ltr' },
  { index: 33, code: 'is', nativeName: 'Íslenska', englishName: 'Icelandic', dir: 'ltr' },
  { index: 34, code: 'ga', nativeName: 'Gaeilge', englishName: 'Irish', dir: 'ltr' },
  { index: 35, code: 'cy', nativeName: 'Cymraeg', englishName: 'Welsh', dir: 'ltr' },
  { index: 36, code: 'mt', nativeName: 'Malti', englishName: 'Maltese', dir: 'ltr' },
  { index: 37, code: 'eu', nativeName: 'Euskara', englishName: 'Basque', dir: 'ltr' },
  { index: 38, code: 'ca', nativeName: 'Català', englishName: 'Catalan', dir: 'ltr' },
  { index: 39, code: 'gl', nativeName: 'Galego', englishName: 'Galician', dir: 'ltr' },
  { index: 40, code: 'ka', nativeName: 'ქართული', englishName: 'Georgian', dir: 'ltr' },
  { index: 41, code: 'hy', nativeName: 'Հայերեն', englishName: 'Armenian', dir: 'ltr' },
  { index: 42, code: 'az', nativeName: 'Azərbaycan', englishName: 'Azerbaijani', dir: 'ltr' },
  { index: 43, code: 'kk', nativeName: 'Қазақ тілі', englishName: 'Kazakh', dir: 'ltr' },
  { index: 44, code: 'uz', nativeName: 'Oʻzbekcha', englishName: 'Uzbek', dir: 'ltr' },
  { index: 45, code: 'ky', nativeName: 'Кыргызча', englishName: 'Kyrgyz', dir: 'ltr' },
  { index: 46, code: 'tk', nativeName: 'Türkmençe', englishName: 'Turkmen', dir: 'ltr' },
  { index: 47, code: 'tg', nativeName: 'Тоҷикӣ', englishName: 'Tajik', dir: 'ltr' },
  { index: 48, code: 'mn', nativeName: 'Монгол', englishName: 'Mongolian', dir: 'ltr' },
  { index: 49, code: 'af', nativeName: 'Afrikaans', englishName: 'Afrikaans', dir: 'ltr' },
  { index: 50, code: 'sw', nativeName: 'Kiswahili', englishName: 'Swahili', dir: 'ltr' },
  { index: 51, code: 'ar', nativeName: 'العربية', englishName: 'Arabic', dir: 'rtl' },
  { index: 52, code: 'he', nativeName: 'עברית', englishName: 'Hebrew', dir: 'rtl' },
  { index: 53, code: 'fa', nativeName: 'فارسی', englishName: 'Persian', dir: 'rtl' },
  { index: 54, code: 'ur', nativeName: 'اردو', englishName: 'Urdu', dir: 'rtl' },
  { index: 55, code: 'hi', nativeName: 'हिन्दी', englishName: 'Hindi', dir: 'ltr' },
  { index: 56, code: 'bn', nativeName: 'বাংলা', englishName: 'Bengali', dir: 'ltr' },
  { index: 57, code: 'pa', nativeName: 'ਪੰਜਾਬੀ', englishName: 'Punjabi', dir: 'ltr' },
  { index: 58, code: 'mr', nativeName: 'मराठी', englishName: 'Marathi', dir: 'ltr' },
  { index: 59, code: 'gu', nativeName: 'ગુજરાતી', englishName: 'Gujarati', dir: 'ltr' },
  { index: 60, code: 'ta', nativeName: 'தமிழ்', englishName: 'Tamil', dir: 'ltr' },
  { index: 61, code: 'te', nativeName: 'తెలుగు', englishName: 'Telugu', dir: 'ltr' },
  { index: 62, code: 'kn', nativeName: 'ಕನ್ನಡ', englishName: 'Kannada', dir: 'ltr' },
  { index: 63, code: 'ml', nativeName: 'മലയാളം', englishName: 'Malayalam', dir: 'ltr' },
  { index: 64, code: 'si', nativeName: 'සිංහල', englishName: 'Sinhala', dir: 'ltr' },
  { index: 65, code: 'ne', nativeName: 'नेपाली', englishName: 'Nepali', dir: 'ltr' },
  { index: 66, code: 'th', nativeName: 'ไทย', englishName: 'Thai', dir: 'ltr' },
  { index: 67, code: 'vi', nativeName: 'Tiếng Việt', englishName: 'Vietnamese', dir: 'ltr' },
  { index: 68, code: 'id', nativeName: 'Bahasa Indonesia', englishName: 'Indonesian', dir: 'ltr' },
  { index: 69, code: 'ms', nativeName: 'Bahasa Melayu', englishName: 'Malay', dir: 'ltr' },
  { index: 70, code: 'fil', nativeName: 'Filipino', englishName: 'Filipino', dir: 'ltr' },
  { index: 71, code: 'zh-CN', nativeName: '简体中文', englishName: 'Chinese (Simplified)', dir: 'ltr' },
  { index: 72, code: 'zh-TW', nativeName: '繁體中文', englishName: 'Chinese (Traditional)', dir: 'ltr' },
  { index: 73, code: 'ja', nativeName: '日本語', englishName: 'Japanese', dir: 'ltr' }
] as const;
```

### 5.2 Complete Master Dictionary Schema (`src/i18n/master/en.json` & `src/i18n/master/tr.json`)

Every single one of the 73 locale files MUST conform to this exact JSON tree:

`src/i18n/master/en.json`:

```json
{
  "meta": {
    "locale": "en",
    "dir": "ltr",
    "translated": true
  },
  "app": {
    "title": "Zenith",
    "subtitle": "Deterministic System Diagnostic & Self-Healing Engine",
    "simulatorBadge": "SIMULATION MODE - NO OS CHANGES",
    "adminBadge": "ADMINISTRATOR",
    "standardUserBadge": "STANDARD USER",
    "elevateButton": "Restart as Admin",
    "win10EsuBanner": "Windows 10 mainstream support ended Oct 14, 2025. Verify ESU enrollment or upgrade to Windows 11."
  },
  "nav": {
    "all": "All Actions",
    "cleanup": "Cleanup & Updates",
    "network": "Network & Connectivity",
    "recovery": "System Recovery & Hardware",
    "dev_office": "Developer & Office",
    "searchPlaceholder": "Search actions, diagnostics, or system tools (Ctrl+K)..."
  },
  "hud": {
    "healthScore": "System Health Index",
    "junkFiles": "Reclaimable Junk",
    "dnsLatency": "DNS Resolution",
    "memoryPressure": "Memory Pressure",
    "activeIssues": "Detected Issues",
    "diagnoseAll": "Run Full Diagnostics",
    "runSafeBatch": "Execute Safe Maintenance Preset",
    "cancelOperation": "Cancel Active Operation",
    "openTerminal": "Live Telemetry Console",
    "openSnapshots": "Rollback & Snapshots",
    "exportScript": "Export Portable Script"
  },
  "card": {
    "diagnose": "Diagnose",
    "execute": "Remediate",
    "rollback": "Rollback",
    "requiresAdmin": "Admin Required",
    "safeBatch": "Safe Preset",
    "reversibility": {
      "fully_reversible": "Fully Reversible",
      "partially_reversible": "Partially Reversible",
      "compensating_recovery": "System Restore Point",
      "irreversible": "Irreversible"
    },
    "status": {
      "idle": "Not Scanned",
      "diagnosing": "Scanning...",
      "healthy": "Healthy",
      "needs_attention": "Attention Needed",
      "running": "Executing...",
      "success": "Remediated",
      "error": "Failed",
      "skipped_dependency": "Skipped (Prerequisite Failed)",
      "cancelled": "Cancelled",
      "rolled_back": "Rolled Back"
    }
  },
  "modals": {
    "confirmTitle": "Confirm System Remediation",
    "confirmProceed": "Confirm & Execute",
    "confirmCancel": "Cancel",
    "recycleBinWarning": "Emptying the Windows Recycle Bin permanently destroys all items currently inside it. This action cannot be undone.",
    "winsockWarning": "Resetting Winsock and TCP/IP creates a Windows System Restore Point and exports registry hives, then requires a system restart.",
    "wslWarning": "Shutting down WSL2 terminates all running Linux distributions and Docker Engine containers. Ensure active database containers are saved.",
    "officeHungWarning": "Only unresponsive (Not Responding) Office processes selected below will be terminated. Check AutoRecover folder after restart.",
    "portModalTitle": "Active Developer Port Listeners (3000-9999)",
    "terminateSelected": "Terminate Selected PIDs",
    "scriptExporterTitle": "Export Portable PowerShell / Batch Script",
    "snapshotsTitle": "Transactional Snapshots & Rollback History"
  },
  "actions": {
    "clean-temp-cache": {
      "title": "Purge Stale Temporary Caches",
      "description": "Scans user and Windows Temp directories for unlocked cache files untouched for over 24 hours.",
      "technicalImpact": "Deletes unlocked files older than 24h in %TEMP% and C:\\Windows\\Temp."
    },
    "empty-recycle-bin": {
      "title": "Empty Windows Recycle Bin",
      "description": "Queries total Recycle Bin item count and reclaims disk space via native Shell API.",
      "technicalImpact": "Invokes Win32 SHEmptyRecycleBinW after explicit user confirmation."
    },
    "archive-screenshots": {
      "title": "Archive & Recycle Old Screenshots",
      "description": "Compresses screenshots older than 30 days into a verified backup ZIP and moves originals to the Recycle Bin.",
      "technicalImpact": "Creates SHA-256 verified ZIP snapshot before moving >30d files to Recycle Bin."
    },
    "winget-upgrade-all": {
      "title": "Silent Winget Package Upgrade",
      "description": "Audits outdated packages and runs non-interactive background upgrades via Windows Package Manager.",
      "technicalImpact": "Executes winget upgrade --all --silent with live stdout telemetry."
    },
    "windows-update-scan": {
      "title": "Trigger Windows Update Scan",
      "description": "Queries pending missing security and cumulative updates via official Microsoft.Update.Session COM API.",
      "technicalImpact": "Runs COM UpdateSearcher IsInstalled=0 scan and logs pending KBs."
    },
    "flush-dns-cache": {
      "title": "Flush DNS Resolver Cache",
      "description": "Clears stale DNS records directly via native dnsapi.dll FFI and measures resolution latency.",
      "technicalImpact": "Calls native DnsFlushResolverCache() and benchmarks lookup time."
    },
    "reset-winsock-stack": {
      "title": "Reset Winsock & TCP/IP Stack",
      "description": "Creates a System Restore Point and registry hive backup, then resets corrupted Winsock catalogs.",
      "technicalImpact": "Exports WinSock2 hive, runs netsh winsock reset, and prompts for reboot."
    },
    "clear-stuck-proxy-vpn": {
      "title": "Clear Orphaned VPN & Proxy Locks",
      "description": "Backs up Internet Settings registry values and disables stuck proxy intercepts blocking traffic.",
      "technicalImpact": "Snapshots HKCU Internet Settings, sets ProxyEnable=0, refreshes WinINet."
    },
    "sync-ntp-time": {
      "title": "Resynchronize System Clock (NTP)",
      "description": "Ensures Windows Time service is running and forces an immediate UTC clock resynchronization to prevent TLS/SSL errors.",
      "technicalImpact": "Starts W32Time via Win32 SCM and executes w32tm /resync /force."
    },
    "copy-sysadmin-info": {
      "title": "Copy SysAdmin Diagnostic Summary",
      "description": "Collects hostname, OS build, uptime, RAM pressure, and active IPv4 adapters into the clipboard.",
      "technicalImpact": "Writes structured IT diagnostic report to OS clipboard."
    },
    "dism-restore-health": {
      "title": "DISM Component Store Repair",
      "description": "Verifies and repairs corrupted Windows image component store packages prior to SFC scanning.",
      "technicalImpact": "Executes Dism.exe /Online /Cleanup-Image /RestoreHealth with live progress."
    },
    "sfc-system-scan": {
      "title": "SFC System File Integrity Scan",
      "description": "Scans protected Windows system files and replaces corrupted binaries using the repaired DISM store.",
      "technicalImpact": "Runs sfc.exe /scannow after DISM verification with stateful UTF-16LE decoding."
    },
    "restart-explorer": {
      "title": "Restart Windows Explorer Shell",
      "description": "Snapshots currently open folder paths, restarts hung explorer.exe shell, and restores open folder windows.",
      "technicalImpact": "Saves Shell.Application folder paths to SQLite and restarts explorer.exe."
    },
    "rebuild-icon-cache": {
      "title": "Rebuild Corrupted Icon Cache",
      "description": "Backs up iconcache_*.db files, temporarily pauses Explorer to release file locks, purges cache, and refreshes shell icons.",
      "technicalImpact": "Archives iconcache_*.db, restarts Explorer to unlock handles, runs ie4uinit.exe."
    },
    "restart-bluetooth": {
      "title": "Restart Bluetooth Support Service",
      "description": "Snapshots bthserv service state and restarts hung Bluetooth discovery and audio stacks via Win32 SCM.",
      "technicalImpact": "Restarts bthserv via OpenSCManagerW / ControlService / StartServiceW."
    },
    "reset-print-spooler": {
      "title": "Reset Print Spooler & Stuck Queue",
      "description": "Stops Spooler service, archives stuck .SPL/.SHD print jobs into a reversible backup ZIP, and restarts Spooler.",
      "technicalImpact": "Stops Spooler, zips C:\\Windows\\System32\\spool\\PRINTERS, restarts service."
    },
    "reset-gpu-driver": {
      "title": "Reset WDDM Graphics Driver",
      "description": "Injects the native Windows hardware chord (Win+Ctrl+Shift+B) via Win32 SendInput to reinitialize DWM and GPU drivers.",
      "technicalImpact": "Synthesizes Win+Ctrl+Shift+B kernel graphics reset signal via SendInput."
    },
    "controlled-reboot": {
      "title": "Controlled 10s System Restart",
      "description": "Schedules a clean 10-second OS restart with an instant one-click abort failsafe button.",
      "technicalImpact": "Executes shutdown.exe /r /t 10; rollback button invokes shutdown.exe /a."
    },
    "unlock-dev-ports": {
      "title": "Inspect & Free Locked Dev Ports",
      "description": "Scans TCP ports 3000-9999 via GetExtendedTcpTable and lets you terminate specific processes with TOCTOU verification.",
      "technicalImpact": "Lists listening PIDs on ports 3000-9999 and terminates only verified PIDs."
    },
    "close-hung-office": {
      "title": "Close Unresponsive Office Apps",
      "description": "Detects hung Word, Excel, PowerPoint, and Outlook windows via Win32 IsHungAppWindow without touching healthy documents.",
      "technicalImpact": "Enumerates HWND windows with IsHungAppWindow and terminates selected hung PIDs."
    },
    "clear-teams-outlook-cache": {
      "title": "Clean Teams & Outlook RoamCache",
      "description": "Archives both Teams EBWebView metadata and Outlook RoamCache into a reversible ZIP before clearing corrupted caches.",
      "technicalImpact": "Creates verified ZIP backup of RoamCache & Teams cache, then clears unlocked files."
    },
    "reclaim-wsl-docker-ram": {
      "title": "Reclaim WSL2 & Docker vmmem RAM",
      "description": "Measures vmmemWSL memory consumption and shuts down idle Linux VMs to return gigabytes of RAM to Windows.",
      "technicalImpact": "Executes wsl.exe --shutdown after confirmation and calculates freed RAM delta."
    }
  }
}
```

### 5.3 True Recursive `deepMerge` & Lazy Loader (`src/utils/deepMerge.ts` & `src/i18n/engine.ts`)

```typescript
// src/utils/deepMerge.ts
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const output: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const baseVal = output[key];
    const overVal = override[key];
    if (isPlainObject(baseVal) && isPlainObject(overVal)) {
      output[key] = deepMerge(baseVal, overVal);
    } else if (overVal !== undefined && overVal !== '') {
      output[key] = overVal;
    }
  }
  return output as T;
}
```

```typescript
// src/i18n/engine.ts
import trMaster from './master/tr.json';
import enMaster from './master/en.json';
import { SUPPORTED_LOCALES, LocaleEntry } from './registry';
import { deepMerge } from '../utils/deepMerge';
import type { TranslationDictionary } from '../types/zenith';

const localeModules = import.meta.glob<{ default: TranslationDictionary }>('./locales/*.json');

const cache = new Map<string, TranslationDictionary>([
  ['tr', trMaster as unknown as TranslationDictionary],
  ['en', enMaster as unknown as TranslationDictionary],
]);

export function applyLocaleDomAttributes(code: string): LocaleEntry {
  const entry = SUPPORTED_LOCALES.find((l) => l.code === code) ?? SUPPORTED_LOCALES[0];
  if (typeof document !== 'undefined') {
    document.documentElement.lang = entry.code;
    document.documentElement.dir = entry.dir;
  }
  return entry;
}

export async function loadLocaleDictionary(code: string): Promise<TranslationDictionary> {
  const entry = applyLocaleDomAttributes(code);
  const cached = cache.get(entry.code);
  if (cached) return cached;

  const loader = localeModules[`./locales/${entry.code}.json`];
  if (!loader) {
    return enMaster as unknown as TranslationDictionary;
  }
  try {
    const mod = await loader();
    const merged = deepMerge(
      enMaster as unknown as Record<string, unknown>,
      (mod.default ?? {}) as unknown as Record<string, unknown>
    ) as unknown as TranslationDictionary;
    merged.meta = {
      locale: entry.code,
      dir: entry.dir,
      translated: Boolean(mod.default?.meta?.translated),
    };
    cache.set(entry.code, merged);
    return merged;
  } catch {
    return enMaster as unknown as TranslationDictionary;
  }
}
```

### 5.4 Strict AST Key-Parity & Translation Completeness Validator (`scripts/validate-i18n.ts`)

*(Fails with exit code 1 if any of the 73 locale files is missing, has extra/missing keys compared to `en.json`, has mismatched `{placeholder}` tokens, or if a non-English locale copies more than 15% of its strings verbatim from English.)*

```typescript
// scripts/validate-i18n.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { SUPPORTED_LOCALES } from '../src/i18n/registry';

function flattenKeys(obj: Record<string, unknown>, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      for (const [subK, subV] of flattenKeys(v as Record<string, unknown>, fullKey)) {
        out.set(subK, subV);
      }
    } else {
      out.set(fullKey, String(v));
    }
  }
  return out;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const enRaw = await fs.readFile(path.join(root, 'src/i18n/master/en.json'), 'utf-8');
  const enFlat = flattenKeys(JSON.parse(enRaw) as Record<string, unknown>);
  let errors = 0;

  for (const locale of SUPPORTED_LOCALES) {
    const filePath = path.join(root, 'src/i18n/locales', `${locale.code}.json`);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch {
      console.error(`[FAIL] Missing locale file: ${filePath}`);
      errors++;
      continue;
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const flat = flattenKeys(parsed);

    for (const [key, enVal] of enFlat.entries()) {
      if (!flat.has(key)) {
        console.error(`[FAIL] ${locale.code}.json is missing key: ${key}`);
        errors++;
        continue;
      }
      const locVal = flat.get(key)!;
      const enPlaceholders = (enVal.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort().join(',');
      const locPlaceholders = (locVal.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort().join(',');
      if (enPlaceholders !== locPlaceholders) {
        console.error(`[FAIL] ${locale.code}.json placeholder mismatch at ${key}: expected [${enPlaceholders}], got [${locPlaceholders}]`);
        errors++;
      }
    }

    if (locale.code !== 'en') {
      let identicalCount = 0;
      let translatableCount = 0;
      for (const [key, enVal] of enFlat.entries()) {
        if (key.startsWith('meta.') || key === 'app.title') continue;
        translatableCount++;
        if (flat.get(key) === enVal) {
          identicalCount++;
        }
      }
      const ratio = identicalCount / Math.max(1, translatableCount);
      if (ratio > 0.15) {
        console.error(
          `[FAIL] ${locale.code}.json appears untranslated (${(ratio * 100).toFixed(1)}% identical to English). Agent must translate all strings natively.`
        );
        errors++;
      }
    }
  }

  if (errors > 0) {
    console.error(`i18n validation failed with ${errors} error(s).`);
    process.exit(1);
  }
  console.log(`i18n validation passed across all ${SUPPORTED_LOCALES.length} locales.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

---

## SECTION 6: DETERMINISTIC 22-ACTION SPECIFICATION MATRIX (HONEST REVERSIBILITY & DAG)

| # | `ActionId` | Category | Risk | Admin? | Safe Batch? | `ReversibilityTier` | `dependsOn` | Exact Rust Diagnostic Probe (`diagnose_action`) | Exact Rust Execution (`execute_action`) | Exact Rollback / Recovery Behavior (`rollback_action`) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | `clean-temp-cache` | `cleanup` | `safe` | No | **YES** | `Irreversible` | `[]` | Scan `std::env::temp_dir()` (and `C:\Windows\Temp` only when `is_process_elevated() == true`); sum unlocked files modified $>24\text{h}$ ago. | Delete unlocked files older than $24\text{h}$; skip `ERROR_SHARING_VIOLATION` handles and `ERROR_ACCESS_DENIED`; report exact deleted bytes. | Irreversible temp purge (`can_rollback = false`). |
| 2 | `empty-recycle-bin` | `cleanup` | `moderate` | No | **NO** | `Irreversible` | `[]` | Call `query_recycle_bin_stats()` (`SHQueryRecycleBinW`) propagating any `HRESULT` error. | Require user confirmation modal; call `empty_recycle_bin_native()` (`SHEmptyRecycleBinW`) propagating `HRESULT`. | Irreversible permanent deletion (`can_rollback = false`). |
| 3 | `archive-screenshots` | `cleanup` | `safe` | No | **NO** | `FullyReversible` | `[]` | Scan `%USERPROFILE%\Pictures\Screenshots` for `.png`/`.jpg` files older than 30 days. | Run 4-phase transactional archiver (`create_verified_zip_backup` preserving relative paths + SHA-256 verification $\to$ SQLite commit $\to$ `trash::delete_all` to Recycle Bin). | Call `extract_verified_zip_backup` (verifying SHA-256 and Zip-Slip bounds) back into `Pictures\Screenshots`. |
| 4 | `winget-upgrade-all` | `cleanup` | `moderate` | No | **NO** | `Irreversible` | `[]` | Run `winget.exe upgrade --accept-source-agreements` with 45s timeout and count upgradable packages. | Run `winget.exe upgrade --all --accept-package-agreements --accept-source-agreements --silent --disable-interactivity` with cancellation token and 1800s timeout. | Audit log stores prior version table (`can_rollback = false`). |
| 5 | `windows-update-scan` | `cleanup` | `safe` | Yes | **YES** | `Irreversible` | `[]` | Check `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired`. | Run PowerShell COM `(New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher().Search('IsInstalled=0').Updates | Select-Object Title` with 180s timeout. | Read-only update discovery scan (`can_rollback = false`). |
| 6 | `flush-dns-cache` | `network` | `safe` | No | **YES** | `Irreversible` | `[]` | Measure DNS lookup latency (ms) for `one.one.one.one:443`. | Call `flush_dns_native()` (`DnsFlushResolverCache` FFI in `dnsapi.dll`) and re-measure latency. | OS repopulates DNS resolver cache automatically (`can_rollback = false`). |
| 7 | `reset-winsock-stack` | `network` | `moderate` | Yes | **NO** | `CompensatingRecovery` | `['flush-dns-cache']` | Inspect Winsock catalog keys under `HKLM\SYSTEM\CurrentControlSet\Services\WinSock2\Parameters`. | 1. Export `HKLM\SYSTEM\CurrentControlSet\Services\WinSock2` via `reg.exe save` to backup file. 2. Invoke `Checkpoint-Computer -Description 'Zenith_Winsock_Reset'`. 3. Run `netsh winsock reset` & `netsh int ip reset`. 4. Set `requires_reboot_prompt = true`. | Imports backed-up `WinSock2` hive file via `reg.exe restore` and prompts user to reboot or launch `rstrui.exe` (System Restore). |
| 8 | `clear-stuck-proxy-vpn` | `network` | `safe` | No | **YES** | `FullyReversible` | `[]` | Inspect `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` (`ProxyEnable`, `ProxyServer`, `AutoConfigURL`). | Save `RegistryBackup` snapshot to SQLite; set `ProxyEnable = 0`, remove `ProxyServer` & `AutoConfigURL`; invoke `InternetSetOptionW(INTERNET_OPTION_SETTINGS_CHANGED)`. | Restore exact `ProxyEnable`, `ProxyServer`, and `AutoConfigURL` values from SQLite and invoke `InternetSetOptionW`. |
| 9 | `sync-ntp-time` | `network` | `safe` | Yes | **YES** | `FullyReversible` | `[]` | Query `W32Time` service status via Win32 SCM (`OpenServiceW`, `QueryServiceStatusEx`). | Snapshot `W32Time` service state (`ServiceStateBackup`); start `W32Time` if stopped; run `w32tm.exe /resync /force`. | Restore prior `W32Time` running/stopped state and startup type from SQLite. |
| 10 | `copy-sysadmin-info` | `network` | `safe` | No | **NO** | `Irreversible` | `[]` | Read Hostname, OS Build (`get_accurate_os_build`), Uptime, RAM, and IPv4 adapters. | Format diagnostic summary and return in `ExecutionOutcome.clipboard_text` + copy to OS Clipboard. | Read-only clipboard copy (`can_rollback = false`). |
| 11 | `dism-restore-health` | `recovery` | `moderate` | Yes | **NO** | `Irreversible` | `[]` | Run `Dism.exe /Online /Cleanup-Image /CheckHealth` (< 5s) and inspect exit code. | Run `Dism.exe /Online /Cleanup-Image /RestoreHealth` via `run_cancellable_command` (1800s timeout), streaming stdout to `zenith://terminal-log`. | Official Microsoft component store repair (`can_rollback = false`). |
| 12 | `sfc-system-scan` | `recovery` | `moderate` | Yes | **NO** | `Irreversible` | `['dism-restore-health']` | Inspect `C:\Windows\Logs\CBS\CBS.log` timestamp. | Run `sfc.exe /scannow` via `run_cancellable_command` using `StatefulStreamDecoder` (UTF-16LE carry-byte safe) and stream to `zenith://terminal-log`. | Official Microsoft system binary repair (`can_rollback = false`). |
| 13 | `restart-explorer` | `recovery` | `safe` | No | **NO** | `PartiallyReversible` | `[]` | Inspect `explorer.exe` memory usage and `IsHungAppWindow` status. | Save open folder paths via `(New-Object -ComObject Shell.Application).Windows()` into SQLite `ExplorerSessionBackup`, restart `explorer.exe`, re-open saved folder windows. | Re-opens all folder paths stored in `ExplorerSessionBackup`. |
| 14 | `rebuild-icon-cache` | `recovery` | `safe` | No | **NO** | `FullyReversible` | `[]` | Scan `%LOCALAPPDATA%\Microsoft\Windows\Explorer` for `iconcache_*.db` files. | 1. Copy `iconcache_*.db` into verified backup ZIP. 2. Gracefully stop `explorer.exe` to release file locks. 3. Delete `iconcache_*.db`. 4. Start `explorer.exe` and run `ie4uinit.exe -show`. | Stop `explorer.exe`, extract backed-up `iconcache_*.db` files via `extract_verified_zip_backup`, start `explorer.exe`. |
| 15 | `restart-bluetooth` | `recovery` | `safe` | Yes | **YES** | `FullyReversible` | `[]` | Query `bthserv` status and start type via Win32 `OpenSCManagerW` / `QueryServiceConfigW`. | Save `ServiceStateBackup` to SQLite; restart `bthserv` via Win32 SCM. | Restore prior `bthserv` running state and startup config from SQLite. |
| 16 | `reset-print-spooler` | `recovery` | `safe` | Yes | **YES** | `FullyReversible` | `[]` | Query `Spooler` status and count `.SPL`/`.SHD` files in `C:\Windows\System32\spool\PRINTERS`. | 1. Stop `Spooler` via Win32 SCM. 2. Archive `.SPL`/`.SHD` files via `create_verified_zip_backup` + commit SQLite snapshot. 3. Delete spool files. 4. Start `Spooler`. | Stop `Spooler`, extract `.SPL`/`.SHD` jobs via `extract_verified_zip_backup`, start `Spooler`. |
| 17 | `reset-gpu-driver` | `recovery` | `safe` | No | **NO** | `Irreversible` | `[]` | Enumerate primary display adapter via Win32 `EnumDisplayDevicesW`. | Call `trigger_wddm_gpu_driver_reset()` (synthesizes `Win+Ctrl+Shift+B` via Win32 `SendInput`) to trigger a genuine WDDM/DWM driver reset. | Non-destructive hardware reset signal (`can_rollback = false`). |
| 18 | `controlled-reboot` | `recovery` | `destructive` | Yes | **NO** | `FullyReversible` | `[]` | Check `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending`. | Require confirmation modal; execute `shutdown.exe /r /t 10 /c "Zenith Controlled Restart"` and open 10s countdown overlay. | Clicking **Abort Reboot** calls `shutdown.exe /a` (`abort_pending_reboot`). |
| 19 | `unlock-dev-ports` | `dev_office` | `moderate` | No | **NO** | `Irreversible` | `[]` | Call `scan_dev_ports_detailed()` (`GetExtendedTcpTable` with `Vec<u64>` alignment + `sysinfo` `ProcessesToUpdate::All`). | Opens `PortProcessModal`; user selects targets; backend verifies `(pid, expected_name, expected_start_time_unix)` via `terminate_verified_pids`. | Audit log records terminated PID and redacted command line (`can_rollback = false`). |
| 20 | `close-hung-office` | `dev_office` | `moderate` | No | **NO** | `Irreversible` | `[]` | Call `scan_office_processes()` (`EnumWindows` returning `BOOL(1)` + `IsHungAppWindow`). | Opens confirmation modal listing hung (`Not Responding`) Office instances; terminates via `terminate_verified_pids` (TOCTOU safe) and displays AutoRecover path. | Audit log records closed Office PID (`can_rollback = false`). |
| 21 | `clear-teams-outlook-cache` | `dev_office` | `safe` | No | **NO** | `FullyReversible` | `[]` | Scan `%LOCALAPPDATA%\Microsoft\Outlook\RoamCache` and Teams `EBWebView\Default\Cache` (warns user that Outlook AutoComplete cache will be reset). | Archive both `RoamCache` and Teams config files via `create_verified_zip_backup` $\to$ commit SQLite snapshot $\to$ delete unlocked cache files. | Extract both Outlook `RoamCache` and Teams files via `extract_verified_zip_backup`. |
| 22 | `reclaim-wsl-docker-ram` | `dev_office` | `moderate` | No | **NO** | `Irreversible` | `[]` | Inspect `vmmem` and `vmmemWSL` memory usage via `sysinfo` (`ProcessesToUpdate::All`). | Display container data-loss warning modal; execute `wsl.exe --shutdown`; re-measure memory and report reclaimed MB delta. | User restarts WSL2/Docker on demand (`can_rollback = false`). |

---

## SECTION 7: ALGORITHMS, HEALTH INDEX FORMULA & PORTABLE SCRIPT GENERATOR

### 7.1 Piecewise-Linear System Health Index Formula (`src/utils/healthScore.ts`)

*(Honestly named Piecewise-Linear Penalty Index; DNS penalty threshold is relaxed to start at $50\text{ ms}$ with a maximum penalty cap of 15 points so users on high-latency ISPs are never unfairly penalized, and $F_{\text{issues}}$ is explicitly defined as the count of actions whose `DiagnosticReport.needs_attention == true`.)*

$$
S = \text{round}\left(100 - \left( 30 \cdot \min\left(1, \frac{J_{\text{MB}}}{5120}\right) + 15 \cdot \min\left(1, \frac{\max(0, L_{\text{ms}} - 50)}{250}\right) + 25 \cdot \min\left(1, \frac{\max(0, M_{\%} - 75)}{20}\right) + 30 \cdot \min\left(1, \frac{F_{\text{issues}}}{6}\right) \right)\right)
$$

```typescript
// src/utils/healthScore.ts
export interface HealthMetricsInput {
  junkBytes: number;
  dnsLatencyMs: number;
  memoryUsagePercent: number;
  detectedIssueCount: number;
}

export function computeSystemHealthScore(input: HealthMetricsInput): number {
  const junkMb = Math.max(0, input.junkBytes) / (1024 * 1024);
  const junkPenalty = 30 * Math.min(1, junkMb / 5120);
  const dnsPenalty = 15 * Math.min(1, Math.max(0, input.dnsLatencyMs - 50) / 250);
  const memPenalty = 25 * Math.min(1, Math.max(0, input.memoryUsagePercent - 75) / 20);
  const issuePenalty = 30 * Math.min(1, Math.max(0, input.detectedIssueCount) / 6);

  const raw = 100 - (junkPenalty + dnsPenalty + memPenalty + issuePenalty);
  return Math.max(0, Math.min(100, Math.round(raw)));
}
```

### 7.2 Portable Script Generator Specification (`src/utils/scriptGenerator.ts`)

```typescript
// src/utils/scriptGenerator.ts
import { ActionId } from '../types/zenith';
import { ACTIONS_CATALOG } from '../data/actionsCatalog';
import { topologicalSortActions } from './dagSort';

export function generateConsolidatedScript(
  selectedIds: ActionId[],
  format: 'ps1' | 'bat'
): string {
  const orderedIds = topologicalSortActions(selectedIds, ACTIONS_CATALOG);
  const selectedMeta = orderedIds
    .map((id) => ACTIONS_CATALOG.find((a) => a.id === id))
    .filter((a): a is NonNullable<typeof a> => Boolean(a));

  if (format === 'ps1') {
    const lines: string[] = [
      '#Requires -RunAsAdministrator',
      '# Zenith v1.0.0 - Portable Deterministic Maintenance Script (PowerShell)',
      '$ErrorActionPreference = "Continue"',
      'Write-Host "=== Zenith Automated Remediation Started ===" -ForegroundColor Cyan',
      'Checkpoint-Computer -Description "Zenith_Portable_Script" -RestorePointType "MODIFY_SETTINGS" -ErrorAction SilentlyContinue',
      '',
    ];
    for (const action of selectedMeta) {
      lines.push(`Write-Host "[Running] ${action.id}..." -ForegroundColor Yellow`);
      lines.push(action.exportablePowerShellSnippet);
      lines.push('');
    }
    lines.push('Write-Host "=== Zenith Remediation Complete ===" -ForegroundColor Green');
    return lines.join('\r\n');
  }

  const batLines: string[] = [
    '@echo off',
    'REM Zenith v1.0.0 - Portable Deterministic Maintenance Script (Batch)',
    'net session >nul 2>&1',
    'if %errorLevel% neq 0 (',
    '    echo [ERROR] Administrator privileges required. Right-click and Run as Administrator.',
    '    exit /b 1',
    ')',
    '',
  ];
  for (const action of selectedMeta) {
    batLines.push(`echo [Running] ${action.id}...`);
    batLines.push(action.exportableBatchSnippet);
    batLines.push('');
  }
  batLines.push('echo === Zenith Remediation Complete ===');
  return batLines.join('\r\n');
}
```

---

## SECTION 8: RISKS AND MITIGATIONS MATRIX

| ID | Risk Description | Likelihood | Impact | Concrete Mitigation Implemented in Specification | Owner |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **R-01** | **`tauri::generate_context!()` Macro Panic When `../dist` Is Missing** | Certain (if WP order is wrong) | Critical (Build fails) | WP-1 and WP-2 run `npm run build` to produce `dist/index.html` *before* WP-3 runs `cargo check` or `cargo test`. | Build Pipeline |
| **R-02** | **JSON Comments Breaking Tauri v2 Strict Parser** | Certain (if comments present) | Critical (Build fails) | Removed all `//` comments from `tauri.conf.json`, `capabilities/default.json`, `package.json`, and `tsconfig.json` in Section 2. | Config Layer |
| **R-03** | **`GetExtendedTcpTable` Alignment UB & Buffer Overflow** | Medium | Critical | Allocated 8-byte aligned `Vec<u64>`, added `ERROR_INSUFFICIENT_BUFFER` retry loop, and clamped `dwNumEntries` to buffer byte length in Section 3.4.A. | Process Adapter |
| **R-04** | **PID-Reuse TOCTOU Killing Wrong Process** | Low | Critical | `TerminatePidsRequest` requires `(pid, expected_name, expected_start_time_unix)` verified in `terminate_verified_pids` before `kill()` in Section 3.4.A. | Process Adapter |
| **R-05** | **UAC Split-Brain (`%LOCALAPPDATA%` Profile Mismatch)** | Medium | High | Moved shared SQLite DB and backup archives to `C:\ProgramData\Vellium\Zenith` and added `--resume-queue <CSV>` in Sections 3.3 & 3.4.E. | Storage & UAC |
| **R-06** | **SFC UTF-16LE Line-Split Parity Shift Corrupting Output** | High | High | Implemented `StatefulStreamDecoder` carrying odd trailing bytes (`carry_byte: Option<u8>`) across chunks in Section 3.4.C. | Shell Runner |
| **R-07** | **Crash During ZIP Archiving Causing Data Loss** | Low | Critical | 4-phase transactional archiving (`.zip.tmp` write $\to$ re-open & CRC/SHA-256 verify $\to$ atomic rename & HMAC SQLite commit $\to$ Recycle Bin move) + Zip-Slip `enclosed_name()` check in Section 3.4.D. | FS Clean Adapter |
| **R-08** | **Untranslated English Copies Masquerading as 73 Languages** | High | Medium | Removed external API dependency; Gemini 4 Hydrogen translates all 73 locales directly and `scripts/validate-i18n.ts` fails if $>15\%$ of strings match English or keys/placeholders diverge. | i18n Engine |

---

## SECTION 9: WORK PACKAGES (COMPILER-SAFE SEQUENTIAL EXECUTION PLAN)

### WP-1: Repository Bootstrap, `.rules` Governance, Icons, Configs, Core Utilities & Initial `dist/` Build
* **Scope:** Create `.rules`, `package.json` (`1.0.0`), `tsconfig.json`, `vite.config.ts` (`vitest/config`), `index.html`, `public/app-icon.svg`, `src/styles/index.css` (WCAG-corrected tokens), `src/types/zenith.ts`, `src/data/actionsCatalog.ts`, `src/utils/deepMerge.ts`, `src/utils/dagSort.ts`, `src/utils/healthScore.ts`, `src/utils/scriptGenerator.ts`, and a minimal `src/main.tsx` + `src/App.tsx` bootstrap so `npm run build` produces `dist/` immediately.
* **Verification & Acceptance Criteria:** `npm install && npm run typecheck && npm run build` exits with code `0` and `dist/index.html` exists on disk.

### WP-2: Agent-Native 73-Language i18n Engine, Direct Translation & AST Validation
* **Scope:** Implement `src/i18n/registry.ts` (all 73 locales including `ko`), master dictionaries (`src/i18n/master/en.json` and `tr.json`), `src/i18n/engine.ts` (recursive `deepMerge` + `import.meta.glob`), and `scripts/validate-i18n.ts`. Directly author native translations for all 73 locale files in `src/i18n/locales/<code>.json` without any external API key.
* **Verification & Acceptance Criteria:** `npm run i18n:validate && npm run typecheck && npm run build` exits with code `0` across all 73 locales.

### WP-3: Rust Core Engine - `build.rs`, Icon Generation, Machine-Wide SQLite WAL + HMAC & Kahn's DAG
* **Scope:** Create `src-tauri/Cargo.toml` (`1.0.0`), `src-tauri/build.rs`, comment-free `tauri.conf.json` (`1.0.0`), comment-free `capabilities/default.json`, run `npm run icons:gen` (`tauri icon public/app-icon.svg`), and implement `models.rs`, `error.rs`, `engine/db.rs` (`C:\ProgramData\Vellium\Zenith`, HMAC-SHA256, crash recovery), `engine/dag.rs`, and `engine/telemetry.rs`.
* **Verification & Acceptance Criteria:** Because `dist/` already exists from WP-1/WP-2 and icons exist from `npm run icons:gen`, `cd src-tauri && cargo test` compiles and passes 100% of unit tests on the first run.

### WP-4: Memory-Safe Win32 Adapters, Stateful UTF-16LE Decoder, Cancellation & UAC Queue Handover
* **Scope:** Implement `adapters/uac.rs` (`get_accurate_os_build`, `--wait-pid`, `--resume-queue`), `adapters/fs_clean.rs` (4-phase transactional ZIP backup, `enclosed_name()` Zip-Slip guard, explicit `HRESULT` Recycle Bin calls), `adapters/net.rs` (`DnsFlushResolverCache` FFI, `Checkpoint-Computer` + hive save for Winsock), `adapters/scm.rs` (`SendInput` `Win+Ctrl+Shift+B` GPU reset, Win32 SCM service control), `adapters/proc.rs` (`Vec<u64>` aligned `GetExtendedTcpTable`, `EnumWindows` returning `BOOL(1)`, `terminate_verified_pids` TOCTOU guard), `adapters/shell_iso.rs` (`StatefulStreamDecoder`, `run_cancellable_command`), and `lib.rs` / `main.rs` (`spawn_blocking` IPC handlers + `cancel_running_action` + `--headless` CLI).
* **Verification & Acceptance Criteria:** `cd src-tauri && cargo check --all-targets && cargo test` compiles cleanly with zero errors.

### WP-5: Dual-Environment Bridge (Tauri IPC + Badged Browser Simulator) & Zustand Store
* **Scope:** Implement `src/adapters/bridge.ts`, `tauriAdapter.ts`, `simulatorAdapter.ts` (clearly badged as simulation mode, supporting realistic diagnostics, cancellation, TOCTOU PID simulation, and `localStorage` transactional snapshots), and `src/store/useZenithStore.ts` (managing active action mutex, cancellation trigger, and `--resume-queue` restoration).
* **Verification & Acceptance Criteria:** `npm run typecheck` passes with zero errors.

### WP-6: Complete 10-Component React 19 Workspace (`App.tsx`) with Logical RTL CSS
* **Scope:** Implement `TitleBar.tsx`, `HealthMonitor.tsx`, `CategoryTabs.tsx`, `ActionCard.tsx` (displaying honest `ReversibilityTier` badges and before/after diffs), `TerminalLogDrawer.tsx`, `PortProcessModal.tsx`, `ScriptExporterModal.tsx`, `SnapshotHistoryModal.tsx`, `CommandPalette.tsx`, and `EffectsOverlay.tsx` using logical CSS properties (`ms-*`, `me-*`, `ps-*`, `pe-*`), and wire all 10 components in `src/App.tsx`.
* **Verification & Acceptance Criteria:** `npm run build` succeeds and updates `dist/`.

### WP-7: End-to-End Automated Verification Suite (`vitest` & `cargo test`)
* **Scope:** Implement `src/__tests__/zenith.test.ts` testing: (1) all 73 locales in `SUPPORTED_LOCALES` (including `ko` and RTL flags for `ar`, `he`, `fa`, `ur`) and recursive `deepMerge`; (2) Kahn's DAG topological sort, cycle detection, and fail-fast dependency skipping; (3) Piecewise-Linear Health Score boundaries; (4) `.ps1` and `.bat` script generation; (5) simulator diagnose/execute/cancel/rollback lifecycle. Run full Rust test suite verifying `StatefulStreamDecoder` odd-byte chunk splits, HMAC-SHA256 tamper rejection, and Zip-Slip path rejection.
* **Verification & Acceptance Criteria:** `npm run i18n:validate && npm test && npm run build && cd src-tauri && cargo test` passes 100% of checks.

---

## SECTION 10: IMMEDIATE EXECUTION PROMPT FOR GEMINI 4 HYDROGEN

Place `ZENITH_GREENFIELD_MASTER_SPEC.md` into an empty workspace directory and execute:

```text
Read ZENITH_GREENFIELD_MASTER_SPEC.md completely. Execute Work Packages WP-1 through WP-7 sequentially to build Zenith v1.0.0 from scratch.
1. Follow the exact comment-free JSON configurations, pinned versions, and build order (run `npm run build` in WP-1/WP-2 and `npm run icons:gen` in WP-3 BEFORE running `cargo test` or `cargo check`).
2. Populate all 73 locale JSON files in `src/i18n/locales/<code>.json` directly using native translations without any external API key, and verify them with `npm run i18n:validate`.
3. Implement all Rust modules in `src-tauri/src/` using the exact memory-aligned Win32 FFI (`Vec<u64>` for `GetExtendedTcpTable`), TOCTOU PID verification (`(pid, expected_name, expected_start_time_unix)`), `SendInput` Win+Ctrl+Shift+B WDDM reset, `StatefulStreamDecoder` for UTF-16LE pipes, 4-phase transactional ZIP archiving with `enclosed_name()` Zip-Slip protection, and HMAC-SHA256 SQLite WAL storage in `C:\ProgramData\Vellium\Zenith`.
Run all verification commands at the end of every work package. Zero stubs, zero placeholders, and zero tool-specific rule files are permitted.
```