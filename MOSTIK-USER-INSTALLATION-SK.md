# Inštalácia Dokladovka Mostík

Tento postup je určený pre účtovníka, ktorý pripája POHODU prvýkrát. Netreba
inštalovať .NET, spúšťať PowerShell ani upravovať konfiguračné súbory.

## Pred inštaláciou

Pripravte počítač alebo Windows Server, na ktorom je nainštalovaná POHODA.
Potrebujete administrátorské práva vo Windows, platnú licenciu POHODA/mServer,
používateľa s právom **Dátová komunikácia** a prístup na internet cez HTTPS.

## Pripojenie

1. V Dokladovke otvorte `Nastavenia → Mostík` a povoľte Mostík.
2. V sprievodcovi potvrďte požiadavky. Ponechajte predvolené
   **Jeden Mostík pre všetky firmy** – agent nájde databázy všetkých firiem
   automaticky. (Prípadne zrušte voľbu a vyberte jednu organizáciu.)
3. Vygenerujte párovací kód. Je jednorazový a platí 15 minút.
4. Kliknite na **Stiahnuť Dokladovka Agent pre Windows**. Tlačidlo je dostupné
   iba pre úplné podpísané vydanie.
5. Otvorte jeden stiahnutý súbor `Dokladovka-Agent-Setup-{version}.exe` a
   povoľte inštaláciu ako správca.
   Pri dočasnom súbore `SELF-SIGNED-TEMP` môže Windows prvýkrát zobraziť
   SmartScreen. Skontrolujte názov vydavateľa a SHA-256 z webovej aplikácie,
   potom zvoľte **Ďalšie informácie → Napriek tomu spustiť**. Setup pridá iba
   dočasný certifikát Dokladovky; pri odinštalovaní ho odstráni.
6. V grafickom konfigurátore zadajte párovací kód a prihlásenie do POHODY.
   Pri predvolenom priamom importe kliknite na **Vyhľadať POHODU** – doplní sa
   cesta k `pohoda.exe` aj dátový priečinok so všetkými firmami (IČO netreba).
   Produkčná URL Dokladovky je predvyplnená.
7. Kliknite na **Skontrolovať a pripojiť**. Pri úspechu sa overí POHODA,
   prihlásenie, nájdené firmy, cloud, pairing, XSD a odošle sa prvý heartbeat.
8. Dokončite setup. Windows služba `DokladovkaService` sa spustí automaticky.
9. Vo webovej aplikácii sa do niekoľkých sekúnd zobrazí
   **Mostík bol úspešne pripojený**.

## Viac firiem a nové firmy

Agent hlási všetky databázy `StwPh_{IČO}_{rok}.mdb` z dátového priečinka a
Dokladovka ich spáruje s organizáciami podľa IČO (predvolene najnovší rok).
Keď pridáte novú firmu v Dokladovke alebo založíte novú firmu/rok v POHODE,
otvorte **Dokladovka Agent** v ponuke Štart a kliknite na **Obnoviť** – firma
sa objaví v zozname a spáruje sa. Bez kliknutia sa tak stane automaticky do
jednej minúty (pravidelný cyklus agenta). Prepínanie medzi firmami prebieha
v Dokladovke; agent exportuje doklady vždy do databázy príslušnej firmy.

## Bezpečnosť

Setup neobsahuje heslo, agent token ani osobné údaje. Párovací kód sa nevkladá
do download URL. Heslo mServera a agent token sa ukladajú iba na danom počítači
cez Windows DPAPI `LocalMachine`. POHODA ani mServer nie sú súčasťou setupu.

## Riešenie problémov

- Expirovaný alebo použitý kód: vo webovej aplikácii vygenerujte nový.
- Nezhoda IČO: vyberte správnu organizáciu alebo otvorte správnu firmu v
  POHODE. Backend neumožní automatické prepojenie odlišných IČO.
- mServer nie je dostupný: spustite správnu inštanciu a skontrolujte endpoint.
- Nesprávne meno/heslo: skontrolujte aj právo **Dátová komunikácia**.
- Firewall/backend: povoľte odchádzajúce HTTPS a lokálne spojenie na mServer.
- Podpora: v ponuke Štart otvorte **Dokladovka Agent – Diagnostika** a použite
  technický kód. Diagnostika neobsahuje heslá, tokeny, XML ani PDF.

Odinštalovanie vykonajte cez **Nainštalované aplikácie** vo Windows. Prevádzkové
auditné dáta v `%ProgramData%\Dokladovka` sa zámerne automaticky nemažú.
