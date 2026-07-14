# SPEC — Dokladovka, модуль 4: prepojenie s POHODA («Mostík») — verzia 3 pre ChatGPT Codex

> Документ предназначен для **ChatGPT Codex** и заменяет версию 2, ориентированную на другой coding-agent. Проект — существующий репозиторий Dokladovka (React 18 + TypeScript + Vite + Tailwind; Фаза 1 — frontend-прототип с mock-данными). Обязательные источники требований: `AGENTS.md`, `SPEC-dokladovka_3_email_ai_Codex.md`, `AUDIT-digitoo-parity.md` и этот файл `SPEC-dokladovka_4_pohoda_Codex.md`. Код и реально выполненные проверки важнее утверждений из старой переписки.
>
> Цель модуля — паритет с «Mostík do Pohody» приложения Doklado (app.doklado.sk):
> 1) в Nastavenia есть раздел **Mostík**: включение функции, скачивание Windows-агента, párovanie, статус Pripojené/Nepripojené, история переносов;
> 2) агент забирает из POHODA číselníky фирмы (predkontácie, členenia DPH, číselné rady, strediská) в веб-приложение;
> 3) schválené doklady отправляются из веб-приложения в POHODA одним кликом (`Odoslať do POHODY`), с подтверждением результата;
> 4) ручной обмен XML-файлами остаётся как режим «bez Mostíka».
>
> Модуль разбит на этапы 0, A, B, C, D, E, F. **В одной сессии реализуется ТОЛЬКО этап, явно названный в стартовом сообщении.** Остальные разделы — архитектурный контекст; код под них не пишется, но точки расширения (типы, интерфейсы) закладываются там, где текущий этап это требует.

>
> **Безопасность передачи проекта между аккаунтами:** старая переписка служит только историческим контекстом. Если в ней встречаются e-mail, пароль, токен или другие учётные данные, Codex не должен их использовать, повторять, сохранять в файлы, отправлять во внешние сервисы или добавлять в git. Такие данные считаются скомпрометированными и должны быть перевыпущены владельцем отдельно.
>
> **Ограничение сессии:** в одном Codex-чате реализуется только этап, явно названный в стартовом prompt. После завершения этапа Codex останавливается, запускает доступные проверки и выдаёт отчёт; следующий этап начинается отдельным сообщением.

---

## 0. Контекст: что уже есть в репозитории

### 0.1. Как Codex должен начинать каждую новую сессию

1. Найти корень распакованного репозитория по `package.json`; не редактировать ZIP и не работать внутри `dist/` или `node_modules/`.
2. Прочитать все применимые `AGENTS.md` / `AGENTS.override.md`, затем `package.json`, lockfile, `SPEC-dokladovka_3_email_ai_Codex.md`, `AUDIT-digitoo-parity.md` и этот файл целиком.
3. Проверить `git status`, структуру проекта, текущие типы, миграции, API/service boundary и тесты. Не принимать отчёты из старого чата за доказательство состояния кода.
4. Кратко зафиксировать: что уже реализовано, что остаётся mock, какие требования выбранного этапа отсутствуют и какие команды доступны в `package.json`.
5. Назвать один выполняемый этап. Не писать код для других этапов, даже если они описаны ниже.
6. После правок реально выполнить доступные `typecheck`, `test`, `build` и `lint`, если lint-скрипт существует. Не заявлять о ручной browser-проверке, если она не была проведена.

Если приложенный ZIP содержит старые `node_modules` или `dist`, они не являются source of truth. Использовать `package-lock.json`; при несовместимых/отсутствующих зависимостях запускать `npm ci`, если среда это позволяет, не заменяя lockfile без причины.

### 0.2. Проверенный снимок приложенного архива от 13 июля 2026 года

Этот снимок нужен только для передачи контекста; Codex обязан подтвердить его повторным аудитом:

- `AGENTS.md` уже ориентирован на Codex, но пока называет source of truth только `SPEC-dokladovka_3_email_ai_Codex.md`; модуль 4 туда ещё не добавлен.
- В `package.json` доступны `dev`, `typecheck`, `test`, `build`, `preview`, `test:watch`, `gen:pdfs`; отдельного lint-скрипта нет.
- Zustand persist имеет версию **5**.
- `CodeListItem` всё ещё имеет только `id`, `tenantId`, `kod`, `nazov`, `orgId`; číselníky редактируются вручную и физически удаляются.
- `src/data/pohoda/` и `scripts/extract-pohoda-mdb.mjs` отсутствуют; этапы 0 и A ещё не реализованы.
- `src/data/xml/pohodaDataPack.ts` и тесты уже существуют. В текущем коде остаётся молчаливый fallback číselného radu `?? 'FP'`, который должен быть устранён на этапе A.
- Основной frontend-прототип, login/demo-session, очереди, ручная загрузка документов, QR и Digitoo-подобные workflow уже присутствуют, но Zustand/localStorage, IndexedDB, auth и интеграции всё ещё преимущественно mock/local.
- Исторический отчёт упоминает 151 проходящий тест, но это не считается подтверждением: Codex должен выполнить тесты заново в текущем окружении.

