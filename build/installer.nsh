!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "WordFunc.nsh"
!insertmacro VersionCompare

!ifndef BUILD_UNINSTALLER
  !define MUI_INSTFILESPAGE_COLORS "887BCF 17151E"
  !define MUI_INSTFILESPAGE_PROGRESSBAR "smooth colored"
  !define MUI_INSTFILESPAGE_FINISHHEADER_TEXT "OrbitChat is ready"
  !define MUI_INSTFILESPAGE_FINISHHEADER_SUBTEXT "Your orbit has been set up. Launch the app to continue."
  !define MUI_BGCOLOR "17151E"
  !define MUI_TEXTCOLOR "EEEDF4"
  !define MUI_LICENSEPAGE_BGCOLOR "C0C0C0"
  !define MUI_HEADERIMAGE
  !define /redef MUI_HEADERIMAGE_BITMAP "${BUILD_RESOURCES_DIR}\installer-header.bmp"
  !define /redef MUI_HEADERIMAGE_BITMAP_STRETCH "FitControl"
  !define /redef MUI_DIRECTORYPAGE_TEXT_TOP "Choose where Orbit Chat should be installed. Existing app data is kept when you upgrade, repair, or change installation scope."
  !define /redef MUI_DIRECTORYPAGE_TEXT_DESTINATION "Install Orbit Chat in:"
!endif

!ifndef BUILD_UNINSTALLER
Function OrbitChatLicensePageShow
  ; Control 1000 is the NSIS license RichEdit viewer.
  FindWindow $0 "#32770" "" $HWNDPARENT
  GetDlgItem $1 $0 1000
  ; RichEdit uses EM_SETBKGNDCOLOR (WM_USER + 67), not SetCtlColors.
  SendMessage $1 0x0443 0 0x00C0C0C0
FunctionEnd

Var OrbitChatInstalledVersion
Var OrbitChatInstallerAction
Var OrbitChatActionRepair
Var OrbitChatActionUpgrade
Var OrbitChatActionDowngrade
Var OrbitChatInstallStatusPageText
  Var OrbitChatStatusLabel
  Var OrbitChatStepOne
  Var OrbitChatStepTwo
  Var OrbitChatStepThree
  Var OrbitChatStepFour
  Var OrbitChatPulse

!macro customWelcomePage
  !insertmacro MUI_PAGE_INIT
  PageEx custom
    PageCallbacks OrbitChatWelcomePageShow OrbitChatWelcomePageLeave
    Caption " "
  PageExEnd
  !insertmacro MUI_PAGE_FUNCTION_CUSTOM SHOW
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW OrbitChatLicensePageShow
!macroend

