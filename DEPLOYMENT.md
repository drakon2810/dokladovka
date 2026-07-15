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

Pred prvým nasadením treba doplniť doménu, hosting a prístupy. Bez nich nie
je možné z lokálneho repozitára overiť verejné HTTPS ani auto-deploy.
