# Capability Declarations

| Field | Value |
| :--- | :--- |
| Document ID | DOC-STORE-004 |
| Version | 1.0.0 |
| Owner | Release Engineering |
| Closes | REQ-N-047 |

The Store build uses the same Rust core as the GitHub build. An MSIX package
cannot rely on a per-machine NSIS install, so the following table separates what
the application needs from what the current Tauri configuration grants.

## Tauri window capabilities (`src-tauri/capabilities/default.json`)

| Capability | Justification |
| :--- | :--- |
| `core:default` | Baseline event and window API |
| `core:event:default` | The core emits phase, log, diagnosis, telemetry, snapshot, and notice events |
| `core:window:allow-start-dragging` | The window is frameless; the drag region is the title bar |
| `core:window:allow-minimize` | Custom window control |
| `core:window:allow-toggle-maximize` | Custom window control |
| `core:window:allow-is-maximized` | The maximize icon reflects the real state |
| `core:window:allow-internal-toggle-maximize` | Double click on the drag region |
| `core:window:allow-close` | Custom close control |
| `dialog:allow-save` | Export a settings document or a support bundle to a path the user picks |

No filesystem, shell, process, or HTTP plugin is granted to the renderer. Every
file operation runs through one of the 15 typed IPC commands.

## MSIX manifest capabilities

| Capability | Needed | Justification |
| :--- | :--- | :--- |
| `runFullTrust` | Yes | The core reads system state, writes snapshots, and starts elevated helper processes. A Store desktop bridge package requires full trust for this. |
| `internetClient` | Yes | Update check against `api.github.com`, optional telemetry, optional webhook |
| `privateNetworkClientServer` | No | The local API is not implemented in 1.0.0 |
| `broadFileSystemAccess` | No | The application writes only under its declared roots and the folders the user picks for a snapshot |
| `documentsLibrary` | No | Snapshots are chosen per action; a broad library capability would exceed the need |

## Store package differences

1. The installer target changes from NSIS to MSIX/APPX.
2. The update channel default changes from `github` to `store`, and the in-app
   download is disabled. The application reports that the Store manages updates.
3. The package identity comes from Partner Center. `com.vellium.zenith` is the
   Tauri identifier and must match the reserved Store identity or be changed
   before submission.
4. The executable is signed by Microsoft. The GitHub build is signed by Vellium
   when a signing certificate is configured.
