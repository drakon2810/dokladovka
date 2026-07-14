# SPEC — «Dokladovka» (рабочее название): веб-приложение для приёма, проверки и экспорта бухгалтерских документов в POHODA

> Документ предназначен для OpenAI Codex (coding agent в ChatGPT, IDE или CLI). Фаза 1 = фронтенд-прототип с mock-данными, рабочей генерацией XML, mock-генерацией уникальных e-mail-адресов организаций и симуляцией входящего письма. Реальные интеграции (backend, база данных, inbound e-mail, файловое хранилище, OpenAI API, SharePoint и mServer POHODA) реализуются поэтапно; архитектурные точки подключения обязательны уже в Фазе 1.
>
> **Версия 1.1:** добавлена подробная спецификация автоматического создания e-mail-алиасов для организаций, маршрутизации входящих фактур, AI-извлечения, предложения заúčtovania, ручного schválenia и последующего экспорта в POHODA.
>
> **Версия 1.2 (Codex/OpenAI):** документ адаптирован для OpenAI Codex как coding agent. Production AI-извлечение переведено на provider abstraction с OpenAI Responses API и Structured Outputs; секрет используется только на backend/worker через `OPENAI_API_KEY`.
>
> **Приоритет требований:** если новый раздел 11–13 конфликтует с более ранним описанием e-mail, организации, AI или статусов обработки, применяются разделы 11–13. Весь production-функционал, требующий secrets, webhook, файлового хранилища или базы данных, выполняется только на backend/worker.

## Содержание

1. Контекст и цель
2. Scope Фазы 1
3. Технологический стек
4. Модель данных
5. Роли
6. Экраны
7. Генерация XML POHODA
8. Дизайн
9. Mock-данные
10. Definition of Done Фазы 1
11. Автоматические e-mail-адреса, inbound pipeline и AI
12. Фазы реализации нового модуля
13. Definition of Done e-mail/AI-модуля
14. Обновлённый kickoff-промпт для OpenAI Codex

---

## 1. Контекст и цель

Продукт для словацкой бухгалтерской фирмы, обслуживающей несколько клиентских компаний (организаций). Входящие документы (faktúry prijaté/vydané, bankové výpisy, mzdy, ostatné záväzky) приходят на e-mail в PDF, автоматически извлекаются AI и попадают в это приложение. Здесь бухгалтер:

1. видит очередь документов, разделённую по организациям;
2. проверяет и правит извлечённые данные (суммы, DPH, dodávateľ…);
3. назначает predkontáciu, členenie DPH, číselný rad;
4. схваливает документ;
5. экспортирует схвалённые документы в XML (формат POHODA dataPack) для импорта в POHODA.

Функциональный ориентир — wflow.com (приём докладов, AI-вытяжка, схвалення, экспорт в ERP). **Важно: мы делаем аналог по функциям, а не клон бренда.** Не копировать тексты, логотип, иллюстрации или фирменные цвета wflow. Весь UI — собственный, на словацком языке.

**Язык интерфейса: словацкий.** Все строки UI выносить в один модуль `src/i18n/sk.ts` (плоский объект), чтобы позже добавить CZ/EN.

---

## 2. Scope Фазы 1 (этот прототип)

Входит:
- SPA на React с mock-данными (in-memory store, сериализация в localStorage для персистентности между перезагрузками);
- все экраны из раздела 6;
- рабочая генерация XML dataPack на клиенте с выгрузкой файла;
- переключение ролей (Účtovník / Schvaľovateľ / Admin) без реальной авторизации;
- фиктивная «AI-вытяжка»: у mock-документов данные уже извлечены, у части — с ошибками/пропусками, чтобы показать сценарий проверки;
- при ручном создании организации автоматически генерируется уникальный mock e-mail-алиас по правилам раздела 11;
- экран «E-mailové schránky» показывает алиасы и позволяет запустить локальную симуляцию входящего письма без реальной почтовой инфраструктуры;
- сервисные интерфейсы для будущих backend/API-интеграций, чтобы в Фазе 2 не переписывать UI.

НЕ входит (заглушки с пометкой `// TODO: integration point`):
- реальный приём почты, настройка MX/DNS, webhook почтового провайдера / Microsoft Graph / SharePoint;
- реальный вызов OpenAI API для извлечения;
- отправка в mServer POHODA;
- реальная авторизация (Entra ID планируется в Фазе 2);
- мобильное приложение.

---

## 3. Технологический стек

- **React 18 + TypeScript + Vite**
- **Tailwind CSS** (v3, конфиг с дизайн-токенами из раздела 8)
- **react-router-dom v6** — маршрутизация
- **zustand** — состояние (store с mock-данными + persist middleware на localStorage)
- **react-pdf** (обёртка pdf.js) — просмотр PDF; sample-PDF лежат в `/public/samples/`
- **date-fns** — даты, локаль `sk`
- В Фазе 1 никакого реального бэкенда. Слой данных изолировать в `src/data/api.ts` с async-сигнатурами (`getDocuments(): Promise<Doc[]>`), чтобы замена mock → REST не трогала компоненты. Генерацию алиаса, симуляцию inbound e-mail и mock AI также вызывать только через сервисный слой, а не напрямую из React-компонентов.

Структура каталогов:

```
src/
  app/            # роутер, layout, providers
  components/     # переиспользуемые UI-компоненты
  features/
    documents/    # очередь, detail, форма
    export/       # экспорт XML, история
    settings/     # организации, числники, пользователи
    dashboard/
  data/           # types.ts, mock/, api.ts, xml/pohodaDataPack.ts
  i18n/sk.ts
  lib/            # утилиты: formatMoney, validateICO, ...
```

---

## 4. Модель данных (TypeScript)

```ts
type DocumentType = 'FP' | 'FV' | 'BV' | 'MZDY' | 'OZ' | 'PD';
// FP faktúra prijatá, FV faktúra vydaná, BV bankový výpis,
// MZDY mzdové podklady, OZ ostatný záväzok, PD pokladničný doklad

type DocumentStatus =
  | 'novy'          // prišiel e-mailom, čaká na extrakciu
  | 'extrahovany'   // AI dokončila vyťaženie, čaká na kontrolu
  | 'na_kontrole'   // otvorený účtovníkom, rozpracovaný
  | 'schvaleny'     // skontrolovaný, pripravený na export
  | 'exportovany'   // zahrnutý do XML exportu
  | 'chyba'         // extrakcia zlyhala / nevalidné dáta
  | 'karantena'     // nesúlad IČO odberateľa s organizáciou
  | 'duplicita'     // rovnaký dodávateľ + číslo faktúry už existuje
  | 'zamietnuty';

type ProcessingStatus =
  | 'received'
  | 'validating'
  | 'queued'
  | 'extracting'
  | 'normalizing'
  | 'ready_for_review'
  | 'failed_retryable'
  | 'failed_permanent';

interface Organization {
  id: string;
  nazov: string;          // "Alfa s.r.o."
  ico: string;            // 8 cifier
  dic: string;
  icDph?: string;         // "SK2020..."
  emailAlias: string;     // генерируется автоматически, напр. "alfa-trade-k7m4q2@doklady.dokladorpro.sk"
  farba: string;          // hex, farebný štítok organizácie v UI
}

interface VatBreakdownRow {
  sadzba: 23 | 19 | 5 | 0; // sadzby DPH platné v SR
  zaklad: number;
  dph: number;
}

interface DocumentLineItem {
  id: string;
  popis: string;
  mnozstvo?: number;
  jednotka?: string;
  jednotkovaCenaBezDph?: number;
  sadzbaDph?: 23 | 19 | 5 | 0;
  sumaBezDph?: number;
  sumaDph?: number;
  sumaSpolu?: number;
}

interface DocumentItem {
  id: string;
  orgId: string;
  typ: DocumentType;
  status: DocumentStatus;
  processingStatus: ProcessingStatus;
  pdfUrl: string;              // /samples/xxx.pdf
  prijateDna: string;          // ISO — kedy prišiel e-mail
  zdroj: {
    typ: 'email' | 'manual' | 'upload';
    inboundEmailId?: string;
    attachmentId?: string;
    odosielatel?: string;
    prijemcaAlias?: string;
    predmet?: string;
    povodnyNazovSuboru?: string;
  };
  confidence: number;          // 0–1, агрегированная istota AI extrakcie
  fieldConfidence?: Record<string, number>;
  extracted: {
    dodavatel: {
      nazov: string; ico?: string; dic?: string; icDph?: string;
      adresa?: string; iban?: string;
    };
    odberatel?: {
      nazov?: string; ico?: string; dic?: string; icDph?: string;
      adresa?: string;
    };
    cisloFaktury: string;      // dodávateľské číslo
    variabilnySymbol?: string;
    konstantnySymbol?: string;
    specifickySymbol?: string;
    datumVystavenia: string;
    datumSplatnosti?: string;
    datumDodania?: string;     // DUZP
    mena: 'EUR' | 'CZK' | 'USD';
    rozpisDph: VatBreakdownRow[];
    sumaSpolu: number;
    polozky?: DocumentLineItem[];
    textPolozky?: string;      // stručný popis plnenia
  };
  ucto: {                      // vyplní účtovník (predvyplnené návrhom)
    predkontaciaId?: string;
    clenenieDphId?: string;
    ciselnyRadId?: string;
    strediskoId?: string;
    poznamka?: string;
  };
  history: Array<{ ts: string; user: string; akcia: string }>;
  comments: Array<{ ts: string; user: string; text: string }>;
  exportId?: string;
}

interface CodeListItem { id: string; kod: string; nazov: string; orgId: string; }
// samostatné zoznamy: predkontacie, cleneniaDph, ciselneRady, strediska

interface ExportBatch {
  id: string; orgId: string; createdAt: string; user: string;
  documentIds: string[]; xmlFileName: string;
}

type Role = 'uctovnik' | 'schvalovatel' | 'admin';
```