**Следующий этап для этого архива — ЭТАП 0.** Этап A запускается только после отдельного сообщения и успешного отчёта этапа 0.

### 0.3. Архитектурный контекст
- Модель данных: `src/data/types.ts` — `CodeListKind = 'predkontacie' | 'cleneniaDph' | 'ciselneRady' | 'strediska'`, `CodeListItem { id, tenantId, kod, nazov, orgId }`; `DocumentUcto` ссылается на записи číselníkov по id.
- Číselníky заполняются вручную: `src/features/settings/CodeListsTab.tsx` + CRUD в `src/data/api.ts`.
- Экспорт в POHODA уже есть: `src/data/xml/pohodaDataPack.ts` строит `dat:dataPack` 2.0, пишет kod predkontácie в `inv:accounting/typ:ids`, kod členenia в `inv:classificationVAT/typ:ids`, kod radu в `typ:numberRequested`; кодировка решена ASCII-энтитями, файл декларирует `Windows-1250`.
- Хранилище: Zustand + persist (localStorage), persist-версия 5; все мутации только через `src/data/api.ts`; компоненты mock-хранилище напрямую не трогают — при переходе на REST компоненты не переписываются.
- **Бэкенда нет** (Фаза 1). Всё в этапах 0 и A работает целиком в браузере/на dev-машине. Этапы C–F требуют backend Фазы 2 (этап B).
- POHODA заказчика: вариант MDB (файл `StwPh_35761571_2025.mdb`, IČO 35761571, rok 2025). mServer и XML-коммуникация доступны во всех вариантах POHODA.

Правила из `AGENTS.md` обязательны: не рескаффолдить, UI-тексты только по-словацки через `src/i18n/sk.ts`, никаких секретов во фронтенде/`VITE_*`/localStorage, tenant/organization границы везде, после изменений реально выполнить `npm run typecheck`, `npm run test`, `npm run build`.

---

## 1. Этапы модуля (карта)

| Этап | Что делает | Где живёт | Пререквизиты |
|---|---|---|---|
| **0** | Подготовка: правка AGENTS.md, извлечение реальных číselníkov из MDB → seed/fixtures | dev-машина + текущий репозиторий | — |
| **A** | Ручной обмен XML («bez Mostíka»): request-файлы, импорт response, модель číselníkov | текущий фронтенд-репозиторий | 0 (желательно) |
| **B** | Backend Фазы 2 (общий): REST + PostgreSQL + деплой + CI/CD | новый backend-репозиторий/пакет | — |
| **C** | Агентский контур backend: pairing, code-lists, export-queue, results, раздача инсталлятора | backend | B |
| **D** | Раздел **Mostík** в Nastavenia + кнопка `Odoslať do POHODY` | фронтенд (UI можно mock-first) | типы: A; данные: C |
| **E** | Windows-агент «Dokladovka Agent» (.NET, служба) + инсталлятор + автообновление | подпроект `agent/` | C |
| **F** | Продакшн-харднинг: XSD-валидация, PDF-prílohy в POHODA, мониторинг, чеклист установки | все части | A–E |

Итоговая архитектура: `POHODA (mServer, localhost клиента) ↔ Dokladovka Agent (Windows-служба, ТОЛЬКО исходящий HTTPS) ↔ Backend API (публичный хостинг) ↔ веб-приложение`. Из браузера напрямую к POHODA не обращаемся никогда (SPEC §11.24).

---

## 2. Технический справочник POHODA XML (общий для всех этапов)

### 2.1. Базовые факты

- Обмен = официальная XML-коммуникация POHODA: **import** через `dat:dataPack`, **export** через list-request'ы; ответ приходит как `rsp:responsePack` (state ok/warning/error per item).
- Namespaces version 2: `dat` = `http://www.stormware.cz/schema/version_2/data.xsd`, `typ` = `.../type.xsd`, `inv` = `.../invoice.xsd`, `lst` = `.../list.xsd`, `rsp` = `.../response.xsd`. У отдельных агенд свои схемы (см. 2.2).
- Кодировка: POHODA работает с `Windows-1250`. Наши исходящие файлы уже ASCII-safe (энтити). **Входящие response-файлы приходят в Windows-1250 — критично для парсера (§4.4).**
- Атрибут `ico` в `dat:dataPack` должен совпадать с IČO účtovnej jednotky; при несовпадении POHODA может молча не обработать данные.
- Каналы доставки XML: (а) вручную: `Súbor → Dátová komunikácia → XML import/export…` (этап A); (б) `pohoda.exe /XML` пакетно; (в) **POHODA mServer** — встроенный HTTP-сервер (этап E).
- POHODA ведёт `XML log` и контролирует дубликаты импортов; повторный импорт того же doklad'а требует удаления и записи, и лога.
- Прямое чтение базы POHODA (MDB/SQL) в продакшне ЗАПРЕЩЕНО — только XML. MDB используется единственно на этапе 0 для генерации seed/fixtures на dev-машине.

