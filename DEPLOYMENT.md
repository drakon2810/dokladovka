# Nasadenie Dokladovky

Produkčný release používa tok `commit → push → zelené CI → automatické nasadenie`.
Ručné kopírovanie súborov na server nie je podporované.

## Lokálny backend

Ak je dostupný Docker, `docker compose up --build` spustí PostgreSQL, privátny
MinIO bucket, API a worker. Bez Dockeru príkaz `npm run db:migrate` vytvorí
lokálnu PGlite databázu (na Windows predvolene v
`%LOCALAPPDATA%\Dokladovka\pglite`, aby ju neblokovala synchronizácia OneDrive);
API sa potom spúšťa cez `npm run dev:api` a worker cez `npm run dev:worker`.
Umiestnenie možno zmeniť serverovou premennou `PGLITE_DATA_DIR`.

Prvého administrátora vytvára `npm run db:seed` iba vtedy, keď sú v
serverovom prostredí nastavené `SEED_ADMIN_EMAIL` a `SEED_ADMIN_PASSWORD`.
Heslo sa ukladá ako scrypt hash.

## Produkcia

- Cloudflare Pages nasadzuje Vite build z `main`, ak sú nastavené GitHub
  secrets `CLOUDFLARE_API_TOKEN` a `CLOUDFLARE_ACCOUNT_ID`.
- GitHub Actions publikuje API/worker image do GHCR. Dokploy alebo Coolify má
  sledovať tag `latest`, použiť produkčný PostgreSQL a S3-compatible private
  bucket a po novom image vykonať rolling deploy.
- API pri štarte automaticky aplikuje doposiaľ nevykonané SQL migrácie.
- TLS termináciu a verejné HTTPS zabezpečuje reverse proxy platformy.
- Všetky heslá, webhook secrets, DB URL a storage credentials patria iba do
  secret managera hostingu. Hodnoty z `.env.example` nie sú produkčné secrets.

## AI extrakcia faktúr

Worker podporuje `DOCUMENT_EXTRACTION_PROVIDER=mock|openai`. Pre produkčnú
extrakciu nastavte v secret manageri hostingu `DOCUMENT_EXTRACTION_PROVIDER=openai`
a `OPENAI_API_KEY`. Voliteľné nastavenia sú `OPENAI_MODEL` (predvolene
`gpt-5.6-terra`), `OPENAI_STORE_RESPONSES=false`, `OPENAI_TIMEOUT_MS`,
`OPENAI_MAX_RETRIES`, `EXTRACTION_MAX_FILE_BYTES` a `EXTRACTION_MAX_PDF_PAGES`.
Kľúč nikdy nepatrí do
`VITE_*`, frontend buildu, Git repozitára ani databázy.

Worker načíta PDF/JPEG/PNG z privátneho object storage, odošle ho cez OpenAI
Responses API so Structured Outputs a výsledok uloží ako samostatný nemenný
`extraction_run`. Pri opakovanej extrakcii sa existujúci doklad ani ručné
úpravy neprepíšu; používateľ musí nový úspešný výsledok výslovne použiť.
OpenAI výsledok sa pred zápisom a schválením kontroluje deterministicky
(IČO odberateľa, dátumy, DPH, súčty, duplicita a hranice organizácie).

Po zmene providera reštartujte worker. Overenie bez reálneho API kľúča:

1. nechajte `DOCUMENT_EXTRACTION_PROVIDER=mock`,
2. prijmite testovací webhook s PDF/JPEG/PNG,
3. spustite worker a skontrolujte nový doklad aj `extraction_runs`,
4. až potom nastavte OpenAI secret a provider na `openai`.

Voliteľný test proti skutočnému API sa spustí iba s
`RUN_OPENAI_EXTRACTION_INTEGRATION=true` a `OPENAI_API_KEY`; bežné `npm test`
ho preskočí a nič neúčtuje.

## IMAP poller (príjem pošty zo schránky)

Samostatný proces `server/imap.ts` (`npm run dev:imap`, v produkcii služba
`imap` v docker-compose) periodicky číta IMAP schránku, parsuje MIME a prílohy
odovzdáva do `POST /api/webhooks/inbound-email/imap` s `INBOUND_WEBHOOK_SECRET`.
Idempotenciu zaručuje `providerMessageId` (Message-ID); správa sa označí ako
prečítaná až po úspešnom prijatí webhookom. Konfigurácia: `IMAP_HOST`,
`IMAP_PORT` (993), `IMAP_USER`, `IMAP_PASSWORD` (pre Gmail app password),
`IMAP_POLL_INTERVAL` (sekundy, predvolene 30), `IMAP_MAILBOX` (INBOX).
Bez nastavených IMAP premenných proces skončí chybou — služba je voliteľná,
nasadzujte ju len s nakonfigurovanou schránkou.

Pred prvým nasadením treba doplniť doménu, hosting a prístupy. Bez nich nie
je možné z lokálneho repozitára overiť verejné HTTPS ani auto-deploy.

## Podpísaný Windows Agent

Produkčný agent sa vydáva iba tagom `agent-vX.Y.Z`. Windows workflow zostaví
self-contained agent a grafický konfigurátor, vytvorí Inno Setup, podpíše ho,
overí Authenticode a SHA-256, publikuje GitHub Release a odošle manifest do
`POST /api/internal/agent-releases`. Backend vyžaduje serverový
`AGENT_RELEASE_PUBLISH_TOKEN`; rovnaká hodnota je uložená v GitHub secret
`DOKLADOVKA_RELEASE_API_TOKEN`. Download URL musí byť verejné HTTPS. Súkromný
GitHub Release sa nesmie publikovať do produkčného UI bez autentizovanej
download proxy.

Úplný postup, secrets, rollback a blokovanie vydania sú v
`MOSTIK-RELEASE-PROCESS.md`.