Правила статусных переходов: `novy → extrahovany → na_kontrole → schvaleny → exportovany`; из `chyba/karantena/duplicita` можно вручную перевести в `na_kontrole` (кнопка «Spracovať ručne») или `zamietnuty`. Переход в `schvaleny` доступен ролям uctovnik/admin; schvalovatel видит только `na_kontrole → schvaleny/zamietnuty`.

---

## 5. Roles (переключатель в topbar, без логина)

- **Účtovník** — всё, кроме настроек пользователей.
- **Schvaľovateľ** — только просмотр очереди и schvaľovanie/zamietnutie; поля формы read-only, кроме комментариев.
- **Admin** — всё + Nastavenia.

---

## 6. Экраны

### 6.1 Layout
Левый sidebar (240 px, сворачиваемый до иконок):
- Переключатель организации сверху: dropdown со списком организаций + пункт **«Všetky organizácie»**. У каждой — цветной кружок (`farba`) и счётчик документов «na kontrolu».
- Навигация: `Prehľad`, `Doklady`, `Export`, `Nastavenia` (только admin).
Topbar: глобальный поиск (по dodávateľ/číslo faktúry/VS), переключатель роли, аватар.

### 6.2 Prehľad (dashboard) — `/`
Карточки-счётчики по выбранной организации (или сумма по всем): `Nové`, `Na kontrolu`, `Schválené`, `Chyby/Karanténa`. Клик по карточке = переход в Doklady с фильтром. Ниже: список последних 10 событий (из history) и мини-график «doklady за posledných 30 dní» (простая CSS-гистограмма, без chart-библиотек).

### 6.3 Doklady (очередь) — `/doklady`
Ядро приложения. Таблица документов:

| Колонка | Содержимое |
|---|---|
| ☐ | checkbox для bulk-действий |
| Organizácia | цветной chip (скрыт, если выбрана конкретная организация) |
| Typ | badge FP/FV/BV/MZDY/OZ/PD |
| Dodávateľ | názov + IČO серым |
| Číslo faktúry / VS | |
| Dátum dodania | |
| Splatnosť | красным, если просрочено |
| Suma | tabular-nums, выравнивание вправо, `1 234,56 €` |
| Stav | статусный badge (цвета в разделе 8) |
| AI | индикатор confidence: ✓ ≥0.9, ~ 0.7–0.9, ! <0.7 |

Над таблицей: tabs по статусам (`Všetky / Na kontrolu / Schválené / Exportované / Problémy`) + фильтры (typ, dodávateľ, obdobie od–do) + сортировка. Bulk-действия для выбранных: `Schváliť`, `Zamietnuť`, `Presunúť do…`. Строка кликабельна → detail. Пустое состояние: «Žiadne doklady. Nové doklady prídu automaticky na e-mail organizácie, napr. *firma-token*@doklady.dokladorpro.sk». Адрес брать из `Organization.emailAlias`, не хардкодить.

### 6.4 Detail dokladu — `/doklady/:id`
Split view 50/50 (перетаскиваемый разделитель):

**Слева** — PDF viewer (react-pdf): зум, листание страниц, кнопка «Stiahnuť PDF».

**Справа** — форма, секции:
1. **Hlavička**: typ dokladu (select), organizácia (read-only + предупреждение, если IČO odberateľa из PDF ≠ IČO организации → жёлтый баннер «Možný nesúlad organizácie»).
2. **Dodávateľ**: názov, IČO, DIČ, IČ DPH, IBAN. Возле IČO кнопка «Overiť» (в прототипе — заглушка с тултипом «Overenie v ORSR — Fáza 2»). Валидация: IČO 8 цифр, IBAN формат SK.
3. **Doklad**: číslo faktúry, VS, KS, ŠS, dátum vystavenia / splatnosti / dodania (DUZP), mena.
4. **Rozpis DPH** — редактируемая таблица строк {sadzba 23/19/5/0 %, základ, DPH} + автосумма `Spolu`. Live-валидация: |základ×sadzba − dph| ≤ 0,02 €, иначе строка подсвечена и подсказка «Prepočítať». Итог должен сойтись с `sumaSpolu`; расхождение — красный индикатор.
5. **Zaúčtovanie**: selects `Predkontácia`, `Členenie DPH`, `Číselný rad`, `Stredisko` (значения — числники организации), `Poznámka`. Под селектами подсказка «Naposledy pre tohto dodávateľa: 518/321 · PD» (mock-логика: взять последний schválený документ того же dodávateľa) с кнопкой «Použiť».
6. **Komentáre** и **História** — две вкладки внизу.

Поля, извлечённые с confidence <0.7, подсвечены янтарным фоном — визуальный сигнал «проверь меня».

Панель действий (sticky снизу): `Uložiť`, `Schváliť` (primary; disabled + тултип, пока не заполнены predkontácia, členenie DPH, číselný rad и не сходится DPH), `Zamietnuť`, `Karanténa`. Навигация «← Predchádzajúci / Nasledujúci →» по текущему фильтру очереди (клавиши J/K).

### 6.5 Export — `/export`
Две вкладки:
- **Nový export**: выбор организации (обязателен — dataPack всегда per-организация) → таблица документов в статусе `schvaleny` с checkbox → кнопка `Vygenerovať XML pre POHODA`. Результат: скачивается файл `pohoda-{orgKod}-{YYYYMMDD-HHmm}.xml`, документы переходят в `exportovany`, создаётся ExportBatch. Показать preview первых ~40 строк XML в `<pre>` перед скачиванием.
- **História exportov**: таблица batch'ей (dátum, organizácia, počet dokladov, user, кнопка «Stiahnuť znova»).

### 6.6 Nastavenia — `/nastavenia` (admin)
Вкладки:
- **Organizácie**: CRUD-таблица (nazov, IČO, DIČ, IČ DPH, farba-picker). `emailAlias` создаётся системой автоматически после сохранения организации, показывается read-only, имеет кнопку «Kopírovať» и не принимается из обычной формы как свободный текст.
- **Číselníky**: выбор организации → четыре списка (Predkontácie, Členenia DPH, Číselné rady, Strediská) с CRUD. Баннер: «Vo Fáze 2 sa číselníky synchronizujú z POHODY automaticky».
- **Používatelia**: mock-список (meno, e-mail, rola) — только просмотр/редактирование роли.
- **E-mailové schránky**: в Фазе 1 — рабочий mock-экран со списком алиасов, статусом, кнопками «Kopírovať», «Simulovať prijatý e-mail» и admin-действием «Vygenerovať nový alias». В Фазе 2 этот же экран показывает реальные данные почтового провайдера, последние письма, ошибки и повторную обработку.

---

## 7. Генерация XML (реализовать по-настоящему)

`src/data/xml/pohodaDataPack.ts` — чистая функция `buildDataPack(org: Organization, docs: DocumentItem[]): string`.

Скелет (namespace-ы и структура по схеме Stormware, version 2.x):