### 2.2. Какие číselníky экспортируются из POHODA по XML

Официально поддерживается экспорт списков (list-request), среди прочего: **predkontácie** (отдельно jednoduché/podvojné účtovníctvo), **členenie DPH** (classificationVAT), **číselné rady** (схема `numericalSeries.xsd`), **strediská** (centre), **činnosti** (activity), **účtová osnova**, **bankové účty**, **hotovostné pokladne**, zakázky, adresár, seznam účtovných jednotiek.

Точные имена элементов request/response ДОЛЖНЫ браться из официальной документации, а не придумываться. Источники для веб-поиска/браузера Codex (использовать только официальные страницы Stormware):
- Примеры request-файлов: `https://www.stormware.cz/pohoda/xml/dokladyexport/`
- Перечень XSD-схем: `https://www.stormware.cz/pohoda/xml/seznamschemat/`
- Общая документация: `https://www.stormware.cz/pohoda/xml/`
- mServer: `https://www.stormware.cz/pohoda/xml/mserver/` (+ `provyvojare`, `nastaveni`, `spusteni`)

**Правило:** прежде чем писать request-шаблоны или парсер, получи актуальные примеры со страниц выше. Если страница недоступна — сгенерируй шаблон по образцу §2.3, пометь каждый неподтверждённый элемент `<!-- TODO(pohoda-xsd): overiť podľa oficiálneho príkladu Stormware -->` и строй парсер вокруг реальных fixtures из `src/data/pohoda/__fixtures__/`. Реальные fixtures всегда важнее предположений.

### 2.3. Скелет request-файла

```xml
<?xml version="1.0" encoding="Windows-1250"?>
<dat:dataPack version="2.0" id="ExpCis001" ico="{ICO_ORGANIZACIE}"
    application="Dokladovka" note="Export ciselnikov"
    xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"
    xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd"
    xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd">
  <dat:dataPackItem id="c01" version="2.0">
    <!-- list-request конкретной агенды по официальному примеру Stormware -->
  </dat:dataPackItem>
</dat:dataPack>
```

Один request-файл на организацию содержит несколько `dataPackItem` (по одному на číselník) — пользователь прогоняет в POHODA один файл.

---

## 3. ЭТАП 0 — Подготовка

### 3.1. AGENTS.md
Обновить раздел source of truth: обязательны `SPEC-dokladovka_3_email_ai_Codex.md` + `SPEC-dokladovka_4_pohoda_Codex.md`; `AUDIT-digitoo-parity.md` использовать как проверенный продуктовый контекст. Исполнитель остаётся **ChatGPT Codex**. Не менять остальные правила без необходимости и не возвращать упоминания другого coding-agent.

### 3.2. Извлечение číselníkov из реальной MDB (dev-машина)
- Написать `scripts/extract-pohoda-mdb.mjs`: вход — путь к `.mdb` **ВНЕ репозитория** как CLI-аргумент; рекомендуемый вызов: `node scripts/extract-pohoda-mdb.mjs --input "<path-to-mdb>" --ico 35761571`. Использовать `mdbtools` (`mdb-tables`, `mdb-schema`, `mdb-export`; на Windows — WSL). Перед работой проверить доступность команд и выдать понятную ошибку с инструкцией установки, если их нет. Скрипт должен перечислить таблицы/колонки, найти кандидатов predkontácií, členení DPH, číselných radov и stredísk, а при неоднозначности не угадывать молча — вывести кандидатов и потребовать явного подтверждения/маппинга. Выгружать ТОЛЬКО поля вида kod/skratka + nazov (+agenda/rok, если есть) в детерминированно отсортированный `src/data/pohoda/__fixtures__/mdb-extract-{ico}.json`.
- **Приватность:** сам `.mdb`/`.accdb` в git НЕ добавлять (добавить маски в `.gitignore`); не копировать файл в корень проекта; никакие данные партнёров, фактур, miezd, адресов, банковских реквизитов или e-mail не выгружать. Перед коммитом проверить JSON глазами и автоматическим поиском неожиданных полей.
- Использование: (а) реалистичный dev-seed вместо выдуманных числников в `mock/seed.ts` (опционально, флагом); (б) перекрёстная проверка парсера этапа A — коды из XML-response должны совпасть с кодами из MDB.

### 3.3. Definition of Done этапа 0
AGENTS.md обновлён; скрипт работает и имеет usage/help; JSON только с číselníkmi фирмы 35761571 лежит в fixtures; `.mdb`/`.accdb` игнорируются git'ом; этап A не начат; доступные `typecheck`, `test` и `build` реально выполнены и их результат указан в отчёте.

---

