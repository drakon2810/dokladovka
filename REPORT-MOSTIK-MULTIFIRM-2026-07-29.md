# Сессия 2026-07-29: Mostík multi-firm агент (Doklado-parity) — резюме для AI

Этот файл — конспект диалога и выполненной работы, чтобы следующий AI/разработчик
понял контекст без чтения переписки.

## Запрос пользователя

Изначальный вопрос «какие улучшения добавить на сайт» был прерван и заменён
конкретной задачей: **изучить, как работает Mostík у конкурента Doklado
(docs.doklado.sk), и сделать так же** — скачиваемый агент (exe) на компьютер с
POHODA, который соединяет POHODA и наш облачный сервис **без mServer**; при
добавлении фирмы в вебе достаточно нажать «Обновить» в агенте — фирма появляется
и паруется; в вебе можно переключаться между фирмами и импортировать их доклады
в POHODA. Подписать exe self-signed. Затем: коммит, пуш, деплой на сервер.

## Что выяснено из документации Doklado (7 страниц docs.doklado.sk)

- Агент «Doklado Agent» + Windows-служба «DokladoService» ставятся на машину с
  POHODA; подключение к данным напрямую (SQL Server: IP/port/sysadmin, или MS
  Access: путь к папке MDB) + учётка POHODA c admin-правами; POHODA.exe должен
  быть локальным (XML-импорт через pohoda.exe, не mServer).
- **Один Mostík обслуживает все фирмы канцелярии** («aby sa dal jeden Mostík…
  potrebné používať rovnakú Pohodu»); паруется с базами автоматически по IČO,
  приоритет года: новейший / старейший незакрытый; авто re-pair ~30 мин; ручной
  re-pair в настройках агента.
- История экспортов: statusy Vytvorené → Prenesené / Zlyhalo / Čiastočne
  prenesené, ошибка по hover; documented POHODA-ошибки (duplicita, číselný rad,
  UsIDS, licencia…).
- Автообновление агента при запуске под админом.

## Состояние нашего репо ДО изменений

- `agent/` — .NET 8 агент (Worker service `DokladovkaService`) + WinForms
  конфигуратор-мастер. Уже умел режим **`cli`** = прямой XML-импорт
  `pohoda.exe /XML user pass job.ini` без mServer (Windows-1250, межпроцессный
  lock, XSD-валидация) и режим `mserver`.
- Бэкенд (`server/routes/agentRoutes.ts`) уже был multi-firm: `/api/agent/organizations`
  отдаёт все организации тенанта; **heartbeat авто-парует организации с базами
  POHODA по IČO** (`pohoda_company_links`, `match_rule='auto_ico'`, preferred_year);
  очередь экспорта per-организация (`FOR UPDATE SKIP LOCKED`), результаты
  идемпотентны. Строка линка создаётся при создании организации
  (`organizationRoutes.ts` INSERT в `pohoda_company_links`).
- **Разрыв**: агент знал только ОДНУ вручную сконфигурированную фирму
  (один endpoint c `CompanyIco`+`Database` в `agent.json`) → новые фирмы из веба
  давали `organization_unmatched`, экспорт блокировался
  («Organizácia nie je spárovaná s POHODOU»). Пейринг-код был жёстко привязан к
  одной организации + проверка IČO.

## Сделанные изменения

### C#-агент (`agent/`)

- **`src/Dokladovka.Agent/PohodaDataDiscovery.cs` (новый)**:
  `Scan(dataDirectory)` — находит `StwPh_{8-значное IČO}_{4-значный rok}.mdb`
  (regex, системные StwPh.mdb/StwPhProfile игнорируются), сортировка IČO ↑, год ↓;
  `FindDataDirectory(exePath)` — кандидаты `<exeDir>\Data`,
  `%ProgramData%\STORMWARE\POHODA[ SK]\Data`; сюда же переехал
  `PohodaDiscovery.FindExecutable()` (раньше был в Configurator).
