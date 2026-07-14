#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef OutputSuffix
  #define OutputSuffix ""
#endif
#ifndef AppPublisher
  #define AppPublisher "Dokladovka"
#endif
#define AgentRoot ".."

[Setup]
AppId={{530A3B50-029F-48B5-AB54-70D74BA98996}
AppName=Dokladovka Agent
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\Dokladovka Agent
DefaultGroupName=Dokladovka Agent
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#AgentRoot}\artifacts
OutputBaseFilename=Dokladovka-Agent-Setup-{#AppVersion}{#OutputSuffix}
Compression=lzma2/ultra64
SolidCompression=yes
CloseApplications=yes
RestartApplications=no
UninstallDisplayIcon={app}\Dokladovka.Agent.exe
SetupLogging=yes
Uninstallable=yes
VersionInfoVersion={#AppVersion}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription=Dokladovka Agent pre POHODA Mostík
VersionInfoProductName=Dokladovka Agent
VersionInfoProductVersion={#AppVersion}

[Languages]
Name: "slovak"; MessagesFile: "compiler:Languages\Slovak.isl"

[Dirs]
Name: "{commonappdata}\Dokladovka"; Permissions: admins-full system-full

[Files]
Source: "{#AgentRoot}\publish\win-x64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs restartreplace uninsrestartdelete
#ifdef SelfSignedCertificatePath
Source: "{#SelfSignedCertificatePath}"; DestDir: "{tmp}"; DestName: "Dokladovka-Agent-Temporary-Code-Signing.cer"; Flags: deleteafterinstall
#endif

[Icons]
Name: "{group}\Dokladovka Agent – Nastavenie"; Filename: "{app}\Dokladovka.Agent.Configurator.exe"
Name: "{group}\Dokladovka Agent – Diagnostika"; Filename: "{app}\Dokladovka.Agent.Configurator.exe"; Parameters: "--diagnostics"
Name: "{commondesktop}\Dokladovka Agent – Nastavenie"; Filename: "{app}\Dokladovka.Agent.Configurator.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Vytvoriť odkaz na nastavenie na pracovnej ploche"; Flags: unchecked

[Run]
#ifdef SelfSignedCertificatePath
Filename: "{sys}\certutil.exe"; Parameters: "-addstore -f Root ""{tmp}\Dokladovka-Agent-Temporary-Code-Signing.cer"""; Flags: runhidden waituntilterminated
Filename: "{sys}\certutil.exe"; Parameters: "-addstore -f TrustedPublisher ""{tmp}\Dokladovka-Agent-Temporary-Code-Signing.cer"""; Flags: runhidden waituntilterminated
#endif
Filename: "{app}\Dokladovka.Agent.Configurator.exe"; Description: "Nakonfigurovať a spárovať agenta"; Flags: postinstall waituntilterminated skipifsilent; Check: not AgentIsConfigured
Filename: "{sys}\sc.exe"; Parameters: "create DokladovkaService binPath= ""{app}\Dokladovka.Agent.exe"" start= auto DisplayName= ""Dokladovka Agent"""; Flags: runhidden waituntilterminated; Check: AgentIsConfigured and not ServiceExists
Filename: "{sys}\sc.exe"; Parameters: "description DokladovkaService ""Bezpečný odchádzajúci most medzi Dokladovkou a POHODA mServer"""; Flags: runhidden waituntilterminated; Check: ServiceExists
Filename: "{sys}\sc.exe"; Parameters: "failure DokladovkaService reset= 86400 actions= restart/5000/restart/15000/restart/60000"; Flags: runhidden waituntilterminated; Check: ServiceExists
Filename: "{sys}\sc.exe"; Parameters: "start DokladovkaService"; Flags: runhidden waituntilterminated; Check: AgentIsConfigured and ServiceExists

[UninstallRun]
Filename: "{sys}\sc.exe"; Parameters: "stop DokladovkaService"; Flags: runhidden waituntilterminated; RunOnceId: "StopService"
Filename: "{sys}\sc.exe"; Parameters: "delete DokladovkaService"; Flags: runhidden waituntilterminated; RunOnceId: "DeleteService"
#ifdef SelfSignedCertificateThumbprint
Filename: "{sys}\certutil.exe"; Parameters: "-delstore TrustedPublisher {#SelfSignedCertificateThumbprint}"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveTemporaryPublisherCertificate"
Filename: "{sys}\certutil.exe"; Parameters: "-delstore Root {#SelfSignedCertificateThumbprint}"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveTemporaryRootCertificate"
#endif

[Code]
var
  ServiceWasInstalled: Boolean;

function AgentIsConfigured: Boolean;
begin
  Result := FileExists(ExpandConstant('{commonappdata}\Dokladovka\agent.json'));
end;

function ServiceExists: Boolean;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\sc.exe'), 'query DokladovkaService', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := ResultCode = 0;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Result := '';
  if ServiceExists then
  begin
    ServiceWasInstalled := True;
    Exec(ExpandConstant('{sys}\sc.exe'), 'stop DokladovkaService', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(2000);
  end;
end;

procedure DeinitializeSetup();
var
  ResultCode: Integer;
begin
  if ServiceWasInstalled and ServiceExists and AgentIsConfigured then
    Exec(ExpandConstant('{sys}\sc.exe'), 'start DokladovkaService', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;