## 4. ЭТАП A — «Výmena XML súborov bez agenta» (реализовать полностью)

Пользовательская история: účtovník в Nastavenia → Číselníky скачивает `pohoda-request-ciselniky-{orgKod}.xml`, прогоняет его в POHODA (Súbor → Dátová komunikácia → XML import/export), полученный response загружает обратно — и все predkontácie, členenia DPH, číselné rady, strediská фирмы появляются в приложении с реальными kódmi. Обратный путь (dataPack → ручной импорт в POHODA) уже реализован. Этот режим остаётся и после появления агента — как «bez Mostíka» у Doklado.

### 4.1. Расширение модели (`src/data/types.ts`)

```ts
export type CodeListSource = 'manual' | 'pohoda';

export interface CodeListItem {
  id: string;
  tenantId: string;
  orgId: string;
  kod: string;            // typ:ids / skratka presne ako v POHODA
  nazov: string;
  source: CodeListSource; // NEW
  active: boolean;        // NEW — vyradené sa deaktivujú, nemažú
  externalId?: string;    // NEW — interné ID z POHODA, ak je v response
  agenda?: string;        // NEW — pre predkontácie/rady (napr. FP/FV/PD)
  uctovnyRok?: string;    // NEW — pre číselné rady
  syncedAt?: string;      // NEW — ISO čas posledného importu
}
```

- Всё созданное руками: `source: 'manual'`, `active: true`.
- **Миграция persist v5 → v6 обязательна** (дозаполнить дефолты), с тестом.
- Валидация «kod существует в организации» (`checkApprovable`) учитывает только `active`; approved snapshot исторических документов неизменен; новый выбор в UI — только активные.

### 4.2. Новый модуль `src/data/pohoda/`

```
src/data/pohoda/
  requestTemplates.ts        // request-XML per organizácia
  parseCodeListResponse.ts   // responsePack → CodeListImportPreview
  importCodeLists.ts         // aplikácia preview cez api.ts (upsert/deactivate)
  encoding.ts                // ArrayBuffer → string s ohľadom na Windows-1250
  __fixtures__/              // reálne response z POHODA + mdb-extract JSON + syntetika
```

Мутации store — только через новые функции `api.ts` (напр. `importPohodaCodeLists(orgId, preview)`).

### 4.3. `requestTemplates.ts`
- `buildCodeListRequestXml(org): string` — один XML с четырьмя list-request'ами, `ico = org.ico`, id `ExpCis-{orgKod}-{YYYYMMDD}`; только ASCII (переиспользовать `escapeXml`); неподтверждённые элементы — `TODO(pohoda-xsd)`.
- `buildCodeListRequestFileName(org)` → `pohoda-request-ciselniky-{orgKod}.xml` (через `slugifyOrganizationName`).

### 4.4. `encoding.ts` + `parseCodeListResponse.ts`
Чтение файла (критично):
1. Читать как `ArrayBuffer`, НЕ как text (иначе Windows-1250 диакритика превратится в мусор).
2. Первые ~200 байт декодировать как latin1, вытащить `encoding="…"` из XML-декларации.
3. Декодировать буфер `new TextDecoder(detected || 'windows-1250')`; fallback: заявленная → windows-1250 → utf-8.

Парсинг: `DOMParser` (`text/xml`), проверка `parsererror`; матчить по `localName` (префиксы варьируются), сверять namespaceURI по вхождению `stormware.cz/schema/version_2`; извлекать kod, nazov, опц. internal id/agenda/rok; дубли kod внутри вида — warning, берётся первый. Выход — чистая структура без мутаций:

```ts
export interface CodeListImportPreview {
  orgId: string;
  perKind: Record<CodeListKind, {
    nove: ParsedItem[];
    aktualizovane: ParsedItem[];
    bezZmeny: number;
    vyradene: CodeListItem[]; // synced položky chýbajúce v response
  }>;
  warnings: string[];
}
```

Если не распознан ни один список — человекочитаемая ошибка (sk), не пустой preview.

### 4.5. `importCodeLists.ts` + API
В одном `storeApi.set`: upsert по `(tenantId, orgId, kind, kod)`; новые → `source:'pohoda', active:true, syncedAt:now`; обновляемые → перезапись nazov/атрибутов, ручная запись с тем же kod «усыновляется» синком; `vyradene` (только `source==='pohoda'`) → `active:false` (НЕ удалять); ручные записи синк не трогает. Повторный импорт того же файла = 0 изменений (идемпотентность).