```xml
<?xml version="1.0" encoding="Windows-1250"?>
<dat:dataPack version="2.0" id="Export001" ico="{org.ico}"
    application="Dokladovka" note="Import faktur"
    xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"
    xmlns:inv="http://www.stormware.cz/schema/version_2/invoice.xsd"
    xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd">
  <dat:dataPackItem id="{doc.id}" version="2.0">
    <inv:invoice version="2.0">
      <inv:invoiceHeader>
        <inv:invoiceType>receivedInvoice</inv:invoiceType>
        <inv:number><typ:numberRequested>...</typ:numberRequested></inv:number>
        <inv:symVar>{VS}</inv:symVar>
        <inv:date>{datumVystavenia}</inv:date>
        <inv:dateTax>{datumDodania}</inv:dateTax>
        <inv:dateDue>{datumSplatnosti}</inv:dateDue>
        <inv:accounting><typ:ids>{predkontacia.kod}</typ:ids></inv:accounting>
        <inv:classificationVAT><typ:ids>{clenenieDph.kod}</typ:ids></inv:classificationVAT>
        <inv:partnerIdentity>
          <typ:address>
            <typ:company>{dodavatel.nazov}</typ:company>
            <typ:ico>{dodavatel.ico}</typ:ico>
            <typ:dic>{dodavatel.dic}</typ:dic>
          </typ:address>
        </inv:partnerIdentity>
        <inv:paymentAccount><typ:accountNo>{iban}</typ:accountNo></inv:paymentAccount>
      </inv:invoiceHeader>
      <inv:invoiceSummary>
        <inv:homeCurrency>
          <typ:priceHigh>{zaklad23}</typ:priceHigh>
          <typ:priceHighVAT>{dph23}</typ:priceHighVAT>
          <typ:priceLow>{zaklad19}</typ:priceLow>
          <typ:priceLowVAT>{dph19}</typ:priceLowVAT>
          <typ:priceNone>{zaklad0}</typ:priceNone>
        </inv:homeCurrency>
      </inv:invoiceSummary>
    </inv:invoice>
  </dat:dataPackItem>
</dat:dataPack>
```

Требования: экранировать XML-спецсимволы; `invoiceType` мапить из типа (`FP → receivedInvoice`, `FV → issuedInvoice`, `OZ → пометить TODO: liability/internal doklad`); суммы с точкой, 2 знака; в коде комментарий `// TODO: validovať proti oficiálnej XSD Stormware pred Fázou 2` (третью ставку 5 % POHODA обрабатывает отдельным полем — оставить TODO-комментарий). BV и MZDY в Фазе 1 из экспорта исключить (disabled checkbox + тултип «Bankové výpisy sa importujú cez camt.053 priamo do POHODY»).

---

## 8. Дизайн

Это плотный рабочий инструмент бухгалтера, не маркетинговый сайт. Ценности: скорость чтения таблиц, различимость статусов, ноль декоративного шума. Не использовать фирменные цвета/стиль wflow.

Токены (в `tailwind.config`):
- Фон приложения `#F6F7F5`, поверхности `#FFFFFF`, границы `#E3E6E2`.
- Текст: primary `#1B1F1D`, secondary `#5C645F`.
- **Accent (primary)**: глубокий зелёный `#0E7A5F`, hover `#0A6650`. Focus ring `#0E7A5F` 2 px.
- Статусы: novy `#64748B`, extrahovany `#0369A1`, na_kontrole `#B45309`, schvaleny `#15803D`, exportovany `#334155`, chyba/duplicita `#B91C1C`, karantena `#A16207`, zamietnuty `#6B7280`. Badge = светлый фон того же тона + тёмный текст, не сплошная заливка.
- Радиусы 6 px, тени минимальные (`0 1px 2px rgba(0,0,0,.06)`).

Типографика: **Inter** (Google Fonts) для всего UI; для всех чисел, сумм, IČO, VS — `font-variant-numeric: tabular-nums`. Размеры: таблицы 13–14 px, формы 14 px, заголовки страниц 20 px/600. Плотность строк таблицы ~44 px.

Фирменная деталь (signature): цвет организации проходит через весь интерфейс — кружок в sidebar, chip в таблице, тонкая 3-px полоса слева на странице detail. Бухгалтер всегда периферийным зрением знает, «в чьей» он фактуре.

Доступность: видимый keyboard focus, aria-label на иконках-кнопках, контраст ≥ 4.5:1. Desktop-first (min 1280 px), таблицы горизонтально скроллятся на меньших экранах; мобильная версия вне scope.

---

## 9. Mock-данные (`src/data/mock/`)

