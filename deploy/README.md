# Деплой на сервер (Docker)

Весь стек поднимается одной командой через `docker compose`: PostgreSQL, MinIO
(хранилище файлов), API, worker, IMAP-поллер, monitor и Caddy (раздаёт фронт +
reverse-proxy + авто-HTTPS).

Фронт обращается к API по относительному `/api`, поэтому фронт и бэкенд живут
за одним доменом — это делает Caddy.

---

## 0. Что нужно заранее

- VPS с Ubuntu (≥ 4 ГБ RAM), root/SSH-доступ.
- Домен `dokladovka.site` (Namecheap).
- Почтовый ящик **catch-all** (Namecheap Private Email) — для приёма документов.

## 1. DNS (в панели Namecheap)

- `A` запись: `dokladovka.site` → IP вашего VPS (и `www` при желании).
- `MX` запись → серверы Namecheap Private Email (Namecheap проставляет сам при
  подключении Private Email).
- В Private Email создайте ящик (напр. `zber@dokladovka.site`) и включите
  **Catch-all** на него.

Дождитесь, пока `A` запись распространится (проверка: `ping dokladovka.site`
должен вернуть IP сервера) — иначе Caddy не сможет выпустить HTTPS-сертификат.

## 2. Установка Docker на сервере

```bash
curl -fsSL https://get.docker.com | sh
```

## 3. Клонирование репозитория

```bash
git clone https://github.com/drakon2810/dokladovka.git
cd dokladovka
```

## 4. Конфигурация `.env`

```bash
cp deploy/.env.server.example .env
```

Откройте `.env` и заполните. Случайные секреты сгенерируйте так:

```bash
openssl rand -base64 24
```

Обязательно задать: `POSTGRES_PASSWORD`, `MINIO_ROOT_PASSWORD`,
`INBOUND_WEBHOOK_SECRET`, `OPENAI_API_KEY`, `IMAP_PASSWORD`,
`SEED_ADMIN_PASSWORD`. Остальное можно оставить по умолчанию.

`.env` в `.gitignore` — он никогда не коммитится.

## 5. Первый запуск

```bash
docker compose up -d --build
```

Соберётся образ (фронт + сервер), поднимутся все сервисы. Миграции БД
применяются автоматически при старте API. Caddy сам выпустит HTTPS-сертификат
для домена.

Проверка:

```bash
docker compose ps
curl -k https://dokladovka.site/api/health   # должно вернуть {"status":"ok",...}
```

## 6. Создание первого админа (один раз)

```bash
docker compose run --rm api node build/server/db/seed.js
```

Создаст админа с `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` из `.env`.
Теперь можно зайти на `https://dokladovka.site` и войти под ним.

---

## Обновление (новая версия кода)

```bash
git pull
docker compose up -d --build
```

Пересобираются только API/worker/imap/web. **PostgreSQL и MinIO не трогаются —
данные в томах сохраняются.** Изменения схемы применяются миграциями
автоматически и данные не удаляют.

## Бэкап базы (по желанию, перед крупным апдейтом)

```bash
docker compose exec postgres pg_dump -U dokladovka dokladovka > backup-$(date +%F).sql
```

## ⚠️ Что НЕ делать

- **Никогда** `docker compose down -v` — флаг `-v` удаляет тома с данными
  пользователей (БД и файлы). Обычная остановка: `docker compose down` (без `-v`).

## Полезное

```bash
docker compose logs -f api        # логи API
docker compose logs -f web        # логи Caddy (в т.ч. выпуск сертификата)
docker compose logs -f imap       # логи приёма почты
docker compose restart api        # перезапуск сервиса
```