- **`AgentSettings.cs`**: новая секция `PohodaAuto { PohodaExePath, DataDirectory }`
  (`agent.json` → `pohodaAuto`), `MServers` может быть пустым при её наличии.
  Константы: secret id `pohoda-auto`, префикс endpoint-ов `auto:`.
- **`AgentRuntime.cs`**: `RefreshAutoEndpoints()` — каждый цикл каждая найденная
  база становится динамическим cli-endpoint (`auto:StwPh_...mdb`) с общим
  DPAPI-секретом; удаление исчезнувших; статические endpoint-ы имеют приоритет.
  `ReadCompaniesAsync` идёт по всем endpoint-ам → heartbeat репортит ВСЕ фирмы →
  бэкенд их сам парует. `MatchEndpoint` стал `public static` (переиспользуется в
  StatusForm). Новый `EndpointCount`.
- **`AgentConfiguration.cs`**: два маршрута — `ConfigureAutoAsync` (cli +
  DataDirectory: discovery, probe первой/выбранной фирмы через codelist-запрос,
  пейринг БЕЗ IČO (опционально), heartbeat всех фирм) и прежний
  `ConfigureSingleAsync`. `CompanyIco` теперь `string?`. Результат несёт
  `Discovered` (список найденных фирм).
- **`BackendClient.cs`**: `PairAsync` принимает `string? companyIco`
  (null не сериализуется — WhenWritingNull).
- **`Program.cs`**: `configure` — `--data-dir`, cli по умолчанию, IČO не
  спрашивается в авто-режиме; `--database` = легаси-режим одной фирмы;
  диагностика считает `runner.EndpointCount`; обновлён `--help`.
- **Configurator**: **`StatusForm.cs` (новый)** — главное окно «Prepojené firmy»:
  таблица (Firma, IČO, Databáza, Rok, Stav) = организации бэкенда × найденные
  базы; кнопка **Obnoviť** (re-scan + heartbeat + reload — новая фирма паруется
  сразу), Nastavenie… (мастер), Diagnostika. `Program.cs`: настроенный агент →
  StatusForm, иначе/`--configure` → мастер. `WizardForm.cs`: поле «Dátový
  priečinok POHODA» + Prehľadávať + автопоиск, IČO опционально в cli,
  на шаге «Výber firmy» список найденных фирм, результат теста показывает их число.

### Бэкенд/веб

- `server/routes/agentRoutes.ts`: `POST /api/mostik/pairing-codes` —
  `organizationId` опционален (код «на всю канцелярию», organization_id NULL);
  `POST /api/agent/pair` — `companyIco` опционален, проверка несовпадения только
  когда есть и организация, и IČO.
- `src/features/settings/MostikOnboarding.tsx`: чекбокс
  «Jeden Mostík pre všetky firmy (odporúčané)» (default ON) — код без организации.
- `src/data/mostik/mostikService.ts`, `src/data/types.ts`: organizationId
  опционален; mock «все фирмы» парует все линки.
- `src/i18n/sk.ts`: ключи `mostik.vsetkyFirmy(, Popis)`.
- `docker-compose.yml`: api-сервису добавлен том
  `./agent/artifacts:/app/agent/artifacts:ro` — инсталлятор (gitignored)
  копируется на сервер по scp и раздаётся API на `/downloads/*` (Caddy проксирует).

### Скрипты сборки (важные фиксы)

- **`agent/scripts/publish.ps1` — критичный баг**: Configurator ссылается на
  exe-проект агента, его publish содержит нерабочий ~9.6MB apphost
  `Dokladovka.Agent.exe` + runtimeconfig, который затирал правильный ~70MB
  single-file exe (копировался вторым). Теперь Configurator копируется ПЕРВЫМ,
  агент поверх, лишний runtimeconfig удаляется. Возможно, из-за этого 0.1.0
  «не до конца работал».
