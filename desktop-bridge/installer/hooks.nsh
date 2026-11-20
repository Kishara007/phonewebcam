; PhoneWebcam Bridge — Tauri v2 NSIS 1-Click Installer Hooks
; Automatically registers the bundled Softcam DirectShow virtual camera DLL
; and assists with optional VB-Cable installation for Zoom/Meet microphone routing.

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "Registering PhoneWebcam DirectShow Virtual Camera driver..."
  IfFileExists "$INSTDIR\resources\softcam.dll" 0 +3
    ExecWait '"$SYSDIR\regsvr32.exe" /s "$INSTDIR\resources\softcam.dll"'
    Goto _pwc_cam_done
  IfFileExists "$INSTDIR\softcam.dll" 0 _pwc_cam_done
    ExecWait '"$SYSDIR\regsvr32.exe" /s "$INSTDIR\softcam.dll"'
  _pwc_cam_done:

  ; Check whether VB-Cable virtual audio driver is already installed.
  ; Skip interactive prompt during silent/automated installs (/S).
  IfSilent _pwc_vbcable_done
  ClearErrors
  ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Services\VBAudioVACWDM" "DisplayName"
  IfErrors 0 _pwc_vbcable_done
    MessageBox MB_YESNO|MB_ICONINFORMATION \
      "PhoneWebcam Virtual Camera is registered and ready!$\r$\n$\r$\nTo also use your phone's microphone in Google Meet, Zoom, or Teams, the free VB-Cable audio driver is recommended (not yet detected on this PC).$\r$\n$\r$\nOpen the official VB-Cable download page now?" \
      IDNO _pwc_vbcable_done
    ExecShell "open" "https://vb-audio.com/Cable/"
  _pwc_vbcable_done:
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Unregistering PhoneWebcam DirectShow Virtual Camera driver..."
  IfFileExists "$INSTDIR\resources\softcam.dll" 0 +2
    ExecWait '"$SYSDIR\regsvr32.exe" /u /s "$INSTDIR\resources\softcam.dll"'
  IfFileExists "$INSTDIR\softcam.dll" 0 +2
    ExecWait '"$SYSDIR\regsvr32.exe" /u /s "$INSTDIR\softcam.dll"'
!macroend