Function OrbitChatWelcomePageShow
  StrCpy $OrbitChatInstalledVersion ""
  StrCpy $OrbitChatInstallerAction "upgrade"

  ; Read the existing per-user or per-machine installation version.
  ReadRegStr $OrbitChatInstalledVersion HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayVersion"
  ${If} $OrbitChatInstalledVersion == ""
    ReadRegStr $OrbitChatInstalledVersion HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayVersion"
  ${EndIf}
  ; electron-builder also writes this GUID-keyed uninstall entry for compatibility.
  ${If} $OrbitChatInstalledVersion == ""
    ReadRegStr $OrbitChatInstalledVersion HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}" "DisplayVersion"
  ${EndIf}
  ${If} $OrbitChatInstalledVersion == ""
    ReadRegStr $OrbitChatInstalledVersion HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}" "DisplayVersion"
  ${EndIf}

  ${If} $OrbitChatInstalledVersion != ""
    ${VersionCompare} "${VERSION}" "$OrbitChatInstalledVersion" $0
    ${If} $0 == 2
      StrCpy $OrbitChatInstallerAction "downgrade"
    ${EndIf}
  ${EndIf}

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  SetCtlColors $0 "#EEEDF4" "#17151E"
  ${NSD_CreateLabel} 0u 0u 300u 26u "Orbit Chat  •  version ${VERSION}"
  Pop $1
  SetCtlColors $1 "#F0ECFF" "#17151E"
  ${NSD_CreateLabel} 0u 30u 300u 34u "A calmer place for your community.$\r$\nChoose an install action and continue through the setup wizard."
  Pop $1
  SetCtlColors $1 "#A7A1B7" "#17151E"

  ${If} $OrbitChatInstalledVersion == ""
    ${NSD_CreateLabel} 0u 77u 300u 32u "Ready to install Orbit Chat on this PC."
    Pop $1
    SetCtlColors $1 "#D8D1F1" "#211E2B"
  ${ElseIf} $OrbitChatInstallerAction == "downgrade"
    ${NSD_CreateLabel} 0u 77u 300u 38u "Installed $OrbitChatInstalledVersion  →  Installer ${VERSION}$\r$\nThis is an older version. Confirm the downgrade below."
    Pop $1
    SetCtlColors $1 "#E5C48E" "#211E2B"
    ${NSD_CreateRadioButton} 10u 124u 280u 24u "Downgrade to version ${VERSION}"
    Pop $OrbitChatActionDowngrade
    SetCtlColors $OrbitChatActionDowngrade "#EEEDF4" "#25222E"
    SendMessage $OrbitChatActionDowngrade ${BM_SETCHECK} ${BST_CHECKED} 0
  ${Else}
    ${NSD_CreateLabel} 0u 77u 300u 38u "Installed $OrbitChatInstalledVersion  →  Installer ${VERSION}$\r$\nChoose repair or upgrade to continue."
    Pop $1
    SetCtlColors $1 "#D8D1F1" "#211E2B"
    ${NSD_CreateRadioButton} 10u 124u 280u 24u "Fix this installation (repair)"
    Pop $OrbitChatActionRepair
    SetCtlColors $OrbitChatActionRepair "#EEEDF4" "#25222E"
    ${NSD_CreateRadioButton} 10u 154u 280u 24u "Upgrade to version ${VERSION}"
    Pop $OrbitChatActionUpgrade
    SetCtlColors $OrbitChatActionUpgrade "#EEEDF4" "#25222E"
    ${VersionCompare} "${VERSION}" "$OrbitChatInstalledVersion" $0
    ${If} $0 == 1
      SendMessage $OrbitChatActionUpgrade ${BM_SETCHECK} ${BST_CHECKED} 0
      StrCpy $OrbitChatInstallerAction "upgrade"
    ${Else}
      SendMessage $OrbitChatActionRepair ${BM_SETCHECK} ${BST_CHECKED} 0
      StrCpy $OrbitChatInstallerAction "repair"
    ${EndIf}
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function OrbitChatWelcomePageLeave
  ${If} $OrbitChatInstalledVersion != ""
    ${If} $OrbitChatInstallerAction == "downgrade"
      ${NSD_GetState} $OrbitChatActionDowngrade $0
      ${If} $0 != ${BST_CHECKED}
        Abort
      ${EndIf}
    ${Else}
      ${NSD_GetState} $OrbitChatActionRepair $0
      ${If} $0 == ${BST_CHECKED}
        StrCpy $OrbitChatInstallerAction "repair"
      ${Else}
        ${NSD_GetState} $OrbitChatActionUpgrade $0
        ${If} $0 == ${BST_CHECKED}
          StrCpy $OrbitChatInstallerAction "upgrade"
        ${Else}
          Abort
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
FunctionEnd

!macro customPageAfterChangeDir
  !insertmacro MUI_PAGE_INIT
  PageEx custom
    PageCallbacks OrbitChatInstallStatusShow
    Caption " "
  PageExEnd
!macroend

