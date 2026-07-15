# Dokladovka Agent pre Windows

Agent je odchádzajúci most medzi cloud backendom a lokálnym POHODA mServer. Cloud nemá priamy prístup do siete zákazníka. Token agenta a mServer heslá sa ukladajú cez Windows DPAPI (`LocalMachine`) do `%ProgramData%\Dokladovka`.

## Vývoj a zostavenie

```powershell
.\agent\scripts\fetch-pohoda-xsd.ps1
dotnet test .\agent\Dokladovka.Agent.sln --configuration Release
.\agent\scripts\publish.ps1 -Runtime win-x64
.\agent\scripts\build-installer.ps1 -Iscc 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe'
```

`fetch-pohoda-xsd.ps1` sťahuje aktuálny oficiálny balík schém STORMWARE a uloží URL, čas a SHA-256 zdrojového ZIP. Publikovaný agent obsahuje schémy v `Schemas` a pred každým exportom vykoná fail-closed validáciu.

## Konfigurácia a diagnostika

Inštalátor pri prvej interaktívnej inštalácii ponúkne konfiguráciu. Ručné spustenie:

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
