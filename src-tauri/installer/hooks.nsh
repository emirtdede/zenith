; Zenith NSIS hooks (DEF-064 / REQ-F-134).
;
; Tauri's uninstaller already offers a "delete app data" checkbox on the confirm
; page (`installer.nsi` -> un.ConfirmShow). The problem it had was the *path*: the
; stock template removes `%APPDATA%\com.vellium.zenith` and
; `%LOCALAPPDATA%\com.vellium.zenith`, but Zenith keeps nothing there. Its real
; roots are `...\Vellium\Zenith` (see `Paths::resolve` in
; `crates/zenith-core/src/config.rs`), so checking the box deleted an empty,
; unrelated folder and left snapshots, logs and preferences behind.
;
; This hook re-uses that checkbox instead of adding a second prompt: one question,
; one decision, and the answer is honoured against the directories that exist.
;
; Silent uninstall (`/S`) never deletes data: the confirm page is skipped in
; passive mode (`un.SkipIfPassive`), so `$DeleteAppDataCheckboxState` stays empty
; and this block is inert. `scripts/verify-uninstall.ps1` asserts the store is
; byte-identical after `/S`, and that guarantee is deliberate.

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
    ; Machine store (D1..D7): state.db, hmac key, backups, hives, logs,
    ; quarantine. Under SetShellVarContext "all", $APPDATA is %ProgramData%.
    SetShellVarContext all
    RMDir /r "$APPDATA\Vellium\Zenith"
    RMDir "$APPDATA\Vellium"

    ; Per-user store (D8 prefs, D9 support bundles) for the user running the
    ; uninstaller. Other user profiles keep their own copy, which is correct:
    ; this process has no mandate to enumerate them.
    SetShellVarContext current
    RMDir /r "$LOCALAPPDATA\Vellium\Zenith"
    RMDir "$LOCALAPPDATA\Vellium"
  ${EndIf}
!macroend