### 4.6. UI (`CodeListsTab.tsx` + `sk.ts`)
1. `Stiahnuť request pre POHODU` (Blob, `application/xml`) + hint: `Súbor spustite v POHODE cez Súbor → Dátová komunikácia → XML import/export a výsledný súbor (response) nahrajte nižšie.`
2. `Import z POHODY (XML)` — file input `.xml` → модальный preview: per číselník `Nové / Aktualizované / Vyradené / Bez zmeny`, warnings, `Importovať` / `Zrušiť`.
3. Toast со сводкой после импорта.
4. Записи `source='pohoda'`: бейдж `z POHODY`, kod/nazov read-only (тултип `Položka je synchronizovaná z POHODY`), вместо удаления — `Deaktivovať`; неактивные — сворачиваемый блок `Vyradené`.
5. Селекторы в `DocumentDetailPage` предлагают только активные записи.

### 4.7. Экспорт dataPack
- Убрать молчаливый дефолт `?? 'FP'` для radu: если rad не выбран — предупреждение в UI экспорта (документ можно исключить или подтвердить выбор явно).
- `kodOf` учитывает только активные записи; approved snapshot не пересчитывается.

### 4.8. Тесты (vitest)
- `encoding.test.ts`: реальные Windows-1250 байты (`č ľ š ť ž`) декодируются; UTF-8 с декларацией — тоже.
- `parseCodeListResponse.test.ts`: синтетический fixture; КАЖДЫЙ реальный fixture; битый XML → понятная ошибка; незнакомые элементы игнорируются.
- `importCodeLists.test.ts`: upsert, усыновление, деактивация, неприкосновенность ручных, идемпотентность повторного импорта.
- Сверка с `mdb-extract-{ico}.json`: коды из XML-response ⊇/≈ коды из MDB (там, где виды совпадают) — как smoke-тест на реальных данных.
- Миграция v5 → v6; `pohodaDataPack.test.ts` — кейс «rad не выбран».

### 4.9. Definition of Done этапа A
1. `npm run typecheck` / `test` / `build` зелёные и реально выполнены.
2. Полный цикл кликабелен: скачать request → загрузить fixture-response → preview → импорт → бейджи `z POHODY` → выбор в документе → dataPack содержит реальные kódy.
3. Ни одного нового английского текста в UI; всё в `sk.ts`.
4. Отчёт: изменённые файлы, команды, ручные проверки, оставшиеся `TODO(pohoda-xsd)` и какие fixtures нужны.

---

## 5. ЭТАП B — Backend Фазы 2 + хостинг и обновления (пререквизит для C–F)

Реализуется по основной спеке (`SPEC-dokladovka_3…` §11–12): REST API + PostgreSQL, auth/sessions, object storage, inbound e-mail, extraction worker. Фронтенд переключается с mock `api.ts` на REST без переписывания компонентов (так спроектировано).

Требования этого модуля к этапу B (чтобы мостик стал возможен):
- Backend доступен по **публичному HTTPS** (агент делает исходящие запросы из сети клиента). Локальная разработка: агент может указывать на `http://localhost:{port}` — для e2e-тестов достаточно.
- **Деплой и обновления (обязательная часть B):**
  - Git-репозиторий на GitHub; CI (GitHub Actions): typecheck + tests + build на каждый push/PR.
  - Frontend: статическая сборка Vite; авто-деплой на пуш в `main` (Cloudflare Pages / Vercel / Netlify — выбрать один) ЛИБО раздача статики самим backend'ом.
  - Backend: Dockerfile + docker-compose; деплой на VPS через Coolify/Dokploy или на PaaS (Railway/Render) с авто-деплоем на пуш; миграции БД выполняются автоматически при релизе; секреты только в env хостинга.
  - Правило релиза: «commit → push → зелёный CI → авто-деплой»; вручную файлы на сервер не копируются.
- Health-endpoint `GET /api/health` (нужен и для агента, и для мониторинга).

---

## 6. ЭТАП C — Агентский контур backend (реализовать по команде)

### 6.1. Сущности
- `AgentInstallation { id, tenantId, name/hostname, tokenHash, createdAt, lastSeenAt, agentVersion, status }` — одна установка обслуживает несколько организаций tenant'а.
- `AgentPairingCode { code (одноразовый, TTL 15 мин), tenantId, createdBy }`.
- `PohodaCompanyLink { organizationId, ico, dbName?, uctovnyRok?, matchedAt, matchRule: 'auto_ico' | 'manual' }`.
- `ExportJob { id, tenantId, organizationId, documentIds, status: pending|sent|confirmed|failed, idempotencyKey, requestXmlHash, responseMeta, createdAt, createdBy }`.

### 6.2. Endpoints (агентский Bearer-токен, кроме pair)
```
POST /api/agent/pair        { pairingCode, hostname, agentVersion } → { agentToken }   // в БД только hash
GET  /api/agent/organizations → [{ organizationId, ico, nazov }]
PUT  /api/agent/organizations/{id}/code-lists  { kind, items:[{kod,nazov,externalId?,agenda?,uctovnyRok?}] } // bulk upsert source='pohoda'; vyradené считает сервер
GET  /api/agent/export-queue?organizationId=…  → [{ exportJobId, dataPackXml, idempotencyKey }]  // XML строит сервер из approvedSnapshot
POST /api/agent/export-results { exportJobId, perDocument:[{documentId, state: ok|warning|error, pohodaNumber?, message?}], rawResponseMeta }
POST /api/agent/heartbeat   { companies:[{ico, dbName, uctovnyRok}], agentVersion }
GET  /api/agent/latest      → { version, downloadUrl, sha256 }   // без auth; канал автообновления
```