- `create-temporary-self-signed-release.ps1` / `build-installer.ps1`:
  неинтерактивная сессия не может импортировать серт в `CurrentUser\Root`
  (Windows требует UI-диалог) → импорт try/catch с warning, проверка подписи
  принимает `UnknownError` при совпадении thumbprint (подпись криптографически
  валидна, нет только локального доверия).

## Тесты / проверки

- `dotnet test agent` — 18/18 (новые: discovery-парсинг, PohodaAuto-валидация,
  MatchEndpoint db→preferredYear→latest).
- `server/agent.test.ts` — новый тест tenant-wide пейринга (без organizationId и
  без companyIco, heartbeat парует по IČO); таймаут 90s как у соседей (PGlite медленный).
- `npm run typecheck` — чисто. Полный vitest: 379/380; падал только
  `documentUpload.test.ts` по таймауту под нагрузкой полного прогона — в
  изоляции 6/6 (флейк, не связан с изменениями).

## Сборка и подпись

- Inno Setup 6 установлен через winget (с согласия пользователя):
  `%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe`.
- Команда: `.\agent\scripts\create-temporary-self-signed-release.ps1 -Version 0.2.0
  -CloudBaseUrl 'https://dokladovka.site' -Iscc "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"`.
- **Сертификат новый**: старый ключ 0.1.0 (B0516ED2…) на машине не сохранился;
  новый thumbprint `74811A932DED375795713131CB52534F2C4D166F` (до 2027-07-29).
  Старые установки с pinned старым thumbprint не автообновятся — 0.2.0 ставится
  вручную поверх (конфигурация сохраняется), затем мастер заново (новый код).
- Артефакты: `agent/artifacts/Dokladovka-Agent-Setup-0.2.0-SELF-SIGNED-TEMP.exe`
  (+ .sha256, .cer, release-manifest.json) и копия в `public/downloads/`
  (всё gitignored). Подпись с DigiCert timestamp; статус `UnknownError` на
  build-машине = нет локального доверия к self-signed root, это ожидаемо.
- ВАЖНО: первая сборка шла с `-CloudBaseUrl https://app.dokladorpro.sk`
  (как в 0.1.0) — это НЕ прод-домен; финальная сборка с `https://dokladovka.site`.

## Деплой (см. deploy/update.md)

- Прод: `root@162.254.38.225`, репо `/root/dokladovka`, сайт https://dokladovka.site.
- Процесс: локально `git push` → `ssh … "cd /root/dokladovka && git pull &&
  docker compose up -d --build"`; артефакты агента отдельно
  `scp agent/artifacts/... root@…:/root/dokladovka/agent/artifacts/`.
- `/downloads/*` → Caddy → api (Fastify) → `agent/artifacts` (том, см. compose).
  Фронтенд-фолбэк `loadLocalTemporaryRelease()` читает `/downloads/release-manifest.json`,
  поэтому кнопка скачивания работает без записи релиза в БД
  (`AGENT_ALLOW_SELF_SIGNED_RELEASES` в проде выключен — fail-closed).

## Открытые вопросы / следующие шаги

- POHODA SQL/E1: discovery пока только по файлам MDB; для SQL-варианта — ручные
  endpoint-ы или доработка (перечисление баз `StwPh_%` через SQL). Помечено как
  сознательное упрощение.
- Реальную проверку с живой POHODA (пейринг, Obnoviť, экспорт) пользователь
  делает на машине с POHODA: установить 0.2.0, мастер → «Priamy XML import»,
  Vyhľadať POHODU, код «все фирмы» из Nastavenia → Mostík.
- Экран истории экспортов в вебе (parity с Doklado «História exportov») —
  частично есть в MostikTab/health; можно доработать отдельно.
- Прод-подпись: self-signed временная; план перехода на настоящий Authenticode —
  в MOSTIK-RELEASE-PROCESS.md.
