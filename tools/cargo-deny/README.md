# Vendored `cargo-deny` (build-time only)

`check:deny` runs this binary against `deny.toml`. It is vendored so the gate
does not depend on PATH and still works on an air-gapped machine.

| Field | Value |
| :--- | :--- |
| Version | cargo-deny 0.22.0 |
| Target | `x86_64-pc-windows-msvc` |
| Release | <https://github.com/EmbarkStudios/cargo-deny/releases/tag/0.22.0> |
| Archive | `cargo-deny-0.22.0-x86_64-pc-windows-msvc.tar.gz` |
| Archive SHA-256 | `a85b270b4aa28633d2cb2be97fccd4518ccb783014914e99463e75468cb3183c` |
| Binary | `cargo-deny-0.22.0-x86_64-pc-windows-msvc/cargo-deny.exe` (9,125,888 B) |
| Licence | MIT OR Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE` beside the binary) |
| Verified | 2026-11-20, hash matched the published `.sha256` before extraction |

This tool is **not** shipped in the installer; it is development/release
infrastructure. The notices in `resources/licenses/` cover what ships.