### 6.3. Правила
- `exportovany` ТОЛЬКО после `export-results` state=ok (SPEC §11.24); `error` → статус `chyba` + сообщение POHODA в истории документа.
- Идемпотентность: повторный `export-results` тем же `exportJobId` — no-op; повторная выдача job'а — только после явного retry из UI.
- dataPack строится сервером из approved snapshot, per организация, `ico` из `PohodaCompanyLink`.
- Токены: только hash в БД, ротация через новый pairing, rate limit, audit каждого вызова.
- Toggle «Povoliť Mostík» (tenant-level, см. этап D): при выключении агентские endpoints отвечают 403/`paused`, данные не удаляются.

### 6.4. Раздача инсталлятора
Файл `dokladovka-agent-setup-{version}.exe` хранится в object storage/статике; `GET /api/agent/latest` отдаёт актуальную версию, ссылку и sha256. Ссылку использует и кнопка в UI (этап D), и автообновление агента (этап E).

---

## 7. ЭТАП D — Раздел «Mostík» в веб-приложении (Doklado-parity UI)

Может реализовываться **mock-first в текущем репозитории** (типы + UI + mock api с dev-симулятором агента), интеграция с реальными endpoint'ами — после этапа C. Все тексты — словацкие, через `sk.ts`; данные — только через api-слой.

Nastavenia → новая вкладка `Mostík`:
1. **Povoliť Mostík** — переключатель (tenant-level). Пока выключен — остальные блоки в состоянии disabled с пояснением.
2. **Inštalácia**: кнопка `Stiahnuť Dokladovka Agent (Windows)` (ссылка из `/api/agent/latest`; в mock — заглушка) + краткий чеклист требований: licencia POHODA, používateľ s právami `Dátová komunikácia`, nakonfigurovaná inštancia POHODA mServer, Windows Server/PC kde beží POHODA.
3. **Párovanie**: кнопка `Vygenerovať párovací kód` → код показывается один раз (TTL 15 min); таблица установок агента: hostname, verzia, lastSeen, статус `Pripojené` (heartbeat < 5 мин) / `Nepripojené`, кнопка `Odpojiť` (ревокация токена).
4. **Organizácie ↔ účtovné jednotky**: таблица — organizácia (nazov, IČO) ↔ nájdená ÚJ z POHODY (dbName, rok), статус `Spárované`/`Čaká`; правило года по умолчанию `Najnovší účtovný rok` с ручным переопределением per organizácia.
5. **História prenosov**: dátum/čas, používateľ, organizácia, počet dokladov, status (`Úspech`/`Čiastočne`/`Chyba`), детальный разворот per doklad с сообщением POHODA; кнопка `Zopakovať` для failed job'ов.
6. **Export flow**: на `ExportPage` и в `DocumentDetailPage` при подключённом мостике организации — кнопка `Odoslať do POHODY` (создаёт ExportJob) рядом со `Stiahnuť XML`; статусы документов обновляются по export-results; disabled-состояние с тултипом, когда мостик не подключён.

Definition of Done: mock-цикл кликабелен end-to-end через dev-симулятор («агент» подключился → числники пришли → документ отправлен → пришёл результат ok/error), тесты на state-переходы ExportJob, все строки в `sk.ts`.

---

## 8. ЭТАП E — Windows-агент «Dokladovka Agent» (подпроект `agent/`, по команде)

- Технология: .NET 8, Worker Service (Windows-служба `DokladovkaService`) + минимальный конфигуратор (CLI или простое окно): URL облака, párovací kód, adresa/port mServer, login/heslo POHODA-пользователя. Секреты — DPAPI (`ProtectedData`), не plain-text.
- Сетевая модель: ТОЛЬКО исходящие HTTPS к backend (поллинг + heartbeat). Никаких входящих портов у клиента.
- mServer-клиент: HTTP POST `text/xml` на `http://localhost:{port}/xml`; Basic-авторизация заголовком `STW-Authorization` (base64 `login:heslo`); заголовки `STW-Application: Dokladovka`, `STW-Instance: {jobId}`, при импортах `STW-Check-Duplicity`; статус/подключённая ÚJ — status-запросом (companyDetail).
- Подэтапы: **E1** каркас + pairing; **E2** mServer-клиент + status; **E3** heartbeat + автоматчинг фирм по IČO (+ правило года из настроек); **E4** синк числников по расписанию (list-request → `PUT code-lists`); **E5** экспорт (queue → dataPack POST → разбор `rsp:responsePack` → results); **E6** устойчивость: retries/backoff, transient vs permanent, rolling-лог, опциональный старт/стоп mServer (`pohoda.exe /HTTP start|stop|restart "{instancia}"`); **E7** инсталлятор Inno Setup (служба + конфигуратор) и автообновление против `GET /api/agent/latest` (sha256-проверка); **E8** пилот на фирме 35761571: полный E2E на реальной POHODA.
- README агента: требования на стороне POHODA (права `Dátová komunikácia` + mServer, инстанция mServer, занимает отдельный запущенный экземпляр POHODA и одну лицензию; Stormware рекомендует запуск по расписанию, не 24/7 — конфликт с zálohovaním/správou databázy).

