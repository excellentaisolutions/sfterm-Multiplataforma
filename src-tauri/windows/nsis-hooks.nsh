; Tauri muestra una casilla "Borrar datos de la aplicacion" en el uninstall.
; Su plantilla conoce las rutas derivadas del bundle id, pero SFTerm conserva
; configuracion y estado en rutas historicas propias. Solo se borran cuando el
; usuario marca expresamente la casilla y nunca durante un upgrade.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RMDir /r "$APPDATA\SFTerm"
    RMDir /r "$LOCALAPPDATA\SFTerm"
  ${EndIf}
!macroend
