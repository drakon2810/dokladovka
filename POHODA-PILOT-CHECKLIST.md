# Checklist pilotu POHODA Mostík

## Pred inštaláciou

- Windows Server/PC je podporovaný a zálohovaný; POHODA a mServer majú platnú licenciu.
- Existuje samostatný mServer používateľ s minimálnymi právami Dátová komunikácia.
- mServer počúva iba v dôveryhodnej lokálnej sieti; firewall povoľuje spojenie iba z hosta agenta.
- Host má odchádzajúci HTTPS prístup na cloud Dokladovky. Nie je potrebný žiadny inbound port z internetu.
- V Mostíku je povolená integrácia, organizácia má správne IČO a je vygenerovaný jednorazový 15-minútový pairing code.
- Podpísaný inštalátor a jeho SHA-256 boli overené; publisher thumbprint je uložený v konfigurácii pre automatické aktualizácie.

## Inštalácia a smoke test

1. Nainštalovať agent ako administrátor a dokončiť `configure` bez zapisovania hesla do príkazového riadka.
2. Spustiť `Dokladovka.Agent.exe diagnose`; skontrolovať názov databázy, IČO a účtovný rok.
3. Overiť službu `DokladovkaService`, recovery actions a `%ProgramData%\Dokladovka\logs\agent.log`.
4. V UI potvrdiť heartbeat, automatické párovanie podľa IČO a zvolený účtovný rok.
5. Spustiť synchronizáciu štyroch číselníkov a porovnať počty/ukážkové kódy s POHODOU.
6. Na kópii účtovnej jednotky odoslať po jednom doklade FP, FV, OZ a PD. Pri PD musí účtovník nastaviť kód pokladne aj smer príjem/výdaj.
7. V POHODE skontrolovať typ agendy, dátumy, partnera, predkontáciu, členenie DPH, číselný rad, sadzby 23/19/5/0 a bankový účet.
8. Zopakovať rovnaký export a potvrdiť ochranu proti duplicite/idempotenciu.
9. Simulovať dočasnú nedostupnosť cloudu a mServera, reštart služby a následné spracovanie lokálne uloženého pending jobu.
10. Overiť health panel, offline alert a prah chýb exportu; odoslanie outboxu pripojiť na schválený firemný notifikačný kanál.

## Akceptácia a rollback

- Pilot sa považuje za prijatý až po porovnaní výsledku účtovníkom a archivácii testovacieho protokolu bez reálnych hesiel/XML obsahu.
- Pri probléme vypnúť Mostík v UI, zastaviť službu `sc.exe stop DokladovkaService` a v POHODE zablokovať mServer používateľa.
- Rozpracované joby nemenia stav na exportovaný bez potvrdenia POHODY. Neúspešný job sa opakuje iba explicitnou akciou používateľa.
- Odinštalovanie odstráni službu a binárky, ale zámerne ponechá `%ProgramData%\Dokladovka` pre audit/obnovu; zmazanie dát je samostatné schválené rozhodnutie.