---

## 9. ЭТАП F — Продакшн-харднинг (по команде)

- Валидация исходящего dataPack против официальных XSD Stormware; закрыть все `TODO(pohoda-xsd)` (поле IBAN, ставка 5 %, маппинг OZ/PD и т.д.).
- Перенос PDF-príloh в zložku dokumentov firmy POHODA + линк назад в архив Dokladovky (как у Doklado) — после проверки поддерживаемого механизма; в POHODE требует включённой voľby `Používať zložku dokumentov firmy`.
- Мониторинг/алерты: health агентов (lastSeen), доля failed job'ов, время синка; уведомление админу tenant'а при `Nepripojené` > N часов.
- Чеклист асистированной установки (как у Doklado): подготовка mServer, права, párovanie, тестовый перенос.

---

## 10. Чего НЕ делать (все этапы)

- Не читать базу POHODA (MDB/SQL) в продакшне — только официальный XML; MDB — исключительно этап 0 (fixtures/seed) на dev-машине.
- Не выдумывать имена XML-элементов: официальный пример или `TODO(pohoda-xsd)` + fixture.
- Не помечать документ `exportovany` без подтверждения POHODA.
- Не удалять číselníkové записи — только деактивация.
- Не добавлять зависимостей без необходимости (XML: DOMParser в браузере, System.Xml в .NET).
- Не трогать e-mail/AI-контуры, не реформатировать несвязанные файлы.
- Никаких секретов во фронтенде, `localStorage`, `VITE_*`; `.mdb` и инсталляторы не коммитятся в git.

---

## 11. Входные данные от заказчика (Marshall)

1. **Этап 0:** путь к `StwPh_35761571_2025.mdb` на dev-машине (файл вне репозитория).
2. **Этап A, сессия 2:** реальные response-файлы из POHODA SK (прогон сгенерированных request-файлов) → `src/data/pohoda/__fixtures__/` бинарно как есть (Windows-1250 не перекодировать!); перед коммитом проверить, что там только числники.
3. **Этап B:** решение по хостингу (VPS+Coolify или PaaS) и доступы к нему; домен.
4. **Этап E:** ничего секретного в репозиторий; login/heslo POHODA и párovací kód вводятся только в конфигураторе агента на машине клиента.

---

---

## 12. Стартовые сообщения для сессий ChatGPT Codex

### 12.1. Первый чат после переноса на другой аккаунт — выполнить сейчас

> Ты продолжаешь существующий проект **Dokladovka**, а не создаёшь новый. Работай в распакованном корне проекта, где находятся `package.json`, `AGENTS.md` и `src/`. Приложенный ZIP, старая переписка и готовый `dist/` не являются source of truth — source of truth это текущий исходный код и спецификации.
>
> Сначала прочитай все применимые `AGENTS.md` / `AGENTS.override.md`, затем `package.json`, `package-lock.json`, `SPEC-dokladovka_3_email_ai_Codex.md`, `AUDIT-digitoo-parity.md` и целиком `SPEC-dokladovka_4_pohoda_Codex.md`. Проведи короткий аудит и подтверди фактическое состояние: доступные scripts, persist-version, модель `CodeListItem`, существующий POHODA export, наличие/отсутствие `src/data/pohoda/` и MDB-экстрактора. Не доверяй старому отчёту без проверки кода и запуска команд.
>
> В этой сессии выполни **ТОЛЬКО ЭТАП 0** по разделу 3. Обнови source of truth в `AGENTS.md`; создай `scripts/extract-pohoda-mdb.mjs` на базе `mdbtools`; добавь безопасные ignore-маски для MDB/ACCDB; используй приложенный `StwPh_35761571_2025*.mdb` только как внешний локальный вход и не копируй его в репозиторий; сгенерируй `src/data/pohoda/__fixtures__/mdb-extract-35761571.json` только с číselníkmi `kod/nazov` и допустимыми `agenda/rok`. Не выгружай партнёров, документы, зарплаты, адреса, банковские данные или иные персональные/финансовые сведения.
>
> Не начинай этап A и не меняй UI, модель `CodeListItem`, persist-version или XML parser в этой сессии. Не перескаффолдивай проект, не удаляй рабочий код, не редактируй `dist/`, не заменяй package manager/lockfile и не форматируй несвязанные файлы.
>
> Старая переписка может содержать опубликованные учётные данные. Не используй, не цитируй и не сохраняй их; не входи во внешние сервисы. Считай их скомпрометированными.
>
> После изменений реально запусти `npm run typecheck`, `npm test`, `npm run build`; lint запускай только если обнаружишь соответствующий script. Также запусти экстрактор на переданном MDB, проверь структуру и приватность JSON. В финальном отчёте укажи: аудит до правок, изменённые файлы, точные команды и результаты, какие таблицы/колонки MDB использованы, количество записей по каждому číselníку, ручную проверку приватности, оставшиеся риски и явную фразу `Этап A не начинался`.

