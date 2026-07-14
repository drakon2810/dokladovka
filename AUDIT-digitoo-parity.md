# Dokladovka × Digitoo — funkčný audit a parity plán

Dátum auditu: 2026-07-12

## Bezpečnostný rozsah auditu

- Externá aplikácia bola prezretá iba read-only. Neboli vytvorené, zmenené,
  odoslané ani odstránené žiadne externé dáta.
- Prihlasovacie údaje, integračné tokeny ani hodnoty dokumentov sa neukladajú
  do repozitára, `.env`, test fixtures ani reportu.
- Dokladovka nebude kopírovať značku, logo, proprietárne assety ani pixelovo
  identický vizuál. Preberá sa informačná architektúra a overené workflow.

## Produktová hierarchia

Digitoo používa štyri úrovne:

1. organizácia — predplatné, používatelia, globálne nastavenia;
2. workspace / účtovná jednotka — konkrétna firma;
3. queue — typ a workflow dokumentu s vlastnou importnou adresou;
4. document — súbor, vyťažené údaje, validácia, schválenie, export a platba.

Aktuálna Dokladovka má `tenant → organization → document`. `Organization`
zodpovedá Digitoo workspace/firme. Samostatná entita queue zatiaľ chýba.

> Poznámka k implementácii: táto veta zachytáva stav na začiatku auditu.
> Po audite bola doplnená vrstva `organization → queue → document`; aktuálny
> stav je uvedený nižšie.

## Zistené moduly

### Prihlásenie a používateľský účet

- e-mail + heslo, zabudnuté heslo;
- Google a Microsoft login;
- voliteľné TOTP 2FA;
- meno, jazyk, komentárové a in-app notifikácie;
- pripojené identity;
- pozvánky a prístup po workspaces/queues;
- role Owner, Super Admin, Admin, Editor, Limited Editor, Uploader, Reader;
- samostatný príznak approver.

### Firmy, workspaces a queues

- údaje organizácie, región a fakturačný e-mail;
- viac firiem v jednej organizácii;
- ľubovoľný počet queues pre prijaté/vydané faktúry, pokladňu, zmluvy,
  objednávky a nevytěžovacie archívy;
- vlastná importná e-mailová adresa každej queue;
- nastaviteľná schéma: viditeľnosť, povinnosť, formát a default každého poľa;
- záložky To Approve, To Validation, Sent, To Pay, Spam, Skipped, Deleted, All;
- ARES/VIES, kontrola bankového účtu, rizikového platiteľa a ISDOC;
- spam detection, required approval note a automatické priloženie príloh;
- warnings s globálnym alebo per-field confidence thresholdom;
- notifikácia zlyhaného email importu.

### Dokumenty

- button upload, drag-and-drop, email, spoločný AI inbox, mobilná kamera a API;
- PDF, JPEG, PNG, TIFF a PDF/ISDOC;
- používateľsky nastaviteľné stĺpce, poradie, šírka a počet riadkov;
- full-text search, zložené filtre a globálne hľadanie naprieč firmami;
- hromadný export, delete, skip, reject, approve, send, payment a move;
- detail s originálom, hlavičkou, partnermi, bankou, DPH, položkami,
  účtovaním, confidence/evidence, emailom, prílohami, komentármi a auditom;
- split/rotate/crop dokumentu a šablóny položiek podľa dodávateľa.

### Automatizácia a schvaľovanie

- podmienky podľa AI confidence a dokumentových polí;
- automatický presun do validation alebo odoslanie do ERP;
- jednoduché aj viacúrovňové schvaľovanie;
- sekvenčné/paralelné skupiny a one/majority/all pravidlá;
- podmienky podľa sumy, dodávateľa, typu, strediska, zákazky a autora;
- delegation, Out of Office, ad-hoc approver a audit trail.

### Platby

- samostatná záložka To Pay a payment status;
- QR pre jeden doklad aj hromadný carousel QR kódov;
- dátum vykonania a manuálne označenie uhradenia;
- čiastočná úhrada;
- ABO/SEPA payment order po účte a mene;
- QR vyžaduje deterministicky validný účet a sumu;
- aplikácia nepredstiera bankové potvrdenie vykonania platby.

### Integrácie, export a reporting

- Pohoda a ďalšie ERP konektory, importné tokeny a agent versioning;
- export PDF/PNG/ISDOC/XML/XLSX/CSV/ZIP a audit CSV;
- štatistiky počtu, času, presnosti, používateľov, stavov, AI/ISDOC;
- kredity a billing per organizácia.

## Gap matica

