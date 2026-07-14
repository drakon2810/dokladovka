# Отчёт по этапу E — Windows-агент Dokladovka

Дата: 14 июля 2026.

## Результат

Подэтапы E1–E7 реализованы. Создан .NET 8 Worker Service `DokladovkaService` и CLI-конфигуратор. Агент использует только исходящее HTTPS-соединение с backend и локальное соединение с POHODA mServer.

- E1: одноразовый pairing с backend; token и mServer credentials защищены Windows DPAPI `LocalMachine`.
- E2: `GET /status?companyDetail` и `POST /xml`; реализованы `STW-Authorization`, `STW-Application`, `STW-Instance`, `STW-Check-Duplicity`, Windows-1250 и gzip/deflate.
- E3: heartbeat и сопоставление по IČO с поддержкой `latest`/явного года и ручной привязки базы.
- E4: плановая синхронизация `predkontacie`, `cleneniaDph`, `ciselneRady`, `strediska`; деактивация исчезнувших POHODA items остаётся на backend.
- E5: получение export queue, fail-closed XSD-проверка, последовательная отправка в mServer, разбор per-document response и идемпотентная передача результата.
- E6: exponential backoff, разделение transient/permanent ошибок, rolling JSONL log 10 × 10 MB, локальное DPAPI-зашифрованное сохранение claimed jobs и восстановление после рестарта, CLI start/stop/restart mServer.
- E7: воспроизводимый self-contained publish, Inno Setup script, установка/recovery Windows-службы, безопасный upgrade stop/start, update manifest, HTTPS download, SHA-256 и обязательная проверка Authenticode publisher перед автоматическим запуском.

Основной код находится в `agent/src/Dokladovka.Agent`, тесты — в `agent/tests/Dokladovka.Agent.Tests`, build/install scripts — в `agent/scripts` и `agent/installer`.

## Backend и БД

- Расширен agent API: организация получает выбранную базу/год; heartbeat соблюдает `preferred_year`; добавлен приём sync metrics.
- Добавлена миграция `0002_agent_observability.sql` для истории синхронизаций и notification outbox.
- Claimed export job не выдаётся повторно backend без явного retry; агент сохраняет его локально до принятия результата backend.

## Выполненные проверки

- `.NET SDK 8.0.422` установлен локально в `%LOCALAPPDATA%\Dokladovka\dotnet`.
- `dotnet test agent/Dokladovka.Agent.sln --configuration Release --no-restore`: 7/7 passed.
- `agent/scripts/publish.ps1 -Runtime win-x64`: успешно; self-contained EXE 69 949 977 bytes, 75 XSD в publish.
- Запуск опубликованного `Dokladovka.Agent.exe --help`: успешно.
- `npm run typecheck`: успешно.
- `npm test -- --reporter=dot`: 21 files, 183 tests passed.
- `npm run build`: успешно; Vite сообщил только существующее предупреждение о размере chunk.

## Ручная проверка и ограничение E8

E8 нельзя честно завершить в этой среде: найдено 0 `pohoda.exe`, 0 запущенных процессов POHODA, отсутствуют mServer credentials. MDB-файл намеренно не используется агентом — production-интеграция разрешена только через официальный XML API.

Для E8 нужен Windows-host с POHODA/mServer и тестовой копией фирмы IČO 35761571. Пошаговый протокол находится в `POHODA-PILOT-CHECKLIST.md`.

Inno Setup и SignTool на текущем компьютере отсутствуют, поэтому `.iss` и signing workflow реализованы и включены в Windows CI, но локальный подписанный setup здесь не создан.
