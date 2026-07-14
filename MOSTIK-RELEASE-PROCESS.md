# Release proces Dokladovka Agent

## Vývojový artifact

Lokálne a na bežnom CI sa vytvára iba jasne označený nepodpísaný setup:

```powershell
.\agent\scripts\publish.ps1 -Runtime win-x64 -Version 0.1.0
.\agent\scripts\build-installer.ps1 `
  -Iscc 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe' `
  -Version 0.1.0 -Development
```

Výstup `Dokladovka-Agent-Setup-0.1.0-UNSIGNED-DEV.exe` slúži iba na lokálny
test. Endpoint `/api/agent/latest` ho nesmie ponúknuť.

## Dočasný self-signed release

Tento režim je výslovne dočasný. Vytvorí neexportovateľný code-signing kľúč v
`Cert:\CurrentUser\My`, pridá verejný certifikát do lokálnych úložísk `Root` a
`TrustedPublisher`, zostaví agent a vytvorí `SELF-SIGNED-TEMP` setup:

```powershell
.\agent\scripts\create-temporary-self-signed-release.ps1 `
  -Version 0.1.0 `
  -Iscc "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
```

EXE, SHA-256, manifest a verejný `.cer` sa skopírujú do `public/downloads`.
Manifest má `signatureTrust: self-signed`, `channel: temporary` a odkaz na
verejný certifikát. Backend povolí jeho publikovanie iba pri
`AGENT_ALLOW_SELF_SIGNED_RELEASES=true`; v development režime je povolené
automaticky. Privátny kľúč sa nekopíruje do projektu ani do inštalátora.

Na čistom počítači Windows pri prvom spustení stále môže zobraziť SmartScreen.
Po vedomom potvrdení setup pridá dočasný certifikát do `Root` a
`TrustedPublisher`, aby boli ďalšie aktualizácie overiteľné. Odinštalátor tento
certifikát odstráni. Po získaní dôveryhodného certifikátu dočasný release
deaktivujte, vypnite `AGENT_ALLOW_SELF_SIGNED_RELEASES` a publikujte vyššiu
production verziu.

## Produkčný release

Produkčný tok je `tag → test → publish → setup → podpis → verifikácia → GitHub
Release → backend manifest`.

1. Nastavte secrets:
   - `WINDOWS_SIGNING_CERTIFICATE_BASE64`
   - `WINDOWS_SIGNING_CERTIFICATE_PASSWORD`
   - `WINDOWS_SIGNING_CERTIFICATE_THUMBPRINT`
   - `WINDOWS_SIGNING_PUBLISHER`
   - `AGENT_CLOUD_BASE_URL`
   - `DOKLADOVKA_RELEASE_API_URL`
   - `DOKLADOVKA_RELEASE_API_TOKEN`
2. Rovnaký náhodný publish token nastavte backendu ako
   `AGENT_RELEASE_PUBLISH_TOKEN`.
3. Vytvorte tag `agent-v1.2.3` a pushnite ho. Workflow
   `.github/workflows/agent-release.yml` odmietne chýbajúci alebo neplatný
   podpis.
4. Workflow publikuje `Dokladovka-Agent-Setup-1.2.3.exe` a
   `release-manifest.json`. Verejný download musí fungovať bez GitHub session;
   pri súkromnom repozitári použite verejné HTTPS object storage alebo
   autorizovanú backend download proxy.
5. Backend uloží len release s HTTPS URL, 64-znakovým SHA-256, veľkosťou,
   dátumom, vydavateľom, thumbprintom a `signed: true`.

## Overenie

```powershell
$setup = '.\Dokladovka-Agent-Setup-1.2.3.exe'
Get-AuthenticodeSignature -LiteralPath $setup | Format-List Status,SignerCertificate
Get-FileHash -LiteralPath $setup -Algorithm SHA256
```

Status musí byť `Valid`, thumbprint sa musí zhodovať s manifestom a SHA-256 s
hodnotou z `/api/agent/latest`. Na čistom podporovanom Windows otestujte setup,
GUI pairing, vytvorenie a recovery actions služby, heartbeat, upgrade a
odinštalovanie.

## Upgrade a rollback

Upgrade tým istým `AppId` zastaví službu, nahradí súbory, zachová DPAPI secrets
a konfiguráciu a službu opäť spustí. Pri zlyhaní setup obnoví pôvodné súbory a
v `DeinitializeSetup` sa pokúsi znovu spustiť existujúcu službu.

Kompromitované vydanie okamžite deaktivujte cez admin
`DELETE /api/mostik/releases/{version}`, odvolajte certifikát podľa procesu CA
a publikujte opravenú vyššiu verziu. Rollback znamená zablokovať chybný release
a znovu publikovať overený build s vyšším semver; agent vedome neinštaluje
nižšiu verziu automaticky.

Auditné dáta v `%ProgramData%\Dokladovka` odinštalátor nemaže. Ich odstránenie
je samostatné vedomé rozhodnutie správcu podľa retention policy.
