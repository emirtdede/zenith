; Zenith installer hooks.
;
; Tauri's NSIS template shows a "delete application data" checkbox on uninstall
; and exposes its state as `$DeleteAppDataCheckboxState`. The template's own
; deletion targets `%APPDATA%\<bundle id>` and `%LOCALAPPDATA%\<bundle id>`,
; which for Zenith (identifier `com.vellium.zenith`) are paths the application
; never writes. The hook below rebinds the checkbox to the two roots
; `Paths::resolve` actually builds, and nothing else.
;
; Two rules hold here:
;
; 1. The deletion runs only when the user checked the box. A silent uninstall
;    (`/S`) leaves the audit and snapshot directories in place.
; 2. `%ProgramData%\Vellium\Zenith` is machine-wide. The uninstaller is elevated
;    for a per-machine install, so the removal is permitted; a standard user
;    never reaches this hook because they cannot uninstall the machine copy.

!macro NSIS_HOOK_POSTINSTALL
  ; The application registers its own PATH entry on first launch, after the user
  ; has seen what the CLI does. The installer only records where it went, so a
  ; later repair or uninstall can find the same directory.
  WriteRegStr SHCTX "Software\Vellium\Zenith" "InstallDir" "$INSTDIR"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
    RMDir /r "$LOCALAPPDATA\Vellium\Zenith"
    RMDir /r "$APPDATA\Vellium\Zenith"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey SHCTX "Software\Vellium\Zenith"
!macroend
