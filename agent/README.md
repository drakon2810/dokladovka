# Dokladovka Agent pre Windows

Agent je odchádzajúci most medzi cloud backendom a lokálnou POHODOU. Cloud nemá priamy prístup do siete zákazníka. Token agenta a POHODA heslá sa ukladajú cez Windows DPAPI (`LocalMachine`) do `%ProgramData%\Dokladovka`.

Agent podporuje dva režimy prepojenia s POHODOU (pole `mode` endpointu v `agent.json`):

- **`mserver`** (predvolený) – HTTP komunikácia s trvalo bežiacim POHODA mServer.
- **`cli`** – priamy XML import bez mServera: agent zapíše dataPack a INI súbor do `%ProgramData%\Dokladovka\xml` a spustí `pohoda.exe /XML "user" "heslo" job.ini`. POHODA sa spustí bez okna, spracuje import, zapíše responsePack a skončí. Licencia je obsadená iba počas behu. Režim vyžaduje `database` (názov databázy firmy, napr. `StwPh_12345678_2026.mdb`; pri SQL/E1 názov SQL databázy) a `pohodaExePath`. Účtovný rok sa odvodzuje z názvu databázy – **pri prechode na nový rok treba `database` v konfigurácii aktualizovať**. Beh má timeout 10 minút a na stroji beží vždy iba jeden import naraz (medziprocesový zámok, takže sa serializuje aj beh služby vs. `configure`/`run-once`). **Bezpečnostné upozornenie:** POHODA vyžaduje prihlasovacie údaje ako argumenty príkazového riadku (oficiálny mechanizmus STORMWARE), takže počas behu je heslo viditeľné v zozname procesov (`Win32_Process.CommandLine`) – a to nielen lokálnemu správcovi, ale na predvolenom Windowse aj bežným (neadministrátorským) používateľom prihláseným na tom istom stroji, plus sa zaznamená do auditu vytvárania procesov (Event ID 4688 / Sysmon 1). Preto: službu spúšťajte pod vyhradeným účtom s minimom práv, na zdieľanom (RDP) serveri, kde sa prihlasuje viac ľudí, uprednostnite režim `mserver`, a prístup interaktívneho/RDP prihlásenia obmedzte len na nevyhnutné účty.

## Inštalácia používateľom

Používateľ sťahuje jediný súbor `Dokladovka-Agent-Setup-{version}.exe` z
`Nastavenia → Mostík`. Setup obsahuje self-contained .NET runtime, Windows
službu, XSD schémy, updater, grafický konfigurátor a odinštalátor. Po prvej
inštalácii sa automaticky otvorí slovenský sprievodca. Pairing code a údaje
mServera sa nikdy nevkladajú do setupu ani jeho command line.

Podrobný postup je v `MOSTIK-USER-INSTALLATION-SK.md` v koreni repozitára.

## Vývoj a zostavenie

```powershell
.\agent\scripts\fetch-pohoda-xsd.ps1
dotnet test .\agent\Dokladovka.Agent.sln --configuration Release
.\agent\scripts\publish.ps1 -Runtime win-x64
.\agent\scripts\build-installer.ps1 -Iscc 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe' -Version 0.1.0 -Development
```

`fetch-pohoda-xsd.ps1` sťahuje aktuálny oficiálny balík schém STORMWARE a uloží URL, čas a SHA-256 zdrojového ZIP. Publikovaný agent obsahuje schémy v `Schemas` a pred každým exportom vykoná fail-closed validáciu.

Development setup je zámerne pomenovaný `*-UNSIGNED-DEV.exe` a backend ho
nesmie publikovať. Produkčný setup vytvára tag workflow
`.github/workflows/agent-release.yml`; bez platného Authenticode certifikátu
workflow zlyhá.

## Konfigurácia a diagnostika

Inštalátor pri prvej interaktívnej inštalácii otvorí grafický konfigurátor.
Odkazy **Dokladovka Agent – Nastavenie** a **Dokladovka Agent – Diagnostika**
sú v ponuke Štart. CLI zostáva iba pre správcu/podporu:

```powershell
& 'C:\Program Files\Dokladovka Agent\Dokladovka.Agent.exe' configure
& 'C:\Program Files\Dokladovka Agent\Dokladovka.Agent.exe' diagnose
& 'C:\Program Files\Dokladovka Agent\Dokladovka.Agent.exe' run-once
```

Agent podporuje viac mServer endpointov v `agent.json`. Prvý endpoint vytvorí sprievodca; ďalšie sa doplnia do konfigurácie a ich prihlasovacie údaje sa musia bezpečne uložiť opätovnou konfiguráciou. POHODA mServer možno riadiť overeným CLI tvarom:

```powershell
Dokladovka.Agent.exe pohoda restart --endpoint mserver-1
```

Logy sú štruktúrované JSONL, rotujú po 10 MB a neobsahujú tokeny, heslá ani XML/PDF obsah.

mServer drží samostatne spustený proces POHODA a spotrebúva jednu licenciu. Používateľ musí mať právo `Dátová komunikácia`. Prevádzkové okno treba zosúladiť so zálohovaním a údržbou databázy; STORMWARE odporúča plánovaný štart/stop namiesto nekontrolovanej 24/7 prevádzky.

## Aktualizácie

Backend publikuje release URL a SHA-256. Agent balík stiahne iba cez HTTPS a overí hash. Automatické spustenie inštalátora je povolené až po nastavení `allowedPublisherThumbprint` a úspešnom overení Authenticode podpisu; bez thumbprintu sa balík iba bezpečne pripraví v `%ProgramData%\Dokladovka\updates`.

## PDF prílohy

Automatické pripojenie PDF k importovanému dokladu nie je zapnuté. Oficiálna XSD `attachmentsType/files/file` označuje súborový element ako export-only a POHODA dokumentové priečinky vyžadujú lokálnu konfiguráciu a práva. Agent preto neposiela neoverené cesty ani PDF obsah; zapnutie vyžaduje samostatne overený podporovaný importný mechanizmus.
