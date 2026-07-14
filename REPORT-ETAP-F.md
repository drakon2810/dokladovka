# Отчёт по этапу F — production hardening POHODA

Дата: 14 июля 2026.

## XSD и XML-маппинг

- Добавлена загрузка официального `all_schema_ver2.zip` STORMWARE на build-time. Зафиксированный при проверке SHA-256: `ab6a9f3c406a9e2257f544203d21df3723e8e10026e73a0898aa6249446bfd9b`.
- Production-агент валидирует каждый code-list request и каждый outgoing dataPack до mServer. При ошибке XSD отправка блокируется и backend получает детерминированный per-document error.
- Закрыты все `TODO(pohoda-xsd)` в исполняемом коде:
  - SK IBAN разбирается в `accountNo` + `bankCode`;
  - 5 % использует `price3`/`price3VAT`;
  - OZ использует подтверждённый XSD тип `commitment`;
  - PD использует `voucher.xsd`; бухгалтер обязательно выбирает код кассы и `receipt`/`expense` перед утверждением.
- Тесты официальной XSD покрывают code-list request и representative dataPack с OZ/IBAN/5 %/PD voucher.

## PDF-приложения

Автоматическое прикрепление PDF не включено. Проверка официальной `type.xsd` показала, что `attachments/files/file` помечен как export-only; документация POHODA требует заранее настроенную локальную папку документов и filesystem permissions. Поэтому код не отправляет выдуманный XML, локальные пути или неподдерживаемый binary upload. Решение и условие дальнейшего включения зафиксированы в `agent/README.md`.

## Мониторинг и оповещения

- Агент отправляет duration/state/item count каждой синхронизации.
- `/api/mostik/health` показывает lastSeen/online, последние sync outcomes/duration, total/failed exports за 24 часа и admin alerts за 7 дней.
- Отдельный monitor process создаёт дедуплицированные tenant-scoped alerts при offline > `AGENT_OFFLINE_ALERT_HOURS` и при failure rate > `EXPORT_FAILURE_ALERT_PERCENT` (минимум 5 jobs).
- Alert payload содержит список tenant-admin recipients и хранится в durable outbox; admin UI получает только безопасные metadata без payload/адресов.
- Добавлен `monitor` service в Docker Compose и Slovak health panel в Mostík.

## Установка и эксплуатация

- Создан `POHODA-PILOT-CHECKLIST.md`: сеть, лицензия, права Dátová komunikácia, pairing, smoke test FP/FV/OZ/PD, idempotency, outage/restart, alerts и rollback.
- `agent/README.md` описывает сборку, конфигурацию, диагностику, обновления, ротацию логов, лицензию mServer и конфликт с backup/maintenance windows.
- Добавлен Windows CI для test → self-contained publish → Inno Setup → artifact.

## Проверки

- Официальный XSD downloader: успешно, 75 XSD.
- .NET tests: 7/7 passed.
- Frontend/backend tests: 183/183 passed.
- TypeScript typecheck и production build: успешно.
- Поиск `TODO(pohoda-xsd)` в `server`, `src`, `agent`: 0 результатов.

## Оставшиеся внешние действия

- Реальный пилот E8 на POHODA фирмы 35761571.
- Компиляция и Authenticode-подпись setup в Windows CI/на release-машине с Inno Setup и SignTool.
- Если требуется именно e-mail/SMS, а не in-app/durable alert, notification outbox следует подключить к выбранному заказчиком outbound provider; credentials такого provider в задании отсутствуют.