Function OrbitChatInstallStatusTick
  ${If} $OrbitChatPulse == 0
    SetCtlColors $OrbitChatStepOne "#F0ECFF" "#302B3C"
    SetCtlColors $OrbitChatStepTwo "#B4AEC3" "#25222E"
    SetCtlColors $OrbitChatStepThree "#B4AEC3" "#25222E"
    SetCtlColors $OrbitChatStepFour "#B4AEC3" "#25222E"
    StrCpy $OrbitChatStatusLabel "Inspecting the installation package"
  ${ElseIf} $OrbitChatPulse == 1
    SetCtlColors $OrbitChatStepOne "#F0ECFF" "#302B3C"
    SetCtlColors $OrbitChatStepTwo "#F0ECFF" "#302B3C"
    SetCtlColors $OrbitChatStepThree "#B4AEC3" "#25222E"
    SetCtlColors $OrbitChatStepFour "#B4AEC3" "#25222E"
    StrCpy $OrbitChatStatusLabel "Extracting OrbitChat files"
  ${ElseIf} $OrbitChatPulse == 2
    SetCtlColors $OrbitChatStepOne "#F0ECFF" "#302B3C"
    SetCtlColors $OrbitChatStepTwo "#F0ECFF" "#302B3C"
    SetCtlColors $OrbitChatStepThree "#F0ECFF" "#302B3C"
    SetCtlColors $OrbitChatStepFour "#B4AEC3" "#25222E"
    StrCpy $OrbitChatStatusLabel "Creating shortcuts and registration"
  ${Else}
    SetCtlColors $OrbitChatStepOne "#F0ECFF" "#302B3C"
    SetCtlColors $OrbitChatStepTwo "#F0ECFF" "#302B3C"
    SetCtlColors $OrbitChatStepThree "#F0ECFF" "#302B3C"
    SetCtlColors $OrbitChatStepFour "#F0ECFF" "#302B3C"
    StrCpy $OrbitChatStatusLabel "Finishing the OrbitChat setup"
  ${EndIf}
  IntOp $OrbitChatPulse $OrbitChatPulse + 1
  ${If} $OrbitChatPulse >= 4
    StrCpy $OrbitChatPulse 0
  ${EndIf}
  SendMessage $OrbitChatInstallStatusPageText ${WM_SETTEXT} 0 "STR:$OrbitChatStatusLabel"
FunctionEnd

Function OrbitChatInstallStatusShow
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  SetCtlColors $0 "#EEEDF4" "#17151E"
  ${NSD_CreateLabel} 0u 0u 300u 26u "OrbitChat is finding its orbit"
  Pop $1
  SetCtlColors $1 "#F0ECFF" "#17151E"
  ${NSD_CreateLabel} 0u 31u 300u 34u "Installing version ${VERSION}.$\r$\nThe application files are included with this installer."
  Pop $1
  SetCtlColors $1 "#A7A1B7" "#17151E"
  ${NSD_CreateLabel} 0u 76u 300u 24u ""
  Pop $OrbitChatInstallStatusPageText
  SetCtlColors $OrbitChatInstallStatusPageText "#D9D2F5" "#17151E"
  ${NSD_CreateLabel} 8u 111u 286u 27u "01   Prepare installer"
  Pop $OrbitChatStepOne
  ${NSD_CreateLabel} 8u 143u 286u 27u "02   Extract application"
  Pop $OrbitChatStepTwo
  ${NSD_CreateLabel} 8u 175u 286u 27u "03   Create shortcuts"
  Pop $OrbitChatStepThree
  ${NSD_CreateLabel} 8u 207u 286u 27u "04   Finish setup"
  Pop $OrbitChatStepFour
  SetCtlColors $OrbitChatStepOne "#F0ECFF" "#302B3C"
  SetCtlColors $OrbitChatStepTwo "#B4AEC3" "#25222E"
  SetCtlColors $OrbitChatStepThree "#B4AEC3" "#25222E"
  SetCtlColors $OrbitChatStepFour "#B4AEC3" "#25222E"
  StrCpy $OrbitChatPulse 0
  ${NSD_CreateTimer} OrbitChatInstallStatusTick 650
  nsDialogs::Show
  ${NSD_KillTimer} OrbitChatInstallStatusTick
FunctionEnd
!endif
