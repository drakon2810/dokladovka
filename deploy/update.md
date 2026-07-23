# Шпаргалка: сервер, обновление, DNS

Оперативная памятка по продовому серверу. Полная инструкция первого запуска —
в [README.md](README.md).

## Сервер и доступ

- **VPS:** `root@162.254.38.225` (Namecheap, Ubuntu 24.04, Docker Compose)
- **Репозиторий на сервере:** `/root/dokladovka`
- **SSH-ключ:** `~/.ssh/id_ed25519` на рабочей машине (уже авторизован на сервере).
  Вход по ключу, без пароля.
- **Сайт:** https://dokladovka.site · вход `admin@dokladovka.site`

> На другом компьютере ключа нет — либо скопировать `~/.ssh/id_ed25519` туда,
> либо сгенерировать новый и добавить его `.pub` в `~/.ssh/authorized_keys` на сервере.

## Обновить сайт после изменения кода

```bash
# 1) локально
git push

# 2) обновить сервер одной командой (с рабочей машины)
ssh root@162.254.38.225 "cd /root/dokladovka && git pull && docker compose up -d --build"
```

Пересобирается образ, контейнеры пересоздаются (простой — секунды). Изменения
схемы БД применяются миграциями автоматически.

## Данные — что можно и нельзя

- Данные живут в томах Docker: **`postgres-data`** (БД) и **`objects-data`** (файлы
  документов). Обновление кода их не трогает.
- ⚠️ **Никогда** `docker compose down -v` — флаг `-v` удалит тома с данными.
  Обычная остановка: `docker compose down` (без `-v`).
- Бэкап БД: `docker compose exec postgres pg_dump -U dokladovka dokladovka > backup.sql`

## DNS (Namecheap → Advanced DNS)

Должна быть **одна** запись:

| Type | Host | Value | TTL |
|------|------|-------|-----|
| A Record | `@` | `162.254.38.225` | Automatic |

Удалить дефолтные парковочные записи (`URL Redirect @` и `CNAME www → parkingpage`).
После этого Caddy выпустит HTTPS автоматически.

## Диагностика

```bash
ssh root@162.254.38.225 "cd /root/dokladovka && docker compose ps"
ssh root@162.254.38.225 "cd /root/dokladovka && docker compose logs -f api"   # логи API
ssh root@162.254.38.225 "cd /root/dokladovka && docker compose logs -f web"   # Caddy / сертификат
```

## Ещё не подключено

- **Приём документов с почты (IMAP)** — сервис `imap` не запущен. Когда будет
  готова почта Namecheap Private Email (catch-all ящик): вписать `IMAP_USER` и
  `IMAP_PASSWORD` в `/root/dokladovka/.env` (там же `IMAP_HOST=mail.privateemail.com`),
  затем `docker compose up -d imap`.