- **3 организации**: `Alfa Trade s.r.o.` (IČO 36123456, alias `alfa-trade-k7m4q2@doklady.dokladorpro.sk`, farba #0E7A5F), `Beta Gastro s.r.o.` (IČO 47654321, alias `beta-gastro-p9x2vd@doklady.dokladorpro.sk`, #B45309), `Gama Servis s.r.o.` (IČO 51987654, alias `gama-servis-r4c8wn@doklady.dokladorpro.sk`, #4338CA). Токены фиксированы в seed-данных, чтобы reset demo dát давал воспроизводимый результат.
- **~28 документов**, распределение: 15 FP, 4 FV, 3 BV, 2 MZDY, 2 OZ, 2 PD; статусы вперемешку, минимум: 8 na_kontrole, 5 schvaleny, 4 exportovany (в 2 batch-ах), 2 chyba, 1 karantena (IČO mismatch), 1 duplicita, остальные novy/extrahovany. У 5 документов confidence <0.7 с пропущенными полями (нет VS, нет DUZP…).
- Dodávatelia — реалистичные словацкие: `Slovak Telekom, a.s.`, `ZSE Energia, a.s.`, `Alza.sk s. r. o.`, `Metro Cash & Carry SR`, `Orange Slovensko`, `Kancelárske potreby OFFICEO` и т.п.; корректные форматы IČO (8 цифр), IČ DPH `SK` + 10 цифр, IBAN `SK..`.
- Суммы: rozpis DPH со ставками 23 % (основная), 19 % и 5 % (пониженные); у пары документов две ставки одновременно; математика base×rate=vat должна сходиться, у одного «chyba»-документа — специально не сходиться.
- Числники per-организация, примеры: predkontácie `518/321 Služby`, `501/321 Materiál`, `511/321 Opravy`, `112/321 Tovar`; členenia DPH: `PD – Tuzemské plnenie, odpočet 100 %`, `PDpdp – Prenesenie daňovej povinnosti`, `PNzahr – Nadobudnutie z EÚ`, `BEZ – Bez vplyvu na DPH` (пометка в коде: реальные коды придут из POHODA); číselné rady `26FP`, `26FV`, `26OZ`; strediská `HLAVNE`, `SKLAD`.
- **Sample PDF**: 5–6 простых односторничных PDF в `/public/samples/` — сгенерировать node-скриптом (`scripts/gen-pdfs.mjs`, pdf-lib) с видом простой словацкой фактуры (dodávateľ, tabuľka položiek, rozpis DPH, suma). Разные документы могут ссылаться на один PDF.

---

## 10. Definition of Done (Фаза 1)

1. `npm i && npm run dev` работает без ошибок; `npm run build` проходит.
2. Проходится сценарий: открыть Doklady → фильтр «Na kontrolu» → открыть документ → исправить поле с низким confidence → выбрать predkontáciu/členenie/rad → Schváliť → Export → выбрать организацию и документ → скачать XML → документ в статусе `exportovany`, batch в истории.
3. XML открывается, well-formed, кодировка/суммы/даты корректны.
4. Karanténa-документ показывает баннер несоответствия IČO; duplicita помечена; у документа с несходящейся DPH — красный индикатор и заблокированное schválenie.
5. Переключение ролей меняет доступные действия.
6. Состояние переживает перезагрузку страницы (localStorage), есть кнопка «Reset demo dát» в Nastavenia.
7. Ни один экран не падает при пустых данных.
8. При создании новой mock-организации генерируется уникальный валидный e-mail-алиас; переименование организации не меняет уже выданный адрес.
9. Кнопка «Simulovať prijatý e-mail» создаёт mock inbound message, маршрутизирует его по алиасу в правильную организацию и создаёт отдельный `DocumentItem` для каждого поддерживаемого вложения.
10. Неизвестный алиас, неподдерживаемый файл, дубликат и IČO mismatch демонстрируются отдельными mock-сценариями и не приводят к тихому добавлению документа в неверную организацию.
11. Ни один API-ключ или секрет не попадает в frontend-код, localStorage, bundle или `VITE_*` переменные.

---

## 11. Автоматические e-mail-адреса организаций и приём входящих фактур

### 11.1. Пользовательский сценарий

Администратор или účtovník с соответствующим правом вручную создаёт новую организацию, например `AGS s.r.o.`. После успешного сохранения система автоматически:

1. создаёт запись организации;
2. генерирует уникальный входящий e-mail-алиас;
3. связывает алиас с `organizationId`;
4. показывает адрес в интерфейсе с кнопкой копирования;
5. разрешает отправлять этот адрес клиенту;
6. все поддерживаемые документы, пришедшие на этот адрес, относит только к данной организации;
7. запускает автоматическую обработку каждого вложения;
8. создаёт документы в очереди организации;
9. извлекает фактические данные из фактуры;
10. предлагает бухгалтерские параметры (`predkontácia`, `členenie DPH`, `číselný rad`, `stredisko`), но не подменяет ими окончательное решение бухгалтера;
11. после проверки пользователь может документ изменить, `Schváliť` или `Zamietnuť`;
12. только schválené документы становятся доступными для XML-экспорта или будущего прямого импорта в POHODA.

**Критическое правило:** входящий адрес определяет организацию, но не является механизмом авторизации. Знание алиаса не должно давать доступ к приложению или данным организации.

### 11.2. Корректный формат адреса

Запись вида `AGS-343.DokladorPro.sk` не является e-mail-адресом, потому что в ней отсутствует символ `@`. В проекте использовать один из валидных вариантов:

- основной рекомендуемый формат: `ags-k7m4q2@doklady.dokladorpro.sk`;
- допустимый упрощённый формат, если корневой домен полностью выделен сервису: `ags-k7m4q2@dokladorpro.sk`;
- вариант с отдельным поддоменом компании возможен как `doklady@ags-k7m4q2.dokladorpro.sk`, но не использовать его по умолчанию: он сложнее в DNS и эксплуатации.

Рекомендуемое разделение production-доменов:

```text
Web aplikácia:          https://app.dokladorpro.sk
Prijímací mail domain:  doklady.dokladorpro.sk
Alias organizácie:      ags-k7m4q2@doklady.dokladorpro.sk
```

Домен **никогда не хардкодить**. Источник истины:

```env
MAIL_RECEIVING_DOMAIN=doklady.dokladorpro.sk
```

### 11.3. Правила генерации алиаса

Формула:

```text
{organizationSlug}-{randomToken}@{MAIL_RECEIVING_DOMAIN}
```

Пример:

```text
AGS s.r.o. -> ags-k7m4q2@doklady.dokladorpro.sk
```

Правила `organizationSlug`:

- брать из `nazov` организации;
- привести к lowercase;
- убрать диакритику (`Čučoriedka` → `cucoriedka`);
- удалить юридические суффиксы только для удобства адреса (`s.r.o.`, `a.s.`), но не менять официальное название в БД;
- пробелы и последовательности недопустимых символов заменить на один `-`;
- разрешить только ASCII `a-z`, `0-9`, `-`;
- убрать `-` в начале и конце;
- ограничить длину slug, чтобы local-part целиком оставался не длиннее 64 символов;
- если после нормализации slug пустой, использовать `firma`;
- алиас сравнивать без учёта регистра, но хранить в lowercase.

Правила `randomToken`:

- 6–8 символов;
- использовать криптографически стойкий генератор: backend `crypto.randomBytes`, frontend mock `crypto.getRandomValues`;
- не использовать `Math.random()`;
- использовать набор без визуально неоднозначных символов, например lowercase base32 без `0/o/1/l`;
- на поле нормализованного адреса создать уникальный индекс в БД;
- при коллизии сгенерировать новый токен и повторить транзакцию;
- трёхзначный токен вроде `343` недостаточен для production из-за малого пространства комбинаций;
- токен не считать секретом и не использовать как пароль.

Жизненный цикл алиаса:

- первый алиас генерируется только после успешного создания организации;
- переименование организации не должно автоматически менять выданный клиентам адрес;
- обычный пользователь не может вручную редактировать полный адрес;
- admin может выполнить `Vygenerovať nový alias` только через отдельное подтверждаемое действие;
- новый алиас становится primary;
- старый алиас по умолчанию остаётся активным в переходный период, настраиваемый через `EMAIL_ALIAS_GRACE_DAYS`, затем становится disabled;
- отключённый адрес никогда не переиспользовать для другой организации;
- удаление организации с документами запрещено: использовать архивирование;
- при архивировании организации новые письма на её алиасы попадают в quarantine с причиной `organization_archived`.

### 11.4. Физические mailbox-ы не создавать без необходимости

Не нужно создавать отдельный настоящий почтовый ящик с логином и паролем для каждой организации. Рекомендуемая production-схема:

1. домен `doklady.dokladorpro.sk` настроен на inbound e-mail provider;
2. provider принимает все письма по wildcard/catch-all правилу `*@doklady.dokladorpro.sk`;
3. provider передаёт письмо и вложения в backend webhook;
4. backend извлекает **envelope recipient**, находит точное совпадение в таблице алиасов и определяет организацию;
5. дальнейшая обработка выполняется асинхронно.

Такой подход позволяет добавлять организации без реального создания mailbox-а у почтового провайдера. Если выбранный provider не поддерживает catch-all, предусмотреть второй режим `provider_alias`, где backend через API провайдера создаёт route/alias и сохраняет `providerRouteId`.

Обязательная абстракция:

```ts
type EmailProvisioningMode = 'catch_all' | 'provider_alias';

interface InboundEmailProvider {
  verifyWebhook(request: Request): Promise<boolean>;
  parseWebhook(request: Request): Promise<ParsedInboundEmail>;
  provisionAlias?(address: string): Promise<{ providerRouteId: string }>;
  disableAlias?(providerRouteId: string): Promise<void>;
}
```

Не реализовывать одновременно интеграции со всеми провайдерами. Должен существовать общий интерфейс, mock-адаптер для разработки и один production-адаптер, выбранный при развёртывании.

### 11.5. DNS и инфраструктура домена

Для production предусмотреть отдельный deployment checklist:

- A/AAAA/CNAME для web-приложения;
- MX-записи для `MAIL_RECEIVING_DOMAIN` согласно выбранному inbound provider;
- подтверждение владения доменом;
- webhook URL с HTTPS;
- секрет/ключ проверки подписи webhook;
- SPF/DKIM/DMARC нужны для исходящих уведомлений и автоответов; входящая маршрутизация в первую очередь зависит от MX;
- web-домен и mail-домен должны настраиваться независимо;
- изменение mail-домена после выдачи адресов клиентам является миграцией и не должно выполняться тихо.

В UI admin должен видеть системный статус:

```text
Doména overená / MX nakonfigurované / Webhook aktívny / Posledný prijatý e-mail
```

В Фазе 1 это mock-статусы. В Фазе 2 данные приходят с backend health endpoint.

### 11.6. Полный pipeline входящего письма

Порядок обработки обязателен:

```text
Inbound provider
  -> webhook verification
  -> idempotency check
  -> envelope recipient resolution
  -> organization resolution
  -> raw message metadata storage
  -> attachment enumeration
  -> MIME/file signature validation
  -> malware scan
  -> object storage upload
  -> SHA-256 duplicate check
  -> one processing job per supported attachment
  -> OCR/text extraction when needed
  -> OpenAI extraction via Responses API to strict structured output
  -> deterministic normalization and validation
  -> organization/IČO consistency check
  -> accounting suggestion engine
  -> document status assignment
  -> user notification / queue update
```

Webhook должен завершаться быстро. После безопасного сохранения минимального набора данных он ставит jobs в очередь и возвращает provider-у успешный ответ. Долгий AI-вызов не выполнять внутри webhook request.

### 11.7. Маршрутизация по получателю

Источник истины — **envelope recipient**, который передаёт provider. Заголовок `To` может быть изменён при пересылке, содержать display name или отсутствовать при BCC.

Правила:

1. Нормализовать recipient в lowercase и убрать окружающие пробелы.
2. Найти точное совпадение с активным `OrganizationEmailAlias.addressNormalized`.
3. Если найден ровно один активный алиас — назначить его `organizationId`.
4. Если алиас неизвестен — сохранить письмо в `unassigned/quarantine`, не пытаться угадать организацию по названию в адресе, теме или отправителю.
5. Если письмо доставлено сразу на алиасы разных организаций — status `ambiguous_recipient`, не создавать дубликаты автоматически.
6. Если алиас указывает на организацию A, а IČO odberateľa в документе соответствует организации B — не переносить автоматически; status `karantena`, причина `buyer_ico_mismatch`.
7. Admin может вручную назначить unassigned/karantena письмо другой организации; действие обязательно попадает в audit log.
8. Никогда не показывать документы одной организации пользователям, не имеющим к ней доступа.

### 11.8. Обработка вложений

Один e-mail может содержать несколько фактур. Правило: **одно поддерживаемое вложение = один DocumentItem**, при этом все документы сохраняют ссылку на общий `inboundEmailId`.

Поддерживаемые типы для первой реальной версии:

- `application/pdf`;
- `image/jpeg`;
- `image/png`;
- опционально `image/tiff` после проверки выбранного OCR pipeline.

Не доверять только расширению файла. Проверять MIME, magic bytes и фактическую возможность открыть документ.

Рекомендуемые лимиты, все через env/config:

```env
MAX_EMAIL_SIZE_MB=30
MAX_ATTACHMENT_SIZE_MB=20
MAX_ATTACHMENTS_PER_EMAIL=20
MAX_PDF_PAGES=50
```

Поведение по edge cases:

- письмо без вложений → `quarantine/no_supported_attachment`;
- повреждённый PDF → `quarantine/corrupted_file`;
- password-protected PDF → `quarantine/password_protected_pdf`;
- неподдерживаемый тип → записать причину и не отправлять в AI extraction provider;
- ZIP/RAR и исполняемые файлы не распаковывать автоматически;
- маленькие inline-логотипы подписи не превращать в документы, если они имеют `Content-ID`, используются в HTML письма и соответствуют безопасной эвристике;
- возможность вручную выбрать ошибочно проигнорированное вложение оставить admin-у;
- оригинальное имя файла хранить отдельно, но для storage key генерировать безопасный UUID;
- имя файла никогда не использовать как путь без sanitization.

### 11.9. Хранение файлов и данных

Не хранить PDF и изображения как большие BLOB-поля в основной БД. Использовать S3-compatible object storage, Azure Blob или эквивалент.

Рекомендуемая схема:

```text
Object storage:
  inbound/{tenantId}/{organizationId}/{inboundEmailId}/raw.eml
  inbound/{tenantId}/{organizationId}/{inboundEmailId}/{attachmentId}/original.pdf
  derived/{tenantId}/{organizationId}/{documentId}/preview-1.webp

PostgreSQL:
  organizations
  organization_email_aliases
  inbound_emails
  inbound_attachments
  processing_jobs / job references
  documents
  extraction_runs
  accounting_suggestions
  supplier_accounting_rules
  document_versions
  audit_logs
  export_batches
```

Файлы выдавать frontend-у только через короткоживущие signed URLs после проверки прав пользователя. Bucket не должен быть public.

Для денежных значений в production backend использовать `DECIMAL/NUMERIC` или integer minor units, а не binary floating point. Frontend `number` допустим для mock Фазы 1, но API-контракт должен передавать точные decimal strings либо согласованный формат minor units.

### 11.10. Разделение статуса обработки и бухгалтерского workflow

Не перегружать `DocumentStatus` техническими деталями. Добавить отдельный processing status:

```ts
type ProcessingStatus =
  | 'received'
  | 'validating'
  | 'queued'
  | 'extracting'
  | 'normalizing'
  | 'ready_for_review'
  | 'failed_retryable'
  | 'failed_permanent';
```

`DocumentStatus` продолжает описывать пользовательский workflow:

```text
novy -> extrahovany -> na_kontrole -> schvaleny -> exportovany
```

Исключения:

```text
chyba | karantena | duplicita | zamietnuty
```

Frontend показывает оба измерения без смешения. Пример:

```text
Stav dokladu: Na kontrolu
Spracovanie: AI extrakcia dokončená
```

### 11.11. Идемпотентность и дубликаты

Различать два типа дубликатов:

1. **Технический дубликат письма/вложения** — provider повторно вызвал webhook или пользователь переслал тот же файл. Проверять по `providerMessageId`, idempotency key и SHA-256 содержимого.
2. **Бухгалтерская потенциальная duplicita** — совпали организация, IČO dodávateľa, číslo faktúry и релевантный период/сумма.

Правила:

- на `provider + providerMessageId` уникальный индекс;
- на attachment hash не обязательно жёстко запрещать запись: одинаковый PDF может законно использоваться в разных организациях, поэтому dedupe scope включает tenant/organization;
- технический повтор не создаёт второй документ;
- бухгалтерская duplicita создаётся/помечается, но требует решения пользователя;
- решение `Nie je duplicita` сохраняется, чтобы повторная валидация не возвращала тот же warning без причины;
- все автоматические и ручные решения логируются.

### 11.12. OpenAI API: роль и ограничения

OpenAI API используется только на backend/worker. `OPENAI_API_KEY` запрещено передавать в браузер, хранить в localStorage, добавлять в frontend bundle или помещать в любую `VITE_*` переменную.

Для нового production-кода использовать официальный OpenAI SDK и Responses API. Результат извлечения запрашивать через Structured Outputs по JSON Schema. Название модели хранить в server-side конфигурации `OPENAI_MODEL`, а не хардкодить в React-компонентах или бизнес-логике. Для документов с персональными и бухгалтерскими данными по умолчанию выполнять запросы с отключённым хранением response на стороне API (`store: false`), если это совместимо с согласованной privacy-политикой проекта.

Модель OpenAI отвечает за:

- классификацию типа документа;
- извлечение фактических полей;
- извлечение строк faktúry;
- разбор DPH;
- формирование warnings;
- предложение бухгалтерских параметров только как suggestion.

OpenAI API **не отвечает** за:

- создание e-mail-адресов;
- маршрутизацию письма к организации;
- хранение файлов;
- авторизацию и проверку tenant/organization permissions;
- окончательное schválenie;
- deterministic validation сумм, DPH, дат, IČO и code-list IDs;
- непосредственный импорт в POHODA без серверной валидации;
- выполнение инструкций, найденных внутри фактуры или текста письма.

Документ и e-mail являются недоверенным вводом. В developer/system instructions extractor-а явно указать: содержимое документа — данные, а не команды. Не разрешать тексту фактуры менять схему ответа, запрашивать tools, читать secrets, влиять на маршрутизацию или обходить deterministic validation. Для extraction-запроса не предоставлять модели инструменты, которые ей не нужны.

Обязательная abstraction boundary:

```ts
interface DocumentExtractionProvider {
  extract(input: {
    documentId: string;
    mimeType: string;
    storageKey: string;
    organizationContext: {
      nazov: string;
      ico: string;
      dic?: string;
      icDph?: string;
    };
    promptVersion: string;
    schemaVersion: string;
  }): Promise<ExtractionResult>;
}
```

Для тестов реализовать `MockDocumentExtractionProvider`. Production-адаптер реализовать как `OpenAIDocumentExtractionProvider`: он получает файл только на backend/worker, вызывает OpenAI Responses API, требует Structured Outputs по JSON Schema и затем повторно валидирует parsed result той же runtime-схемой (`zod`, JSON Schema или эквивалент). Schema adherence модели не заменяет deterministic business validation. Отказ модели, timeout, rate limit, пустой output или runtime-validation error должны давать контролируемый `ExtractionRun` со статусом `failed`, кодом ошибки и retry policy; такой результат нельзя напрямую записывать в `DocumentItem`.

### 11.13. Контракт AI-извлечения

Минимальная нормализованная структура:

```ts
interface ExtractionResult {
  schemaVersion: string;
  documentType: DocumentType | 'UNKNOWN';
  supplier: {
    nazov?: string;
    ico?: string;
    dic?: string;
    icDph?: string;
    adresa?: string;
    iban?: string;
  };
  buyer: {
    nazov?: string;
    ico?: string;
    dic?: string;
    icDph?: string;
    adresa?: string;
  };
  invoiceNumber?: string;
  variableSymbol?: string;
  constantSymbol?: string;
  specificSymbol?: string;
  issueDate?: string;
  taxDate?: string;
  dueDate?: string;
  currency?: 'EUR' | 'CZK' | 'USD' | string;
  lineItems: Array<{
    description?: string;
    quantity?: string;
    unit?: string;
    unitPriceWithoutVat?: string;
    vatRate?: '23' | '19' | '5' | '0' | string;
    amountWithoutVat?: string;
    vatAmount?: string;
    amountTotal?: string;
  }>;
  vatBreakdown: Array<{
    vatRate: string;
    base: string;
    vat: string;
    total?: string;
  }>;
  totalWithoutVat?: string;
  totalVat?: string;
  totalAmount?: string;
  fieldConfidence: Record<string, number>;
  evidence: Record<string, Array<{
    page?: number;
    text?: string;
  }>>;
  warnings: Array<{
    code: string;
    message: string;
    severity: 'info' | 'warning' | 'error';
  }>;
}
```

Требования:

- даты нормализовать в ISO `YYYY-MM-DD` только после проверки;
- исходный текст/значение при необходимости хранить в extraction run для объяснимости;
- confidence хранить на уровне каждого поля, а не только один общий процент;
- evidence используется для подсветки причины, но не должно ломать UI, если provider не вернул координаты;
- structured output AI provider не считается бизнес-валидным, пока не прошёл runtime schema validation и deterministic validation;
- модель, prompt version, schema version, latency, token/cost metadata и результат каждого запуска сохранять в `ExtractionRun`;
- повторная обработка создаёт новый `ExtractionRun`, а не перезаписывает историю;
- manual edits пользователя не перезаписывать новой AI-экстракцией без явного действия `Použiť novú extrakciu`.

### 11.14. Deterministic validation после AI

Backend обязан отдельно проверить:

- формат IČO, DIČ, IČ DPH и IBAN;
- математическую согласованность DPH с допуском 0,02 € на строку;
- сумму строк, VAT breakdown и `sumaSpolu`;
- допустимость дат и логические отношения между ними;
- наличие обязательных полей;
- соответствие buyer IČO выбранной организации;
- дубликаты;
- поддерживаемую валюту и тип документа;
- существование выбранных code-list IDs именно в той же организации;
- что schvaľovaný документ не изменился после последней проверки.

AI не должен сам отменять эти ошибки. Результат deterministic validation имеет приоритет над confidence модели.

### 11.15. Автоматическое предложение zaúčtovania

Из фактуры можно извлечь данные, но `predkontácia` и `členenie DPH` часто зависят от внутренних правил клиента. Поэтому реализовать отдельный `AccountingSuggestionService`.

Источники suggestions в порядке приоритета:

1. активное вручную созданное правило для `organizationId + supplier IČO`;
2. точное правило по supplier IČO + ключевым словам/типу plnenia;
3. последние schválené документы этого поставщика в **той же организации**;
4. defaults организации для типа документа;
5. AI suggestion;
6. оставить поле пустым, если уверенность недостаточна.

Никогда не использовать историю другой клиентской организации для автоматической проводки, даже если supplier тот же.

Структура suggestion:

```ts
type SuggestionSource = 'manual_rule' | 'supplier_history' | 'organization_default' | 'ai' | 'none';

interface AccountingSuggestion {
  documentId: string;
  predkontaciaId?: string;
  clenenieDphId?: string;
  ciselnyRadId?: string;
  strediskoId?: string;
  source: SuggestionSource;
  confidence: number;
  reason: string;
  basedOnDocumentId?: string;
  createdAt: string;
}
```

UI должен явно отличать suggestion от подтверждённого значения:

```text
Navrhnuté podľa posledných 7 schválených faktúr od tohto dodávateľa.
```

Кнопка `Použiť návrh` переносит значения в форму. Можно автоматически предзаполнить поля, но пользователь должен видеть источник и иметь возможность изменить их.

Обучение на исправлениях:

- сохранять разницу между suggestion и schválenным результатом;
- не создавать правило автоматически после одного документа;
- после нескольких повторяющихся подтверждений можно показать admin/účtovník предложение `Vytvoriť pravidlo pre dodávateľa`;
- любое правило создаётся явным действием пользователя и имеет audit trail.

### 11.16. Human-in-the-loop и auto-approval

По умолчанию AI не имеет права окончательно zaúčtovať и экспортировать документ без человека. После успешной обработки документ попадает в `na_kontrole`.

Auto-approval можно рассматривать только в отдельной поздней фазе и только при одновременном выполнении всех условий:

- feature flag `AUTO_APPROVAL_ENABLED=true`;
- организация явно разрешила auto-approval;
- точное совпадение buyer IČO;
- нет duplicate/quarantine/error warnings;
- обязательные поля заполнены;
- DPH и totals сходятся;
- каждый критичный field confidence выше настроенного threshold;
- бухгалтерские параметры получены из стабильного manual rule, а не только из AI;
- сумма ниже лимита организации;
- действие полностью логируется и может быть отменено.

По умолчанию:

```env
AUTO_APPROVAL_ENABLED=false
```

### 11.17. Новые и расширенные модели данных

```ts
type AliasStatus = 'active' | 'grace_period' | 'disabled';
type InboundEmailStatus =
  | 'received'
  | 'queued'
  | 'processed'
  | 'partially_processed'
  | 'quarantine'
  | 'failed';

type AttachmentStatus =
  | 'received'
  | 'ignored_inline'
  | 'stored'
  | 'queued'
  | 'processing'
  | 'document_created'
  | 'duplicate'
  | 'quarantine'
  | 'failed';

interface OrganizationEmailAlias {
  id: string;
  tenantId: string;
  organizationId: string;
  address: string;
  addressNormalized: string;
  localPart: string;
  domain: string;
  slugAtCreation: string;
  token: string;
  status: AliasStatus;
  isPrimary: boolean;
  providerRouteId?: string;
  createdAt: string;
  graceUntil?: string;
  disabledAt?: string;
}

interface InboundEmail {
  id: string;
  tenantId: string;
  organizationId?: string;
  aliasId?: string;
  provider: string;
  providerMessageId: string;
  envelopeRecipients: string[];
  senderEmail?: string;
  senderName?: string;
  subject?: string;
  receivedAt: string;
  status: InboundEmailStatus;
  attachmentCount: number;
  rawMessageStorageKey?: string;
  quarantineReason?: string;
  processingErrorCode?: string;
  processingErrorMessage?: string;
  correlationId: string;
  createdAt: string;
}

interface InboundAttachment {
  id: string;
  inboundEmailId: string;
  organizationId?: string;
  originalFileName: string;
  safeFileName: string;
  declaredMimeType?: string;
  detectedMimeType?: string;
  byteSize: number;
  sha256: string;
  storageKey?: string;
  status: AttachmentStatus;
  documentId?: string;
  quarantineReason?: string;
  createdAt: string;
}

interface ExtractionRun {
  id: string;
  documentId: string;
  provider: 'mock' | 'openai';
  model?: string;
  promptVersion: string;
  schemaVersion: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  result?: ExtractionResult;
  errorCode?: string;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}
```

На всех tenant-owned таблицах обязательны `tenantId` и индексы, предотвращающие cross-tenant доступ. `organizationId` не принимать на доверии только из browser payload: backend проверяет membership/permissions.

### 11.18. Backend/API для Фазы 2

Рекомендуемая структура монорепозитория:

```text
apps/
  web/                 # текущий React frontend
  api/                 # REST API, auth, CRUD, webhook
  worker/              # attachment processing, AI, retries
packages/
  contracts/           # shared DTO + runtime schemas
  db/                  # schema, migrations, repositories
  email/               # provider interface + adapters
  extraction/          # mock/OpenAI adapters
  accounting-rules/    # suggestion engine
  pohoda/              # XML/mServer integration
```

Рекомендуемый production stack, если в репозитории ещё нет backend-решения:

- Node.js + TypeScript;
- Fastify/NestJS или другой единообразный server framework;
- PostgreSQL;
- Prisma/Drizzle или эквивалент с migrations;
- Redis + BullMQ или эквивалентная durable queue;
- S3-compatible object storage;
- OpenAPI для REST-контрактов;
- Entra ID согласно первоначальному плану авторизации;
- Docker Compose для локальных PostgreSQL/Redis/object storage.

Не переносить business logic в контроллеры. Минимальные сервисы:

```text
OrganizationService
EmailAliasService
InboundEmailService
AttachmentService
DocumentProcessingService
ExtractionService
DocumentValidationService
AccountingSuggestionService
ApprovalService
PohodaExportService
AuditLogService
```

Минимальные endpoints:

```http
POST   /api/organizations
GET    /api/organizations
GET    /api/organizations/:id
PATCH  /api/organizations/:id
POST   /api/organizations/:id/archive

GET    /api/organizations/:id/email-aliases
POST   /api/organizations/:id/email-aliases/regenerate
POST   /api/organizations/:id/email-aliases/:aliasId/disable

POST   /api/webhooks/inbound-email/:provider
GET    /api/inbound-emails
GET    /api/inbound-emails/:id
POST   /api/inbound-emails/:id/retry
POST   /api/inbound-emails/:id/assign-organization

GET    /api/documents
GET    /api/documents/:id
PATCH  /api/documents/:id
POST   /api/documents/:id/reprocess
POST   /api/documents/:id/approve
POST   /api/documents/:id/reject
POST   /api/documents/:id/quarantine

POST   /api/exports/pohoda/xml
GET    /api/exports
GET    /api/exports/:id/download
```

Пример создания организации:

```http
POST /api/organizations
Content-Type: application/json

{
  "nazov": "AGS s.r.o.",
  "ico": "12345678",
  "dic": "2020123456",
  "icDph": "SK2020123456",
  "farba": "#0E7A5F"
}
```

Ответ:

```json
{
  "organization": {
    "id": "org_...",
    "nazov": "AGS s.r.o.",
    "ico": "12345678"
  },
  "primaryEmailAlias": {
    "id": "alias_...",
    "address": "ags-k7m4q2@doklady.dokladorpro.sk",
    "status": "active"
  }
}
```

Backend сам генерирует адрес. Обычный create endpoint не принимает полный `emailAlias` от клиента.

### 11.19. UI/UX изменения

#### Создание организации

Форма:

- `Názov organizácie`;
- `IČO`;
- `DIČ`;
- `IČ DPH`;
- `Farba organizácie`;
- optional `Prefix e-mailu` только как предложение slug, без возможности задать токен/домен целиком.

После сохранения показать success panel:

```text
Organizácia bola vytvorená.
E-mail pre prijímanie dokladov:
ags-k7m4q2@doklady.dokladorpro.sk
[ Kopírovať adresu ]
```

Не показывать выдуманный адрес до успешного ответа backend. В Фазе 1 mock API должен вести себя так же асинхронно.

#### E-mailové schránky

Таблица:

| Organizácia | Primárny e-mail | Stav | Posledný e-mail | Správy za 30 dní | Akcie |
|---|---|---|---|---:|---|
| AGS s.r.o. | ags-k7m4q2@... | Aktívny | 10. 7. 2026 14:32 | 18 | Kopírovať / Detail |

Admin detail:

- все active/grace/disabled алиасы;
- дата создания;
- дата отключения;
- provider route status;
- последние inbound messages;
- ошибки и кнопка retry;
- `Vygenerovať nový alias` с подтверждением и объяснением последствий;
- `Simulovať prijatý e-mail` только в demo/dev режиме.

#### Detail dokladu

Добавить секцию `Zdroj`:

- odosielateľ;
- prijímací alias;
- predmet;
- dátum prijatia;
- pôvodný názov súboru;
- inbound message ID;
- кнопка `Zobraziť pôvodný e-mail` с permission check;
- статус processing/extraction;
- кнопка `Spustiť extrakciu znova` для разрешённых ролей.

Показывать field-level confidence. При наличии evidence можно по клику подсветить страницу PDF или хотя бы показать текстовый фрагмент источника.

#### Queue

Добавить фильтры:

- `Zdroj: e-mail / ručné nahratie / manuálne vytvorený`;
- `Spracovanie: čaká / spracúva sa / hotovo / chyba`;
- `Prijaté na e-mail`;
- `Vyžaduje zásah`.

### 11.20. Симуляция входящего письма в Фазе 1

Чтобы проверить весь UX до backend-интеграции, добавить dev/demo flow `Simulovať prijatý e-mail`:

Поля:

- recipient alias (select из active aliases + возможность ввести неизвестный alias для negative test);
- sender;
- subject;
- 1–5 sample attachments;
- scenario: `úspech`, `nízka istota`, `duplicita`, `IČO mismatch`, `poškodený súbor`, `nepodporovaný typ`.

Mock pipeline должен:

1. создать `InboundEmail`;
2. разрешить алиас;
3. создать `InboundAttachment` на каждый sample-файл;
4. для каждого поддерживаемого вложения создать отдельный `DocumentItem`;
5. добавить историю действий;
6. показать toast со ссылкой на документы;
7. для negative scenarios поместить запись в quarantine/error queue;
8. переживать reload через Zustand persist/localStorage;
9. сбрасываться через `Reset demo dát`.

Не делать mock напрямую в компоненте. Использовать `src/data/api.ts` и отдельные сервисы, чтобы UI не менялся при подключении REST.

### 11.21. Безопасность, privacy и audit

Обязательные меры:

- Entra ID/auth middleware и role-based permissions;
- tenant/organization authorization на каждом backend endpoint;
- webhook signature verification и защита от replay;
- rate limits и quotas на tenant/alias;
- MIME sniffing, file size limits, malware scan;
- private object storage и signed URLs;
- encryption in transit и encryption at rest средствами инфраструктуры;
- secrets только в server-side secret manager/env;
- redaction чувствительных данных в logs;
- audit log для создания/архивирования организации, генерации/отключения алиаса, ручного переназначения письма, изменения бухгалтерских полей, schválenia, zamietnutia, экспорта и повторной AI-обработки;
- retention policy для raw e-mail и документов;
- возможность удалить/анонимизировать данные в рамках правовых требований без разрушения обязательного бухгалтерского audit trail;
- договорные и privacy-настройки AI provider должны быть проверены владельцем продукта до production;
- API response не должен раскрывать существование чужого alias/organization.

### 11.22. Ошибки, retry и observability

Каждая цепочка получает `correlationId`, который проходит через webhook, attachment, job, extraction run и document history.

Логи структурированные, без полного содержимого фактур:

```text
correlationId, tenantId, organizationId, inboundEmailId,
attachmentId, documentId, stage, status, errorCode, durationMs
```

Retry policy:

- transient provider/network/AI errors → exponential backoff, ограниченное число попыток;
- permanent validation/file errors → без автоматического бесконечного retry;
- после исчерпания попыток job попадает в dead-letter queue;
- admin/účtovník видит понятную ошибку и кнопку `Skúsiť znova`;
- повторная попытка идемпотентна;
- UI не показывает stack trace или секреты.

Минимальные метрики:

- e-mails received/processed/quarantined;
- attachments processed/failed;
- average extraction latency;
- AI failure rate;
- documents waiting for review;
- duplicate rate;
- cost/usage per tenant, если provider предоставляет metadata.

### 11.23. Исходящие уведомления

Опционально, per organization:

- подтверждение отправителю `Doklad bol prijatý`;
- сообщение об отсутствии поддерживаемого вложения;
- уведомление внутреннему пользователю о quarantine/error;
- уведомление schvaľovateľ-у о новых документах.

Защита от mail loop:

- учитывать `Auto-Submitted`, `Precedence` и собственные message headers;
- не отвечать на auto-replies/bounces;
- не включать чувствительные extracted data в автоматическое письмо;
- outgoing mail вынести в отдельный provider interface.

### 11.24. Связь с POHODA

После `Schváliť` документ включается в существующий flow `/export`.

Дополнительные правила:

- XML строится из immutable approved snapshot/version;
- если schválený документ изменён, он возвращается в `na_kontrole` и исключается из экспорта до нового schválenia;
- экспорт не смешивает организации;
- повторный экспорт требует явного действия и audit record;
- `exportId` и ответ POHODA/mServer в будущей фазе хранятся отдельно;
- direct mServer import не выполняется из browser;
- при mServer интеграции использовать idempotency key, сохранять request/response metadata и не отмечать документ `exportovany`, пока POHODA не подтвердила успешный импорт;
- binary attachment/scan linkage к POHODA реализовать только после проверки поддерживаемого формата и API.

### 11.25. Конфигурация окружения

Минимальный server-side config:

```env
APP_BASE_URL=https://app.dokladorpro.sk
MAIL_RECEIVING_DOMAIN=doklady.dokladorpro.sk
# Только для frontend mock Фазы 1; значение публичное, не secret:
VITE_PUBLIC_MAIL_RECEIVING_DOMAIN=doklady.dokladorpro.sk
EMAIL_PROVISIONING_MODE=catch_all
EMAIL_ALIAS_TOKEN_LENGTH=6
EMAIL_ALIAS_GRACE_DAYS=30
INBOUND_EMAIL_PROVIDER=mock
INBOUND_WEBHOOK_SECRET=change-me

DATABASE_URL=postgresql://...
REDIS_URL=redis://...
OBJECT_STORAGE_ENDPOINT=https://...
OBJECT_STORAGE_BUCKET=dokladovka-private
OBJECT_STORAGE_ACCESS_KEY=...
OBJECT_STORAGE_SECRET_KEY=...

DOCUMENT_EXTRACTION_PROVIDER=mock
OPENAI_API_KEY=...
OPENAI_MODEL=...
OPENAI_STORE_RESPONSES=false
OPENAI_API_TIMEOUT_MS=120000
EXTRACTION_PROMPT_VERSION=invoice-sk-v1
EXTRACTION_SCHEMA_VERSION=1

MAX_EMAIL_SIZE_MB=30
MAX_ATTACHMENT_SIZE_MB=20
MAX_ATTACHMENTS_PER_EMAIL=20
MAX_PDF_PAGES=50
AUTO_APPROVAL_ENABLED=false
```

В repository добавить `.env.example` без реальных secrets. В Фазе 1 frontend может читать безопасный public display domain из `VITE_PUBLIC_MAIL_RECEIVING_DOMAIN`. В Фазе 2 frontend получает готовый alias из API/config endpoint и не конструирует production-адрес самостоятельно. Секретные server env не должны начинаться с `VITE_`.

### 11.26. Edge cases, которые обязательно учесть

- две организации с одинаковым названием;
- очень длинное название;
- название только из спецсимволов/кириллицы;
- изменение названия после выдачи алиаса;
- коллизия token;
- письмо на disabled alias;
- письмо на неизвестный alias;
- письмо сразу на два alias разных организаций;
- forwarded email, где `To` не совпадает с envelope recipient;
- один e-mail с несколькими PDF;
- PDF из нескольких страниц;
- invoice и credit note в одном письме;
- одинаковый PDF, отправленный повторно;
- разные PDF с одинаковым supplier invoice number;
- скан без text layer;
- низкое качество/повёрнутые страницы;
- password-protected/corrupted PDF;
- inline logo и подпись;
- сумма с rounding difference;
- иностранная валюта;
- supplier без IČO;
- buyer IČO другого клиента;
- документ не является фактурой;
- OpenAI API вернул отказ, неполный ответ или результат, не прошедший runtime-валидацию;
- timeout/rate limit AI provider;
- пользователь исправил поля во время повторной extraction;
- document уже экспортирован;
- организация архивирована во время обработки job;
- удалённый/недоступный code-list item;
- webhook provider повторил доставку.

Для каждого case определить ожидаемый status, user-visible message и возможность восстановления.

---

## 12. Фазы реализации нового модуля

### Фаза 1A — текущий frontend-прототип

Реализовать сейчас:

- генератор alias через Web Crypto;
- уникальность в mock store;
- read-only alias в organization CRUD;
- mock `E-mailové schránky`;
- `Simulovať prijatý e-mail`;
- mock inbound e-mail/attachment models;
- mock extraction runs;
- field-level confidence;
- line items;
- processing status;
- service interfaces и TODO integration points;
- сценарий от mock e-mail до schválenia и XML export;
- tests для alias generator и mock routing.

Не делать в browser:

- реальный DNS/MX;
- реальный inbound webhook;
- реальный OpenAI API key/API call;
- antivirus;
- private object storage;
- server auth;
- прямой mServer import.

### Фаза 2A — backend foundation и inbound e-mail

- монорепозиторий/API/worker или интеграция с существующим backend;
- PostgreSQL + migrations;
- object storage;
- durable queue;
- auth/tenant permissions;
- real organization CRUD;
- transaction-safe alias generation;
- inbound provider adapter;
- webhook verification;
- attachment pipeline;
- quarantine, retries, audit, observability;
- frontend переключается с mock API на REST без переписывания компонентов.

### Фаза 2B — OpenAI extraction и accounting suggestions

- production `OpenAIDocumentExtractionProvider` на OpenAI Responses API;
- strict schema validation;
- OCR/fallback pipeline;
- field evidence/confidence;
- deterministic validations;
- supplier rules/history-based suggestions;
- corrections/history;
- cost controls и monitoring;
- human approval remains mandatory.

### Фаза 3 — POHODA integration

- validation against official XSD;
- production XML encoding and schema coverage;
- mServer adapter;
- code-list synchronization;
- idempotent direct import;
- import response handling;
- optional attachment linking;
- reconciliation и error retry.

---

## 13. Definition of Done для e-mail/AI-модуля

### Для Фазы 1 mock

1. Создание `AGS s.r.o.` возвращает адрес вида `ags-xxxxxx@doklady.dokladorpro.sk`.
2. Адрес валиден, уникален и сохраняется после reload.
3. Переименование организации не меняет адрес.
4. Regenerate создаёт новый primary alias, а старый получает ожидаемый mock-status.
5. Симуляция письма на alias AGS создаёт документы только в AGS.
6. Один e-mail с тремя PDF создаёт три документа с общим `inboundEmailId`.
7. Неизвестный alias не создаёт документ в случайной организации.
8. Buyer IČO mismatch приводит к `karantena`.
9. Повтор одного и того же mock attachment даёт технический duplicate без второго документа.
10. Низкий confidence и missing fields видны пользователю.
11. AI suggestion визуально отделён от подтверждённого zaúčtovania.
12. После ручной правки и schválenia документ доступен в Export.
13. Build и tests проходят.

### Для Фазы 2 production

1. Новая организация и alias создаются одной согласованной операцией; коллизия безопасно повторяется.
2. Реальное письмо проходит provider webhook, signature verification и idempotency.
3. Файл хранится privately, доступен только через authorized signed URL.
4. Не менее одного supported attachment создаёт отдельный processing job.
5. AI response проходит strict schema и deterministic validation.
6. Ошибки provider/AI повторяются по policy и попадают в DLQ после исчерпания попыток.
7. Unknown/disabled/ambiguous alias и buyer IČO mismatch не приводят к cross-org leakage.
8. User видит понятный status, error и retry action.
9. Secrets отсутствуют в frontend bundle и logs.
10. Audit log покрывает все критические действия.
11. Schválenie требует валидных бухгалтерских полей и totals.
12. POHODA XML использует approved snapshot и не смешивает организации.
13. Интеграционные и E2E tests покрывают happy path и обязательные edge cases.

---

## 14. Обновлённый kickoff-промпт для OpenAI Codex

Ниже — текст, который можно вставить как первую задачу в Codex после открытия корня репозитория:

> Сначала прочитай все применимые `AGENTS.md` / `AGENTS.override.md`, затем `README`, `package.json`, lockfile, существующую структуру каталогов и весь файл `SPEC-dokladovka_3_email_ai_Codex.md` в корне репозитория. Разделы 11–13 обязательны и имеют приоритет при конфликте с более ранними требованиями по организациям, e-mail-алиасам, inbound pipeline, AI и POHODA.
>
> Перед изменениями проведи аудит существующего репозитория. Определи:
> 1. что уже реализовано и реально работает;
> 2. что является mock/demo;
> 3. какие данные сейчас живут только в Zustand/localStorage;
> 4. где находится async data/service boundary;
> 5. какие build, lint, typecheck и test scripts доступны;
> 6. какие требования спецификации ещё не закрыты.
>
> Не перескаффолдивай существующий проект, не удаляй рабочий код, не меняй package manager и не заменяй lockfile без необходимости. Адаптируй репозиторий минимальными последовательными изменениями. Если находишь расхождение между спецификацией и текущей реализацией, сначала зафиксируй его в кратком плане, затем выбери безопасный вариант, совместимый с разделами 11–13.
>
> Для текущей Фазы 1 реализуй frontend-прототип полностью: mock-генерацию уникального e-mail-алиаса при создании организации, read-only отображение и копирование адреса, mock lifecycle алиасов, экран `E-mailové schránky`, сценарий `Simulovať prijatý e-mail`, модели `InboundEmail`, `InboundAttachment`, `ExtractionRun`, отдельный `ProcessingStatus`, по одному `DocumentItem` на каждое поддерживаемое вложение, field-level confidence, line items, mock accounting suggestions, quarantine/duplicate/IČO mismatch и полный путь до schválenia и XML-экспорта. Все операции проводи через async data/service layer; React-компоненты не должны знать, используется mock или REST.
>
> Не вызывай OpenAI API из browser и не добавляй `OPENAI_API_KEY` либо другой secret в `VITE_*`, localStorage, frontend source или bundle. В Фазе 1 создай только provider interfaces, mock adapters и явные `// TODO: integration point`. Production `OpenAIDocumentExtractionProvider` относится к Фазе 2B и должен работать только на backend/worker через OpenAI Responses API и Structured Outputs с последующей runtime и deterministic validation.
>
> Порядок работы для Фазы 1:
> 1. types и runtime validation schemas;
> 2. alias generator + unit tests;
> 3. organization CRUD и alias UI;
> 4. inbound mock models/store/API;
> 5. `Simulovať prijatý e-mail`;
> 6. routing, attachments, duplicate/quarantine scenarios;
> 7. detail source/extraction UI;
> 8. accounting suggestions и schválenie;
> 9. export;
> 10. dashboard/settings polish;
> 11. build, tests и ручной happy-path.
>
> После каждого логического этапа кратко сообщай: какие файлы изменены, какие требования закрыты, какие команды фактически запущены и каков их результат. Не утверждай, что build/test прошёл, если команда не была выполнена. При падении проверки исправь причину либо явно опиши блокирующую внешнюю зависимость.
>
> Соблюдай UI только на словацком, дизайн-токены из раздела 8, accessibility, tenant/org boundaries на уровне моделей и отсутствие hardcoded domain. Все display-адреса брать из данных. Используй `VITE_PUBLIC_MAIL_RECEIVING_DOMAIN` только как безопасный public mock/display config в Фазе 1. В Фазе 2 `MAIL_RECEIVING_DOMAIN` остаётся server-side, а frontend получает готовые адреса из API.
>
> Не добавляй новые production-зависимости без необходимости. Для каждой новой зависимости объясни назначение и используй уже установленную альтернативу, если она покрывает задачу. Сохраняй focused diff, не форматируй несвязанные файлы и не меняй публичные контракты без обновления типов, runtime schemas и tests.
>
> В конце задачи выдай: summary, список изменённых файлов, выполненные проверки с результатами, ручной сценарий проверки и отдельный список оставшихся production TODO для Фаз 2A, 2B и 3.

### Отдельная задача для перехода к Фазе 2A

Когда Фаза 1 полностью проходит build/tests, запусти в Codex новую задачу:

> Фаза 1 frontend-прототип завершена. Теперь начни Фазу 2A согласно разделам 11–13 `SPEC-dokladovka_3_email_ai_Codex.md`.
>
> Сначала выполни аудит текущего репозитория и подготовь короткий implementation plan с зависимостями и рисками. Затем создай или адаптируй production-like архитектуру без переписывания UI:
> - `apps/web` — существующий React frontend;
> - `apps/api` — REST API, auth boundary, CRUD и inbound e-mail webhook;
> - `apps/worker` — фоновые jobs, attachment processing и retries;
> - `packages/contracts` — shared DTO + runtime schemas;
> - `packages/db` — schema, migrations и repositories;
> - `packages/email` — provider interface + mock adapter;
> - `packages/extraction` — mock adapter и interface для будущего OpenAI provider;
> - `packages/accounting-rules`;
> - `packages/pohoda`.
>
> Локальная инфраструктура должна запускаться через Docker Compose и включать PostgreSQL, Redis и S3-compatible private object storage. На первом проходе оставь `INBOUND_EMAIL_PROVIDER=mock` и `DOCUMENT_EXTRACTION_PROVIDER=mock`; не подключай реальный почтовый provider и не вызывай OpenAI API.
>
> Frontend не переписывай. Реализуй переключаемый data adapter `mock | rest` через environment configuration. Добавь migrations, health endpoints, transaction-safe alias generation, idempotency, correlationId, audit log, private object storage abstraction, queue abstraction и минимальные integration tests. После каждого этапа запускай доступные lint/typecheck/tests/build и сообщай фактический результат.