| Oblasť | Aktuálne | Cieľ |
|---|---|---|
| Auth | voľný client role switch | session contract, login, route guards, backend BFF |
| Identity | seed users bez identity | user, membership, queue scope, approver flag |
| Firma | základné IČO/DIČ/alias | adresa, kontakty, bankové účty, defaults |
| Queue | neexistuje | queue model, schema, import alias, tabs/features |
| Upload | PDF/JPG/PNG + IndexedDB mock | TIFF/ISDOC, backend object storage, split/rotate |
| Queue list | pevné filtre/stĺpce | saved views, configurable columns, composite filters |
| Detail | invoice form/PDF/history | email/attachments, audit diff, payment, comments threads |
| Approval | jedna rola/stav | rules, groups, delegation, OOO |
| Automation | suggestion + mock extraction | condition/action rules, confidence policies |
| Payment | chýba | payment instruction/status, PAY by square, bulk flow |
| ERP | POHODA XML download | versioned connectors, delivery/retry/audit |
| Statistics | jednoduchý dashboard | configurable widgets, accuracy and CSV |

## Stav implementácie po audite

### Dokončené a overené v prototype

- login/logout a route guards cez `SessionGateway`; demo režim je viditeľne
  označený a production konfigurácia používa BFF kontrakt s cookie/CSRF;
- profil používateľa s menom, jazykom, notifikačnými preferenciami a pravdivým
  stavom 2FA/Google/Microsoft; demo nič nepredstiera ako prepojené;
- explicitná fail-closed capability matica pre existujúce roly a service-level
  guards aj pri priamom volaní API; neznáma rola nezíska implicitné práva;
- manuálne vytvorenie firmy, troch predvolených front a troch unikátnych
  importných aliasov pre všetky podporované typy dokladov;
- tri seed fronty na firmu a migrácia starších uložených demo dát;
- vytvorenie, úprava funkcií, confidence prahu a automatizácie fronty;
- presné routovanie inbound e-mailu na frontu cez `alias.queueId`;
- povinný výber kompatibilnej fronty pri manuálnom vytvorení alebo nahratí
  dokladu, upload cez file input aj drag-and-drop;
- filtrovanie, sidebar navigácia a previous/next navigácia podľa fronty;
- bankové účty firmy, payment status, PAY by square QR vytvorený lokálne,
  hromadný QR carousel a audit hash verzie dokladu;
- PDF/image detail má loading/error/empty stavy a bol manuálne overený bez
  pôvodného bieleho screenu.

### Stále iba mock alebo konfiguračný kontrakt

- samotné dokumenty, firmy, fronty, používatelia a audit sú stále uložené v
  Zustand/localStorage; uploadované súbory v IndexedDB;
- produkčný login endpoint, password reset, OIDC a 2FA vyžadujú backend BFF;
- oprávnenia sú v prototype stále tenant-wide; presné membership/grants na
  organizáciu a frontu musia byť autoritatívne v serverovej session a databáze;
- queue automation a väčšina feature flags sa zatiaľ konfiguruje, ale nie je
  durable worker workflow;
- potvrdenie úhrady je ručné a nepredstavuje potvrdenie banky;
- OpenAI, skutočný inbound provider, object storage a ERP delivery zostávajú
  serverovou úlohou ďalšej fázy.

## Implementačné fázy

### P0 — bezpečnostná hranica

- `SessionGateway`, `AuthProvider`, login/logout a route guards;
- dev adapter musí byť explicitne označený ako mock;
- produkcia: BFF, HttpOnly Secure cookie, CSRF, rate limit, password reset,
  Argon2id/scrypt na serveri a voliteľné OIDC/2FA;
- server odvádza trusted `userId`, `tenantId`, rolu a org/queue scopes;
- starý localStorage musí byť partitioned/cleared pri zmene identity.

### P1 — produktový shell

- organization/workspace/queue navigácia;
- queues, tabs, import alias a queue settings;
- user preferences, memberships a rozšírené role;
- zachovať existujúcu slovenskú Dokladovka identitu.

### P2 — platby

- organization bank accounts;
- `PaymentInstruction` a striktná validácia;
- PAY by square encoder + lokálny QR renderer;
- detail modal, download/print, payment status a bulk carousel;
- payload/version hash v audite, nikdy nie bankové tvrdenie o úhrade.

### P3 — konfigurovateľné workflow

- queue field schema, warnings a required/default fields;
- automation conditions/actions;
- approval rules/groups/delegation;
- threaded comments a audit diff.

### P4 — serverové integrácie

- DB, object storage, inbound worker, OpenAI adapter;
- ERP connectors a durable delivery/retry;
- reporting, billing/credits a observability.

## Povinné bezpečnostné pravidlá

- Žiadne externé heslo ani token nesmie byť vo frontend bundle alebo storage.
- QR sa generuje iba z deterministicky validovanej platobnej inštrukcie.
- Finančné dáta sa neposielajú verejnému QR web API z browsera.
- AI ostáva návrh; approval a export vyžadujú deterministickú kontrolu človekom.
- Tenant, firma a queue scope sa musia kontrolovať na každej serverovej operácii.