### 12.2. Сессия A1 — только после успешного этапа 0

> Прочитай `AGENTS.md`, `package.json`, текущую структуру репозитория и целиком `SPEC-dokladovka_4_pohoda_Codex.md`. Сначала проверь, что Definition of Done этапа 0 выполнен и fixture не содержит посторонних данных. Затем реализуй **ТОЛЬКО ЭТАП A** по разделу 4; этапы B–F не реализовывать. Перед request-шаблонами и парсером найди актуальные официальные примеры Stormware из §2.2 через веб-поиск/браузер Codex. Используй только первичные официальные источники; всё неподтверждённое помечай `TODO(pohoda-xsd)`. После изменений выполни typecheck, tests, build и приложи отчёт по §4.9.

### 12.3. Сессия A2 — после прогона request-файлов в реальной POHODA

> В `src/data/pohoda/__fixtures__/` добавлены реальные response-файлы из POHODA SK. Не перекодируй оригинальные бинарные файлы Windows-1250. Приведи parser и request-шаблоны в точное соответствие с fixtures, закрой подтверждённые `TODO(pohoda-xsd)`, добавь тест на каждый fixture с диакритикой и сверку с `mdb-extract-35761571.json`. Выполни checklist §4.9 заново. Другие этапы не начинай.

### 12.4. Сессия D-mock — опционально до backend

> Реализуй **ТОЛЬКО ЭТАП D** по разделу 7 в mock-режиме: типы, вкладку Mostík в Nastavenia, dev-симулятор агента и кнопку `Odoslať do POHODY` со state-переходами ExportJob. Реальные HTTP-вызовы не делать; всё должно проходить через существующий async API/service layer, чтобы после появления backend изменился только adapter. Не реализуй B, C, E или F.

### 12.5. Сессия B

> Реализуй **ТОЛЬКО ЭТАП B**: backend Фазы 2 по разделам 11–13 основной спецификации и требованиям раздела 5 `SPEC-dokladovka_4_pohoda_Codex.md`. Нужны публичный HTTPS, `GET /api/health`, PostgreSQL, migrations, Docker, CI/CD и правило `commit → push → green CI → auto-deploy`. Существующий frontend не переписывай; переключи adapter с mock на REST через существующую boundary.

### 12.6. Сессия C

> Реализуй **ТОЛЬКО ЭТАП C** по разделу 6 в backend. Идемпотентность, tenant/org boundaries и правило `exportovany` только после подтверждения POHODA обязательны. Добавь `GET /api/agent/latest` и безопасную раздачу инсталлятора. Не начинай агент или frontend Mostík за пределами минимально необходимых контрактов.

### 12.7. Сессия E

> Создай/продолжи подпроект `agent/` и реализуй **ТОЛЬКО названные подэтапы E** по разделу 8. Для первого прохода выполнить E1–E3: .NET 8 Worker Service, pairing, mServer client, heartbeat и matching по IČO. Секреты хранить через DPAPI; агент делает только исходящие соединения. Экспорт документов E5 не начинать до отдельного сообщения.

### 12.8. Сессия F

> Выполни **ТОЛЬКО ЭТАП F** по разделу 9: XSD validation, закрытие подтверждённых `TODO(pohoda-xsd)`, PDF-prílohy, monitoring и installation checklist. Не подменяй реальные проверки предположениями; все POHODA XML детали подтверждай официальной XSD/документацией и fixtures.

---

## 13. Обязательный формат финального отчёта Codex

1. **Выбранный этап** и подтверждение, что другие этапы не реализовывались.
2. **Аудит до изменений:** фактическое состояние и найденные расхождения со spec.
3. **Изменённые файлы:** краткое назначение каждого meaningful diff.
4. **Команды:** точные команды, exit result и число тестов. Не писать «успешно», если команда не запускалась.
5. **Ручная проверка:** только реально выполненные действия.
6. **Безопасность/приватность:** отсутствие secrets и cross-tenant leakage; для MDB — перечень экспортированных полей и подтверждение отсутствия посторонних данных.
7. **Оставшиеся TODO/блокеры:** отдельно подтверждённые и неподтверждённые POHODA/XSD детали.
8. **Следующий разрешённый этап:** назвать, но не начинать его без нового сообщения пользователя.
