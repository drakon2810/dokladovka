#define AppVersion "0.1.0"
#define AgentRoot ".."

[Setup]
AppId={{530A3B50-029F-48B5-AB54-70D74BA98996}
AppName=Dokladovka Agent
AppVersion={#AppVersion}
AppPublisher=Dokladovka
DefaultDirName={autopf}\Dokladovka Agent
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#AgentRoot}\artifacts
OutputBaseFilename=dokladovka-agent-setup-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
CloseApplications=yes
RestartApplications=no
UninstallDisplayIcon={app}\Dokladovka.Agent.exe
SetupLogging=yes

[Files]
Source: "{#AgentRoot}\publish\win-x64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Run]
Filename: "{app}\Dokladovka.Agent.exe"; Parameters: "configure"; Description: "Nakonfigurovať a spárovať agenta"; Flags: postinstall waituntilterminated skipifsilent; Check: not AgentIsConfigured
Filename: "{sys}\sc.exe"; Parameters: "create DokladovkaService binPath= ""{app}\Dokladovka.Agent.exe"" start= auto DisplayName= ""Dokladovka Agent"""; Flags: runhidden waituntilterminated; Check: not ServiceExists
Filename: "{sys}\sc.exe"; Parameters: "description DokladovkaService ""Bezpečný odchádzajúci most medzi Dokladovkou a POHODA mServer"""; Flags: runhidden waituntilterminated
Filename: "{sys}\sc.exe"; Parameters: "failure DokladovkaService reset= 86400 actions= restart/5000/restart/15000/restart/60000"; Flags: runhidden waituntilterminated
Filename: "{sys}\sc.exe"; Parameters: "start DokladovkaService"; Flags: runhidden nowait; Check: AgentIsConfigured

[UninstallRun]
Filename: "{sys}\sc.exe"; Parameters: "stop DokladovkaService"; Flags: runhidden waituntilterminated; RunOnceId: "StopService"
Filename: "{sys}\sc.exe"; Parameters: "delete DokladovkaService"; Flags: runhidden waituntilterminated; RunOnceId: "DeleteService"

[Code]
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
    Exec(ExpandConstant('{sys}\sc.exe'), 'stop DokladovkaService', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Sleep(2000);
  end;
end;
