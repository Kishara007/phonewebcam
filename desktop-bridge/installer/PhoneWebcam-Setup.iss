; Standalone Inno Setup 6 Script (Alternative to Tauri's Built-In NSIS Bundler)
; Builds `PhoneWebcam-Setup.exe`, registers `softcam.dll` (`regsvr32 /s`), and assists with VB-Cable.

#define MyAppName "PhoneWebcam Bridge"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Kishara Dilshan"
#define MyAppURL "https://phonewebcam.pages.dev/"
#define MyAppExeName "phonewebcam-bridge.exe"

[Setup]
AppId={{8D6E4921-7A6E-4A95-A43E-14D8E79A2C11}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
OutputDir=output
OutputBaseFilename=PhoneWebcam-Setup
SetupIconFile=..\src-tauri\icons\icon.ico
Compression=lzma2/ultra64
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
WizardStyle=modern

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "vbcable"; Description: "Open official VB-Cable download page for Phone Mic routing (recommended)"; GroupDescription: "Virtual Microphone Driver"; Flags: unchecked

[Files]
Source: "..\src-tauri\target\release\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\src-tauri\resources\softcam.dll"; DestDir: "{app}\resources"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{sys}\regsvr32.exe"; Parameters: "/s ""{app}\resources\softcam.dll"""; StatusMsg: "Registering PhoneWebcam DirectShow Virtual Camera..."; Flags: runhidden waituntilterminated
Filename: "https://vb-audio.com/Cable/"; Flags: shellexec runasoriginaluser postinstall; Tasks: vbcable
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\regsvr32.exe"; Parameters: "/u /s ""{app}\resources\softcam.dll"""; RunOnceId: "UnregisterPhoneWebcamSoftcam"; Flags: runhidden waituntilterminated
