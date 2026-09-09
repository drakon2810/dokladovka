# Аудит AI-бухгалтера Dokladovka

Дата: 9 сентября 2026 года, Europe/Bratislava. Ветка: main. Аудируемый коммит: e6f70c94c11bbce31ba9aa7828426b917c648686. Все номера строк и цитаты ниже сверены с содержимым этого коммита через git show.

Доступ: исходный код проекта, спецификации SPEC-dokladovka_3_email_ai_Codex.md и SPEC-dokladovka_4_pohoda_Codex.md, AUDIT-digitoo-parity.md, сохранённые результаты SELECT из PostgreSQL этой же аудиторской задачи, официальные правовые источники. Обследованы ucto_historia, ucto_dennik, ucto_kategorie, ucto_pravidla, ucto_decisions, ucto_opravy, ucto_presnost, documents, extraction_runs, accounting_suggestions, partners, code_list_items и organizations. Доступ к исходной POHODA, полной выгрузке MDB/XML, договорам лизинга, cestovné príkazy и оригиналам диагностических документов в этом этапе не подтверждён.

Снимок, фактически возвращённый сервером: 2026-09-09 11:24:26.507685+00 [Q02](#q02). Запросы выполнялись последовательно, а не в единой общей транзакции снимка. В журнале есть как завершённые SELECT, так и незавершённые пакеты; они разграничены в приложении A. Повторные обращения при подготовке файла не достигли PostgreSQL: SSH завершился ошибкой проверки ключа хоста, при явном пути также отказом доступа к identity file. Старые результаты восстановлены из журналов этой же задачи, а не выданы за новые измерения.

Рабочее дерево первоначально было чистым. Во время подготовки отчёта обнаружены внешние незакоммиченные изменения server/services/accountingSuggestionService.ts и server/workerService.ts: передача sadzbyRozpisu и zhrnutie в предложение. Это уже направленное исправление описанной ниже потери данных, но его выполнение и результат на документах здесь не проверены. При финальной проверке также изменён извне server/services/accountingSuggestionService.test.ts. Эти файлы аудит не менял. Отчёт описывает указанный коммит; его диагноз нельзя автоматически переносить на последующее рабочее дерево или deployment.

Единственная запись аудитора — этот новый файл. Миграции, DML, вызовы AI с сохранением результата, пересборка памяти, экспорт в POHODA, тесты и build с файловыми артефактами не запускались в рамках подготовки файла. Выполнены чтение кода и журналов, read-only SQL, чистая проверка функции в памяти, проверка правовых первоисточников и сверка цитат с коммитом. Команды, способные менять рабочие данные, не предлагаются как уже выполненная проверка. Локальная сверка использовала git status --short с --no-optional-locks, git rev-parse HEAD, git ls-files, git show и git diff; SQL и его результаты приведены в приложении A. Ручные сценарии будущей проверки и оставшиеся TODO описаны при каждой причине и в приложении B.

## Итог в пяти строках

Основная масса истории относится к OZ и INT, поэтому развитие нужно начинать с представления обязательств, расчётов и связанных бухгалтерских документов.
Система теряет сведения ещё до модели и ограничивает выбор predkontácie, поэтому сначала нужно восстановить полноту данных и гарантировать доступность всех счетов выбранной формы.
Память формы подчинена устойчивости hlavička и недавним примерам контрагента, поэтому форму следует учить отдельно и выбирать по условиям конкретной операции.
Формат предложения умеет назначать и делить существующие položky, но для лизинга, zúčtovanie и samozdanenie нужен проверяемый план объединения, расчёта и связанных документов.
Закон уже упомянут в промпте, однако единый арбитраж после всех правил отсутствует, поэтому правовые ограничения и бухгалтерские инварианты должны проверяться до утверждения и экспорта.

## Диагноз

### Что является корпусом и охватом

В ucto_historia находятся 25952 строки [Q02](#q02). Документ здесь — сочетание tenant, organization, agenda и doklad_cislo IS NOT NULL: 9947 из 9947 (100,00 %) [Q14](#q14), [C01](#c01). Начальное число history_docs из Q02 включает группы без номера; это не тот знаменатель. Строка hlavička, legacy-строка с NULL-индексом, бухгалтерская detail-строка и печатная položka не взаимозаменяемы. Дубли hlavička обнаружены у 4059 из 9947 (40,81 %), но дубли положительных detail-позиций не обнаружены; расхождение кодов DPH/KV между hlavička есть у 10 из 9947 (0,10 %) [Q16](#q16), [C01](#c01).

| Область | Документов | Доля корпуса | Источник |
|---|---:|---:|---|
| OZ | 2961 | 29,77 % | Q23, C01 |
| INT | 2553 | 25,67 % | Q23, C01 |
| FP вместе с FP-D | 2816 | 28,31 % | Q23, C01 |
| FV вместе с FV-D | 1075 | 10,81 % | Q23, C01 |
| VPD и PPD | 542 | 5,45 % | Q23, C01 |

OZ и INT вместе: 5514 из 9947 (55,43 %). Это подтверждает приоритет этих agendy. Но доли разделённых документов из постановки не подтверждены: положительные detail-строки вообще имеются у 1140 из 2961 (38,50 %) OZ и 2014 из 2553 (78,89 %) INT [Q23](#q23), [C01](#c01). Даже наличие detail ещё не означает многокомпонентный rozpis. Число таких разбивок по каждой agenda, число незарплатных INT и число лизинговых/командировочных OZ новым запросом измерить не удалось. Нельзя подменять эти величины количеством всех строк одной agenda.

Кассовые примеры ниже относятся только к PD. Формулировка «3 % корпуса» из задания не воспроизводится на знаменателе документов: измерено 5,45 % для VPD + PPD. Низкий приоритет чеков по сравнению с OZ + INT сохраняется. Отдельная выборка documents содержит 125 документов [Q05](#q05); её проценты нельзя переносить на исторический корпус.

В таблице «затронуто» означает измеренное наличие ограничения или принадлежность к группе риска, а не доказанное количество неверных проводок. Охваты пересекаются, складывать строки таблицы нельзя. Сначала приведён исторический охват по убыванию, затем текущая выборка и причины без измеренного числа документов. Статистика и проценты имеют SQL-основание в приложении A; C01 — фактически выполненный SELECT только в памяти над сохранёнными результатами. Номера строк, UUID, реквизиты норм, коды счетов и константы из цитируемого кода являются идентификаторами и параметрами, а не замерами корпуса.

| # | Причина | Где (файл:строка / функция) | Затронуто документов | Уверенность |
|---|---|---|---|---|
| 1 | В памяти отсутствуют sadzba DPH и stredisko | agent/src/Dokladovka.Agent/PohodaXml.cs:179; Q22 | 9947; 100,00 % имеют неполные атрибуты, ошибка проводки не посчитана | измерено; механизм выведен из кода |
| 2 | Предельная ponuka отрезает часть допустимых predkontácie | server/services/accountingSuggestionService.ts:184 / zuzPonukuPredkontacii | 8680; 87,26 % попадают под cap; потеря правильного кандидата отдельно не измерена | измерено; выведено из кода |
| 3 | Нет сохранённого правила по ключу agenda + имя контрагента | server/services/uctoPravidlaService.ts:122 / odvodPravidlo | 7075; 71,13 %; отсутствие правила не равно ошибке | измерено |
| 4 | Отсутствуют исторические detail-строки для обучения формы | ucto_historia.riadok_index; Q14 | 5684; 57,14 % | измерено |
| 5 | Общий INT смешан с MZDY и исключён из DPH audit | server/services/uctoHistoryService.ts:227; server/services/dphAuditService.ts:344 | 2553; 25,67 % в общей группе INT; число неправильных результатов неизвестно | измерено для группы; выведено из кода для ограничения |
| 6 | Один пример или несовпадающие последние формы объявляются повторяемой практикой | server/services/accountingSuggestionService.ts:1328 / najdiRozuctovanie | 2490; 25,03 % в соответствующих группах по имени | измерено для групп; влияние на решение — гипотеза |
| 7 | Устойчивая форма отбрасывается вместе с неустойчивой hlavička | server/services/uctoPravidlaService.ts:129 | 677; 6,81 % в группах, из них 234 с разными predkontácie detail | измерено чистой функцией над SELECT; ограничение архива Q21 |
| 8 | Разбиение только по DPH/KV не проходит критерий разных predkontácie | server/services/accountingSuggestionService.ts:1328; server/services/uctoKategoriaRozpis.ts:67 | 64; 0,64 % | измерено; выведено из кода |
| 9 | Предложение не адресует хвост длинного документа | server/workerService.ts:695; server/services/accountingSuggestionService.ts:1704 | 43; 0,43 % исторических INT — потенциальный охват; отдельно 2 из 125 текущих FP | измерено для длины; историческое влияние — гипотеза |
| 10 | Извлечённые summary и rozpis DPH не доходят до предложения | server/services/accountingSuggestionService.ts:1716 | 9 из 125; 7,20 % без položky, но со сводкой; 3 из 125 с DPH | измерено; выведено из кода; внешнее исправление замечено |
| 11 | Нет общего языка расчёта и ostatná pohľadávka в маршруте разделения | server/services/accountingSuggestionService.ts:982; server/pohodaXml.ts:104 | Не измерено; особенно существенно для OZ/INT, лизинга и авансов | выведено из кода; массовость конкретных сценариев — гипотеза |
| 12 | Неполный договор между слоями для DPH/KV и правового арбитража | agent/src/Dokladovka.Agent/BackendClient.cs:32; server/services/accountingSuggestionService.ts:1899 | Число документов не измерено; kv_section отсутствует у всех проверенных členení DPH | измерено для справочника; выведено из кода |
| 13 | Ограниченная выгрузка denník и неполная диагностика полноты | agent/src/Dokladovka.Agent/PohodaXml.cs:166 / BuildDennikRequest | Не измерено | выведено из кода; фактическая потеря — гипотеза |
| 14 | Проверка качества не устанавливает точность всей формы | server/services/uctoPresnostService.ts:263 | Число неверных результатов не измерено; пары для проверки описаны ниже | выведено из кода |

### 1. В истории нет атрибутов для различения бухгалтерских режимов

**Механизм.** Импорт сохраняет текст, суммы и коды, но в проверенном представлении строки Mostík нет sadzba DPH и stredisko. Сопоставление с прошлым по ставке не работает, если ставка отсутствует во всей истории; stredisko также нельзя выучить из отсутствующего признака. Из отсутствия этих полей не следует, что каждый документ требует отдельного stredisko или что режим DPH невозможно вывести из других данных.

**Доказательство.** В [Q22](#q22) все строки имеют NULL для проверенных атрибутов; исходный контроль [Q02](#q02) также вернул with_rate = 0, with_stredisko = 0. Проверенное представление строки:

agent/src/Dokladovka.Agent/PohodaXml.cs:179 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
179:     public sealed record HistoryRow(
180:         string Agenda,
181:         string? DokladCislo,
182:         string? Datum,
183:         string? SupplierIco,
184:         string? SupplierName,
185:         string LineText,
186:         string? PredkontaciaKod,
187:         string? ClenenieDphKod,
188:         string? ClenenieKvKod,
189:         /// <summary>0 = hlavička dokladu, 1..n jeho položky. Ide do odtlačku
190:         /// riadka na serveri; bez neho by položka dostala poradie podľa pozície
191:         /// v dávke a pri prvom doklade by kolidovala s vlastnou hlavičkou.</summary>
192:         int? RiadokIndex = null,
193:         /// <summary>Základ a DPH položky. Bez nich sa pomer rozúčtovania nedá
194:         /// prečítať a krátenie odpočtu (PHM 50 %) z podielu základu nevyplýva.</summary>
195:         decimal? Suma = null,
196:         decimal? SumaDph = null);
197: 
198:     /// <summary>
```

**Охват.** 9947 из 9947 (100,00 %) исторических документов имеют эту неполноту; доля ошибочных решений не измерена [Q14](#q14), [Q22](#q22), [C01](#c01).

**Что чинит.** Передавать происхождение, ставку и смысл суммы, stredisko и доступные аналитики от источника до хранилища и предложения. Не восстанавливать отсутствующую ставку по одному названию predkontácia.

**Что сломает.** Неверная нормализация gross/net или смешение старого и нового импорта создаст ложную точность и дубли. До внедрения на сохранённой истории можно проверить уникальность ключей и конфликты кодов; корректность новых полей потребует сопоставления с исходным XML/MDB, которого здесь не было. Это условие приёмки, а не выполненная проверка.

### 2. Модель не может выбрать predkontácia, которой нет в ponuka

**Механизм.** Сначала ограничения agenda формируют допустимые predkontácie, затем лексическое ранжирование и предельный размер сокращают ponuka. Счета из некоторых примеров защищены повышенным баллом, но все счета rozpis категории и правила напрямую в эту защиту не включены. Если самих защищённых кандидатов больше лимита, окончательное обрезание действует и на них. Валидатор затем запрещает любой отсутствующий ID.

**Доказательство.**

server/services/accountingSuggestionService.ts:184 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
184: const MAX_PREDKONTACII_V_PONUKE = 25;
185: 
186: /** Modelu sa neposiela celý účtovný rozvrh (stovky predkontácií) — ponuka sa
187:  *  zúži na riadky podobné textu položiek, zjednotené s predkontáciami vybraných
188:  *  príkladov (príklad s ID mimo ponuky by model nemohol nasledovať). Predtým tu
189:  *  bol spoločný LIMIT 300 cez všetky číselníky: kinds sa radia abecedne, takže
190:  *  predkontácie dostali len zvyšok kvóty a správna často v ponuke vôbec nebola. */
191: export function zuzPonukuPredkontacii<T extends { id: string; kod: string; nazov: string }>(
192:   vsetky: T[],
193:   lineText: string,
194:   priklady: PodobnyPriklad[],
195:   /** Účty zhodných kategórií plnení — musia byť v ponuke, inak ich model nemôže vybrať. */
196:   dalsieIds: Array<string | undefined> = [],
197: ): T[] {
198:   if (vsetky.length <= MAX_PREDKONTACII_V_PONUKE) return vsetky;
199:   const zPrikladov = new Set([
200:     ...priklady.map((priklad) => priklad.predkontaciaId),
201:     ...dalsieIds,
202:   ].filter(Boolean));
203:   return vsetky
204:     .map((item) => ({
205:       item,
206:       // Predkontácie z príkladov majú prednosť pred akoukoľvek textovou zhodou.
207:       skore: zPrikladov.has(item.id) ? 1.1 : textSimilarity(lineText, `${item.kod} ${item.nazov}`),
208:     }))
209:     .sort((a, b) => b.skore - a.skore)
210:     // Bez tokenovej zhody radšej prvých N než prázdna ponuka — model vráti null.
211:     .slice(0, MAX_PREDKONTACII_V_PONUKE)
212:     .map((row) => row.item);
```


server/services/accountingSuggestionService.ts:1590 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
1590:   const dennik = await najdiDennik(database, input, lineText, documentContext.documentType,
1591:     protistranaKontextu, documentContext.historiaDoDatumu);
1592:   // Účtovný denník vidí to, čo hlavičkový korpus stratil: že doklady tejto
1593:   // protistrany firma spravidla rozpisuje na viac nákladových účtov.
1594:   const rozdelenie = await najdiRozdelenie(database, input, protistranaKontextu, documentContext.historiaDoDatumu);
1595:   // Ako táto protistrana naposledy rozúčtovaná bola — s číslami, nie len s kódmi.
1596:   const rozuctovanie = await najdiRozuctovanie(
1597:     database, input, protistranaKontextu, documentContext.documentType, documentContext.historiaDoDatumu);
1598:   // Pravidlo protistrany: to isté, čo je v rozúčtovaní, ale zhrnuté cez všetky
1599:   // doklady a spočítané bez modelu. Účtovník si ho vie prečítať a opraviť.
1600:   const pravidloProtistrany = await najdiPravidlo(
1601:     database, input, HISTORIA_AGENDY[documentContext.documentType] ?? [], protistranaKontextu,
1602:     documentContext.historiaDoDatumu);
1603:   // Model nevie účtovať na účet — vyberá predkontáciu. Ku každému účtu rozpadu
1604:   // preto idú predkontácie, ktoré na tento účet účtujú; bez nich by mu ostalo
1605:   // len číslo účtu, ktoré v číselníku nemá čo vybrať.
1606:   const rozdelenieUcty = (rozdelenie?.ucty ?? []).map((ucet) => ({
1607:     ucet,
1608:     predkontacie: codeLists.rows
1609:       .filter((row) => row.kind === 'predkontacie' && String(row.ucet_md ?? '').trim() === ucet)
1610:       .map((row) => ({ id: row.id, kod: row.code, nazov: row.name })),
1611:   })).filter((polozka) => polozka.predkontacie.length > 0);
1612:   const predkontacie = zuzPonukuPredkontacii(
1613:     vsetkyPredkontacie, lineText, priklady,
1614:     [...kategorie.map((kategoria) => kategoria.predkontacia_id),
1615:       ...dennik.map((riadok) => riadok.predkontaciaId),
1616:       // Predkontácie účtov rozpadu musia v ponuke ostať, inak by model dostal
1617:       // pokyn rozdeliť doklad a nemal by na čo — textová podobnosť ich nenájde,
1618:       // reprezentácia sa v popise položky spravidla nespomína.
1619:       ...rozdelenieUcty.flatMap((polozka) => polozka.predkontacie.map((item) => item.id)),
1620:       // A rovnako predkontácie z rozúčtovania protistrany. V praxi ich ponuke
1621:       // dodá už denník tej istej protistrany, takže to nič neopravuje — ale
1622:       // závisieť na tom je krehké: dôkaz a ponuka majú sedieť z definície, nie
1623:       // náhodou.
1624:       ...rozuctovanie.map((riadok) => riadok.predkontaciaId as string | undefined)],
1625:   );
```

**Охват.** 8680 из 9947 (87,26 %) исторических документов принадлежат фирме/agenda, где срабатывает cap [Q25](#q25), [Q26](#q26), [C01](#c01). Это потенциальная недоступность части справочника, не измерение recall правильного счёта. В AGS для PD до cap доступны 61 predkontácia, отсекаются 36 [Q25](#q25); для OZ и INT ограничение также действует, поэтому механизм не кассовый.

**Что чинит.** Формировать обязательное замыкание выбранного rozpis: каждый используемый счёт должен разрешаться в допустимый ID той же фирмы и нужной agenda и гарантированно попадать в ponuka. Отдельно подбирать ограниченное число альтернатив по содержанию операции. При переполнении формы не обрезать её молча, а показывать конфликт выбора.

**Что сломает.** Расширение ponuka может добавить счета чужой agenda и увеличить неоднозначность. До внедрения воспроизвести отбор на исторических документах, отдельно измеряя наличие всех утверждённых ID и правильность окончательного выбора; удержать tenant, organization, направление и podtyp. По Q25 нельзя утверждать, что простое увеличение лимита уже решило бы ошибки.

### 3. Доступность памяти зависит от hlavička и от факта построения правил

**Механизм.** Правило строится только при достаточном числе документов и hlavičky, наличии доминирующей predkontácia и прохождении порога её частоты. Ветви с возвратом undefined не оставляют модели ни объяснения отказа, ни самостоятельной формы. Отдельно существуют группы, проходящие эти условия, но без сохранённого правила; причина отсутствия запуска/сохранения не установлена.

**Доказательство.**

server/services/uctoPravidlaService.ts:18 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
18: export const MIN_DOKLADOV = 3;
19: /** Akú prevahu musí mať väčšinová hlavička, aby sa zapísala ako pravidlo. */
20: const MIN_ZHODA = 0.6;
21: 
22: export interface PravidloRiadok {
23:   text: string;
24:   predkontaciaKod?: string;
25:   clenenieDphKod?: string;
26:   clenenieKvKod?: string;
27:   /** Podiel na sume dokladu, keď je ustálený — napr. 0,8 a 0,2 pri PHM. */
28:   podiel?: number;
29: }
30: 
```


server/services/uctoPravidlaService.ts:122 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
122: function odvodPravidlo(doklady: Map<string, Riadok[]>): Omit<UctoPravidlo, 'id' | 'agenda' | 'protistrana'> | undefined {
123:   if (doklady.size < MIN_DOKLADOV) return undefined;
124:   const hlavicky = [...doklady.values()]
125:     .map((riadky) => riadky.find((riadok) => riadok.riadokIndex === 0))
126:     .filter((riadok): riadok is Riadok => Boolean(riadok));
127:   if (hlavicky.length < MIN_DOKLADOV) return undefined;
128:   const predkontacia = prevaha(hlavicky.map((riadok) => riadok.predkontaciaKod));
129:   if (!predkontacia.hodnota || predkontacia.pocet < hlavicky.length * MIN_ZHODA) return undefined;
130:   const polozky = [...doklady.values()]
131:     .map((riadky) => riadky.filter((riadok) => riadok.riadokIndex > 0))
132:     .filter((riadky) => riadky.length > 0);
133:   return {
134:     protistranaIco: hlavicky.find((riadok) => riadok.ico)?.ico,
135:     dokladov: hlavicky.length,
136:     zhoda: predkontacia.pocet,
137:     predkontaciaKod: predkontacia.hodnota,
138:     clenenieDphKod: prevaha(hlavicky.map((riadok) => riadok.clenenieDphKod)).hodnota,
139:     clenenieKvKod: prevaha(hlavicky.map((riadok) => riadok.clenenieKvKod)).hodnota,
140:     rozpis: polozky.length >= MIN_DOKLADOV ? odvodRozpis(polozky) : [],
141:   };
```

**Охват.** При точном сопоставлении tenant, organization, исходной agenda и нормализованного имени сохранённое правило есть у 2872 из 9947 (28,87 %), отсутствует у 7075 из 9947 (71,13 %) [Q19](#q19), [C01](#c01). Порог числа документов отсеивает группы с 1298 из 9947 (13,05 %); отсутствие предконтировки hlavička — с 1242 из 9947 (12,49 %); недостаточное доминирование — с 3481 из 9947 (35,00 %). Эти категории описывают конкретный запрос с нормализованным именем, а не полную имитацию runtime-поиска по IČO или имени. Поиск по IČO и другой допустимой agenda может найти правило для части документов вне этого точного сопоставления; фактическую доступность правила для каждого runtime-вызова эти числа не устанавливают. Проходящие фильтры группы RCI и Recable без сохранённого правила охватывают 577 из 9947 (5,80 %); почему правила не построены, остаётся гипотезой.

**Что чинит.** Сохранять раздельные результаты «устойчивость hlavička», «варианты формы» и «почему свидетельств недостаточно»; показывать состояние построения памяти по каждой фирме. Группа без надёжной hlavička должна оставаться пригодной для анализа формы.

**Что сломает.** Принудительное создание правила в слабой группе превратит случайность в норму. Проверять изменение на временном разделении истории, отдельно по устойчивым и смешанным контрагентам. Порог поддержки не снижать без проверки: FastSpring уже достигает модели через другую ветку [Q12](#q12); снижение MIN_DOKLADOV не устраняет этот обход.

### 4. Для значительной части корпуса форма вообще не сохранена

**Механизм.** Legacy-записи и подтверждения без detail дают память hlavička, а не распределение по položky. Отсутствующую форму нельзя восстановить ни большим контекстом, ни другим поиском. В RCI и Recable проверенная история целиком без положительных detail-индексов [Q14](#q14). Отдельно наличие категории не означает наличие её rozpis.

**Доказательство.** Функция выбирает только положительные индексы для формы и требует достаточного числа таких документов:

server/services/uctoPravidlaService.ts:122 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
122: function odvodPravidlo(doklady: Map<string, Riadok[]>): Omit<UctoPravidlo, 'id' | 'agenda' | 'protistrana'> | undefined {
123:   if (doklady.size < MIN_DOKLADOV) return undefined;
124:   const hlavicky = [...doklady.values()]
125:     .map((riadky) => riadky.find((riadok) => riadok.riadokIndex === 0))
126:     .filter((riadok): riadok is Riadok => Boolean(riadok));
127:   if (hlavicky.length < MIN_DOKLADOV) return undefined;
128:   const predkontacia = prevaha(hlavicky.map((riadok) => riadok.predkontaciaKod));
129:   if (!predkontacia.hodnota || predkontacia.pocet < hlavicky.length * MIN_ZHODA) return undefined;
130:   const polozky = [...doklady.values()]
131:     .map((riadky) => riadky.filter((riadok) => riadok.riadokIndex > 0))
132:     .filter((riadky) => riadky.length > 0);
133:   return {
134:     protistranaIco: hlavicky.find((riadok) => riadok.ico)?.ico,
135:     dokladov: hlavicky.length,
136:     zhoda: predkontacia.pocet,
137:     predkontaciaKod: predkontacia.hodnota,
138:     clenenieDphKod: prevaha(hlavicky.map((riadok) => riadok.clenenieDphKod)).hodnota,
139:     clenenieKvKod: prevaha(hlavicky.map((riadok) => riadok.clenenieKvKod)).hodnota,
140:     rozpis: polozky.length >= MIN_DOKLADOV ? odvodRozpis(polozky) : [],
141:   };
```

Фактические поля no_items и detail-распределение приведены полностью в [Q14](#q14), [Q22](#q22). Активные категории с непустым массивом rozpis: AGS 4 из 19, ALPINA 9 из 59, SLO 14 из 56, RCI 0 из 12, Recable 0 из 30 [Q05](#q05). Это подтверждённый замер; ранний вариант Q04 ошибочно считал JSON null как наличие формы и заменён корректным Q05.

**Охват.** Без detail — 5684 из 9947 (57,14 %). Категорий с формой — 27 из 176 (15,34 %); с вектором — 134 из 176 (76,14 %), это доли категорий, а не документов [C01](#c01).

**Что чинит.** Отделить полноту импорта от качества вывода формы; переносить подтверждённые строки с происхождением и идентификаторами источника, а не только hlavička. Показывать «история без строк» как отсутствие свидетельств.

**Что сломает.** Смешение hlavička с detail искусственно увеличит поддержку и исказит суммы. До внедрения использовать Q14 и Q16 как контроль исходной структуры, сравнить повторный импорт с теми же ключами и сверить суммы с первоисточником. На имеющейся БД можно доказать неполноту, но нельзя доказать, что каждый документ без detail действительно был разделён бухгалтером.

### 5. INT достижим, но его смысл расходится между слоями

**Механизм.** Историческая agenda INT сопоставлена documentType MZDY. Редактор предлагает этот же тип как общий interný doklad, экспорт умеет intDoc; следовательно, тезис «INT невозможно создать» неверен. Однако классификация понимает MZDY как зарплатный документ, а DPH audit пропускает этот тип целиком. Незарплатный INT теряет предназначенную ему автоматическую проверку. Samozdanenie дополнительно вынесено промптом в ручной связанный документ.

**Доказательство.**

server/services/uctoHistoryService.ts:213 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
213:   }
214:   return { imported, duplicates: resolved.length - imported, bezKodu };
215: }
216: 
217: /**
218:  * Agenda korpusu podľa typu dokladu, z ktorého rozhodnutie vzniklo. Pokladňa
219:  * nesie smer v zaúčtovaní dokladu, nie v type — bez neho by príjem a výdaj
220:  * skončili v jednej hromade.
221:  */
222: export function agendaZTypuDokladu(documentType: unknown, pokladnaTyp: unknown): string {
223:   switch (String(documentType ?? '')) {
224:     case 'FP': return 'FP';
225:     case 'FV': return 'FV';
226:     case 'OZ': return 'OZ';
227:     case 'MZDY': return 'INT';
228:     case 'BV': return 'BV';
229:     case 'PD': return String(pokladnaTyp ?? '') === 'receipt' ? 'PPD' : 'VPD';
230:     // Rozhodnutia bez dokladu pochádzajú z importu .mdb prijatých faktúr.
231:     default: return 'FP';
232:   }
233: }
234: 
235: /**
236:  * Preklopí už existujúcu pamäť rozhodnutí do korpusu, aby analýza mala z čoho
237:  * vychádzať ešte pred prvým plným exportom z POHODY. Agenda sa berie z dokladu,
238:  * ku ktorému rozhodnutie patrí — kým sa písalo natvrdo 'FP', celý korpus vyzeral
239:  * ako samé prijaté faktúry a rozdelenie profilu podľa agend nemalo čo ukázať.
240:  * Opakované preklopenie agendu opraví aj riadkom, ktoré tu už sú.
```


src/features/documents/InvoicePanel.tsx:83 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
83: }> = [
84:   { value: 'PD:expense', label: 'Výdajový pokladničný doklad', typ: 'PD', pokladnaTyp: 'expense' },
85:   { value: 'PD:receipt', label: 'Príjmový pokladničný doklad', typ: 'PD', pokladnaTyp: 'receipt' },
86:   { value: 'FP', label: 'Faktúra prijatá', typ: 'FP', podtyp: 'bezna' },
87:   { value: 'FP:dobropis', label: 'Dobropis prijatý', typ: 'FP', podtyp: 'dobropis' },
88:   { value: 'FP:tarchopis', label: 'Ťarchopis prijatý', typ: 'FP', podtyp: 'tarchopis' },
89:   { value: 'FP:zalohova', label: 'Zálohová faktúra prijatá', typ: 'FP', podtyp: 'zalohova' },
90:   { value: 'FV', label: 'Faktúra vydaná', typ: 'FV', podtyp: 'bezna' },
91:   { value: 'FV:dobropis', label: 'Dobropis vydaný', typ: 'FV', podtyp: 'dobropis' },
92:   { value: 'FV:tarchopis', label: 'Ťarchopis vydaný', typ: 'FV', podtyp: 'tarchopis' },
93:   { value: 'FV:zalohova', label: 'Zálohová faktúra vydaná', typ: 'FV', podtyp: 'zalohova' },
94:   { value: 'OZ', label: 'Ostatný záväzok', typ: 'OZ' },
95:   { value: 'MZDY', label: 'Interný doklad (INT)', typ: 'MZDY' },
96:   { value: 'BV', label: 'Bankový výpis', typ: 'BV' },
97: ];
98: 
99: const KV_LABEL: Record<string, string> = {
100:   A1: 'A1 – Dodanie tovaru a služby', A2: 'A2 – Samozdanenie príjemcom',
```


server/services/dphAuditService.ts:331 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
331:   input: {
332:     tenantId: string;
333:     organizationId: string;
334:     documentId: string;
335:     documentType: string;
336:     extracted: Record<string, unknown>;
337:     navrhnuteClenenieKod?: string;
338:     navrhnutaKvSekcia?: string;
339:   },
340:   auditor?: DphAuditor,
341: ): Promise<DphVerdikt | undefined> {
342:   // Výpis z účtu, mzdová páska ani zmluva členenie DPH nemajú — kontrola by
343:   // na nich len pálila dopyty a vyrábala rozpory, ktoré nemá kto uzavrieť.
344:   if (['BV', 'MZDY', 'INY', 'UNKNOWN'].includes(input.documentType)) return undefined;
345:   if (!auditor && (config.extractionProvider !== 'openai' || !config.openai.apiKey)) return undefined;
346:   const ciselnik = await nacitajCiselnikPreAudit(database, input.tenantId, input.organizationId, input.documentType);
347:   if (ciselnik.cleneniaDph.length === 0) return undefined;
348: 
```

Фраза промпта, server/services/accountingSuggestionService.ts:1035: «The self-assessment — the classification that reports the tax and its KV section B1 — belongs to a SEPARATE internal document the accountant creates». Это доказательство продуктовой границы, а не требования закона вручную создавать документ в ERP. Экспорт INT: server/pohodaXml.ts:646; ручное разделение: server/routes/documentRoutes.ts:642. Классификатор:

server/extraction/classifyProvider.ts:40 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
40: 
41: DECIDE IN THIS ORDER. First ask: does this document BILL for anything? Only if the answer is yes do you choose between FP and FV. A document that does not bill is INY no matter whose letterhead it carries, no matter that both parties and an amount are printed on it.
42: 
43: documentType:
44: FP = received supplier invoice (someone bills the accounting client)
45: FV = invoice issued by the accounting client
46: PD = cash register receipt (bloček, pokladničný doklad, till slip)
47: MZDY = payslip (mzdová páska, výplatná páska)
48: BV = bank statement
49: OZ = other liability that is still a bookkeeping document with an amount to pay — typically a fine or penalty (pokuta, sankcia, verbale di contravvenzione, Bussgeld, amende), a toll or road-charge demand, or any authority's demand naming a sum the client must pay
50: INY = anything that is NOT a bookkeeping document
51: UNKNOWN = you genuinely cannot tell
52: 
```

**Охват.** 2553 из 9947 (25,67 %) исторических документов находятся в группе INT [Q23](#q23), [C01](#c01). Сколько среди них mzdy, zápočet, samozdanenie, zaokrúhlenie или прочие операции, не измерено. Нельзя объявлять всю эту группу ошибочной или недоступной.

**Что чинит.** Развести физическую agenda INT и экономический вид операции: mzdy, samozdanenie, zápočet и прочие interné doklady. Проверять DPH по виду операции, признакам и связям, а не пропускать всё значение MZDY. Ручную границу samozdanenie сделать явным заданием с контролем исполнения либо поддержать согласованный план связанных документов.

**Что сломает.** Простое переименование MZDY нарушит сохранённые документы, маршруты и XML. До внедрения проверить обратное чтение существующих MZDY, экспорт intDoc и доступность старых решений. Незарплатные INT сначала разметить по первичным данным; точную оценку пользы без этой разметки получить нельзя.

### 6. Последние примеры не доказывают повторяемость формы

**Механизм.** najdiRozuctovanie не требует повторения: возвращает и единственный подходящий документ. Промпт называет любой такой блок уже неоднократно принятым решением и требует повторить форму. Контрагент может выставлять различные операции; порядок последних документов не доказывает применимость конкретной формы к текущему содержанию.

**Доказательство.**

server/services/accountingSuggestionService.ts:1324 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
1324:         WHERE tenant_id=$1 AND organization_id=$2 AND agenda=ANY($3::text[]) AND doklad_cislo IS NOT NULL
1325:           AND ($6::date IS NULL OR datum < $6::date)
1326:           AND (($4::text <> '' AND supplier_ico=$4) OR ($5::text <> '' AND supplier_name_normalized=$5))
1327:         GROUP BY doklad_cislo
1328:        HAVING count(DISTINCT predkontacia_kod) > 1
1329:         ORDER BY max(datum) DESC NULLS LAST
1330:         LIMIT 2)
1331:      SELECT h.doklad_cislo, h.riadok_index, h.line_text_normalized, h.suma, h.suma_dph,
1332:             h.predkontacia_kod, h.predkontacia_id, h.clenenie_dph_kod, h.clenenie_kv_kod
1333:        FROM ucto_historia h JOIN doklady d ON d.doklad_cislo=h.doklad_cislo
1334:       WHERE h.tenant_id=$1 AND h.organization_id=$2 AND h.agenda=ANY($3::text[])
1335:         AND ($6::date IS NULL OR h.datum < $6::date)
1336:         AND (($4::text <> '' AND h.supplier_ico=$4) OR ($5::text <> '' AND h.supplier_name_normalized=$5))
1337:         -- Len položky: hlavička hovorí o doklade ako celku, kým tvar
1338:         -- rozúčtovania je práve v tom, ako sa rozpadol na riadky.
1339:         AND coalesce(h.riadok_index, 0) > 0
1340:       ORDER BY h.doklad_cislo, h.riadok_index
1341:       LIMIT 24`,
```

В server/services/accountingSuggestionService.ts:1055 действительно записано: «When this block is present it is not a hint, it is the record of a decision the firm has already made repeatedly».

**Охват.** В [Q15](#q15) и [Q18](#q18) группы построены по tenant, organization, runtime-agenda и нормализованному имени. Это приближение к runtime IČO OR имя, а не полный повтор его выборки. Суммы по строкам Q15, вычисленные в [C02](#c02): 311 групп с примером; у 154 есть несколько пригодных документов, у 157 только один; среди первых у 117 последние формы совпали, у 37 различаются. Группы с одним примером охватывают 474 из 9947 (4,77 %), с разными последними формами — 2016 из 9947 (20,27 %); вместе 2490 из 9947 (25,03 %) [C01](#c01). Совпадение в запросе означает порядок predkontácia + DPH + KV, без сравнения смысла, сумм и долей. Q15 не нашёл срабатывания лимита detail-строк на выбранных последних примерах; это не доказательство отсутствия длинных документов во всей истории. При равных датах SQL добавляет номер документа для устойчивости, production-запрос этого tie-breaker не имеет.

FastSpring — фактический контрпример минимальной поддержке: [Q12](#q12) возвращает FP ZF260133 с základ 32.51 и отдельной DPH 7.48, а VPD 26PV0006 — оплату 39.99. Нельзя считать оплату независимым подтверждением того же rozpis FP.

**Что чинит.** Передавать отдельные статусы «единственный пример», «устойчивая форма» и «несколько форм с условиями выбора». Выбирать по экономическому виду, договору, стране/режиму DPH, направлению и периоду. Пример подтверждает возможность формы, но не её обязательность.

**Что сломает.** Слишком жёсткое требование повторения лишит полезного примера нового контрагента. На Q18 проверить отдельно single, two_same и two_different: пример оставить доступным, снизить обязательность, а выбор формы оценивать на последующих документах. Утверждение о распределении форм именно W.A.G. из задания не перепроверено и не используется как замер.

### 7. Форма зависит от доминирования hlavička

**Механизм.** odvodPravidlo возвращает undefined до вызова odvodRozpis, если predkontácia hlavička недостаточно устойчива. Для смешанного документа hlavička может меняться, хотя состав detail-ролей повторяется. Это самостоятельная причина потери пригодной памяти, вложенная в общий охват отсутствующих правил.

**Доказательство.** Точный ранний возврат и более поздний вызов формы показаны в цитате odvodPravidlo выше. [Q21](#q21) выполнил чистую функцию этого коммита над SELECT и отдельно проверил odvodRozpis при сохранённом условии достаточного числа detail-документов. В его фактическом выводе ALPINA: shapeButNoRuleGroups = 43, shapeButNoRuleDocs = 611, shapeButNoRuleSplitDocs = 219; SLO: соответственно 1, 66, 15. Исходный поток строк SELECT не сохранён, сохранён вывод вычисления; это ограничение воспроизводимости прямо отмечено в приложениях.

**Охват.** 677 из 9947 (6,81 %) в группах с формой, потерянной из-за hlavička; из них 234 из 9947 (2,35 %) действительно имеют разные predkontácie detail [C01](#c01). Это охват групп на проверенном представлении строк, не число исправленных AI-ответов. В проверке не было сумм и содержательного текста: она доказывает доступность структуры кодов, но не корректность podiel или семантических ролей.

**Что чинит.** Выводить форму независимо от доминирующей predkontácia hlavička и хранить альтернативы с условиями применимости. Уверенность рассчитывать по воспроизведённым ролям и проверенным суммам.

**Что сломает.** В смешанной группе позиционная форма может склеить разные операции. До внедрения пересчитать отдельно структуру и числовые параметры, проверить последние документы без доступа к будущему. Замена Math.max сама по себе не основной ремонт: в Q21 ужесточение нижнего порога изменило одну группу ALPINA с 20 документами, тогда как потеря формы на hlavička имеет иной охват.

silnePravidlo не циклично: условие проверяет совпадение выбранной predkontácia hlavička, а не уже применённый rozpis. Реальный недостаток — высокий потолок уверенности до проверки полноты строк:

server/services/accountingSuggestionService.ts:2000 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
2000:   const kodPredkontacie = codeLists.rows.find((row) => row.id === validated.predkontacia_id)?.code?.trim();
2001:   const silnePravidlo = pravidloProtistrany
2002:     && pravidloProtistrany.dokladov >= 10
2003:     && pravidloProtistrany.zhoda / pravidloProtistrany.dokladov >= 0.9
2004:     && Boolean(kodPredkontacie)
2005:     && kodPredkontacie === pravidloProtistrany.predkontaciaKod;
2006:   const strop = silnePravidlo
2007:     ? 0.95
2008:     : (rozdelenie ? 0.8 : (overenaKategoria || dennikZhoda || prikladZhoda ? 0.95 : 0.8));
```


### 8. Разная DPH/KV на одном счёте не считается формой

**Механизм.** Поиск примеров и отбор документов для формы категории требуют несколько разных predkontácie. Разделение odpočítateľná/neodpočítateľná DPH или KV на одной predkontácia исчезает до вызова функции формы, хотя сама odvodRozpis умеет различать DPH/KV.

**Доказательство.** HAVING в цитате najdiRozuctovanie выше и отбор для категории:

server/services/uctoKategoriaRozpis.ts:62 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
62:     // Odkedy korpus drží aj položky dokladov účtovaných na jeden účet (kvôli
63:     // ich textom), tvoria väčšinu — a odvodRozpis potom vidí prevažne rovnaké
64:     // riadky, zahodí ich ako „nič sa nedelí" a kategórii neostane nič. AGS tak
65:     // prišlo z piatich kategórií s rozpisom na nulu. Doklad na jeden účet
66:     // o DELENÍ nehovorí nič; do korpusu patrí pre svoj text, nie pre tvar.
67:     if (new Set(polozky.map((polozka) => polozka.predkontaciaKod ?? '')).size < 2) continue;
68:     let najlepsia: { id: string; zhoda: number } | undefined;
69:     for (const kategoria of kategorie) {
70:       const zhoda = pocetZhodSlov(kategoria.slovnik, hlavicka.text);
71:       if (zhoda > 0 && (!najlepsia || zhoda > najlepsia.zhoda)) najlepsia = { id: kategoria.id, zhoda };
72:     }
73:     if (!najlepsia) continue;
74:     const zoznam = podlaKategorie.get(najlepsia.id) ?? [];
75:     zoznam.push(polozky);
76:     podlaKategorie.set(najlepsia.id, zoznam);
77:   }
78: 
79:   let sRozpisom = 0;
80:   await database.transaction(async (tx: Queryable) => {
81:     for (const kategoria of kategorie) {
82:       const jejDoklady = podlaKategorie.get(kategoria.id) ?? [];
83:       const rozpis: PravidloRiadok[] = jejDoklady.length >= MIN_DOKLADOV ? odvodRozpis(jejDoklady) : [];
84:       if (rozpis.length > 0) sRozpisom += 1;
85:       await tx.query('UPDATE ucto_kategorie SET rozpis=$1::jsonb WHERE id=$2',
```

**Охват.** 64 из 9947 (0,64 %) документов с одной predkontácia и разными комбинациями DPH/KV исключаются из account-критерия [Q14](#q14), [C01](#c01). Это не только касса; разрез по конкретной экономической операции не измерен.

**Что чинит.** Определять форму по бухгалтерской роли и полному режиму predkontácia + DPH + KV, а не только разнообразию predkontácie. Для законной доли odpočet хранить отдельно основание и способ расчёта.

**Что сломает.** Незначимое дублирование строк может стать ложным rozpis. До внедрения на отобранных Q14 документах сверить пары одинаковых счетов с разной DPH/KV и отделить смысловое разделение от дубликатов/округления; не удалять различие по стране и знаку суммы.

### 9. Хвост документа остаётся вне индивидуального предложения

**Механизм.** Первоначальный worker использует raw lineItems, а предложение снова ограничивает видимый массив. Валидатор разрешает только индексы этого массива. Полный документ сохраняется; утверждать, что хвост удаляется или XML имеет такой же лимит, нельзя. Нормализатор может дополнительно создать строку иностранной DPH, которой вообще нет в raw.

**Доказательство.**

server/workerService.ts:695 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
695:   const polozkyPreModel = (items: typeof result.lineItems) => items.slice(0, 15).map((item) => ({
696:     popis: item.description ?? undefined,
697:     sadzbaDph: item.vatRate == null ? undefined : Number(item.vatRate),
698:     suma: item.amountTotal == null ? undefined : Number(item.amountTotal),
699:   }));
700:   const popisy = (items: typeof result.lineItems) => items.map((item) => item.description ?? '').filter(Boolean);
701:   return {
702:     status,
703:     ...strany,
704:     documentType: normalized.documentType,
705:     // Druh faktúry ide do návrhu zaúčtovania: rozhoduje o sekcii KV aj o tom,
706:     // ktoré členenia DPH sa modelu vôbec ponúknu.
707:     podtyp: podtypPreTyp(normalized.documentType, podtyp),
708:     // Dátum vystavenia: firma môže mať mesačné číselné rady.
709:     datumVystavenia: datumZExtrakcie(normalized.extracted),
710:     totalAmount: normalized.totalAmount,
711:     currency: normalized.currency,
712:     // Doklad BEZ položiek (pokuta, poplatok, odvod) nemá z čoho poskladať
713:     // lineText — a ten je vstupom hneď troch vecí: filtra pravidiel podľa
714:     // kľúčových slov (sediKlucoveSlovo v aiInstructionsService.ts) a retrievalu
715:     // príkladov, kategórií aj denníka. S prázdnym reťazcom sa pravidlo účtovníka
716:     // TICHO odfiltruje a model rozhoduje len podľa typu a sumy: talianska pokuta
717:     // tak namiesto „325100-pokuty šofér" dostala väčšinový nedaňový OZ z denníka.
718:     // Jediný text, ktorý taký doklad odlíši, je jeho zhrnutie — presne tak to
719:     // o pár riadkov nižšie už rieši doklad z rozdelenia.
720:     lineDescriptions: popisy(result.lineItems).length > 0
721:       ? popisy(result.lineItems)
722:       : [result.documentSummary].filter((text): text is string => Boolean(text)),
723:     polozky: polozkyPreModel(result.lineItems),
```


server/services/accountingSuggestionService.ts:1702 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
1702:   // Položky tak, ako ich uvidí model — rovnaké pole musí neskôr overiť rozpis
1703:   // riadkov, inak by index v odpovedi ukazoval inam než index v prompte.
1704:   const polozkyPreModel = (documentContext.polozky
1705:     ?? documentContext.lineDescriptions.map((popis) => ({ popis }))).slice(0, 15);
1706: 
1707:   const poziadavka = {
1708:     model: config.openai.accountingModel,
1709:     store: config.openai.storeResponses,
1710:     instructions: AI_SUGGESTION_INSTRUCTIONS,
1711:     input: [{
1712:       role: 'user',
1713:       content: [{
1714:         type: 'input_text',
1715:         text: JSON.stringify({
1716:           dokument: {
1717:             typ: documentContext.documentType,
1718:             dodavatel: documentContext.supplierName,
1719:             dodavatelIco: documentContext.supplierIco,
1720:             dodavatelIcDph: documentContext.supplierIcDph,
1721:             dodavatelKrajina: documentContext.supplierKrajina,
1722:             odberatel: documentContext.odberatel,
1723:             suma: documentContext.totalAmount,
1724:             mena: documentContext.currency,
1725:             // Sadzby DPH samostatne, nielen skryté v položkách: rozhodujú
1726:             // o daňovom režime dokladu a model ich inak prehliadne.
1727:             sadzbyDphNaDoklade: [...new Set((documentContext.polozky ?? [])
1728:               .map((polozka) => polozka.sadzbaDph)
1729:               .filter((sadzba): sadzba is number => sadzba != null))],
1730:             // Index je explicitne v dátach: podľa neho sa vracia rozpis riadkov
1731:             // a poradie v poli je príliš krehký dohovor na to, aby o ňom
1732:             // rozhodovalo zaúčtovanie.
1733:             polozky: polozkyPreModel.map((polozka, index) => ({ index, ...polozka })),
1734:           },
1735:           // Pravidlo protistrany — zhrnutie praxe cez všetky jej doklady.
1736:           pravidlo: pravidloProtistrany ? {
1737:             dokladov: pravidloProtistrany.dokladov, zhoda: pravidloProtistrany.zhoda,
1738:             predkontaciaKod: pravidloProtistrany.predkontaciaKod,
1739:             clenenieDphKod: pravidloProtistrany.clenenieDphKod,
1740:             clenenieKvKod: pravidloProtistrany.clenenieKvKod,
1741:             rozpis: pravidloProtistrany.rozpis,
1742:           } : undefined,
```


server/services/accountingSuggestionService.ts:2080 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
2080:   for (const [index, casti] of skupiny) {
2081:     const sucet = casti.reduce((spolu, cast) => spolu + (cast.podiel ?? 0), 0);
2082:     const sucetDph = casti.reduce((spolu, cast) => spolu + (cast.podielDph ?? cast.podiel ?? 0), 0);
2083:     if (casti.length >= 2 && polozkyPreModel[index]
2084:       && casti.every((cast) => (cast.podiel ?? 0) > 0 && (cast.podiel ?? 0) < 1)
2085:       && Math.abs(sucet - 1) <= PRESNOST_PODIELU && Math.abs(sucetDph - 1) <= PRESNOST_PODIELU) {
2086:       platneSkupiny.add(index);
2087:     }
2088:   }
2089: 
2090:   const pouziteIndexy = new Set<number>();
2091:   const riadky = (parsed.riadky ?? []).flatMap((riadok) => {
2092:     const polozka = polozkyPreModel[riadok.index];
2093:     const jeCast = jeRez(riadok.podiel) && !celePolozky.has(riadok.index);
2094:     // Rozrezanie sa berie iba celé. Jedna časť bez svojich súrodencov by
2095:     // z dokladu odkrojila kus sumy a zvyšok by sa stratil.
2096:     if (jeCast && !platneSkupiny.has(riadok.index)) return [];
2097:     if (!polozka || (!jeCast && pouziteIndexy.has(riadok.index))) return [];
2098:     if (!vPonukePredkontacii.has(riadok.predkontaciaId)) return [];
2099:     const clenenieDphId = riadok.clenenieDphId && vPonukeCleneni.has(riadok.clenenieDphId)
2100:       ? riadok.clenenieDphId : undefined;
```

**Охват.** В текущей выборке 2 из 125 (1,60 %) FP имеют raw-длину выше лимита [Q05](#q05), [Q10](#q10), [C01](#c01). У b23bd6ed-e7a4-4247-ad57-7b34c2b8f2f1 raw 17, normalized 18, последняя строка «DPH IT 22 %» [Q24](#q24), [Q26](#q26). В истории 43 из 9947 (0,43 %) имеют больше detail-строк; все они INT. Их печатная длина неизвестна, поэтому это лишь потенциальный охват при воспроизведении, не измерение реальных обрезаний. Сопоставить печатные строки со строками проводки для всего корпуса нельзя: таких пар в выполненных запросах нет.

**Что чинит.** Давать предложению единый нормализованный набор фактов с устойчивыми source ID, включая самостоятельную рекапитуляцию DPH. Для длинного документа разделять обработку по смысловым группам с общей проверкой покрытия, сохраняя доступность каждой položka.

**Что сломает.** Смена индексного пространства может применить проводку к соседней строке; смешение блоков — дважды учесть DPH. До внедрения сравнить raw, normalized и утверждённые строки W.A.G., отдельно проверить происхождение добавленной иностранной DPH и покрытие хвоста. Уже существующее создание строки нормализатором не нужно предлагать как новую функцию; требуется передача её в последующее решение.

### 10. Прочитанный документ теряет смысл и ставки между AI-шагами

**Механизм.** В аудируемом коммите sadzbyDphNaDoklade собираются только из položky, а summary не входит в объект dokument. Пустой массив položky не включает fallback через оператор nullish coalescing. Промпт затем интерпретирует пустые ставки как отсутствие налога. Извлечение могло распознать смысл и rozpis DPH, но предложение их не видит.

**Доказательство.** Строки формирования payload приведены выше; server/services/accountingSuggestionService.ts:1050: «Empty or all zero: no tax was charged — do not pick a domestic taxable classification». [Q24](#q24) возвращает ненулевую DPH при отсутствии položky. Это не просто неточное название счёта.

**Охват.** 9 из 125 (7,20 %) имеют сводку без položky, 3 из 125 (2,40 %) — DPH без položky [C01](#c01). Внешнее незакоммиченное изменение, замеченное при подготовке, уже передаёт сводку и ставки; оно не проверено на новых ответах и не устраняет автоматически ограничения формы/ponuka.

**Диагностические PD, низкий приоритет по объёму.** Только эти примеры относятся к кассовым чекам. В [Q06](#q06) MANGI, UUID 45745064-e039-4bb2-a0c8-5bf54ae9a5f4, имеет пустые položky, summary «Stravovanie a nápoje», незаполненные идентификаторы поставщика и предложение 518900 / PN / KN. Сохранённая разбивка содержит ставку 19, základ 75.69, DPH 4.11, итог 80; это результат AI, не подтверждение правильного прочтения бумаги. Исходное изображение здесь не проверялось. DECATHLON, UUID 967302fa-b529-4a27-bdf2-293ce6e7339a, имеет в данных ставку 23, základ 8.05, DPH 1.85 и итог 9.9, но пустые položky и объяснение предложения об отсутствии ставки [Q06](#q06).

У AGS кассовая predkontácia reprezentácia существует и не встречается в измеренной истории VPD; 518900 встречается в 34 строках, но лишь в 10 документах [Q07](#q07), [Q08](#q08). Это не 34 независимых повторения. У MANGI не найден собственный исторический пример; потому доказана пригодность общего частотного механизма, а не выбор личной привычки MANGI. Категория reprezentácia имеется, но её predkontacia_id отсутствует [Q08](#q08); имя кода само не делает ID доступным модели. Результаты сохранены до позднейшего промпт-исправления; повторный прогон не выполнен. Экономическая цель покупки DECATHLON и право на odpočet по ней из одного продавца не выводятся.

**Что чинит.** Согласовать контракт данных: передавать summary, полный rozpis DPH, признаки «не прочитано» и «налог отсутствует» раздельно; ремонтировать связь категорий с активным справочником. Уже добавленные инструкции извлечения не переписывать без повторной проверки.

**Что сломает.** Ошибочная OCR-ставка из рекапитуляции начнёт влиять сильнее; ложное summary может принудить неверный режим. До внедрения сверить исходный документ, normalized и реально сформированный payload, затем оценить новый ответ и математическую согласованность. Сохранённые run-результаты — исходная регрессионная пара, а не доказательство успеха текущего промпта.

### 11. Формат ответа не выражает бухгалтерский расчёт и нужную связанную agenda

**Механизм.** Ответ riadky указывает на существующий index и может делить сумму через положительные podiel. Нет общего выражения «объединить источники», «рассчитать компонент из договора», «создать строку из рекапитуляции» или «связать взаимозачёт с ранее выданным авансом». Историческая форма использует абсолютные суммы, теряя знак zúčtovanie. Отдельный additionalDocuments уже существует, но не содержит самостоятельного claim; OZ при экспорте всегда commitment, хотя ponuka OZ допускает predkontácie claim.

**Доказательство.**

server/services/accountingSuggestionService.ts:982 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
982: const aiRiadokSchema = z.object({
983:   index: z.number().int().min(0),
984:   predkontaciaId: z.string(),
985:   clenenieDphId: z.string().nullable(),
986:   /** Sekcia KV riadku. Bez nej riadok zdedí sekciu hlavičky — a to je chyba,
987:    *  keď je riadok mimo priznania: KN sa z hlavičkového B2 odvodiť nedá. */
988:   clenenieKvKod: z.string().nullable(),
989:   /**
990:    * Podiel položky, ktorý na tento riadok pripadá. Celá položka = null alebo 1.
991:    * Rez sa zapíše tak, že sa rovnaký index zopakuje toľkokrát, na koľko častí
992:    * sa delí, a každá časť nesie podiel MENŠÍ než 1; dokopy musia dať 1.
993:    */
994:   podiel: z.number().nullable(),
995:   /**
996:    * Podiel DPH, keď sa daň nedelí v rovnakom pomere ako základ. PHM pre auto
997:    * používané aj súkromne: základ 80/20, ale odpočet dane je krátený na
998:    * polovicu (§ 49 ods. 5), takže daň ide 50/50. Bez neho sa daň delí rovnako
999:    * ako základ.
1000:    */
1001:   podielDph: z.number().nullable(),
1002: }).strict();
1003: 
1004: const aiSuggestionSchema = z.object({
```


server/services/uctoPravidlaService.ts:78 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
78: export function odvodRozpis(doklady: RozpisRiadok[][]): PravidloRiadok[] {
79:   const podlaPoctu = prevaha(doklady.map((polozky) => polozky.length));
80:   const pocet = podlaPoctu.hodnota ?? 0;
81:   if (pocet < 2 || podlaPoctu.pocet < Math.max(2, doklady.length * MIN_ZHODA)) return [];
82:   const rovnake = doklady.filter((polozky) => polozky.length === pocet);
83: 
84:   const rozpis: PravidloRiadok[] = [];
85:   for (let index = 0; index < pocet; index += 1) {
86:     const naPozicii = rovnake.map((polozky) => polozky[index]);
87:     const predkontacia = prevaha(naPozicii.map((polozka) => polozka.predkontaciaKod));
88:     // Pozícia bez prevažujúcej predkontácie nie je ustálená — celý tvar padá,
89:     // lebo rozpis s dierou by účtovníka viedol k nesprávnemu riadku.
90:     if (!predkontacia.hodnota || predkontacia.pocet < rovnake.length * MIN_ZHODA) return [];
91:     const podiely = naPozicii.map((polozka, poradie) => {
92:       const spolu = rovnake[poradie].reduce((sucet, item) => sucet + Math.abs(item.suma ?? 0), 0);
93:       return spolu > 0 ? Math.abs(polozka.suma ?? 0) / spolu : undefined;
94:     }).filter((podiel): podiel is number => podiel !== undefined);
95:     // Podiel sa zapíše, len keď je naozaj stabilný (rozptyl do dvoch percent) —
96:     // pri obsahovom rozpise sa mení od dokladu k dokladu a číslo by bolo lož.
97:     const priemer = podiely.length > 0 ? podiely.reduce((a, b) => a + b, 0) / podiely.length : undefined;
98:     const stabilny = priemer !== undefined && podiely.length >= rovnake.length * MIN_ZHODA
99:       && podiely.every((podiel) => Math.abs(podiel - priemer) <= 0.02);
100:     rozpis.push({
101:       text: prevaha(naPozicii.map((polozka) => polozka.text)).hodnota ?? '',
102:       predkontaciaKod: predkontacia.hodnota,
103:       clenenieDphKod: prevaha(naPozicii.map((polozka) => polozka.clenenieDphKod)).hodnota,
104:       clenenieKvKod: prevaha(naPozicii.map((polozka) => polozka.clenenieKvKod)).hodnota,
105:       ...(stabilny ? { podiel: Number(priemer!.toFixed(3)) } : {}),
106:     });
107:   }
108:   // Rozpis, kde všetky riadky idú rovnako, nie je rozpis — doklad sa nedelí.
109:   const prvy = rozpis[0];
110:   const vsetkyRovnake = rozpis.every((riadok) =>
111:     riadok.predkontaciaKod === prvy.predkontaciaKod
112:     && riadok.clenenieDphKod === prvy.clenenieDphKod
113:     && riadok.clenenieKvKod === prvy.clenenieKvKod);
114:   return vsetkyRovnake ? [] : rozpis;
```


server/pohodaXml.ts:99 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
99:  * Typ faktúry pre POHODA. Rozhoduje DVOJICA: dobropis a ťarchopis sú v POHODE
100:  * samostatné hodnoty invoiceType, nie iné agendy — presne ako v jej XSD
101:  * (issuedCreditNotice = Dobropis, issuedDebitNote = Vrubopis/ťarchopis).
102:  */
103: function invoiceType(type: string, podtyp?: string): string {
104:   if (type === 'OZ') return 'commitment';
105:   const strana = type === 'FP' ? 'received' : type === 'FV' ? 'issued' : undefined;
106:   if (!strana) throw new Error(`Nepodporovaný typ dokladu pre POHODA: ${type}`);
107:   if (podtyp === 'dobropis') return `${strana}CreditNotice`;
108:   if (podtyp === 'tarchopis') return `${strana}DebitNote`;
109:   if (podtyp === 'zalohova') return `${strana}AdvanceInvoice`;
110:   return `${strana}Invoice`;
111: }
```

В agent/src/Dokladovka.Agent/PohodaXml.cs:132 запрашивается commitment; claim в этом маршруте загрузки не запрашивается. Допустимые типы additionalDocuments: server/extraction/contract.ts:80; ручного разделения: server/routes/documentRoutes.ts:642. Наличие поддержки FV не следует путать с отсутствующим маршрутом ostatná pohľadávka.

**Охват.** Число документов, требующих объединения, вычисленной строки, отрицательного зачёта или claim, не измерено. OZ/INT — приоритетная область, но их общий объём не равен объёму этого дефекта. Утверждение, что весь перечисленный в задании лизинг и расчёт командировок массово падает именно здесь, остаётся гипотезой.

Случай 3116668238 / 2604131046667 с Provízia и Finančná čiastka не найден и не проверен в БД: новые SELECT не выполнились. В тесте server/extraction/normalize.test.ts:497 номер 3116668238 относится к фикстуре W.A.G.; это не доказательство тождества с указанной парой документов. Ограничение маршрута claim подтверждено кодом, но не установлено как фактическая причина именно этого AI-ответа.

**Что чинит.** Ввести предлагаемый ниже план бухгалтерских событий: source-ссылки, роли, знаковые суммы, формулы, операции объединения/разделения и связанные целевые документы, включая ostatná pohľadávka. AI выбирает план и привязки; арифметику и полноту проверяет детерминированный исполнитель.

**Что сломает.** Создание производных сумм и документов без связей удвоит обязательство или налог. До внедрения замкнуть контроль сумм, связей и повторного выполнения на доступных утверждённых документах; для спорной пары сначала получить её первичные данные. Лизинговую формулу нельзя принимать по одному имени predkontácia.

### 12. DPH/KV и приоритет закона не образуют единого контракта

**Механизм.** kv_section предусмотрена в БД, но не в передаваемом Mostík CodeListValue, и не заполнена в справочнике. kvPreClenenie использует её лишь как fallback. Правило «закон выше привычки» присутствует в промпте, но окончательный результат ещё изменяется правилами и выводом DPH из счетов; ранний полностью заданный manual-ответ обходит AI. Исправление только текста промпта не покрывает эти пути. Кроме того, группа podiel проверяется до отбрасывания недопустимых ID, поэтому возможна неатомарная потеря части принятой группы.

**Доказательство.**

agent/src/Dokladovka.Agent/BackendClient.cs:25 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
25:     // Web požiadal o synchronizáciu histórie zaúčtovaní pre Tréning AI.
26:     bool TrainingSyncRequested = false);
27: public sealed record HeartbeatCompany(string Ico, string DbName, string UctovnyRok);
28: // UcetMd/UcetDal: účty predkontácie z atribútov debit/credit (len kind=predkontacie).
29: // PosledneCislo: najvyššie použité číslo číselného radu (topNumber z exportu POHODY) —
30: // web z neho predikuje interné číslo ďalšieho dokladu.
31: // Iban/Mena: bankové účty (kind=bankoveUcty) — IBAN páruje výpis na účet POHODY.
32: public sealed record CodeListValue(string Kod, string Nazov, string? ExternalId = null, string? Agenda = null, string? UctovnyRok = null, string? UcetMd = null, string? UcetDal = null, string? PosledneCislo = null, string? Iban = null, string? Mena = null);
33: // CheckDuplicity=false: voľba „Nekontrolovať duplicity" v exportnom dialógu —
34: // POHODA doklad naimportuje aj vtedy, keď tam s rovnakým číslom už je.
35: public sealed record AgentExportJob(string ExportJobId, string DataPackXml, string IdempotencyKey, bool CheckDuplicity = true);
36: public sealed record ExportDocumentResult(string DocumentId, string State, string? PohodaNumber = null, string? Message = null);
37: public sealed record AgentRelease(
38:     bool Available,
39:     string? Version = null,
40:     string? DownloadUrl = null,
```


server/services/accountingSuggestionService.ts:1895 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
1895:   // je na doklade (extrakcia z neho číta odkaz na paragraf, ktorý model
1896:   // v prompte nevidí), ostávajú vyššie. Beží až tu, lebo potrebuje účet, ktorý
1897:   // sa práve rozhodol — a KV sa počíta nižšie, takže sekcia sa dopočíta už
1898:   // z opraveného členenia.
1899:   if (!pravidlo.candidate.clenenie_dph_id && !naDoklade.clenenieDphId) {
1900:     const kodUctu = codeLists.rows.find((row) => row.id === validated.predkontacia_id)?.code;
1901:     const kodClenenia = kodUctu
1902:       ? await clenenieZUctu(database, input, HISTORIA_AGENDY[documentContext.documentType] ?? [],
1903:         String(kodUctu), documentContext.historiaDoDatumu)
1904:       : undefined;
1905:     const zHistorie = kodClenenia
1906:       ? vsetkyClenenia.find((item) => item.kod.trim() === kodClenenia.trim())?.id
1907:       : undefined;
1908:     if (zHistorie && zHistorie !== validated.clenenie_dph_id) {
1909:       console.info(`[ai-navrh] ${input.documentId}: členenie ${kodClenenia} podľa účtu ${String(kodUctu).trim()}`
1910:         + ' — firma iné na ňom nemala');
1911:       validated.clenenie_dph_id = zHistorie;
1912:     }
1913:   }
```

Порядок проверки сумм и последующего удаления строк по ID показан в server/services/accountingSuggestionService.ts:2080–2098 выше. Отдельная частота этой ошибки в корпусе не измерена.

**Охват.** kv_section отсутствует у 637 из 637 (100,00 %) записей cleneniaDph [Q04](#q04), [C01](#c01). Это справочник, не число документов с неверным KV. Охват конфликтов правил и неатомарного split неизвестен.

**Что чинит.** Передавать и проверять семантику členenie DPH и KV сквозным контрактом, затем запускать единый арбитр уже после manual/default/history/AI. Проверять split целиком после разрешения всех ID, сохраняя причины отклонения. Существующее kvPreDruh с заменой B2 для PD учесть как выполненное исправление; сам по себе этот guard не заменяет проверку места и вида plnenie.

**Что сломает.** Неверно импортированная KV-семантика или чрезмерный запрет перекроет законные исключения и ручные решения. До внедрения сопоставить активные členenia с первичным справочником POHODA, проверить маршруты ручного, AI и массового утверждения на одинаковых фактах; старые overrides пометить по основанию, а не считать автоматически законными. Проект арбитража изложен отдельно ниже.

### 13. Полнота Mostík не доказана ни общим объёмом, ни наличием выгрузки

**Механизм.** BuildDennikRequest ограничивает число строк за выбранный год; проверенная реализация не продолжает запрос страницами. Если объём этой фирмы за этот год превышает limit, запрос не гарантирует полноту. Нельзя вычитать этот limit из общего объёма нескольких фирм и периодов.

**Доказательство.**

agent/src/Dokladovka.Agent/PohodaXml.cs:158 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
158:     public static string BuildDennikRequest(string ico, string requestId, int rok) => $"""
159: <?xml version="1.0" encoding="Windows-1250"?>
160: <dat:dataPack version="2.0" id="{Escape(requestId)}" ico="{Escape(ico)}" application="Dokladovka" note="Export uctovneho dennika"
161:   xmlns:dat="http://www.stormware.cz/schema/version_2/data.xsd"
162:   xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd"
163:   xmlns:ftr="http://www.stormware.cz/schema/version_2/filter.xsd">
164:   <dat:dataPackItem id="dennik" version="2.0">
165:     <lst:listAccountancyRequest version="2.0" accountancyVersion="2.0">
166:       <lst:limit><ftr:count>10000</ftr:count></lst:limit>
167:       <lst:requestAccountancy>
168:         <ftr:filter>
169:           <ftr:dateFrom>{rok:D4}-01-01</ftr:dateFrom>
170:           <ftr:dateTill>{rok:D4}-12-31</ftr:dateTill>
```

**Охват.** В ucto_dennik 20689 строк [Q05](#q05); это другой набор данных, не счётчик потерь. Распределение по organization/году, доступный объём источника и фактическое усечение не измерены. Запросы для уточнения не достигли сервера.

**Что чинит.** Выгружать по проверяемым страницам или непересекающимся диапазонам с контрольными итогами источника, сохранять область и завершённость импорта. Показатель «память готова» должен отличать окончание запроса от полноты года.

**Что сломает.** Нестабильный порядок или пересечение диапазонов дадут пропуски и дубли. До внедрения нужны контрольные итоги POHODA для той же фирмы/года, сверка ключей и сумм, повторная идемпотентная загрузка. Имеющаяся БД позволяет проверить внутренние дубли, но не доказать отсутствие пропусков из источника.

### 14. Измерение точности не проверяет бухгалтерскую задачу целиком

**Механизм.** Проверка на ucto_historia использует уже бухгалтерские строки как вход и оценивает наличие rozpis, не точное соответствие всех компонентов, сумм и связей исходному документу. Это облегчённая задача по сравнению с распознаванием бумаги и расчётом. Возможность ограничить историю по дате не гарантирует отсутствия будущих категорий/решений во всех вспомогательных ветвях.

**Доказательство.**

server/services/uctoPresnostService.ts:258 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
258:       ...(DRUH_PODLA_AGENDY[doklad.agenda].typ === 'FV'
259:         ? { odberatel: { nazov: doklad.supplierName, ico: doklad.supplierIco } }
260:         : {}),
261:       datumVystavenia: doklad.datum,
262:       lineDescriptions: doklad.polozky.map((polozka) => polozka.popis),
263:       polozky: doklad.polozky.map((polozka) => ({ popis: polozka.popis, suma: polozka.suma })),
264:       historiaDoDatumu: deliciDatum,
265:     };
266:     let navrh: Record<string, any> | undefined;
267:     try {
268:       await sNahradnymDokladom(database, input, doklad, async (documentId) => {
269:         await maybeAiAccountingSuggestion(database, config, {
270:           tenantId: input.tenantId, organizationId: input.organizationId, documentId,
271:           supplierIco: doklad.supplierIco, supplierName: doklad.supplierName,
272:         }, context, injectedParser);
273:         navrh = (await database.query<Record<string, any>>(
274:           'SELECT predkontacia_id, clenenie_dph_id, clenenie_kv_kod, ciselny_rad_id, riadky, reason FROM accounting_suggestions WHERE document_id=$1',
275:           [documentId],
276:         )).rows[0];
277:       });
278:     } catch (chyba) {
279:       rozdiely.push({
280:         doklad: doklad.dokladCislo, agenda: doklad.agenda,
281:         chyba: chyba instanceof Error ? chyba.message : String(chyba),
282:       });
283:       continue;
284:     }
285: 
286:     const sedi = {
287:       predkontacia: Boolean(navrh?.predkontacia_id) && navrh!.predkontacia_id === doklad.predkontaciaId,
288:       clenenieDph: !doklad.clenenieDphId || navrh?.clenenie_dph_id === doklad.clenenieDphId,
289:       kv: !doklad.clenenieKvKod || navrh?.clenenie_kv_kod === doklad.clenenieKvKod,
290:       // Rad sa neporovnáva proti korpusu — ten ho nedrží ako id. Berie sa, či
291:       // ho návrh vôbec určil; presnosť radu meria vlastný test.
292:       rad: Boolean(navrh?.ciselny_rad_id),
293:       // Rozpis: navrhol ho tam, kde ho účtovník naozaj urobil?
294:       rozpis: doklad.rozpisany === Array.isArray(navrh?.riadky) && (navrh?.riadky?.length ?? 0) > 0,
295:     };
296:     if (sedi.predkontacia) skore.predkontacia += 1;
297:     if (sedi.clenenieDph) skore.clenenieDph += 1;
```

**Охват.** Имеются 20 записей ucto_presnost [Q05](#q05), но они не устанавливают точность на всех agendy. Подтверждённых документов 107 из 125 (85,60 %); с applied extraction run 105 из 107 (98,13 %), с непустым массивом accounting.items 14 из 107 (13,08 %) [Q11](#q11), [Q13](#q13), [C01](#c01). Само наличие массива не доказывает полноценную эталонную разметку. Подтверждённых PD в Q11 нет.

**Что чинит.** Разделить оценки извлечения, доступности нужной памяти/ID, выбора экономической формы и выполнения расчёта. Проверять полную строковую проводку и связанные документы против подтверждённого результата по состоянию до проверяемого документа.

**Что сломает.** Строгое сравнение может наказать эквивалентный бухгалтерский результат за другое допустимое агрегирование. До внедрения определить экономическую эквивалентность по счетам, режиму, периоду, знакам и итогам; отдельно сохранять ошибку буквального воспроизведения формы. Не объявлять рост текстовой similarity ростом качества учёта.

### Какая память реально достигает решения

Извлечение не получает строки корпуса, формы прошлых документов или расчёт по договору. Это не означает отсутствия инструкций фирмы: ExtractionInput передаёт pokyny, а классификация получает профиль категорий и исправления типов. Точное ограничение входного контракта:

server/extraction/contract.ts:383 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
383: export interface ExtractionInput {
384:   documentId: string;
385:   mimeType: typeof SUPPORTED_EXTRACTION_MIME_TYPES[number];
386:   fileName: string;
387:   bytes: Uint8Array;
388:   organizationContext: { nazov: string; ico: string; dic?: string; icDph?: string };
389:   /** Textové pravidlá (globálne + firemné) — dôveryhodný blok pred dokladom. */
390:   pokyny?: string;
391:   promptVersion: string;
392:   schemaVersion: string;
393: }
394: 
395: export interface ExtractionOutcome {
396:   result: ExtractionResult;
397:   model?: string;
```


| Функция / слой | Что фактически используется | Когда сведений нет / что важно для диагноза |
|---|---|---|
| najdiPartnera — server/services/partnerService.ts:96 | Карточка служит ключом следующих поисков; сама целиком в промпт не уходит | Нет совпадения — undefined; приоритет IČO, IČ DPH, IBAN, нормализованное имя; DIČ не самостоятельный ключ. Заполненность карточки не доказывает тождество экономической операции |
| najdiPravidlo — server/services/uctoPravidlaService.ts:258 | Одно правило: поддержка, hlavička, rozpis | Нет agenda, IČO/имени или записи — undefined; выбирается по поддержке. С cutoff пересчитывается прошлое. Полноту всех временных ограничений нельзя переносить на другие ветви автоматически |
| najdiDennik — server/services/accountingSuggestionService.ts:1169 | До 10 агрегированных текстовых групп, кодов, частот, similarity и признака контрагента | Поиск сначала ограничен 2000 группами; до 5 мест контрагента. Нет mapping — пустой массив. При пустом тексте остаётся частота; count(*) считает строки, включая legacy/hlavička, а не независимые документы |
| najdiRozuctovanie — там же:1309 | До 2 последних документов с разными predkontácie; максимум 24 detail-строки суммарно | Нет mapping/идентичности/подходящих строк — пусто. Один пример допустим. Это не гарантия двух полных документов и не проверка одинаковой формы |
| najdiKategorie — там же:1362 | До 5 категорий, их счета, исключения и формы; lexical-совпадения первыми, затем косинус | Пустой lineText — пусто. Нет пригодного вектора/embedding — только lexical. Другая agenda лишь ослабляет сигнал, не исключает категорию |
| tokenSet / textSimilarity — там же:70 | Ранжирование кандидатов и примеров, оценка для промпта | Удаляются короткие токены; score — пересечение, делённое на меньший размер множества. Вхождение короткого текста в длинный может дать максимум без тождества смысла. Пустой текст даёт нулевой score, не undefined |
| kosinus — server/services/embeddingService.ts:36 | Только оценка семантической близости категории; векторы целиком в промпт не входят | Непригодные/несовместимые векторы исключаются; нулевой результат не доказательство отсутствия нужной формы. Абсолютного порога достоверности семантической категории нет |
| zuzPonukuPredkontacii — accountingSuggestionService.ts:191 | До 25 predkontácie после ранжирования | Даже защищённые ID режутся окончательным cap; подробный охват Q25–Q26 |
| resolveSeriesDefault — там же:389 | Default сохраняемого číselný rad; модель видит список допустимых рядов | Explicit default, однозначный месячный ряд, история контрагента, затем использование. Supplier-порог считает строки, не документы; отсутствие mapping/подходящего ряда оставляет undefined |
| kvPreDruh — там же:259 | Нормализация KV по типу и podtyp | Замена B2 на B3 для PD уже есть; B1 автоматически не переписывается. Это не универсальное доказательство права на odpočet |
| kvPreClenenie — там же:842 | Fallback из kv_section | Если KV уже задан, fallback не арбитр; если kv_section пуста, по справочнику выводить нечего |
| silnePravidlo — там же:2001 | Потолок уверенности по совпадению hlavička | Не проверяет весь rozpis; форма фильтруется позже. Это не циклическое условие |
| odvodRozpis — uctoPravidlaService.ts:78 | Позиционный состав кодов и иногда стабильные доли абсолютных сумм | Недостаточное согласие длины/позиции или одинаковые режимы всех строк дают пустую форму. Это ещё не программа расчёта |

Лимиты в этой таблице — значения прочитанного кода, не статистика. MAX_PREDKONTACII_V_PONUKE, MIN_DOKLADOV и MIN_ZHODA разобраны с охватом выше. KATEGORIA_ISTOTA_OD используется для confidence, не как фильтр допуска категории в промпт:

server/services/accountingSuggestionService.ts:168 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
168: /** Od koľkých historických riadkov je kategória dosť overená na predvyplnenie. */
169: const KATEGORIA_ISTOTA_OD = 20;
170: 
```

Число реальных ответов, которым именно этот порог изменил уверенность, не измерено. Утверждение «он удалил кандидатов из контекста» неверно.

У odvodRozpis действительно есть нижняя граница Math.max в цитате выше, но callers уже проверяют поддержку. У анализа категорий SELECT категорий не имеет ORDER BY, тогда как история упорядочена:

server/services/uctoKategoriaRozpis.ts:23 (коммит e6f70c94c11bbce31ba9aa7828426b917c648686)

```text
23:   input: { tenantId: string; organizationId: string },
24: ): Promise<{ kategoriiSRozpisom: number }> {
25:   const kategorie = (await database.query<Record<string, any>>(
26:     'SELECT id, slovnik FROM ucto_kategorie WHERE tenant_id=$1 AND organization_id=$2 AND active=true',
27:     [input.tenantId, input.organizationId],
28:   )).rows.map((row) => ({ id: row.id as string, slovnik: row.slovnik }));
29:   if (kategorie.length === 0) return { kategoriiSRozpisom: 0 };
30: 
31:   const rows = (await database.query<Record<string, any>>(
32:     `SELECT agenda, doklad_cislo, coalesce(riadok_index, 0) AS riadok_index, line_text_normalized,
33:             suma, predkontacia_kod, clenenie_dph_kod, clenenie_kv_kod
34:        FROM ucto_historia
35:       WHERE tenant_id=$1 AND organization_id=$2 AND doklad_cislo IS NOT NULL
36:       ORDER BY agenda, doklad_cislo, coalesce(riadok_index, 0)`,
37:     [input.tenantId, input.organizationId],
38:   )).rows;
39: 
40:   const doklady = new Map<string, RozpisRiadok[]>();
```

Зависимость разрешения равенств от порядка выведена из кода; изменение результата повторных полных запусков на одинаковой БД не измерено. Ремонт — явные устойчивые ключи и правило неоднозначности. Риск — смена прежнего произвольного победителя; проверка до внедрения — чистый запуск с перестановками входа и сравнение выбранной формы, без сохранения в БД.

Другие границы, которые нельзя обобщать сильнее доказательств:

- agendaHistorie знает podtyp, но AI-путь передаёт в retrieval documentType без её вызова (accountingSuggestionService.ts:1142, :1590). Специальная FP/FV-история потому не полностью соответствует общей ветке; конкретные потерянные правильные ответы не измерены. Проверять на FP-D/FV-D с сохранением направления и podtyp.
- najdiRozdelenie использует сторону MD и исключение DPH-счёта (server/services/uctoDennikService.ts:193, :208), поэтому для FV может не увидеть структуру výnosy на DAL. Охват не измерен; перед изменением сопоставить доступные FV-проводки обеими сторонами, не переносить nákladový шаблон на výnosy.
- Отдельный číselník Forma úhrady Mostík не импортирует, однако фиксированные способы оплаты и часть экспортного поведения существуют. Отдельного импорта справочника Zákazka также нет, но zakazkaKod в denník читается и аналитики в модели документа предусмотрены. Это недостаток синхронизации справочников, а не полное отсутствие функциональности; перед расширением проверить соответствие уже сохранённых кодов источнику.
- Расхождения frontend/backend по срокам и обязательному номеру не дали затронутых текущих документов в Q23; отрицательный FP присутствует и требует сохранения знака. Пример нормализатора/валидаторов нельзя выдавать за массовую ошибку, не посчитав срабатывания.
- Клиентский XML-builder и серверный экспорт не полностью одинаковы, но рабочий REST-маршрут использует серверный. Само различие не доказывает неправильный production-экспорт. Проверка до внедрения — одинаковые тестовые документы через реально используемый маршрут и проверка полученного XML без отправки в POHODA.

## Повторить как раньше vs решить впервые

### Повторить как раньше: проект воспроизводимой памяти формы

Ответ на вопрос «что мешает сейчас»: ограничения существуют одновременно, но действуют на разных этапах. Часть истории не содержит detail; форма уже существует как rozpis, однако зависит от hlavička и позиций; поиск по контрагенту смешивает экономические ситуации; ponuka может исключить счёт формы; исполнитель не выражает объединение, знаковое zúčtovanie и связанные документы. Чтение не видит корпуса, но передачей истории в OCR эти ограничения не устранить. Увеличение контекста само по себе не восстановит отсутствующие сведения и операции.

Предлагаемый процесс:

- Сохранить прочитанные факты отдельно от бухгалтерского решения: печатные položky, рекапитуляции DPH, суммы/валюты/знаки, договор и период, идентичность сторон, назначение, ссылки на аванс и оплату. Каждое поле имеет происхождение и признак «неизвестно». Память может направить дополнительное чтение нужного реквизита, но не подменять напечатанное прошлым документом. Риск: повторное чтение создаст конфликт фактов; проверка — сопоставление исходного и нового значения по одному source ID с обязательным объяснением расхождения.
- Хранить форму как экономические роли и отношения: какие источники дают základ, иностранную DPH, istina, úroky, poplatok, nárok, zápočet; какие роли объединяются, разделяются, рассчитываются или переходят в связанный документ. Сохранять альтернативы, условия применимости, поддержку и противоречащие примеры. Риск: потерять привычные аналитические счета; проверка — каждый старый утверждённый rozpis должен представляться новой моделью без изменения счетов, режимов, знаков и итогов.
- Разделить устойчивость hlavička и формы. В группе контрагента искать сначала подходящий вид операции/договор/режим, затем пример формы; «один раз встречалось» оставить примером. Не огрублять токены и не объявлять cosine доказательством. Риск: слишком узкие условия дадут отсутствие примера; проверка — отдельные срезы повторного контрагента с тем же видом и того же контрагента с другим видом операции.
- После выбора формы разрешить все её счета в активные číselníky той же организации и agenda, затем добавить альтернативы. Отсутствующий ID не превращать в молчаливый fallback. Риск: устаревшая форма с закрытым счётом; проверка — список неразрешённых/чужих ID на имеющейся истории, без автоматической замены на похожее имя.
- Исполнить план детерминированно: покрыть источники, вычислить суммы, проверить знаки, základ/DPH/spolu, валюты, равенство MD/DAL там, где оно применимо, и отсутствие двойного отражения. Повысить confidence только после проверки всего результата. Риск: ошибочный допуск округления скроет недостачу; проверка — сверять документные итоги, каждую валюту и экономическую роль, сохранять явное zaokrúhlenie вместо незаметного остатка.
- Учиться на утверждённом результате вместе с исправлением и его причиной. Изменение назначения, права на odpočet или договора должно создавать вариант условия, а не переписывать все старые документы контрагента. Риск: принять разовую ошибку за правило; проверка — разногласия с прежними подтверждениями и временная проверка на следующем документе до изменения общей памяти.

| Область | Что именно повторять | Что нельзя копировать механически | Проверка до внедрения / риск |
|---|---|---|---|
| FP | Состав náklady/majetok, DPH/KV, иностранный налог, analytika и связанные обязательства | Hlavička поставщика для любой фактуры и старые доли суммы | Доступные FP + raw/normalized пары; риск удвоить налог или пропустить хвост |
| FV | Výnosy на DAL, zákazka, вид plnenie, направление и статус odberateľ | Nákladовый поиск по MD и режим другого покупателя | Сохранённые FV и направление MD/DAL; риск перенести входную DPH на výstup |
| OZ | Вид záväzok, договор, роли компонентов, срок и zúčtovanie | Единую сумму commitment вместо нескольких экономических компонентов | Исторические detail и договор; риск повторно создать уже существующий záväzok |
| INT | Тип события: samozdanenie, zápočet, zaokrúhlenie, начисление | Интерпретацию любого INT как mzdy | Разметить доступные INT по назначению; риск выключить нужную DPH-проверку |
| Касса VPD/PPD | Направление, реальный вид расхода/поступления и связь с оплатой | Режим FP или наиболее частую predkontácia кассы | PD из текущих данных и исторические оплаты; риск учесть расход повторно при úhrada |
| Mzdy | Структуру обязательств, расходов, удержаний и расчётов по payroll-источнику | Суммы/нормы предыдущего периода или любой общий INT | Имеющиеся MZDY после подтверждения, что это payroll; риск смешать начисление с выплатой |
| Zálohy | Цепочку vyplatenie/prijatie, налогового события, vyúčtovanie и возврата | Полный расход при каждом перемещении денег | История связанного аванса и расчёта; риск двойного расхода/DPH |
| Lízing | Роли istina, úroky, fin. sl. и договорный splátkový kalendár | Старые процентные доли и налог прошлого договора | Разные периоды одного договора; риск заново признать уже отражённую DPH |
| Samozdanenie | Связь источника с обязанностью начислить налог и отдельным правом на odpočet | Ручной INT без проверки уже существующего события | FP ↔ INT и итог признания налога; риск двойного начисления |

#### Лизинг: istina / úroky / fin. sl.

История должна учить соответствие роли аналитическому счёту фирмы, а splátkový kalendár и текущий документ — давать суммы. Названия 379101-istina, 379101.úroky и 379101..fin.sl.TL из задания — кандидаты для поиска, не проверенный здесь перечень фактических записей и не универсальный план счетов. Их частоты и принадлежность одному договору не измерены.

Предлагаемый расчёт для текущего периода:

splátka = istina + úroky + poplatky + poistné + DPH, подлежащая отражению по этому событию + знаковые корректировки.

Компоненты должны быть непересекающимися; правило явно указывает, включён ли налог в исходные суммы и был ли он уже признан при передаче предмета. Неизвестный остаток нельзя назвать úroky только для схождения итогов. fin. sl. — назначение строки, требующее классификации, а не автоматический синоним oslobodené plnenie. Квалификация finančný prenájom для учёта и поставки для DPH зависит от условий договора; база DPH может включать связанные проценты и административные платежи. [Finančná správa: учёт finančný prenájom](https://podpora.financnasprava.sk/054363-%C3%9A%C4%8Dtovanie-finan%C4%8Dn%C3%A9ho-pren%C3%A1jmu), [методическое разъяснение DPH при nájomná zmluva](https://www.financnasprava.sk/_img/pfsedit/Dokumenty_PFS/Zverejnovanie_dok/Dane/Metodicke_usmernenia/Nepriame_dane/2025/2025.04.29_002_DPH_2025_MU.pdf).

Риск — неверная периодизация, двойная DPH и копирование структуры после изменения договора. До внедрения сверить роли и знаки исторических OZ с календарём до/после изменения ставки, частичной оплаты или досрочного завершения. По одной ucto_historia можно проверить форму кодов, но экономический расчёт без договора не доказать; этого доступа здесь не было.

#### Расчёт аванса: cestovné / stravné / zúčtovanie

Выданный аванс, право работника на náhrada и окончательное zúčtovanie должны быть разными событиями. Проект расчёта:

nárok работника = подтверждённое cestovné + ubytovanie + рассчитанное stravné + другие признанные náhrady;

saldo = nárok работника − ранее выданные и относимые к поездке zálohy.

Положительный saldo даёт doplatok, отрицательный — vratka. Прямо оплаченные фирмой расходы и корпоративная карта не должны повторно возмещаться работнику. Stravné рассчитывается из обстоятельств поездки: времени, страны, обеспечения питанием и применимой версии норм, а не как сумма ресторанных чеков или доля прежнего документа. [Zákon o cestovných náhradách](https://static.slov-lex.sk/static/SK/ZZ/2002/283/20251101.print.html).

История учит фирменные счета для cestovné, stravné, záväzok и zúčtovanie. Названия cestovné381 или stravné381 сами по себе не доказывают правильность časové rozlíšenie. Движок сохраняет валюту и курс каждого события, знак расчёта, работника, поездку и ссылку на исходный аванс.

Риск — скопировать неверный nárok или погасить чужой аванс. До внедрения восстановить цепочки аванс → поездка → расчёт → возврат/доплата, сверить суммы и прямые оплаты. Исторические коды позволяют найти кандидатов, но не восстановить продолжительность поездки и питание; исходные cestovné príkazy здесь не доступны. Поддержка формулы остаётся проектом, а не подтверждённой точностью на корпусе.

### Решить впервые: проект решения при отсутствии подходящей истории

Начальная точка — классификация экономического события по первичным фактам. Новый поставщик не означает новый вид учёта, а знакомый поставщик не гарантирует знакомую операцию. Когда подходящей формы нет, система должна выбрать допустимую нормативную схему, запросить недостающий факт и только затем сопоставить роли со счетами фирмы.

| Область | Основание первого решения | Что обязано быть известно | Риск и проверка до внедрения |
|---|---|---|---|
| FP | Назначение покупки, náklad/majetok, страна и режим DPH | Факты plnenie и использование в деятельности | Неизвестную цель нельзя превратить в самый частый расход; проверить на отложенных FP новых контрагентов |
| FV | Вид продажи, место plnenie, статус покупателя, направление налога | Содержание услуги/товара, стороны, дата | Риск ошибочного KV; проверить на имеющихся FV с изменённым контрагентом при сохранённых фактах |
| OZ | Юридическое/экономическое основание záväzok | Договор, работник/контрагент, период, расчёт | Риск создать záväzok без основания; проверять на существующих OZ с независимым подтверждением основания |
| INT | Вид внутреннего события и необходимые связи | Источник суммы, период, счета обеих сторон | Риск скрытого manual-only провала; классифицировать имеющиеся INT и проверить доступность маршрута |
| Касса | Назначение, направление и факт оплаты | Документ покупки либо связь с уже учтённым обязательством | Риск повторного расхода; сверять VPD/PPD с оплачиваемым документом |
| Mzdy | Подтверждённый payroll-расчёт и вид события | Начисления, удержания, обязательства, период | Не выводить зарплату из банковской выплаты; проверить доступные MZDY и пометить неполный эталон |
| Zálohy | Вид аванса и его стадия | Получение/выдача, налоговое событие, vyúčtovanie | Риск преждевременного расхода/DPH; проверять полную цепочку и остаток |
| Lízing | Договорная квалификация и splátkový kalendár | Передача предмета, условия перехода собственности, компоненты и изменения | Нельзя угадать istina по общей сумме; применить описанную выше сверку с договором |
| Samozdanenie | Наличие обязанности начислить налог, отдельно условия odpočet | Вид/место plnenie, стороны, дата, использование и ранее отражённый налог | Риск начислить или вычесть без основания; проверить FP + уже существующие INT как одну цепочку |

AI предлагает мотивированный план: факты, нормативное основание, роли, соответствия číselník, формулы и необходимые связанные документы. Детерминированная часть проверяет арифметику, допустимость кодов/agenda, налоговое событие и отсутствие дубля. При недостаточном факте результат должен назвать именно недостающий факт, например назначение покупки или условия договора; отсутствие истории само по себе не основание копировать частый счёт.

Для лизинга впервые потребуется первичное заведение договора/календаря, а не история прошлых долей. Для командировочного аванса впервые — поездка, версия норм, расходы и ранее выданная сумма; затем тот же исполнитель cestovné/stravné/zúčtovanie. Эти расчёты общие с повторным сценарием; отличается источник выбора формы и полнота данных.

Изменение роли модели несёт риск, что корректная нестандартная операция окажется вне библиотеки схем. До внедрения брать реальные подтверждённые документы как временную отложенную выборку: скрывать соответствующую историю, оставляя первичные факты и доступные на ту дату číselníky. Оценивать допустимость экономического решения, а не совпадение текста reason. Сценарии без первичных данных отметить «не проверены», не включать их в общий показатель качества.

Не предлагаются установка pgvector, повторная ставка на semantic search, грубое сокращение токенов или снижение порога поддержки. Их прежние результаты из задания здесь не переизмерены; новых доказательств в пользу этих изменений нет. Устранение отсутствующего claim или знаковой формулы не требует изменения способа хранения векторов.

## Закон против привычки фирмы

### Что должно быть жёстким

В промпте должны быть требования определить вид и место plnenie, участников, даты, валюту, назначение и правовое основание; неизвестное не подменяется налоговым выводом. Иностранная DPH отделяется от словацкой. При samozdanenie обязанность начисления и право на odpočet рассматриваются раздельно. Физическое размещение результата в FP/INT — согласованная модель продукта и POHODA; история не разрешает ни пропуск, ни двойное отражение события. Применимая версия нормы выбирается по дате события, а не по дате последнего анализа. Основание: [Zákon o DPH](https://static.slov-lex.sk/static/SK/ZZ/2004/222/20260101.print.html).

Фраза действующего промпта «FOOD, DRINK AND HOSPITALITY NEVER DEDUCT» шире закона. Ограничение § 49 ods. 7 písm. a) связано с назначением pohostenie a zábava; название еды и ресторан сами по себе не устанавливают назначение. Finančná správa приводит случай питания, включённого в оплачиваемое školenie, для которого режим отличается. Поэтому нельзя механически запрещать odpočet по любой строке еды или любому продавцу питания. Неизвестная цель MANGI требует уточнения; неверно превращать общее бытовое название в юридический факт. [Finančná správa: условия и ограничения odpočítanie dane](https://www.financnasprava.sk/sk/podnikatelia/dane/dan-z-pridanej-hodnoty/odpocitanie-dane).

Эти принципы нужны и в промпте, и в исполняемой проверке после всех источников решения. Конкретные ставки/лимиты stravné и специальные режимы не следует вшивать навсегда в текст модели. Это проект архитектуры правовых правил, не полный аудит соблюдения всех норм по каждому документу.

### Что допустимо учить из истории фирмы

Predkontácia и analytika внутри допустимой экономической роли; stredisko, zákazka, číselný rad и организационная практика; структура подтверждённого rozpis, условия её применимости и связи документов; выбранный допустимый способ отражения и явно подтверждённый отказ от реализации права, если он законен. Привычка фирмы не создаёт право на odpočet, не определяет автоматически место plnenie и не заменяет исходный договор или cestovný príkaz.

Фирменные инструкции должны иметь область, основание, период действия и автора. Состояния «odpočet запрещён», «право есть, фирма его не реализует» и «фактов недостаточно» не должны сворачиваться в один PN/KN без объяснения.

### Правило арбитража

Сначала определить множество решений, допустимых по применимой норме и установленным фактам; внутри него выбрать подтверждённую практику фирмы. Если история противоречит ограничению, сохранить противоречие и его доказательство, предложить допустимый вариант и отправить на человеческое утверждение. Если неизвестен решающий факт, запросить его, не повышая confidence за частоту аналогичной проводки. Ручное утверждение сохраняется с причиной, но само по себе не превращает незаконную практику в законную.

Арбитр запускается после manual, saved rules, defaults, history и AI, затем ещё перед экспортом. Одно объяснение должно показывать происхождение счетов, налогового режима и сумм. При конфликте связанного FP/INT проверяется вся цепочка, а не каждый документ отдельно.

**Что сломает и как проверить.** Слишком общий запрет перекроет законное использование и привычную аналитику; неверная версия нормы даст ретроспективную ошибку. До внедрения классифицировать сохранённые overrides по основаниям, прогнать одни факты через все пути предложения/утверждения и сверить одинаковость налогового результата. Для hospitality включить различное подтверждённое назначение покупки; для samozdanenie — наличие и отсутствие уже отражённого INT; для лизинга — разные договорные режимы; для аванса — доплату и возврат. По доступным данным можно проверить программную согласованность и суммы, но окончательная правовая оценка требует первичных фактов, которых в этом аудите местами нет.

## Приложение A. Все запросы

Ниже приведены все восстановленные SQL-пакеты аудита и фактические потоки результата без сокращения таблиц или JSON. Q — ранее выполненные обращения в PostgreSQL; C — SELECT арифметики только в оперативной памяти над уже полученными значениями; N — не достигшие сервера попытки. C не является новым измерением production и не обращается к рабочей базе. Все C использовали SQLite :memory: только с SELECT, без создания таблиц или DML.

Исходные PostgreSQL-команды использовали psql с отключённым pager и ON_ERROR_STOP, read-only транзакции либо default_transaction_read_only; в SQL ниже сохранены BEGIN/ROLLBACK, где они были. В read-only диагностическом Q03 транзакционная обёртка не добавлена задним числом. Потоки вывода перенесены из результатов инструмента, поэтому ошибки содержат исходный stderr. Метаданные времени — время вызова инструмента, не общий MVCC-снимок.

Происхождение: журналы этой же задачи и её аудиторских подзадач, без чтения других пользовательских проектов:

- rollout-2026-09-09T12-35-31-01a085bc-b0a8-7e61-b09f-c7923b710a15.jsonl
- rollout-2026-09-09T12-38-56-01a085bf-d176-7731-a814-86057bcb3f74.jsonl
- rollout-2026-09-09T12-39-12-01a085c0-0e41-7fa2-8e17-a00eeeb3617f.jsonl
- rollout-2026-09-09T12-39-41-01a085c0-7a42-72d2-91e6-b42fce4c53e6.jsonl

Ограничения полноты архива: для Q02 сохранён лишь первый результат; для Q09 — BEGIN; для Q20/Q21 серверный поток строк был передан прямо в вычисление и отдельно не сохранён. Никаких недостающих строк здесь не восстановлено догадкой. Числа Q21 можно проверить по сохранённому выводу вычисления и его коду, но независимо пересчитать по исходным строкам без повторного SELECT нельзя.

<a id="q01"></a>

### Q01. Схема обследованных таблиц

Вызов: call_OtFQESKxp0Z3WamRr97AQi03. Время: 2026-09-09T11:26:01.413Z. Команда завершилась успешно.

```sql
BEGIN TRANSACTION READ ONLY;
SELECT table_name, string_agg(column_name || ':' || data_type, ', ' ORDER BY ordinal_position) AS columns FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('organizations','ucto_historia','ucto_kategorie','ucto_pravidla','ucto_decisions','ucto_opravy','ucto_presnost','ucto_dennik','code_list_items','documents','extraction_runs','accounting_suggestions','partners') GROUP BY table_name ORDER BY table_name;
ROLLBACK;
```

Фактический вывод:

```text
BEGIN
       table_name       |                                                                                                                                                                                                                                                                                                             columns                                                                                                                                                                                                                                                                                                              
------------------------+----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 accounting_suggestions | document_id:text, tenant_id:text, organization_id:text, predkontacia_id:text, clenenie_dph_id:text, ciselny_rad_id:text, stredisko_id:text, source:text, confidence:numeric, reason:text, based_on_document_id:text, created_at:timestamp with time zone, updated_at:timestamp with time zone, clenenie_kv_kod:text, rule_id:text, vysvetlenia:jsonb, riadky:jsonb
 code_list_items        | id:text, tenant_id:text, organization_id:text, kind:text, code:text, name:text, source:text, active:boolean, external_id:text, agenda:text, accounting_year:text, synced_at:timestamp with time zone, created_at:timestamp with time zone, updated_at:timestamp with time zone, last_number:text, kv_section:text, ucet_md:text, ucet_dal:text, tax_ratio_kod:text, iban:text, mena:text
 documents              | id:text, tenant_id:text, organization_id:text, queue_id:text, document_type:text, status:text, processing_status:text, source:jsonb, extracted:jsonb, accounting:jsonb, field_confidence:jsonb, confidence:numeric, total_amount:numeric, currency:text, history:jsonb, comments:jsonb, version:integer, approved_version:integer, approved_snapshot:jsonb, export_id:text, quarantine_reason:text, duplicate_of_document_id:text, not_duplicate:boolean, created_at:timestamp with time zone, updated_at:timestamp with time zone, applied_extraction_run_id:text, split_from_document_id:text, podtyp:text, pohoda_number:text
 extraction_runs        | id:text, tenant_id:text, organization_id:text, document_id:text, provider:text, model:text, prompt_version:text, schema_version:text, status:text, result:jsonb, error_code:text, error_message:text, latency_ms:integer, usage:jsonb, started_at:timestamp with time zone, completed_at:timestamp with time zone, created_at:timestamp with time zone
 organizations          | id:text, tenant_id:text, name:text, ico:text, dic:text, ic_dph:text, color:text, archived:boolean, created_at:timestamp with time zone, updated_at:timestamp with time zone, subject_type:text, street:text, city:text, zip:text, country:text, sender_whitelist:jsonb
 partners               | id:text, tenant_id:text, organization_id:text, name:text, name_normalized:text, ico:text, dic:text, ic_dph:text, iban:text, address:text, email:text, phone:text, default_predkontacia_id:text, default_clenenie_dph_id:text, default_stredisko_id:text, note:text, source:text, active:boolean, created_at:timestamp with time zone, updated_at:timestamp with time zone, updated_by:text
 ucto_decisions         | id:text, tenant_id:text, organization_id:text, document_id:text, supplier_ico:text, supplier_name_normalized:text, line_text_normalized:text, predkontacia_id:text, clenenie_dph_id:text, ciselny_rad_id:text, stredisko_id:text, clenenie_kv_kod:text, source:text, created_at:timestamp with time zone, excluded:boolean, polozky_ucto:jsonb, document_type:text, podtyp:text
 ucto_dennik            | id:text, tenant_id:text, organization_id:text, externalny_id:text, agenda:text, doklad_cislo:text, datum:date, text:text, suma:numeric, ucet_md:text, ucet_dal:text, partner_ico:text, partner_nazov:text, stredisko_kod:text, cinnost_kod:text, zakazka_kod:text, predkontacia_kody:ARRAY, created_at:timestamp with time zone
 ucto_historia          | id:text, tenant_id:text, organization_id:text, agenda:text, doklad_cislo:text, datum:date, supplier_ico:text, supplier_name_normalized:text, line_text_normalized:text, suma:numeric, sadzba_dph:numeric, predkontacia_kod:text, predkontacia_id:text, clenenie_dph_kod:text, clenenie_dph_id:text, clenenie_kv_kod:text, stredisko_kod:text, stredisko_id:text, source:text, riadok_hash:text, created_at:timestamp with time zone, suma_dph:numeric, riadok_index:integer
 ucto_kategorie         | id:text, tenant_id:text, organization_id:text, nazov:text, popis:text, slovnik:jsonb, predkontacia_kod:text, predkontacia_id:text, clenenie_dph_kod:text, clenenie_dph_id:text, clenenie_kv_kod:text, vynimky:jsonb, agendy:jsonb, pocet:integer, konflikt:text, active:boolean, created_at:timestamp with time zone, updated_at:timestamp with time zone, vektor:jsonb, vektor_model:text, rozpis:jsonb, pravna_poznamka:text
 ucto_opravy            | id:text, tenant_id:text, organization_id:text, document_id:text, document_type:text, podtyp:text, supplier_ico:text, supplier_name:text, navrhnute:jsonb, schvalene:jsonb, zmenene:ARRAY, navrh_zdroj:text, navrh_confidence:numeric, created_at:timestamp with time zone
 ucto_pravidla          | id:text, tenant_id:text, organization_id:text, agenda:text, protistrana:text, protistrana_ico:text, dokladov:integer, zhoda:integer, predkontacia_kod:text, clenenie_dph_kod:text, clenenie_kv_kod:text, rozpis:jsonb, created_at:timestamp with time zone
 ucto_presnost          | id:text, tenant_id:text, organization_id:text, delici_datum:date, vzorka:integer, vysledok:jsonb, rozdiely:jsonb, trvanie_ms:integer, created_at:timestamp with time zone
(13 rows)

ROLLBACK
```

<a id="q02"></a>

### Q02. Начальный снимок и незавершённый пакет

Вызов: call_3df5bNi1BrKdqAqYMn8YwxwY. Время: 2026-09-09T11:26:34.831Z. Завершение команды в доступном результате не подтверждено; нельзя считать весь пакет выполненным. Использован только возвращённый первый SELECT снимка; результаты остальных операторов этого пакета отсутствуют.

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT current_timestamp AS snapshot, count(*) AS history_rows, count(DISTINCT (tenant_id,organization_id,agenda,doklad_cislo)) AS history_docs, count(*) FILTER(WHERE riadok_index=0) AS headers, count(*) FILTER(WHERE riadok_index>0) AS detail_rows, count(*) FILTER(WHERE sadzba_dph IS NOT NULL) AS with_rate, count(*) FILTER(WHERE stredisko_kod IS NOT NULL) AS with_stredisko FROM ucto_historia;
SELECT o.name,h.agenda,count(*) AS rows,count(DISTINCT h.doklad_cislo) AS docs,count(*) FILTER(WHERE h.riadok_index>0) AS detail FROM ucto_historia h JOIN organizations o ON o.id=h.organization_id GROUP BY o.name,h.agenda ORDER BY o.name,h.agenda;
SELECT o.name,count(*) AS categories,count(*) FILTER(WHERE k.active) AS active,count(*) FILTER(WHERE k.active AND k.rozpis IS NOT NULL) AS active_forms,count(*) FILTER(WHERE k.active AND k.vektor IS NOT NULL) AS active_vectors FROM ucto_kategorie k JOIN organizations o ON o.id=k.organization_id GROUP BY o.name ORDER BY o.name;
SELECT o.name,c.kind,count(*) AS items,count(*) FILTER(WHERE c.active) AS active,count(*) FILTER(WHERE nullif(c.kv_section,'') IS NOT NULL) AS kv_filled FROM code_list_items c JOIN organizations o ON o.id=c.organization_id WHERE c.kind IN ('cleneniaDph','predkontacie') GROUP BY o.name,c.kind ORDER BY o.name,c.kind;
SELECT document_type,podtyp,count(*) AS docs,count(*) FILTER(WHERE jsonb_array_length(coalesce(extracted->'polozky','[]'))>15) AS gt15,count(*) FILTER(WHERE jsonb_array_length(coalesce(extracted->'polozky','[]'))=0 AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(extracted->'rozpisDph','[]')) v WHERE coalesce((v->>'dph')::numeric,0)<>0)) AS tax_without_items FROM documents GROUP BY document_type,podtyp ORDER BY document_type,podtyp;
SELECT 'ucto_decisions' AS tab,count(*) AS n FROM ucto_decisions UNION ALL SELECT 'ucto_opravy',count(*) FROM ucto_opravy UNION ALL SELECT 'ucto_presnost',count(*) FROM ucto_presnost UNION ALL SELECT 'ucto_pravidla',count(*) FROM ucto_pravidla UNION ALL SELECT 'ucto_dennik',count(*) FROM ucto_dennik UNION ALL SELECT 'documents',count(*) FROM documents UNION ALL SELECT 'extraction_runs',count(*) FROM extraction_runs UNION ALL SELECT 'accounting_suggestions',count(*) FROM accounting_suggestions UNION ALL SELECT 'partners',count(*) FROM partners;
SELECT id,tenant_id,organization_id,document_type,podtyp,status,extracted,accounting,applied_extraction_run_id FROM documents WHERE id IN ('45745064-e039-4bb2-a0c8-5bf54ae9a5f4','967302fa-b529-4a27-bdf2-293ce6e7339a');
SELECT document_id,provider,model,prompt_version,started_at,status,result FROM extraction_runs WHERE document_id IN ('45745064-e039-4bb2-a0c8-5bf54ae9a5f4','967302fa-b529-4a27-bdf2-293ce6e7339a') ORDER BY started_at;
SELECT a.*,p.code AS pred_code,p.name AS pred_name,d.code AS dph_code FROM accounting_suggestions a LEFT JOIN code_list_items p ON p.id=a.predkontacia_id LEFT JOIN code_list_items d ON d.id=a.clenenie_dph_id WHERE document_id IN ('45745064-e039-4bb2-a0c8-5bf54ae9a5f4','967302fa-b529-4a27-bdf2-293ce6e7339a');
ROLLBACK;
```

Фактический вывод:

```text
BEGIN
           snapshot            | history_rows | history_docs | headers | detail_rows | with_rate | with_stredisko 
-------------------------------+--------------+--------------+---------+-------------+-----------+----------------
 2026-09-09 11:24:26.507685+00 |        25952 |         9954 |    8616 |       10036 |         0 |              0
(1 row)

```

<a id="q03"></a>

### Q03. Диагностика активных запросов

Вызов: call_YgSguuVUuW1v43dzrbMdCrAy. Время: 2026-09-09T11:27:20.363Z. Команда завершилась успешно.

```sql
SELECT pid,state,wait_event_type,wait_event,left(query,240),now()-query_start AS elapsed FROM pg_stat_activity WHERE datname='dokladovka' AND application_name='psql';
```

Фактический вывод:

```text
   pid   | state  | wait_event_type | wait_event |                                                                                  left                                                                                  | elapsed  
---------+--------+-----------------+------------+------------------------------------------------------------------------------------------------------------------------------------------------------------------------+----------
 3409616 | active |                 |            | SELECT pid,state,wait_event_type,wait_event,left(query,240),now()-query_start AS elapsed FROM pg_stat_activity WHERE datname='dokladovka' AND application_name='psql'; | 00:00:00
(1 row)

```

<a id="q04"></a>

### Q04. Объём по фирме/agenda; первичная, затем исправленная метрика форм; справочники

Вызов: call_gjIjhgzckvmh6SAAybZkQ0vG. Время: 2026-09-09T11:27:53.030Z. Команда завершилась успешно. active_forms здесь проверяет IS NOT NULL и ошибочно включает JSON null. Для числа форм использовать Q05, а не этот столбец. Остальные результаты сохранены без подмены.

```sql
BEGIN READ ONLY;
SELECT o.name,h.agenda,count(*) AS rows,count(DISTINCT h.doklad_cislo) AS docs,count(*) FILTER(WHERE h.riadok_index>0) AS detail FROM ucto_historia h JOIN organizations o ON o.id=h.organization_id GROUP BY o.name,h.agenda ORDER BY o.name,h.agenda;
SELECT o.name,count(*) AS categories,count(*) FILTER(WHERE k.active) AS active,count(*) FILTER(WHERE k.active AND k.rozpis IS NOT NULL) AS active_forms,count(*) FILTER(WHERE k.active AND k.vektor IS NOT NULL) AS active_vectors FROM ucto_kategorie k JOIN organizations o ON o.id=k.organization_id GROUP BY o.name ORDER BY o.name;
SELECT o.name,c.kind,count(*) AS items,count(*) FILTER(WHERE c.active) AS active,count(*) FILTER(WHERE nullif(c.kv_section,'') IS NOT NULL) AS kv_filled FROM code_list_items c JOIN organizations o ON o.id=c.organization_id WHERE c.kind IN ('cleneniaDph','predkontacie') GROUP BY o.name,c.kind ORDER BY o.name,c.kind;
ROLLBACK;
```

Фактический вывод:

```text
BEGIN
                    name                     | agenda | rows | docs | detail 
---------------------------------------------+--------+------+------+--------
 AGS Bratislava International Movers, s.r.o. | FP     | 1534 |  391 |    518
 AGS Bratislava International Movers, s.r.o. | FP-D   |    6 |    6 |      0
 AGS Bratislava International Movers, s.r.o. | FV     | 1083 |  159 |    777
 AGS Bratislava International Movers, s.r.o. | FV-D   |   33 |    9 |     24
 AGS Bratislava International Movers, s.r.o. | INT    |  996 |  349 |    351
 AGS Bratislava International Movers, s.r.o. | OZ     |  479 |  143 |    336
 AGS Bratislava International Movers, s.r.o. | PPD    |    6 |    3 |      0
 AGS Bratislava International Movers, s.r.o. | VPD    |   78 |   25 |     31
 ALPINA EST s.r.o.                           | FP     | 3013 |  694 |   1058
 ALPINA EST s.r.o.                           | FP-D   |  138 |   39 |     60
 ALPINA EST s.r.o.                           | FV     |  106 |   45 |     16
 ALPINA EST s.r.o.                           | INT    | 2076 |  656 |    772
 ALPINA EST s.r.o.                           | OZ     | 4755 | 1787 |   1183
 ALPINA EST s.r.o.                           | PPD    |   33 |   16 |      1
 ALPINA EST s.r.o.                           | VPD    |  300 |   86 |    129
 RCI REAL CARGO INDUSTRY s. r. o.            | FP     |  142 |  142 |      0
 RCI REAL CARGO INDUSTRY s. r. o.            | FV     |  125 |  125 |      0
 RCI REAL CARGO INDUSTRY s. r. o.            | INT    |  189 |  189 |      0
 RCI REAL CARGO INDUSTRY s. r. o.            | PPD    |    4 |    4 |      0
 RCI REAL CARGO INDUSTRY s. r. o.            | VPD    |   46 |   46 |      0
 Recable, s.r.o.                             | FP     |  539 |  287 |      0
 Recable, s.r.o.                             | FV     |   56 |   56 |      0
 Recable, s.r.o.                             | INT    |  166 |  166 |      0
 Recable, s.r.o.                             | PPD    |    6 |    6 |      0
 Recable, s.r.o.                             | VPD    |  291 |  291 |      0
 SLO SERVICES, s. r. o.                      | FP     | 2933 | 1230 |    958
 SLO SERVICES, s. r. o.                      | FP-D   |   39 |   27 |     12
 SLO SERVICES, s. r. o.                      | FV     |  677 |  677 |      0
 SLO SERVICES, s. r. o.                      | FV-D   |    4 |    4 |      0
 SLO SERVICES, s. r. o.                      | INT    | 3554 | 1193 |   2361
 SLO SERVICES, s. r. o.                      | OZ     | 2442 | 1031 |   1411
 SLO SERVICES, s. r. o.                      | PPD    |   14 |   14 |      0
 SLO SERVICES, s. r. o.                      | VPD    |   89 |   51 |     38
(33 rows)

                    name                     | categories | active | active_forms | active_vectors 
---------------------------------------------+------------+--------+--------------+----------------
 AGS Bratislava International Movers, s.r.o. |         19 |     19 |           19 |             19
 ALPINA EST s.r.o.                           |         59 |     59 |           59 |             59
 RCI REAL CARGO INDUSTRY s. r. o.            |         12 |     12 |           12 |              0
 Recable, s.r.o.                             |         30 |     30 |           30 |              0
 SLO SERVICES, s. r. o.                      |         56 |     56 |           56 |             56
(5 rows)

                    name                     |     kind     | items | active | kv_filled 
---------------------------------------------+--------------+-------+--------+-----------
 AGS Bratislava International Movers, s.r.o. | cleneniaDph  |    91 |     91 |         0
 AGS Bratislava International Movers, s.r.o. | predkontacie |   795 |    783 |         0
 ALPINA EST s.r.o.                           | cleneniaDph  |    91 |     91 |         0
 ALPINA EST s.r.o.                           | predkontacie |  1141 |   1141 |         0
 BAJVET s.r.o.                               | cleneniaDph  |    91 |     91 |         0
 BAJVET s.r.o.                               | predkontacie |   284 |    284 |         0
 RCI REAL CARGO INDUSTRY s. r. o.            | cleneniaDph  |    91 |     91 |         0
 RCI REAL CARGO INDUSTRY s. r. o.            | predkontacie |   198 |    198 |         0
 Recable, s.r.o.                             | cleneniaDph  |    91 |     91 |         0
 Recable, s.r.o.                             | predkontacie |   609 |    607 |         0
 SLO SERVICES, s. r. o.                      | cleneniaDph  |    91 |     91 |         0
 SLO SERVICES, s. r. o.                      | predkontacie |   786 |    786 |         0
 Shenzhen Import s. r. o.                    | cleneniaDph  |    91 |     91 |         0
 Shenzhen Import s. r. o.                    | predkontacie |   228 |    228 |         0
(14 rows)

ROLLBACK
```

<a id="q05"></a>

### Q05. Корректные формы и векторы; текущие документы; объёмы таблиц; источники истории

Вызов: call_v1XpWaYUCsGE9eHo1hlQchdj. Время: 2026-09-09T11:28:21.779Z. Команда завершилась успешно.

```sql
BEGIN READ ONLY;
SELECT o.name,count(*) AS categories,count(*) FILTER(WHERE jsonb_typeof(k.rozpis)='array' AND jsonb_array_length(k.rozpis)>0) AS forms,count(*) FILTER(WHERE jsonb_typeof(k.vektor)='array') AS vectors FROM ucto_kategorie k JOIN organizations o ON o.id=k.organization_id WHERE k.active GROUP BY o.name ORDER BY o.name;
SELECT document_type,podtyp,count(*) AS docs,count(*) FILTER(WHERE jsonb_array_length(coalesce(extracted->'polozky','[]'))>15) AS gt15,count(*) FILTER(WHERE jsonb_array_length(coalesce(extracted->'polozky','[]'))=0 AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(extracted->'rozpisDph','[]')) v WHERE coalesce((v->>'dph')::numeric,0)<>0)) AS tax_without_items FROM documents GROUP BY document_type,podtyp ORDER BY document_type,podtyp;
SELECT 'decisions' AS tab,count(*) AS n FROM ucto_decisions UNION ALL SELECT 'opravy',count(*) FROM ucto_opravy UNION ALL SELECT 'presnost',count(*) FROM ucto_presnost UNION ALL SELECT 'pravidla',count(*) FROM ucto_pravidla UNION ALL SELECT 'dennik',count(*) FROM ucto_dennik UNION ALL SELECT 'documents',count(*) FROM documents UNION ALL SELECT 'runs',count(*) FROM extraction_runs UNION ALL SELECT 'suggestions',count(*) FROM accounting_suggestions UNION ALL SELECT 'partners',count(*) FROM partners;
SELECT source,count(*) AS rows,count(*) FILTER(WHERE riadok_index IS NULL) AS null_index,count(*) FILTER(WHERE riadok_index=0) AS headers,count(*) FILTER(WHERE riadok_index>0) AS details FROM ucto_historia GROUP BY source;
ROLLBACK;
```

Фактический вывод:

```text
BEGIN
                    name                     | categories | forms | vectors 
---------------------------------------------+------------+-------+---------
 AGS Bratislava International Movers, s.r.o. |         19 |     4 |      19
 ALPINA EST s.r.o.                           |         59 |     9 |      59
 RCI REAL CARGO INDUSTRY s. r. o.            |         12 |     0 |       0
 Recable, s.r.o.                             |         30 |     0 |       0
 SLO SERVICES, s. r. o.                      |         56 |    14 |      56
(5 rows)

 document_type | podtyp | docs | gt15 | tax_without_items 
---------------+--------+------+------+-------------------
 FP            | bezna  |   77 |    2 |                 1
 FV            | bezna  |   27 |    0 |                 0
 MZDY          | bezna  |    3 |    0 |                 0
 OZ            | bezna  |   12 |    0 |                 0
 PD            | bezna  |    6 |    0 |                 2
(5 rows)

     tab     |   n   
-------------+-------
 decisions   |  2052
 opravy      |     8
 presnost    |    20
 pravidla    |   255
 dennik      | 20689
 documents   |   125
 runs        |   144
 suggestions |   125
 partners    |  3248
(9 rows)

  source   | rows  | null_index | headers | details 
-----------+-------+------------+---------+---------
 mdb       | 24042 |       5390 |    8616 |   10036
 decisions |  1910 |       1910 |       0 |       0
(2 rows)

ROLLBACK
```

<a id="q06"></a>

### Q06. Фактические извлечение и предложение MANGI/DECATHLON

Вызов: call_NqqcradNOVkGfyS1IMUExqSQ. Время: 2026-09-09T11:29:09.349Z. Команда завершилась успешно.

```sql
BEGIN READ ONLY;
SELECT jsonb_build_object('id',id,'tenant',tenant_id,'org',organization_id,'type',document_type,'status',status,'extracted',extracted,'accounting',accounting,'run',applied_extraction_run_id) FROM documents WHERE id IN ('45745064-e039-4bb2-a0c8-5bf54ae9a5f4','967302fa-b529-4a27-bdf2-293ce6e7339a');
SELECT jsonb_build_object('doc',document_id,'model',model,'version',prompt_version,'started',started_at,'status',status,'result',result) FROM extraction_runs WHERE document_id IN ('45745064-e039-4bb2-a0c8-5bf54ae9a5f4','967302fa-b529-4a27-bdf2-293ce6e7339a') ORDER BY started_at;
SELECT jsonb_build_object('suggestion',to_jsonb(a),'pred_code',p.code,'pred_name',p.name,'dph_code',d.code) FROM accounting_suggestions a LEFT JOIN code_list_items p ON p.id=a.predkontacia_id LEFT JOIN code_list_items d ON d.id=a.clenenie_dph_id WHERE document_id IN ('45745064-e039-4bb2-a0c8-5bf54ae9a5f4','967302fa-b529-4a27-bdf2-293ce6e7339a');
ROLLBACK;
```

Фактический вывод:

```text
BEGIN
{"id": "967302fa-b529-4a27-bdf2-293ce6e7339a", "org": "dc65b03a-fff8-44ad-87b4-c0c205e40a1f", "run": "3784dfcd-abff-49d5-9185-4096603eb2d9", "type": "PD", "status": "na_kontrole", "tenant": "bddec5cd-09c6-4d99-a735-e525fbe51a0a", "extracted": {"mena": "EUR", "polozky": [], "dodavatel": {"obec": "Bratislava", "nazov": "DECATHLON", "ulica": "Bratislava", "adresa": "Bratislava, mestská časť Ružinov"}, "odberatel": {"ico": "35761571", "nazov": "AGS Bratislava International Movers, s.r.o."}, "rozpisDph": [{"dph": 1.85, "sadzba": 23, "zaklad": 8.05}], "sumaSpolu": 9.9, "textPolozky": "Nákup športového tovaru", "cisloFaktury": "08808", "datumDodania": "2026-05-12", "datumSplatnosti": "2026-05-12", "datumVystavenia": "2026-05-12"}, "accounting": {}}
{"id": "45745064-e039-4bb2-a0c8-5bf54ae9a5f4", "org": "dc65b03a-fff8-44ad-87b4-c0c205e40a1f", "run": "dd8c3d24-992d-4922-8fa0-0f7377819cf7", "type": "PD", "status": "na_kontrole", "tenant": "bddec5cd-09c6-4d99-a735-e525fbe51a0a", "extracted": {"mena": "EUR", "polozky": [], "dodavatel": {"nazov": "MANGI, s.r.o."}, "odberatel": {}, "rozpisDph": [{"dph": 4.11, "sadzba": 19, "zaklad": 75.69}], "sumaSpolu": 80, "textPolozky": "Stravovanie a nápoje", "cisloFaktury": "202605/242", "datumDodania": "2026-05-12", "datumSplatnosti": "2026-05-12", "datumVystavenia": "2026-05-12"}, "accounting": {}}
{"doc": "967302fa-b529-4a27-bdf2-293ce6e7339a", "model": "gpt-5-mini-2025-08-07", "result": {"buyer": {"ico": "35761571", "nazov": "AGS Bratislava International Movers, s.r.o."}, "taxDate": "2026-05-12", "currency": "EUR", "evidence": {"issueDate": [{"page": 1, "text": "12.05.2026 18:06:21"}], "totalAmount": [{"page": 1, "text": "Cena celkom: 9.90 EUR"}], "vatBreakdown": [{"page": 1, "text": "23% 8.05 1.85 9.90 EUR"}], "invoiceNumber": [{"page": 1, "text": "KOD TRANSAKCIE: 08808"}], "supplier.nazov": [{"page": 1, "text": "DECATHLON"}]}, "supplier": {"obec": "Bratislava", "nazov": "DECATHLON", "adresa": "Bratislava, mestská časť Ružinov"}, "totalVat": "1.85", "warnings": [], "issueDate": "2026-05-12", "lineItems": [], "totalAmount": "9.90", "documentType": "PD", "vatBreakdown": [{"vat": "1.85", "base": "8.05", "total": "9.90", "vatRate": "23"}], "invoiceNumber": "08808", "schemaVersion": "2", "documentSummary": "Nákup športového tovaru", "fieldConfidence": {"issueDate": 0.95, "totalAmount": 0.99, "vatBreakdown": 0.9, "invoiceNumber": 0.75, "supplier.nazov": 0.95}, "totalWithoutVat": "8.05", "additionalDocuments": []}, "status": "succeeded", "started": "2026-09-09T09:02:44.620339+00:00", "version": "invoice-sk-cz-v7"}
{"doc": "45745064-e039-4bb2-a0c8-5bf54ae9a5f4", "model": "gpt-5-mini-2025-08-07", "result": {"buyer": {}, "taxDate": "2026-05-12", "currency": "EUR", "evidence": {"issueDate": [{"page": 1, "text": "12.05.2026 19:57:43"}], "totalAmount": [{"page": 1, "text": "Celkom 80,00 EUR"}], "vatBreakdown": [{"page": 1, "text": "Suma 75,69 4,11 80,00"}], "invoiceNumber": [{"page": 1, "text": "DOKLAD C: 202605/242"}], "paymentMethod": [{"page": 1, "text": "Platobná karta"}], "supplier.nazov": [{"page": 1, "text": "MANGI, s.r.o."}]}, "supplier": {"nazov": "MANGI, s.r.o."}, "totalVat": "4.11", "warnings": [{"code": "invalid_vat_row", "message": "Rozpis DPH matematicky nesedí", "severity": "error"}, {"code": "total_mismatch", "message": "Celková suma nesedí s rozpisom DPH", "severity": "error"}, {"code": "declared_totals_mismatch", "message": "Deklarovaný základ a DPH nesedia s celkovou sumou", "severity": "error"}], "issueDate": "2026-05-12", "lineItems": [], "totalAmount": "80.00", "documentType": "PD", "vatBreakdown": [{"vat": "4.11", "base": "75.69", "total": "80.00", "vatRate": "19"}], "invoiceNumber": "202605/242", "schemaVersion": "2", "documentSummary": "Stravovanie a nápoje", "fieldConfidence": {"totalVat": 0.7, "issueDate": 0.9, "totalAmount": 0.9, "invoiceNumber": 0.75, "supplier.nazov": 0.85, "totalWithoutVat": 0.7}, "totalWithoutVat": "75.69", "additionalDocuments": []}, "status": "succeeded", "started": "2026-09-09T09:08:48.887345+00:00", "version": "invoice-sk-cz-v7"}
{"dph_code": "PN", "pred_code": "4V", "pred_name": "Nákup spotrebného materiálu", "suggestion": {"reason": "AI analýza dokladu: Ide o pokladničný doklad od maloobchodného predajcu; bez položiek a bez uvedenej sadzby DPH nemožno preukázať tuzemské zdaniteľné plnenie ani odpočet. Volím všeobecnú predkontáciu nákupu spotrebného materiálu a PN/KN podľa kontroly sadzieb DPH. Denník neobsahuje dostatočne podobný doklad od tejto zó", "riadky": null, "source": "ai", "rule_id": null, "tenant_id": "bddec5cd-09c6-4d99-a735-e525fbe51a0a", "confidence": 0.5500, "created_at": "2026-09-09T09:03:32.942349+00:00", "updated_at": "2026-09-09T09:04:07.898381+00:00", "document_id": "967302fa-b529-4a27-bdf2-293ce6e7339a", "vysvetlenia": null, "stredisko_id": null, "ciselny_rad_id": "4c01bf86-c048-48b6-b652-63d02f994107", "clenenie_dph_id": "462886dd-ae19-4efb-ba9d-c90fc1bf91e2", "clenenie_kv_kod": "KN", "organization_id": "dc65b03a-fff8-44ad-87b4-c0c205e40a1f", "predkontacia_id": "5234da86-2206-4209-be36-33c14e4a130b", "based_on_document_id": null}}
{"dph_code": "PN", "pred_code": "518900 ost.sl.", "pred_name": "Ostatné služby", "suggestion": {"reason": "AI analýza dokladu: Doklad PD nemá položky ani uvedenú sadzbu DPH, preto podľa konzistenčnej kontroly nejde o tuzemské zdaniteľné plnenie; volím PN a KV KN. Predkontácia 518900 vychádza z denníka pri obdobných hotovostných službách.", "riadky": null, "source": "ai", "rule_id": null, "tenant_id": "bddec5cd-09c6-4d99-a735-e525fbe51a0a", "confidence": 0.4500, "created_at": "2026-09-09T09:09:29.023181+00:00", "updated_at": "2026-09-09T09:09:55.857059+00:00", "document_id": "45745064-e039-4bb2-a0c8-5bf54ae9a5f4", "vysvetlenia": null, "stredisko_id": null, "ciselny_rad_id": "4c01bf86-c048-48b6-b652-63d02f994107", "clenenie_dph_id": "462886dd-ae19-4efb-ba9d-c90fc1bf91e2", "clenenie_kv_kod": "KN", "organization_id": "dc65b03a-fff8-44ad-87b4-c0c205e40a1f", "predkontacia_id": "95706487-67af-4618-b35b-61860ae19758", "based_on_document_id": null}}
ROLLBACK
```

<a id="q07"></a>

### Q07. Кассовые счета, история, партнёры и исправления

Вызов: call_RS8d2vxlHU8xWlijQjxvvoAx. Время: 2026-09-09T11:29:55.364Z. Команда завершилась успешно.

```sql
BEGIN READ ONLY;
SELECT c.code,c.name,c.agenda,c.ucet_md,c.ucet_dal,(SELECT count(*) FROM ucto_historia h WHERE h.organization_id=c.organization_id AND h.agenda='VPD' AND h.predkontacia_kod=c.code) AS vpd_rows,(SELECT count(DISTINCT h.doklad_cislo) FROM ucto_historia h WHERE h.organization_id=c.organization_id AND h.agenda='VPD' AND h.predkontacia_kod=c.code) AS vpd_docs FROM code_list_items c WHERE c.organization_id='dc65b03a-fff8-44ad-87b4-c0c205e40a1f' AND c.kind='predkontacie' AND (c.code LIKE '513%' OR c.code LIKE '518900%' OR c.name ILIKE '%repre%') ORDER BY c.code;
SELECT count(*) AS mangi_history FROM ucto_historia WHERE organization_id='dc65b03a-fff8-44ad-87b4-c0c205e40a1f' AND (supplier_ico='50444913' OR supplier_name_normalized LIKE '%mangi%');
SELECT name,ico,ic_dph,default_predkontacia_id FROM partners WHERE organization_id='dc65b03a-fff8-44ad-87b4-c0c205e40a1f' AND (name_normalized LIKE '%mangi%' OR name_normalized LIKE '%decathlon%');
SELECT created_at,navrhnute,schvalene,zmenene FROM ucto_opravy WHERE document_id IN ('45745064-e039-4bb2-a0c8-5bf54ae9a5f4','967302fa-b529-4a27-bdf2-293ce6e7339a');
ROLLBACK;
```

Фактический вывод:

```text
BEGIN
        code         |                 name                 |      agenda      | ucet_md | ucet_dal | vpd_rows | vpd_docs 
---------------------+--------------------------------------+------------------+---------+----------+----------+----------
 513100/325200-      | repre-platba kartou                  | commitment       | 513100  | 325200   |        0 |        0
 518900 des.s.-tuz.  | destination service tuzemsko         | receivedInvoice  | 518900  | 321100   |        0 |        0
 518900 ost.sl.      | Ostatné služby                       | cashPaid         | 518900  | 211100   |       34 |       10
 518900 ost.sl.-tuz. | ost.služby tuz.                      | receivedInvoice  | 518900  | 321100   |        0 |        0
 518900 ost.sl.s DPH | ost.služby vrátane DPH               | receivedInvoice  | 518900  | 321200   |        0 |        0
 518900 ost.služ.§69 | ost.služby zahr.                     | receivedInvoice  | 518900  | 321200   |        0 |        0
 518900/315200       | "rezerva" na dobr.k ostatným službám | internalDocument | 518900  | 315200   |        0 |        0
 PK repre            | repre-platba kartou                  | commitment       | 513100  | 325200   |        0 |        0
 PK-repre            | PK-repre                             | internalDocument | 513100  | 325200   |        0 |        0
 Repre               | Repre                                | receivedInvoice  |         |          |        0 |        0
 Repre-zahr.DDsluz   | Repre zahr.dodávateľ                 | receivedInvoice  | 513100  | 321200   |        0 |        0
 repre               | repre                                | cashPaid         | 513100  | 211100   |        0 |        0
(12 rows)

 mangi_history 
---------------
             0
(1 row)

         name          |    ico     |    ic_dph    | default_predkontacia_id 
-----------------------+------------+--------------+-------------------------
 DECATHLON             |            |              | 
 MANGI, s.r.o.         |            |              | 
 Decathlon SK s. r. o. | 47 658 827 | SK2024047542 | 
(3 rows)

 created_at | navrhnute | schvalene | zmenene 
------------+-----------+-----------+---------
(0 rows)

ROLLBACK
```

<a id="q08"></a>

### Q08. Полная ponuka PD и категории AGS; использование 518900

Вызов: call_3Id9ciHkQ6mNtMh4RvWQ9W55. Время: 2026-09-09T11:31:04.046Z. Команда завершилась успешно.

```sql
BEGIN READ ONLY;
SELECT jsonb_agg(jsonb_build_object('id',id,'kod',code,'nazov',name) ORDER BY code) FROM code_list_items WHERE organization_id='dc65b03a-fff8-44ad-87b4-c0c205e40a1f' AND kind='predkontacie' AND active AND code NOT ILIKE 'BEZ%' AND (agenda IS NULL OR agenda IN ('cashPaid','cashReceived'));
SELECT jsonb_agg(jsonb_build_object('name',nazov,'pred',predkontacia_kod,'id',predkontacia_id,'slovnik',slovnik)) FROM ucto_kategorie WHERE organization_id='dc65b03a-fff8-44ad-87b4-c0c205e40a1f' AND active;
SELECT source,riadok_index,count(*) FROM ucto_historia WHERE organization_id='dc65b03a-fff8-44ad-87b4-c0c205e40a1f' AND agenda='VPD' AND predkontacia_kod='518900 ost.sl.' GROUP BY source,riadok_index ORDER BY source,riadok_index;
ROLLBACK;
```

Фактический вывод:

```text
BEGIN
[{"id": "d7bb3358-9f2f-495e-b349-46421c75ba31", "kod": "10V", "nazov": "Úhrada mzdy spoločníka"}, {"id": "bfcda8b0-a4a5-4cbf-94e9-a2b3c8d853f3", "kod": "261/648", "nazov": "Odvod hotovosti na BÚ-cent.vyr."}, {"id": "64645030-dfbe-45f0-a244-a3f4fc5a1a58", "kod": "2V", "nazov": "Úhrada zálohovej faktúry"}, {"id": "2462c563-8e53-4e29-9d1f-5000a6f2effa", "kod": "3P", "nazov": "Prevod z účtu do pokladne"}, {"id": "30c4b569-86b7-4c77-9021-ca3bb3ecfd28", "kod": "4P", "nazov": "Peňažný vklad podnikateľa - úhrada imania"}, {"id": "5234da86-2206-4209-be36-33c14e4a130b", "kod": "4V", "nazov": "Nákup spotrebného materiálu"}, {"id": "240420ce-d464-4cdd-b553-c33a6cd7387b", "kod": "501200 SM", "nazov": "Spotr.mat."}, {"id": "4ab441d6-45ad-4ce9-beeb-966d71dedb72", "kod": "501400 KPaHP", "nazov": "Kanc. a hyg.potreby"}, {"id": "51e32a1a-a9b0-445a-a710-4ab4e77be253", "kod": "501600 Auto", "nazov": "Auto"}, {"id": "e284f89a-7ba0-4efd-b867-82f8a4910657", "kod": "501600 Auto NED", "nazov": "Auto Nedanovy"}, {"id": "95706487-67af-4618-b35b-61860ae19758", "kod": "518900 ost.sl.", "nazov": "Ostatné služby"}, {"id": "0ab8e4c1-1a03-479f-92b6-bf60a119f329", "kod": "548 NN", "nazov": "ostatné náklady"}, {"id": "03316f40-5c76-4c35-bd3e-d3a774b9131e", "kod": "548500 ost.N", "nazov": "Ost.náklady na HČ"}, {"id": "95176bcd-6a00-4515-9504-d15dad5c2446", "kod": "5V", "nazov": "Nákup ostatných služieb"}, {"id": "8c29ec8c-f350-476f-91ea-6c172b7ce570", "kod": "7V", "nazov": "Nákup cenín"}, {"id": "6cd79589-957d-4c07-9c20-d219bef1bc81", "kod": "8V", "nazov": "Poskytnutá záloha"}, {"id": "a063ed74-cfec-496a-a1e1-7e0ce8070dbf", "kod": "9V", "nazov": "Úhrada mzdy zamestnanca"}, {"id": "5063acb3-1356-4983-a1ac-56f73090e97d", "kod": "DPH AT", "nazov": "Neuplatnená DPH AT"}, {"id": "ee82ef40-dfb1-42dc-b235-9dd54d428803", "kod": "Dotácia", "nazov": "Dotácia pokladne"}, {"id": "227041e2-9473-4872-b3be-80f96b1eb2f5", "kod": "Kanc.hyg.potreby", "nazov": "Kanc.hyg.potreby"}, {"id": "f51cb7d0-bd14-4c04-99bb-3ded72a60b28", "kod": "Mzdy", "nazov": "Mzdy"}, {"id": "b1e0a127-0d5a-4183-a9eb-a3a28e28289a", "kod": "Opravy a udržiavani", "nazov": "Opravy a udržiavanie"}, {"id": "823f9b0a-6dd0-4f43-a95c-55f07392aa8c", "kod": "Ost.pokuty a penále", "nazov": "Ost.pokuty a penále a úrok z om."}, {"id": "945cf563-1d31-40a4-93b6-191ade33f2d7", "kod": "Ost.služby nedaň", "nazov": "Nákup ostatných služieb"}, {"id": "c5c34479-2396-4f61-a1b6-ce39bf1d758e", "kod": "PC", "nazov": "Úhrada cestovných nákladov"}, {"id": "ef2bdb4a-1202-400c-8139-dcb2a967bf8c", "kod": "Prenájom", "nazov": "Prenájom"}, {"id": "b73d87cd-6119-44e3-8c44-f24248f7c4f4", "kod": "Prijatá záloha", "nazov": "Prijatá záloha"}, {"id": "f23dd3ca-3eb6-4165-9ad6-1c7c35d58045", "kod": "Spot.mat.", "nazov": "Spot.mat."}, {"id": "067c4779-84d0-409c-abb1-1ff62e39f931", "kod": "bank.popl", "nazov": "poplatok bankový"}, {"id": "2397adbf-e0a8-47cf-8fba-9f47613ee0d9", "kod": "cp1Pp", "nazov": "Preplatok zamestnanec"}, {"id": "a5d5fd85-60ab-4556-aef5-43ecee1bb7f3", "kod": "cp1Pv", "nazov": "Výplata zálohy zamestnancovi"}, {"id": "fb87cf67-b46d-4ef3-a7b5-3c234629077e", "kod": "cp2Pp", "nazov": "Preplatok spoločník"}, {"id": "f14de850-2f90-4948-aa4c-b0537ae2ea03", "kod": "cp2Pv", "nazov": "Doplatok (v hotovosti) zamestnanec"}, {"id": "f5ec73a4-89e6-48e7-91c0-be4387005496", "kod": "cp3Pv", "nazov": "Výplata zálohy spoločníkovi"}, {"id": "4064cb4f-8f84-48dd-9267-246a51e5d5cc", "kod": "cp4Pv", "nazov": "Doplatok (v hotovosti) spoločník"}, {"id": "ebfdce58-3434-4069-aee7-36f380849959", "kod": "cv", "nazov": "zaokrúhlenie zo zákona"}, {"id": "be4d3012-fd62-476d-9d5b-e7872fac8450", "kod": "dfa uhrada", "nazov": "Úhrada faktúry"}, {"id": "c4fd2e88-8fa6-410b-89ac-a308ccaeedad", "kod": "dfa uhrada zahr", "nazov": "Úhrada faktúry"}, {"id": "1b0e873c-9a3a-41af-883f-69571bd8bfa7", "kod": "exekúcie", "nazov": "exekúcie"}, {"id": "8fc2a0c6-1b16-4e01-bc99-5e5f3051b73f", "kod": "inkaso VFA", "nazov": "Úhrada zálohovej faktúry"}, {"id": "c7abb69b-6d2d-43ee-b032-5adee1949ca2", "kod": "inkaso VFA zahr.", "nazov": "Úhrada zálohovej faktúry"}, {"id": "e098bf93-a3df-4384-a2ad-67822b7d439c", "kod": "kPp", "nazov": "Uzávierka kurzových rozdielov - kurzový zisk"}, {"id": "178e27b6-a32c-4615-9a46-b1cb79f12a31", "kod": "kPv", "nazov": "Uzávierka kurzových rozdielov - kurzová strata"}, {"id": "264eac44-ec3c-44b5-97da-85a16750221d", "kod": "kurz.zisk EUR", "nazov": "kurzový zisk v EUR pokladni"}, {"id": "ce88df8d-0d3e-463a-b7ba-7c6f89d70e66", "kod": "ost.dane a poplatky", "nazov": "ostatné dane a poplatky"}, {"id": "88c6246e-0aed-4067-93bc-0953acf8438e", "kod": "ostatné náklady", "nazov": "ostatné náklady"}, {"id": "6cd11af0-7f8d-422d-8e82-0988aa23b1aa", "kod": "parkovné tuz.", "nazov": "parkovné tuz."}, {"id": "064f2e61-eea9-47a8-aecf-3a4a1df727c9", "kod": "pohľ.voči spol.", "nazov": "pohľ.voči spoločníkovi"}, {"id": "1aaed7f9-4d91-40b8-afda-d162284973d7", "kod": "pohľ.zam.", "nazov": "pohľ.zam."}, {"id": "cbb7a36f-601f-49ec-9559-70195088d616", "kod": "pošta", "nazov": "poštovné"}, {"id": "bb63653f-e77d-4e62-bd82-ba110641ba1b", "kod": "prac.oblečenie", "nazov": "prac.oblečenie"}, {"id": "0b4afc2a-ea40-4503-bdbd-8d96f015269d", "kod": "prebytok", "nazov": "prebytok"}, {"id": "0b98e174-4141-43f0-a01a-75136437ded0", "kod": "prechodné položky", "nazov": "ost.pohľ.-prechodné položky"}, {"id": "b2d034cf-935b-43ea-b5c3-0d6ea0a76a13", "kod": "prenájom dodávky", "nazov": "prenájom dodávky"}, {"id": "1ec50260-eb76-468e-983f-e7a55d09ed16", "kod": "prepravné", "nazov": "prepravné"}, {"id": "a297f582-d187-4903-bc50-81b50f2b94bd", "kod": "repre", "nazov": "repre"}, {"id": "1f421568-2ec1-4cf8-8cec-5b39d5b2b7ac", "kod": "spot.ned", "nazov": "PHM"}, {"id": "fd8806fc-b9e9-48a4-b3b6-9cb0d1fe0fa6", "kod": "vklad na účet", "nazov": "Odvod hotovosti na BÚ"}, {"id": "c433396d-3649-40b1-9ea1-40493852997d", "kod": "zák.soc.N-ostatné", "nazov": "zák.soc.náklady-ostatné"}, {"id": "928c4e38-9e00-4235-b128-035e642889a4", "kod": "záv.zam.", "nazov": "záv.zam."}, {"id": "69f00315-9fe0-4a49-9530-fa3d98d2a257", "kod": "úhr.ost.záv.", "nazov": "úhrada ostatných záväzkov"}]
[{"id": "c988c003-9946-413a-b32c-b01684be5d11", "name": "sťahovanie a súvisiace služby", "pred": "602100 sťah.-zahr.", "slovnik": ["stahovanie", "sťahovanie", "stahovacie sluzby", "door to door removal service", "sťahovacie sluzby", "crate utilization", "long-carry charges", "stair-carry charges", "uncrating", "warehouse handling charges in/out", "warehouse handling charges", "warehouse handling", "manipulácia", "manipulacia", "sťahovacie", "stahovacie", "door to door", "dobr.k fv sťahovanie", "sťahovanie §43", "sťahovanie §47", "manufacture of crate(s)", "manufakture of crate(s)", "recycling of the used furniture", "sťahovanie - §48 ods.8 zákona", "iné poplatky", "preprava door-to-door", "stahovanie - §48", "prepravne, skladovacie a doplnkove sluz", "sťahovanie - §48", "sťahovanie - §48 ods.6"]}, {"id": "54039dd7-bb97-4527-bb25-af62ae78a2b4", "name": "preprava a doprava tovaru (freight)", "pred": "518200 prepr.-tuz.", "slovnik": ["preprava", "preprava - sea freight", "preprava (oslobodené dodanie)", "transport", "sea freight", "ocean freight", "basic ocean freight", "air freight", "prepr.tu.§69", "prepr.-zahr", "haulage", "letecká preprava", "prepr.-tuz.", "medzinárodná cestná preprava", "cestná doprava", "prepr.-zahr.", "preprava 40hc", "preprava 20'", "preprava (oslobodene)", "road transport services", "line-haul", "prepr.-tuz.oslobod", "preprava tovaru", "awb", "awb & labels", "preprava awb", "road transport services ref", "awb 057-59433522", "preprava a sprievodne poplatky za kontaj", "prepravne"]}, {"id": null, "name": "reprezentácia a pohostenie", "pred": "Repre", "slovnik": ["repre", "reprezentacia", "coffee", "kava", "lavazza", "crema e aroma", "coffee lavazza", "material", "material (repre)"]}, {"id": null, "name": "preúčtovanie DPH (interné OZ zápisy)", "pred": null, "slovnik": ["preúčt.dph", "preuct.dph", "preúčt.dph 23% výstup tuz.", "preúčt.dph 19% vstup tuz.", "preúčt.dph vstup eu samozdanenie", "preúčt.dph výstup eu samozdanenie", "priznanie dph", "priznanie dph z nadobudnutia", "priznanie dph z nadobudnutia služby", "odpočet dph", "odpočet dph z nadobudnutia tovaru a sluz", "odpocet dph", "priznanie dph z nadobudnutia služ", "fp č.", "oz č.", "odpočet dph z nadobudnutia tovaru a služ", "priznanie dph z nadobudnutia služby, fp", "odpocitanie dph", "vymeranie dph", "dph - odpočet", "priznanie dph z nadobudnutia sluzby", "odpocet dph z nadobudnutia tovaru a sluz", "preúct.dph", "odpočítanie dph", "odpočet dph z nadobudnutia", "vymeranie dph, fp č.", "aInt", "bInt", "odpocet dph z nadobudnutia"]}, {"id": null, "name": "mzdy a súvisiace odvody (mzdové zúčtovanie)", "pred": null, "slovnik": ["mzdy", "mzda zamestnanca", "mzdy 2026", "zdravotné poistenie", "sp zamestnanec", "sp organizácia", "sp zam.", "sp org.", "mzda", "mzdy 2026/05", "hrubá mzda", "mzdy vyplatené v hotovosti", "DzP FO ZČ", "SP zam.", "SP org.", "SP zam", "12socN", "Mzda", "Mzdy-tvorba sf", "náhrady príjmu", "náhrady prijmu", "úhrada mzdy", "starobné poistenie", "zdravotné poist.", "mzdy-tvorba sf", "povinný prídel do sf", "hruba mzda", "uhrada mzdy", "vyplatene v hotovosti", "dzp fo"]}, {"id": "cee845fb-24e4-4443-a365-1c2b86c9c537", "name": "pokuty, upomienky a nedaňové položky", "pred": "Nedaňové služby", "slovnik": ["upomienka", "pokuta", "parkovné at pokuta", "nedaňové služby", "(nedaňová časť 0 %)", "parkovné at-pokuta", "poplatok za upomienku", "nedaňové"]}, {"id": "d8ba9c77-3aaf-41f6-91dd-b37b7797bec7", "name": "skladovanie a skladné", "pred": "602200 sklad.-tuz.", "slovnik": ["skladné", "skladovanie", "skladovanie sk", "skladné december", "skladné 01.11-30.11", "skladné 01.12.2025 - 31.12.2025", "skladovanie sk 01.2026", "skladne", "storage", "skladovanie (storage)", "carton storage", "storage tva", "lagergeld", "skladovanie kartónov", "skladovanie v bratislave", "storage (po number", "602200 sklad.-tuz.", "storage (po number)", "skladovanie kartonov", "storage at destination", "storage | warehouse handling charges"]}, {"id": "647cf067-d3a9-45dd-b73b-536f9cb043ec", "name": "diaľničné známky a mýto", "pred": "501200/325200", "slovnik": ["dialnicna znamka", "diaľničná známka", "diaľnicna", "diaľn. znamka", "dálnicna znamka", "diaľničná znamka at"]}, {"id": "7303a9b2-72ae-4032-9a66-15cd7069c461", "name": "destination/origin handling (poplatky pri origin/destination a zásobní manipulač", "pred": "destinat.ser. D§69", "slovnik": ["destination service", "origin service", "standard destination service", "origin charges", "destination charges", "terminal handling charges", "terminal handling service - origin", "terminal handling charges at destination", "terminal handling service", "documentation fee- origin", "destination services", "destination", "destination - destination services", "spot booking amendment fee", "local charges", "standard destination service | terminal", "storage at destination", "lagergeld", "destination service | terminal", "destinačné", "demurrage dest", "terminal handling", "chassis fee", "drop off", "stairs carry", "destination service | stairs carry", "isf charge", "destinat.ser. d§69", "stair-carry charges", "stair-carry"]}, {"id": "a3f2b26c-9fd5-4a4c-b167-781793b3f4c3", "name": "colné služby / clenie / custom clearance", "pred": "colné slu-zahr.D§69", "slovnik": ["custom clearance", "clenie", "colné služby", "colne sluzby", "colný sklad", "colny sklad", "colne sluzby - oslobodene", "clenenie", "clearance", "clearance and waste disposal", "colna kontrola", "t-1 erledigung", "colno deklara", "colno deklara né služby", "poplatky za colné odbavenie", "importabfertigung", "importné colné služby", "importabfertigung im hza-wien", "zollsiegel", "colne", "518910 colné sl-tuz", "t-1", "colno deklara ne sluzby", "colné", "import customs clearance"]}, {"id": "25b7176c-b0a4-4485-8c11-ce987cc646d2", "name": "parkovanie / parkovné", "pred": "park.-zahr.DD§69", "slovnik": ["parkovanie", "parkovné", "parking permit", "parkovné at-platba kartou", "parkovné at pokuta", "parkovné bratislava", "parkovné at-dph", "parkovne", "park.-zahr.DD§69", "parking permit on", "parkovanie vienna", "parkovacie povolenie", "parkovacie povolenie vo viedni", "parkovne vienna", "parkovné at-pokuta", "parkovacie povolenie – viedeň", "parkovné vo viedni", "518400/325200-", "park.-zahr.dd§69"]}, {"id": "71dbe8ec-8749-42ae-a7ff-0f9a2ba42340", "name": "prepravné príplatky a handling poplatky (THC, bunker, emission)", "pred": "518900 ost.služ.§69", "slovnik": ["thc", "emission surcharge", "emergency bunker surcharge", "documentation fee- origin", "basic ocean freight", "export intermodal fuel fee", "inland haulage export", "terminal handling charges", "congestion surcharge", "rail infrastructure surcharge", "terminal handling service", "detention fees", "demurrage", "demurrage dest", "exportné prepravné služby", "empty drop off merchant haulage fee", "detention", "bunker surcharge", "518900 ost.služ.§69", "emission surcharge spot"]}, {"id": "82452d2d-6d29-4929-b70d-1529c7e00c62", "name": "nájom nehnuteľností (kancelárie, sklady)", "pred": "518100 nájom-tuz.", "slovnik": ["nájom nehnut.-kancelárie", "najem nehnut.-kancel.", "prenájom nehnut.-sklad", "prenajom nehnut.-sklad", "prenájom nehnut.-kancel.", "pb podnájom nehnuteľnosti", "nájom-tuz.", "najomne", "najemne zahr.", "najomne zahr.", "najem nehnut.-sklad", "podnájom skladových priestorov", "najem", "podnájom spevnenej plochy", "518100 nájom-tuz."]}, {"id": "8212d29e-6bf7-4194-914a-df0402460b8d", "name": "telefón, mobil, internet a hlasové služby", "pred": "518300 tel.sl.-tuz.", "slovnik": ["telefon", "telefón-mobil", "telefon-mobilna siet", "volanie do zahr.", "hlasová služba voip", "voip", "internet", "telekom", "telefón-mobilná sieť", "telefon-mobil", "internetové pripojenie", "internetove pripojenie", "mobilné služby", "mesačný poplatok", "mobilné služby -", "518300 tel.sl.-tuz.", "mobilne sluzby", "mobilne sluzby -", "0911511422", "0903561886", "hlasova sluzba"]}, {"id": "16ca6e52-e85e-4c23-a1e9-bc9057700938", "name": "PHM a pohonné hmoty", "pred": "501100 PHM-tuz.", "slovnik": ["phm", "fuel", "motor spirit", "phm zahr.", "phm bl680jn", "phm ba102ov", "routex poplatky", "omv letna zmes", "dph z phm", "super(95) unlead", "phm bbl642jj", "phm bbl642jj (nedaňová časť 20 %)", "bl 642 jj (nedaňová časť 20 %)", "phm manager", "PHM vrátane DPH", "diesel", "bl642jj", "bbl642jj", "phm bl642jj", "phm (nedaňová)", "manager (daňová časť)", "routexpoplatky", "501100 PHM-tuz.", "palivový příplatek", "palivový příplatek - cpa", "ba 102 ov", "501100 phm-tuz.", "palivo", "ba-panonska", "bl680jn"]}, {"id": "4aacff4b-9898-4c60-b8b1-a1d964841405", "name": "baliaci a spotrebný materiál", "pred": "501200 sp.mat.-tuz.", "slovnik": ["baliaci material", "baliaci m.", "spotr.mat", "spotr.mat.-mixed", "pracovné oblečenie", "pracovne oblecenie", "crate utilization", "spotrebny material", "spotrebny", "PK spot.mat.", "protináraz", "protináraz bub folia", "liquid soap", "dish sponge", "kastik plast", "jdn dtco kastik plast", "obalový materiál", "protináraz.bub.fól", "kontajner 5 vl", "kontajner 5 vl - dno veko", "strojcek na lepiacu pásku", "euroobal", "oz", "protináraz bub.fólia", "501200 sp.mat.-tuz.", "501300 baliaci m.", "protinaraz", "bub.fólia", "permanentný popisovač", "konektor"]}, {"id": "82452d2d-6d29-4929-b70d-1529c7e00c62", "name": "nájom vozidiel", "pred": "518100 nájom-tuz.", "slovnik": ["najem au", "nájom 6/26 fiat aa654mr", "nájom nehnut.-sklady", "nájom 02-03/26 - citroen c4 ab177fr", "ab177fr", "aa654mr", "bt963hm", "bt963hm (nedaňová časť 0 %)", "ab177fr (daňová časť 100 %)", "nájom 6/26 fiat", "nájom 02-03/26", "najem", "nájom Au NE", "Auto NED", "nájom au", "aa654mr (nedaňová časť 0 %)", "aa654mr (daňová časť 100 %)", "najom au", "nájom", "fiat duc.maxi", "nájom-tuz.", "518100 nájom-tuz.", "518100 nájom Au NE"]}, {"id": "aa78e314-fb95-4da5-a8f9-89c1c95b2966", "name": "servis a opravy vozidiel / technické služby", "pred": "518900 ost.sl.-tuz.", "slovnik": ["car service", "car service bl728nb", "car service bl642jj", "servis a údržba vzv", "servisné prace", "servisný poplatok", "servis-tuz.", "servis", "servisné práce", "oprava", "servisne prace", "forklift technical control", "technicka kontrola vzc", "mont b verzia", "montaz", "car wash"]}, {"id": "19d34daa-fef2-43c9-9bcd-a7ce410a45db", "name": "spracovanie účtovníctva a účtovné služby", "pred": "518600 účto tuz.", "slovnik": ["sprac.účtovníctva", "sprac.účtovníctva a miezd", "sprac.účto.dokladov", "sprac.účt.dokladov", "spracovanie účtovných dokladov", "spracovanie účtovných dokladov za mesiac", "spracovanie uctovnictva", "spracovanie uct.zavierky", "spracovanie uct.zavierky a dpp0", "spracovanie účt.závierky", "účtovníctvo", "administratíva", "naskenovanie a zaslanie správ z elektron", "správa elektronickej schránky", "518600 účto tuz.", "spracovanie účtovníctva", "uctovníctvo"]}]
mdb|0|10
mdb|1|9
mdb|2|3
mdb|3|3
mdb||9
ROLLBACK
```

<a id="q09"></a>

### Q09. Попытка подробного чтения длинных FP без возвращённого результата

Вызов: call_J6KQQ8j2RwunUnmIPpdmEwZt. Время: 2026-09-09T11:31:48.652Z. Завершение команды в доступном результате не подтверждено; нельзя считать весь пакет выполненным. Сохранён только BEGIN; фактов о выбранных документах этот результат не даёт. Успешная компактная проверка — Q10.

```sql
BEGIN READ ONLY;
SELECT jsonb_build_object('doc',d.id,'org',o.name,'supplier',d.extracted->'dodavatel'->>'nazov','type',d.document_type,'rawCount',jsonb_array_length(r.result->'lineItems'),'items',d.extracted->'polozky','vat',d.extracted->'rozpisDph','foreignTax',d.extracted->'cudziaDan','suggestionRows',a.riadky,'reason',a.reason) FROM documents d JOIN organizations o ON o.id=d.organization_id LEFT JOIN extraction_runs r ON r.id=d.applied_extraction_run_id LEFT JOIN accounting_suggestions a ON a.document_id=d.id WHERE jsonb_array_length(coalesce(d.extracted->'polozky','[]'))>15;
SELECT count(*) AS decisions_repre_pd FROM ucto_decisions d JOIN code_list_items c ON c.id=d.predkontacia_id WHERE d.organization_id='dc65b03a-fff8-44ad-87b4-c0c205e40a1f' AND d.document_type='PD' AND c.code='repre';
SELECT count(*) AS dennik_repre_mangi FROM ucto_dennik WHERE organization_id='dc65b03a-fff8-44ad-87b4-c0c205e40a1f' AND (partner_ico='50444913' OR lower(partner_nazov) LIKE '%mangi%');
ROLLBACK;
```

Фактический вывод:

```text
BEGIN
```

<a id="q10"></a>

### Q10. Компактный результат по длинным W.A.G.; дополнительные контрольные выборки

Вызов: call_PM18LOiPue3pLjsntcApgKmh. Время: 2026-09-09T11:32:20.621Z. Команда завершилась успешно.

```sql
BEGIN READ ONLY;
SELECT d.id,o.name,d.extracted->'dodavatel'->>'nazov' AS supplier,jsonb_array_length(r.result->'lineItems') AS raw_count,jsonb_array_length(d.extracted->'polozky') AS normalized_count,d.extracted->'cudziaDan' AS foreign_tax,a.riadky,a.reason FROM documents d JOIN organizations o ON o.id=d.organization_id LEFT JOIN extraction_runs r ON r.id=d.applied_extraction_run_id LEFT JOIN accounting_suggestions a ON a.document_id=d.id WHERE jsonb_array_length(coalesce(d.extracted->'polozky','[]'))>15;
SELECT count(*) AS decisions_repre_pd FROM ucto_decisions d JOIN code_list_items c ON c.id=d.predkontacia_id WHERE d.organization_id='dc65b03a-fff8-44ad-87b4-c0c205e40a1f' AND d.document_type='PD' AND c.code='repre';
SELECT count(*) AS dennik_mangi FROM ucto_dennik WHERE organization_id='dc65b03a-fff8-44ad-87b4-c0c205e40a1f' AND (partner_ico='50444913' OR lower(partner_nazov) LIKE '%mangi%');
ROLLBACK;
```

Фактический вывод:

```text
BEGIN
                  id                  |          name          |            supplier            | raw_count | normalized_count | foreign_tax | riadky |                                                                                                                                                    reason                                                                                                                                                    
--------------------------------------+------------------------+--------------------------------+-----------+------------------+-------------+--------+--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 163d007b-4d99-473b-9b70-8052d60d07c0 | SLO SERVICES, s. r. o. | W.A.G. payment solutions, a.s. |        17 |               17 | 1194.43     |        | Podľa denníka firmy (3× rovnako): Podľa denníka tej istej protistrany a zhodných príkladov „mýto it-axxes“ ide o zahraničné mýto na 518202-myto. Talianska 22 % DPH je zahraničná DPH, preto sa doklad nezahŕňa do slovenského priznania ani KV DPH (PN, KN). Všetky položky majú rovnaké účtovanie.
 b23bd6ed-e7a4-4247-ad57-7b34c2b8f2f1 | SLO SERVICES, s. r. o. | W.A.G. payment solutions, a.s. |        17 |               18 | 1194.43     |        | Podľa denníka firmy (3× rovnako): Nasledovaný denník tejto protistrany aj zhodné príklady „mýto it-axxes“: zahraničné talianske mýto sa účtuje na 518202-myto s PN a mimo KV (KN). Sadzba 22 % je talianska DPH pri zahraničnom mýte, preto nejde o slovenské tuzemské plnenie ani o odpočet slovenskej DPH.
(2 rows)

 decisions_repre_pd 
--------------------
                  0
(1 row)

 dennik_mangi 
--------------
            0
(1 row)

ROLLBACK
```

<a id="q11"></a>

### Q11. Подтверждения, правила, записи измерения точности и диагностические контрагенты

Вызов: call_cNZF5UmlgGYA49xt00EdkrHl. Время: 2026-09-09T11:33:25.418Z. Команда завершилась успешно.

```sql
BEGIN READ ONLY;
SELECT source,excluded,document_type,count(*) AS rows,count(DISTINCT document_id) AS document_ids FROM ucto_decisions GROUP BY source,excluded,document_type ORDER BY source,document_type;
SELECT o.name,count(*) AS rules,sum(r.dokladov) AS support_docs,count(*) FILTER(WHERE jsonb_typeof(r.rozpis)='array' AND jsonb_array_length(r.rozpis)>0) AS forms,count(*) FILTER(WHERE r.dokladov<3) AS under3 FROM ucto_pravidla r JOIN organizations o ON o.id=r.organization_id GROUP BY o.name;
SELECT o.name,p.created_at,p.delici_datum,p.vzorka,p.vysledok FROM ucto_presnost p JOIN organizations o ON o.id=p.organization_id ORDER BY p.created_at DESC LIMIT 5;
SELECT h.supplier_name_normalized,h.agenda,count(DISTINCT h.doklad_cislo) AS docs,count(*) AS rows FROM ucto_historia h WHERE h.supplier_name_normalized ILIKE '%fastspring%' GROUP BY h.supplier_name_normalized,h.agenda;
ROLLBACK;
```

Фактический вывод:

```text
BEGIN
  source  | excluded | document_type | rows | document_ids 
----------+----------+---------------+------+--------------
 approved | f        | FP            |   68 |           68
 approved | f        | FV            |   24 |           24
 approved | f        | MZDY          |    3 |            3
 approved | f        | OZ            |   12 |           12
 import   | f        | FP            | 1945 |            0
(5 rows)

                    name                     | rules | support_docs | forms | under3 
---------------------------------------------+-------+--------------+-------+--------
 SLO SERVICES, s. r. o.                      |   114 |         1373 |    12 |      0
 AGS Bratislava International Movers, s.r.o. |    55 |          449 |     9 |      0
 ALPINA EST s.r.o.                           |    86 |         1050 |    28 |      0
(3 rows)

                    name                     |          created_at           | delici_datum | vzorka |                                                                                                                                                                                                                                                                                            vysledok                                                                                                                                                                                                                                                                                             
---------------------------------------------+-------------------------------+--------------+--------+-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 SLO SERVICES, s. r. o.                      | 2026-09-08 09:42:05.937177+00 | 2026-07-15   |     40 | {"FP": {"kv": 6, "rad": 7, "rozpis": 1, "dokladov": 7, "clenenieDph": 7, "rozpisanych": 1, "predkontacia": 6}, "FV": {"kv": 7, "rad": 7, "rozpis": 0, "dokladov": 7, "clenenieDph": 7, "rozpisanych": 0, "predkontacia": 7}, "OZ": {"kv": 8, "rad": 14, "rozpis": 11, "dokladov": 14, "clenenieDph": 8, "rozpisanych": 11, "predkontacia": 9}, "INT": {"kv": 12, "rad": 12, "rozpis": 0, "dokladov": 12, "clenenieDph": 12, "rozpisanych": 0, "predkontacia": 12}}
 AGS Bratislava International Movers, s.r.o. | 2026-09-07 23:22:06.552574+00 | 2026-06-30   |     40 | {"FP": {"kv": 15, "rad": 15, "rozpis": 2, "dokladov": 15, "clenenieDph": 15, "rozpisanych": 3, "predkontacia": 14}, "FV": {"kv": 7, "rad": 8, "rozpis": 1, "dokladov": 8, "clenenieDph": 5, "rozpisanych": 1, "predkontacia": 7}, "OZ": {"kv": 4, "rad": 5, "rozpis": 3, "dokladov": 5, "clenenieDph": 4, "rozpisanych": 3, "predkontacia": 4}, "INT": {"kv": 11, "rad": 11, "rozpis": 0, "dokladov": 11, "clenenieDph": 11, "rozpisanych": 0, "predkontacia": 11}, "FP-D": {"kv": 1, "rad": 1, "rozpis": 0, "dokladov": 1, "clenenieDph": 1, "rozpisanych": 0, "predkontacia": 0}}
 AGS Bratislava International Movers, s.r.o. | 2026-09-07 22:52:12.883796+00 | 2026-06-30   |    150 | {"FP": {"kv": 72, "rad": 72, "rozpis": 5, "dokladov": 72, "clenenieDph": 72, "rozpisanych": 8, "predkontacia": 67}, "FV": {"kv": 33, "rad": 38, "rozpis": 4, "dokladov": 38, "clenenieDph": 34, "rozpisanych": 4, "predkontacia": 36}, "OZ": {"kv": 25, "rad": 25, "rozpis": 19, "dokladov": 25, "clenenieDph": 25, "rozpisanych": 20, "predkontacia": 23}, "INT": {"kv": 14, "rad": 14, "rozpis": 1, "dokladov": 14, "clenenieDph": 11, "rozpisanych": 1, "predkontacia": 12}, "FP-D": {"kv": 1, "rad": 1, "rozpis": 0, "dokladov": 1, "clenenieDph": 1, "rozpisanych": 0, "predkontacia": 0}}
 AGS Bratislava International Movers, s.r.o. | 2026-09-07 22:29:32.239027+00 | 2026-06-30   |     40 | {"FP": {"kv": 15, "rad": 15, "rozpis": 2, "dokladov": 15, "clenenieDph": 15, "rozpisanych": 3, "predkontacia": 14}, "FV": {"kv": 6, "rad": 8, "rozpis": 1, "dokladov": 8, "clenenieDph": 6, "rozpisanych": 1, "predkontacia": 7}, "OZ": {"kv": 5, "rad": 5, "rozpis": 3, "dokladov": 5, "clenenieDph": 5, "rozpisanych": 3, "predkontacia": 4}, "INT": {"kv": 11, "rad": 11, "rozpis": 0, "dokladov": 11, "clenenieDph": 11, "rozpisanych": 0, "predkontacia": 11}, "FP-D": {"kv": 1, "rad": 1, "rozpis": 0, "dokladov": 1, "clenenieDph": 1, "rozpisanych": 0, "predkontacia": 0}}
 AGS Bratislava International Movers, s.r.o. | 2026-09-07 21:38:36.867953+00 | 2026-06-30   |    150 | {"FP": {"kv": 64, "rad": 72, "rozpis": 5, "dokladov": 72, "clenenieDph": 66, "rozpisanych": 8, "predkontacia": 54}, "FV": {"kv": 31, "rad": 38, "rozpis": 3, "dokladov": 38, "clenenieDph": 25, "rozpisanych": 4, "predkontacia": 35}, "OZ": {"kv": 25, "rad": 25, "rozpis": 18, "dokladov": 25, "clenenieDph": 25, "rozpisanych": 20, "predkontacia": 22}, "INT": {"kv": 14, "rad": 14, "rozpis": 1, "dokladov": 14, "clenenieDph": 11, "rozpisanych": 1, "predkontacia": 12}, "FP-D": {"kv": 1, "rad": 1, "rozpis": 0, "dokladov": 1, "clenenieDph": 1, "rozpisanych": 0, "predkontacia": 0}}
(5 rows)

 supplier_name_normalized | agenda | docs | rows 
--------------------------+--------+------+------
 fastspring               | FP     |    1 |    4
 fastspring               | VPD    |    1 |    2
(2 rows)

ROLLBACK
```

<a id="q12"></a>

### Q12. Подробные проводки FastSpring

Вызов: call_LE1VRTswwiPKQ96WZCDT8WVk. Время: 2026-09-09T11:34:11.844Z. Команда завершилась успешно.

```sql
BEGIN READ ONLY;
SELECT o.name,h.agenda,h.doklad_cislo,h.riadok_index,h.suma,h.suma_dph,h.predkontacia_kod,h.clenenie_dph_kod,h.clenenie_kv_kod FROM ucto_historia h JOIN organizations o ON o.id=h.organization_id WHERE h.supplier_name_normalized='fastspring' ORDER BY o.name,h.agenda,h.riadok_index;
SELECT count(*) AS history_repre_pd FROM ucto_historia h WHERE h.organization_id='dc65b03a-fff8-44ad-87b4-c0c205e40a1f' AND h.agenda IN ('VPD','PPD') AND h.predkontacia_kod='repre';
SELECT count(*) AS relevant_blank_agenda FROM code_list_items WHERE organization_id='dc65b03a-fff8-44ad-87b4-c0c205e40a1f' AND kind='predkontacie' AND active AND agenda='';
ROLLBACK;
```

Фактический вывод:

```text
BEGIN
          name          | agenda | doklad_cislo | riadok_index | suma  | suma_dph |  predkontacia_kod   | clenenie_dph_kod | clenenie_kv_kod 
------------------------+--------+--------------+--------------+-------+----------+---------------------+------------------+-----------------
 SLO SERVICES, s. r. o. | FP     | ZF260133     |            0 |       |          | 518-ost.služ. zahr. | PN               | KN
 SLO SERVICES, s. r. o. | FP     | ZF260133     |            1 | 32.51 |     0.00 | 518-ost.služ. zahr. | PN               | KN
 SLO SERVICES, s. r. o. | FP     | ZF260133     |            2 |  7.48 |     0.00 | nedaň. 321200       | PN               | KN
 SLO SERVICES, s. r. o. | FP     |              |              |       |          | 518-ost.služ. zahr. | PN               | KN
 SLO SERVICES, s. r. o. | VPD    | 26PV0006     |            0 |       |          | úhrada Zahr. Fa     | PN               | KN
 SLO SERVICES, s. r. o. | VPD    | 26PV0006     |            1 | 39.99 |     0.00 | úhrada Zahr. Fa     | PN               | KN
(6 rows)

 history_repre_pd 
------------------
                0
(1 row)

 relevant_blank_agenda 
-----------------------
                     0
(1 row)

ROLLBACK
```

<a id="q13"></a>

### Q13. Наличие extraction run и строк у подтверждённых документов

Вызов: call_sO9EFo4neTjGFNQ9eO2wuHyD. Время: 2026-09-09T11:35:32.198Z. Команда завершилась успешно.

```sql
BEGIN READ ONLY;
SELECT d.document_type,count(*) AS approved_decisions,count(*) FILTER(WHERE x.applied_extraction_run_id IS NOT NULL) AS with_applied_run,count(*) FILTER(WHERE jsonb_typeof(d.polozky_ucto)='array' AND jsonb_array_length(d.polozky_ucto)>0) AS with_accounting_items FROM ucto_decisions d LEFT JOIN documents x ON x.id=d.document_id AND x.tenant_id=d.tenant_id WHERE d.source='approved' GROUP BY d.document_type;
SELECT count(DISTINCT (tenant_id,organization_id,agenda,doklad_cislo)) FILTER(WHERE doklad_cislo IS NULL) AS numberless_groups, count(*) FILTER(WHERE doklad_cislo IS NULL) AS numberless_rows FROM ucto_historia;
SELECT count(*) AS source_agenda_year_keys FROM code_list_items WHERE active AND kind='predkontacie' AND agenda IS NULL;
ROLLBACK;
```

Фактический вывод:

```text
BEGIN
 document_type | approved_decisions | with_applied_run | with_accounting_items 
---------------+--------------------+------------------+-----------------------
 OZ            |                 12 |               12 |                     4
 FP            |                 68 |               68 |                     3
 FV            |                 24 |               24 |                     6
 MZDY          |                  3 |                1 |                     1
(4 rows)

 numberless_groups | numberless_rows 
-------------------+-----------------
                 7 |            1910
(1 row)

 source_agenda_year_keys 
-------------------------
                       0
(1 row)

ROLLBACK
```

<a id="q14"></a>

### Q14. Документная структура корпуса и пригодность формы

Вызов: call_TkC2spvqTt98WtnnhF4UXGIY. Время: 2026-09-09T11:29:39.456Z. Команда завершилась успешно.

```sql
WITH d AS (
 SELECT tenant_id,organization_id,agenda,doklad_cislo,
 count(*) FILTER(WHERE riadok_index>0) n,
 count(*) FILTER(WHERE coalesce(riadok_index,0)=0) headers,
 count(*) FILTER(WHERE riadok_index IS NULL) nulls,
 count(DISTINCT predkontacia_kod) all_accounts,
 count(DISTINCT predkontacia_kod) FILTER(WHERE riadok_index>0) accounts,
 count(DISTINCT (predkontacia_kod,clenenie_dph_kod,clenenie_kv_kod)) FILTER(WHERE riadok_index>0) treatments,
 bool_or(coalesce(supplier_ico,'')<>'' OR coalesce(supplier_name_normalized,'')<>'') identified
 FROM ucto_historia WHERE doklad_cislo IS NOT NULL GROUP BY 1,2,3,4)
SELECT o.name,count(*) docs,
 count(*) FILTER(WHERE n=0) no_items,
 count(*) FILTER(WHERE n>15) over15,
 count(*) FILTER(WHERE n>24) over24,
 count(*) FILTER(WHERE headers>1) multi_headers,
 count(*) FILTER(WHERE nulls>0) null_index_docs,
 count(*) FILTER(WHERE accounts>1) split_items,
 count(*) FILTER(WHERE all_accounts>1 AND n>0) query_usable,
 count(*) FILTER(WHERE accounts=1 AND treatments>1) tax_only,
 count(*) FILTER(WHERE all_accounts<=1 AND treatments>1) tax_only_excluded,
 count(*) FILTER(WHERE NOT identified) no_party
FROM d JOIN organizations o ON o.id=d.organization_id AND o.tenant_id=d.tenant_id GROUP BY o.name ORDER BY o.name;
```

Фактический вывод:

```text
                    name                     | docs | no_items | over15 | over24 | multi_headers | null_index_docs | split_items | query_usable | tax_only | tax_only_excluded | no_party 
---------------------------------------------+------+----------+--------+--------+---------------+-----------------+-------------+--------------+----------+-------------------+----------
 AGS Bratislava International Movers, s.r.o. | 1085 |      370 |      0 |      0 |           763 |             782 |         179 |          179 |        7 |                 7 |      108
 ALPINA EST s.r.o.                           | 3323 |     1902 |      7 |      0 |          3296 |            3296 |         843 |          844 |       42 |                42 |      289
 RCI REAL CARGO INDUSTRY s. r. o.            |  506 |      506 |      0 |      0 |             0 |             506 |           0 |            0 |        0 |                 0 |       10
 Recable, s.r.o.                             |  806 |      806 |      0 |      0 |             0 |             806 |           0 |            0 |        0 |                 0 |        5
 SLO SERVICES, s. r. o.                      | 4227 |     2100 |     36 |      6 |             0 |               0 |        1093 |         1094 |       15 |                15 |       65
(5 rows)

```

<a id="q15"></a>

### Q15. Последние формы по группам контрагента

Вызов: call_v0bT7iUqxHrEfA6Ox54gaWjC. Время: 2026-09-09T11:30:10.225Z. Команда завершилась успешно.

```sql
WITH d AS (
 SELECT tenant_id,organization_id,
 CASE WHEN agenda IN ('VPD','PPD','PD') THEN 'PD' WHEN agenda IN ('INT','MZDY') THEN 'MZDY' ELSE agenda END kind,
 supplier_name_normalized party,doklad_cislo,max(datum) dt,
 count(*) FILTER(WHERE riadok_index>0) n,
 count(DISTINCT predkontacia_kod) acc,
 jsonb_agg(jsonb_build_array(predkontacia_kod,clenenie_dph_kod,clenenie_kv_kod) ORDER BY riadok_index) FILTER(WHERE riadok_index>0) shape
 FROM ucto_historia WHERE doklad_cislo IS NOT NULL AND coalesce(supplier_name_normalized,'')<>''
 GROUP BY 1,2,3,4,5),
 u AS(SELECT *,row_number() OVER(PARTITION BY tenant_id,organization_id,kind,party ORDER BY dt DESC NULLS LAST,doklad_cislo) rn
 FROM d WHERE acc>1 AND n>0),
 g AS(SELECT tenant_id,organization_id,kind,party,count(*) usable,
 count(DISTINCT shape) FILTER(WHERE rn<=2) shapes,
 sum(n) FILTER(WHERE rn<=2) latest_rows,
 count(DISTINCT dt) FILTER(WHERE rn<=2) dates
 FROM u GROUP BY 1,2,3,4)
SELECT o.name,count(*) party_agendas_with_example,sum(usable) usable_docs,
 count(*) FILTER(WHERE usable>=2) with_two,
 count(*) FILTER(WHERE usable=1) with_one,
 count(*) FILTER(WHERE usable>=2 AND shapes=1) same_shape,
 count(*) FILTER(WHERE usable>=2 AND shapes>1) different_shape,
 count(*) FILTER(WHERE latest_rows>24) trunc24,
 count(*) FILTER(WHERE usable>=2 AND dates=1) same_date
FROM g JOIN organizations o ON o.id=g.organization_id AND o.tenant_id=g.tenant_id GROUP BY o.name ORDER BY o.name;
```

Фактический вывод:

```text
                    name                     | party_agendas_with_example | usable_docs | with_two | with_one | same_shape | different_shape | trunc24 | same_date 
---------------------------------------------+----------------------------+-------------+----------+----------+------------+-----------------+---------+-----------
 AGS Bratislava International Movers, s.r.o. |                         28 |         158 |       19 |        9 |         16 |               3 |       0 |         4
 ALPINA EST s.r.o.                           |                        192 |         837 |       97 |       95 |         80 |              17 |       0 |         9
 SLO SERVICES, s. r. o.                      |                         91 |        1058 |       38 |       53 |         21 |              17 |       0 |         8
(3 rows)

```

<a id="q16"></a>

### Q16. Legacy/new hlavička и дубли detail

Вызов: call_jgGmi5sWU2wiksKX9ZFuQh0q. Время: 2026-09-09T11:30:47.464Z. Команда завершилась успешно.

```sql
WITH d AS (
 SELECT tenant_id,organization_id,agenda,doklad_cislo,
 count(*) FILTER(WHERE riadok_index IS NULL) oldh,
 count(*) FILTER(WHERE riadok_index=0) newh,
 count(DISTINCT (predkontacia_kod,clenenie_dph_kod,clenenie_kv_kod)) FILTER(WHERE coalesce(riadok_index,0)=0) variants,
 count(DISTINCT predkontacia_kod) FILTER(WHERE coalesce(riadok_index,0)=0) predvariants
 FROM ucto_historia WHERE doklad_cislo IS NOT NULL GROUP BY 1,2,3,4),
 p AS(SELECT tenant_id,organization_id,agenda,doklad_cislo,riadok_index,count(*) n
 FROM ucto_historia WHERE doklad_cislo IS NOT NULL AND riadok_index>0 GROUP BY 1,2,3,4,5),
 pd AS(SELECT organization_id,count(*) positions,count(DISTINCT(tenant_id,agenda,doklad_cislo)) docs FROM p WHERE n>1 GROUP BY 1)
SELECT o.name,
 count(*) FILTER(WHERE oldh>0 AND newh>0) old_and_new_headers,
 count(*) FILTER(WHERE oldh+newh>1) duplicate_header_docs,
 count(*) FILTER(WHERE oldh+newh>1 AND variants>1) conflicting_headers,
 count(*) FILTER(WHERE oldh+newh>1 AND predvariants>1) conflicting_header_pred,
 coalesce(max(pd.positions),0) repeated_detail_positions,coalesce(max(pd.docs),0) repeated_detail_docs
FROM d JOIN organizations o ON o.id=d.organization_id AND o.tenant_id=d.tenant_id
LEFT JOIN pd ON pd.organization_id=d.organization_id GROUP BY o.name ORDER BY o.name;
```

Фактический вывод:

```text
                    name                     | old_and_new_headers | duplicate_header_docs | conflicting_headers | conflicting_header_pred | repeated_detail_positions | repeated_detail_docs 
---------------------------------------------+---------------------+-----------------------+---------------------+-------------------------+---------------------------+----------------------
 AGS Bratislava International Movers, s.r.o. |                 763 |                   763 |                   2 |                       0 |                         0 |                    0
 ALPINA EST s.r.o.                           |                3296 |                  3296 |                   8 |                       0 |                         0 |                    0
 RCI REAL CARGO INDUSTRY s. r. o.            |                   0 |                     0 |                   0 |                       0 |                         0 |                    0
 Recable, s.r.o.                             |                   0 |                     0 |                   0 |                       0 |                         0 |                    0
 SLO SERVICES, s. r. o.                      |                   0 |                     0 |                   0 |                       0 |                         0 |                    0
(5 rows)

```

<a id="q17"></a>

### Q17. Предварительные фильтры построения правила

Вызов: call_lcSpTloTAFupSgJ8M6UHwdzA. Время: 2026-09-09T11:32:10.048Z. Команда завершилась успешно.

```sql
WITH d AS (
 SELECT tenant_id,organization_id,agenda,supplier_name_normalized party,doklad_cislo,
 count(*) FILTER(WHERE coalesce(riadok_index,0)=0)>0 header,
 max(predkontacia_kod) FILTER(WHERE coalesce(riadok_index,0)=0) pred,
 count(DISTINCT coalesce(predkontacia_kod,'<NULL>')) FILTER(WHERE coalesce(riadok_index,0)=0) head_variants,
 count(*) FILTER(WHERE riadok_index>0)>0 items,
 count(DISTINCT predkontacia_kod) FILTER(WHERE riadok_index>0)>1 split
 FROM ucto_historia WHERE doklad_cislo IS NOT NULL AND supplier_name_normalized IS NOT NULL GROUP BY 1,2,3,4,5),
 g AS(SELECT tenant_id,organization_id,agenda,party,count(*) docs,count(*) FILTER(WHERE header) heads,
 count(*) FILTER(WHERE items) detailed,count(*) FILTER(WHERE split) splits,
 count(*) FILTER(WHERE head_variants>1) ambiguous
 FROM d GROUP BY 1,2,3,4),
 f AS(SELECT tenant_id,organization_id,agenda,party,pred,count(*) n,
 row_number() OVER(PARTITION BY tenant_id,organization_id,agenda,party ORDER BY count(*) DESC,pred) rn
 FROM d WHERE header GROUP BY 1,2,3,4,5),
 r AS(SELECT g.*,CASE WHEN docs<3 THEN '1_docs_lt3' WHEN heads<3 THEN '2_headers_lt3'
 WHEN f.pred IS NULL OR f.n<heads*.6 THEN '3_majority_failed' ELSE '4_pass' END gate
 FROM g LEFT JOIN f ON f.tenant_id=g.tenant_id AND f.organization_id=g.organization_id AND f.agenda=g.agenda AND f.party=g.party AND f.rn=1)
SELECT o.name,gate,count(*) groups,sum(docs) docs,sum(detailed) detail_docs,sum(splits) split_docs,
 count(*) FILTER(WHERE splits>0) groups_with_split,sum(ambiguous) ambiguous_headers
FROM r JOIN organizations o ON o.id=r.organization_id AND o.tenant_id=r.tenant_id
GROUP BY o.name,gate ORDER BY o.name,gate;
```

Фактический вывод:

```text
                    name                     |       gate        | groups | docs | detail_docs | split_docs | groups_with_split | ambiguous_headers 
---------------------------------------------+-------------------+--------+------+-------------+------------+-------------------+-------------------
 AGS Bratislava International Movers, s.r.o. | 1_docs_lt3        |    194 |  268 |         174 |         14 |                10 |                 0
 AGS Bratislava International Movers, s.r.o. | 3_majority_failed |     24 |  260 |         251 |         15 |                 2 |                 0
 AGS Bratislava International Movers, s.r.o. | 4_pass            |     55 |  449 |         253 |        129 |                16 |                 0
 ALPINA EST s.r.o.                           | 1_docs_lt3        |    370 |  428 |         148 |         98 |                89 |                 0
 ALPINA EST s.r.o.                           | 3_majority_failed |    122 | 1556 |         716 |        268 |                68 |                 0
 ALPINA EST s.r.o.                           | 4_pass            |     86 | 1050 |         550 |        470 |                34 |                 0
 RCI REAL CARGO INDUSTRY s. r. o.            | 1_docs_lt3        |    100 |  146 |           0 |          0 |                 0 |                 0
 RCI REAL CARGO INDUSTRY s. r. o.            | 3_majority_failed |     14 |  118 |           0 |          0 |                 0 |                 0
 RCI REAL CARGO INDUSTRY s. r. o.            | 4_pass            |     20 |  232 |           0 |          0 |                 0 |                 0
 Recable, s.r.o.                             | 1_docs_lt3        |    104 |  135 |           0 |          0 |                 0 |                 0
 Recable, s.r.o.                             | 3_majority_failed |     13 |  321 |           0 |          0 |                 0 |                 0
 Recable, s.r.o.                             | 4_pass            |     44 |  345 |           0 |          0 |                 0 |                 0
 SLO SERVICES, s. r. o.                      | 1_docs_lt3        |    246 |  321 |         123 |         63 |                55 |                 0
 SLO SERVICES, s. r. o.                      | 3_majority_failed |     75 | 2468 |        1744 |        794 |                19 |                 0
 SLO SERVICES, s. r. o.                      | 4_pass            |    114 | 1373 |         224 |        200 |                17 |                 0
(15 rows)

```

<a id="q18"></a>

### Q18. Документный охват групп последних форм

Вызов: call_fThMURldkayBeFXgnxVVezQl. Время: 2026-09-09T11:33:08.924Z. Команда завершилась успешно.

```sql
WITH d AS (
 SELECT tenant_id,organization_id,
 CASE WHEN agenda IN ('VPD','PPD','PD') THEN 'PD' WHEN agenda IN ('INT','MZDY') THEN 'MZDY' ELSE agenda END kind,
 supplier_name_normalized party,doklad_cislo,max(datum) dt,
 count(*) FILTER(WHERE riadok_index>0) n,count(DISTINCT predkontacia_kod) acc,
 jsonb_agg(jsonb_build_array(predkontacia_kod,clenenie_dph_kod,clenenie_kv_kod) ORDER BY riadok_index) FILTER(WHERE riadok_index>0) shape
 FROM ucto_historia WHERE doklad_cislo IS NOT NULL AND coalesce(supplier_name_normalized,'')<>''
 GROUP BY 1,2,3,4,5),
 a AS(SELECT tenant_id,organization_id,kind,party,count(*) docs FROM d GROUP BY 1,2,3,4),
 u AS(SELECT *,row_number() OVER(PARTITION BY tenant_id,organization_id,kind,party ORDER BY dt DESC NULLS LAST,doklad_cislo) rn FROM d WHERE acc>1 AND n>0),
 g AS(SELECT tenant_id,organization_id,kind,party,count(*) usable,
 count(DISTINCT shape) FILTER(WHERE rn<=2) shapes,sum(n) FILTER(WHERE rn<=2) latest_rows
 FROM u GROUP BY 1,2,3,4)
SELECT o.name,CASE WHEN usable=1 THEN 'single' WHEN shapes=1 THEN 'two_same' ELSE 'two_different' END class,
 count(*) groups,sum(a.docs) all_docs_in_groups,sum(usable) usable_split_docs
FROM g JOIN a USING(tenant_id,organization_id,kind,party)
JOIN organizations o ON o.id=g.organization_id AND o.tenant_id=g.tenant_id GROUP BY o.name,class ORDER BY o.name,class;
```

Фактический вывод:

```text
                    name                     |     class     | groups | all_docs_in_groups | usable_split_docs 
---------------------------------------------+---------------+--------+--------------------+-------------------
 AGS Bratislava International Movers, s.r.o. | single        |      9 |                 37 |                 9
 AGS Bratislava International Movers, s.r.o. | two_different |      3 |                 37 |                31
 AGS Bratislava International Movers, s.r.o. | two_same      |     16 |                130 |               118
 ALPINA EST s.r.o.                           | single        |     95 |                196 |                95
 ALPINA EST s.r.o.                           | two_different |     17 |                533 |               327
 ALPINA EST s.r.o.                           | two_same      |     80 |                887 |               415
 SLO SERVICES, s. r. o.                      | single        |     53 |                241 |                53
 SLO SERVICES, s. r. o.                      | two_different |     17 |               1446 |               701
 SLO SERVICES, s. r. o.                      | two_same      |     21 |                412 |               304
(9 rows)

```

<a id="q19"></a>

### Q19. Фильтры правила и фактически сохранённые правила

Вызов: call_FS00tIcLqMljmhHQ0tW6PBBN. Время: 2026-09-09T11:34:05.113Z. Команда завершилась успешно.

```sql
WITH d AS (
 SELECT tenant_id,organization_id,agenda,supplier_name_normalized party,doklad_cislo,
 count(*) FILTER(WHERE coalesce(riadok_index,0)=0)>0 header,
 max(predkontacia_kod) FILTER(WHERE coalesce(riadok_index,0)=0) pred,
 count(DISTINCT predkontacia_kod) FILTER(WHERE riadok_index>0)>1 split
 FROM ucto_historia WHERE doklad_cislo IS NOT NULL AND supplier_name_normalized IS NOT NULL GROUP BY 1,2,3,4,5),
 g AS(SELECT tenant_id,organization_id,agenda,party,count(*) docs,count(*) FILTER(WHERE header) heads,count(*) FILTER(WHERE split) splits FROM d GROUP BY 1,2,3,4),
 f AS(SELECT tenant_id,organization_id,agenda,party,pred,count(*) n,
 row_number() OVER(PARTITION BY tenant_id,organization_id,agenda,party ORDER BY count(*) DESC,pred) rn
 FROM d WHERE header GROUP BY 1,2,3,4,5),
 r AS(SELECT g.*,CASE WHEN docs<3 THEN 'docs_lt3' WHEN heads<3 THEN 'headers_lt3'
 WHEN f.pred IS NULL THEN 'null_pred' WHEN f.n<heads*.6 THEN 'share_lt60' ELSE 'pass' END gate
 FROM g LEFT JOIN f ON f.tenant_id=g.tenant_id AND f.organization_id=g.organization_id AND f.agenda=g.agenda AND f.party=g.party AND f.rn=1)
SELECT o.name,gate,count(*) groups,sum(docs) docs,sum(splits) split_docs,count(p.id) stored_rules,
 sum(docs) FILTER(WHERE p.id IS NOT NULL) docs_with_stored_rule
FROM r JOIN organizations o ON o.id=r.organization_id AND o.tenant_id=r.tenant_id
LEFT JOIN ucto_pravidla p ON p.tenant_id=r.tenant_id AND p.organization_id=r.organization_id AND p.agenda=r.agenda AND p.protistrana=r.party
GROUP BY o.name,gate ORDER BY o.name,gate;
```

Фактический вывод:

```text
                    name                     |    gate    | groups | docs | split_docs | stored_rules | docs_with_stored_rule 
---------------------------------------------+------------+--------+------+------------+--------------+-----------------------
 AGS Bratislava International Movers, s.r.o. | docs_lt3   |    194 |  268 |         14 |            0 |                      
 AGS Bratislava International Movers, s.r.o. | null_pred  |      2 |    9 |          0 |            0 |                      
 AGS Bratislava International Movers, s.r.o. | pass       |     55 |  449 |        129 |           55 |                   449
 AGS Bratislava International Movers, s.r.o. | share_lt60 |     22 |  251 |         15 |            0 |                      
 ALPINA EST s.r.o.                           | docs_lt3   |    370 |  428 |         98 |            0 |                      
 ALPINA EST s.r.o.                           | null_pred  |     73 |  889 |        185 |            0 |                      
 ALPINA EST s.r.o.                           | pass       |     86 | 1050 |        470 |           86 |                  1050
 ALPINA EST s.r.o.                           | share_lt60 |     49 |  667 |         83 |            0 |                      
 RCI REAL CARGO INDUSTRY s. r. o.            | docs_lt3   |    100 |  146 |          0 |            0 |                      
 RCI REAL CARGO INDUSTRY s. r. o.            | pass       |     20 |  232 |          0 |            0 |                      
 RCI REAL CARGO INDUSTRY s. r. o.            | share_lt60 |     14 |  118 |          0 |            0 |                      
 Recable, s.r.o.                             | docs_lt3   |    104 |  135 |          0 |            0 |                      
 Recable, s.r.o.                             | null_pred  |      2 |   10 |          0 |            0 |                      
 Recable, s.r.o.                             | pass       |     44 |  345 |          0 |            0 |                      
 Recable, s.r.o.                             | share_lt60 |     11 |  311 |          0 |            0 |                      
 SLO SERVICES, s. r. o.                      | docs_lt3   |    246 |  321 |         63 |            0 |                      
 SLO SERVICES, s. r. o.                      | null_pred  |     38 |  334 |          2 |            0 |                      
 SLO SERVICES, s. r. o.                      | pass       |    114 | 1373 |        200 |          114 |                  1373
 SLO SERVICES, s. r. o.                      | share_lt60 |     37 | 2134 |        792 |            0 |                      
(19 rows)

```

<a id="q20"></a>

### Q20. SELECT для чистой функции; неудачная первая проверка

Вызов: call_rJ2hTm8oKp6kTJGyYzsbvJux. Время: 2026-09-09T11:35:18.620Z. Команда завершилась ошибкой; ниже фактически возвращённый вывод. Вывод ниже принадлежит всей связке SELECT → чистая JS-функция, а не необработанным строкам PostgreSQL. SQL не изменял БД, код проверки не сохранял файлы. Вход содержит коды/индексы, но не суммы и содержательные тексты; вывод не подтверждает числовые доли.

```sql
SELECT jsonb_build_array(o.name,h.agenda,h.supplier_name_normalized,h.doklad_cislo,
 count(*) FILTER(WHERE coalesce(h.riadok_index,0)=0),
 max(h.predkontacia_kod) FILTER(WHERE coalesce(h.riadok_index,0)=0),
 coalesce(jsonb_agg(jsonb_build_array(h.riadok_index,h.predkontacia_kod,h.clenenie_dph_kod,h.clenenie_kv_kod) ORDER BY h.riadok_index) FILTER(WHERE h.riadok_index>0),'[]'::jsonb))
 FROM ucto_historia h JOIN organizations o ON o.id=h.organization_id AND o.tenant_id=h.tenant_id
 WHERE h.doklad_cislo IS NOT NULL AND h.supplier_name_normalized IS NOT NULL
 GROUP BY o.name,h.tenant_id,h.organization_id,h.agenda,h.supplier_name_normalized,h.doklad_cislo
 ORDER BY o.name,h.agenda,h.supplier_name_normalized,h.doklad_cislo;
```

Исполненная программа обработки результата:

```javascript
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const lines=fs.readFileSync('server/services/uctoPravidlaService.ts','utf8').split(/\r?\n/);
const src=lines.slice(17,141).join('\n')+'\nexport {odvodPravidlo};';
function moduleOf(s){const m={exports:{}};vm.runInNewContext(ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,m);return m.exports;}
const actual=moduleOf(src),strict=moduleOf(src.replace('Math.max(2, doklady.length * MIN_ZHODA)','Math.max(MIN_DOKLADOV, doklady.length * MIN_ZHODA)'));
const groups=new Map(),result={};
for(const line of fs.readFileSync(0,'utf8').split(/\r?\n/).filter(x=>x.trim().startsWith('['))){
const a=JSON.parse(line),key=JSON.stringify(a.slice(0,3));if(!groups.has(key))groups.set(key,{org:a[0],docs:new Map()});const rs=a[6].map(v=>({riadokIndex:v[0],text:'',predkontaciaKod:v[1]??undefined,clenenieDphKod:v[2]??undefined,clenenieKvKod:v[3]??undefined}));
if(a[4]>0)rs.unshift({riadokIndex:0,text:'',predkontaciaKod:a[5]??undefined});groups.get(key).docs.set(a[3],rs);}
for(const g of groups.values()){const t=result[g.org]??={groups:0,docs:0,rulePass:0,standaloneShape:0,shapeButNoRuleGroups:0,shapeButNoRuleDocs:0,shapeButNoRuleDetailDocs:0,shapeButNoRuleSplitDocs:0,min2vs3ChangedGroups:0,min2vs3ChangedDocs:0};
t.groups++;t.docs+=g.docs.size;const r=actual.odvodPravidlo(g.docs);if(r)t.rulePass++;
const d=[...g.docs.values()].map(rs=>rs.filter(x=>x.riadokIndex>0)).filter(rs=>rs.length);
const shape=d.length>=3?actual.odvodRozpis(d):[];if(shape.length)t.standaloneShape++;
if(shape.length&&!r){t.shapeButNoRuleGroups++;t.shapeButNoRuleDocs+=g.docs.size;t.shapeButNoRuleDetailDocs+=d.length;t.shapeButNoRuleSplitDocs+=d.filter(rs=>new Set(rs.map(x=>x.predkontaciaKod)).size>1).length;}
if(shape.length&&strict.odvodRozpis(d).length===0){t.min2vs3ChangedGroups++;t.min2vs3ChangedDocs+=g.docs.size;}}
console.log(JSON.stringify(result,null,2));
```

Фактический вывод:

```text
evalmachine.<anonymous>:90
    export { odvodPravidlo };
    ^^^^^^

SyntaxError: Unexpected token 'export'
    at new Script (node:vm:117:7)
    at createScript (node:vm:269:10)
    at Object.runInNewContext (node:vm:310:10)
    at moduleOf ([eval]:4:46)
    at [eval]:5:14
    at runScriptInThisContext (node:internal/vm:219:10)
    at node:internal/process/execution:451:12
    at [eval]-wrapper:6:24
    at runScriptInContext (node:internal/process/execution:449:60)
    at evalFunction (node:internal/process/execution:283:30)

Node.js v24.18.0
```

<a id="q21"></a>

### Q21. Тот же SELECT и завершённая чистая проверка формы

Вызов: call_jUeAsaoLAKg7oQsX7aor4mUZ. Время: 2026-09-09T11:35:40.541Z. Команда завершилась успешно. Вывод ниже принадлежит всей связке SELECT → чистая JS-функция, а не необработанным строкам PostgreSQL. SQL не изменял БД, код проверки не сохранял файлы. Вход содержит коды/индексы, но не суммы и содержательные тексты; вывод не подтверждает числовые доли.

```sql
SELECT jsonb_build_array(o.name,h.agenda,h.supplier_name_normalized,h.doklad_cislo,
 count(*) FILTER(WHERE coalesce(h.riadok_index,0)=0),
 max(h.predkontacia_kod) FILTER(WHERE coalesce(h.riadok_index,0)=0),
 coalesce(jsonb_agg(jsonb_build_array(h.riadok_index,h.predkontacia_kod,h.clenenie_dph_kod,h.clenenie_kv_kod) ORDER BY h.riadok_index) FILTER(WHERE h.riadok_index>0),'[]'::jsonb))
 FROM ucto_historia h JOIN organizations o ON o.id=h.organization_id AND o.tenant_id=h.tenant_id
 WHERE h.doklad_cislo IS NOT NULL AND h.supplier_name_normalized IS NOT NULL
 GROUP BY o.name,h.tenant_id,h.organization_id,h.agenda,h.supplier_name_normalized,h.doklad_cislo
 ORDER BY o.name,h.agenda,h.supplier_name_normalized,h.doklad_cislo;
```

Исполненная программа обработки результата:

```javascript
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const lines=fs.readFileSync('server/services/uctoPravidlaService.ts','utf8').split(/\r?\n/);
const src=lines.slice(17,142).join('\n')+'\nexport {odvodPravidlo};';
function moduleOf(s){const m={exports:{}};vm.runInNewContext(ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,m);return m.exports;}
const actual=moduleOf(src),strict=moduleOf(src.replace('Math.max(2, doklady.length * MIN_ZHODA)','Math.max(MIN_DOKLADOV, doklady.length * MIN_ZHODA)'));
const groups=new Map(),result={};
for(const line of fs.readFileSync(0,'utf8').split(/\r?\n/).filter(x=>x.trim().startsWith('['))){
const a=JSON.parse(line),key=JSON.stringify(a.slice(0,3));if(!groups.has(key))groups.set(key,{org:a[0],docs:new Map()});const rs=a[6].map(v=>({riadokIndex:v[0],text:'',predkontaciaKod:v[1]??undefined,clenenieDphKod:v[2]??undefined,clenenieKvKod:v[3]??undefined}));
if(a[4]>0)rs.unshift({riadokIndex:0,text:'',predkontaciaKod:a[5]??undefined});groups.get(key).docs.set(a[3],rs);}
for(const g of groups.values()){const t=result[g.org]??={groups:0,docs:0,rulePass:0,standaloneShape:0,shapeButNoRuleGroups:0,shapeButNoRuleDocs:0,shapeButNoRuleDetailDocs:0,shapeButNoRuleSplitDocs:0,min2vs3ChangedGroups:0,min2vs3ChangedDocs:0};
t.groups++;t.docs+=g.docs.size;const r=actual.odvodPravidlo(g.docs);if(r)t.rulePass++;
const d=[...g.docs.values()].map(rs=>rs.filter(x=>x.riadokIndex>0)).filter(rs=>rs.length);
const shape=d.length>=3?actual.odvodRozpis(d):[];if(shape.length)t.standaloneShape++;
if(shape.length&&!r){t.shapeButNoRuleGroups++;t.shapeButNoRuleDocs+=g.docs.size;t.shapeButNoRuleDetailDocs+=d.length;t.shapeButNoRuleSplitDocs+=d.filter(rs=>new Set(rs.map(x=>x.predkontaciaKod)).size>1).length;}
if(shape.length&&strict.odvodRozpis(d).length===0){t.min2vs3ChangedGroups++;t.min2vs3ChangedDocs+=g.docs.size;}}
console.log(JSON.stringify(result,null,2));
```

Фактический вывод:

```text
{
  "AGS Bratislava International Movers, s.r.o.": {
    "groups": 273,
    "docs": 977,
    "rulePass": 55,
    "standaloneShape": 9,
    "shapeButNoRuleGroups": 0,
    "shapeButNoRuleDocs": 0,
    "shapeButNoRuleDetailDocs": 0,
    "shapeButNoRuleSplitDocs": 0,
    "min2vs3ChangedGroups": 0,
    "min2vs3ChangedDocs": 0
  },
  "ALPINA EST s.r.o.": {
    "groups": 578,
    "docs": 3034,
    "rulePass": 86,
    "standaloneShape": 71,
    "shapeButNoRuleGroups": 43,
    "shapeButNoRuleDocs": 611,
    "shapeButNoRuleDetailDocs": 219,
    "shapeButNoRuleSplitDocs": 219,
    "min2vs3ChangedGroups": 1,
    "min2vs3ChangedDocs": 20
  },
  "RCI REAL CARGO INDUSTRY s. r. o.": {
    "groups": 134,
    "docs": 496,
    "rulePass": 20,
    "standaloneShape": 0,
    "shapeButNoRuleGroups": 0,
    "shapeButNoRuleDocs": 0,
    "shapeButNoRuleDetailDocs": 0,
    "shapeButNoRuleSplitDocs": 0,
    "min2vs3ChangedGroups": 0,
    "min2vs3ChangedDocs": 0
  },
  "Recable, s.r.o.": {
    "groups": 161,
    "docs": 801,
    "rulePass": 44,
    "standaloneShape": 0,
    "shapeButNoRuleGroups": 0,
    "shapeButNoRuleDocs": 0,
    "shapeButNoRuleDetailDocs": 0,
    "shapeButNoRuleSplitDocs": 0,
    "min2vs3ChangedGroups": 0,
    "min2vs3ChangedDocs": 0
  },
  "SLO SERVICES, s. r. o.": {
    "groups": 435,
    "docs": 4162,
    "rulePass": 114,
    "standaloneShape": 13,
    "shapeButNoRuleGroups": 1,
    "shapeButNoRuleDocs": 66,
    "shapeButNoRuleDetailDocs": 15,
    "shapeButNoRuleSplitDocs": 15,
    "min2vs3ChangedGroups": 0,
    "min2vs3ChangedDocs": 0
  }
}
```

<a id="q22"></a>

### Q22. Структура по фирме/agenda; NULL в атрибутах истории

Вызов: call_BNsLmh2kJA56Up67ah3jcG7w. Время: 2026-09-09T11:29:59.712Z. Команда завершилась успешно.

```sql
SELECT o.name,h.agenda,count(*) AS docs,count(*) FILTER (WHERE detail=0) AS no_detail,count(*) FILTER (WHERE header=0) AS no_header,count(*) FILTER (WHERE detail>0 AND header>0) AS both,count(*) FILTER (WHERE detail>15) AS detail_gt15 FROM (SELECT organization_id,agenda,doklad_cislo,count(*) FILTER (WHERE riadok_index>0) detail,count(*) FILTER (WHERE riadok_index=0) header FROM ucto_historia WHERE doklad_cislo IS NOT NULL GROUP BY organization_id,agenda,doklad_cislo) h JOIN organizations o ON o.id=h.organization_id GROUP BY o.name,h.agenda ORDER BY o.name,h.agenda;
SELECT source,count(*) AS rows,count(*) FILTER (WHERE suma IS NULL) no_suma,count(*) FILTER (WHERE suma_dph IS NULL) no_dph,count(*) FILTER (WHERE sadzba_dph IS NULL) no_rate,count(*) FILTER (WHERE stredisko_kod IS NULL) no_centre FROM ucto_historia GROUP BY source;
SELECT document_type,podtyp,count(*) FROM documents GROUP BY document_type,podtyp ORDER BY 1,2;
```

Фактический вывод:

```text
                    name                     | agenda | docs | no_detail | no_header | both | detail_gt15 
---------------------------------------------+--------+------+-----------+-----------+------+-------------
 AGS Bratislava International Movers, s.r.o. | FP     |  391 |       238 |         7 |  153 |           0
 AGS Bratislava International Movers, s.r.o. | FP-D   |    6 |         6 |         0 |    0 |           0
 AGS Bratislava International Movers, s.r.o. | FV     |  159 |        37 |        12 |  122 |           0
 AGS Bratislava International Movers, s.r.o. | FV-D   |    9 |         6 |         0 |    3 |           0
 AGS Bratislava International Movers, s.r.o. | INT    |  349 |        18 |         0 |  331 |           0
 AGS Bratislava International Movers, s.r.o. | OZ     |  143 |        56 |         0 |   87 |           0
 AGS Bratislava International Movers, s.r.o. | PPD    |    3 |         3 |         0 |    0 |           0
 AGS Bratislava International Movers, s.r.o. | VPD    |   25 |         6 |         0 |   19 |           0
 ALPINA EST s.r.o.                           | FP     |  694 |       328 |         0 |  366 |           0
 ALPINA EST s.r.o.                           | FP-D   |   39 |        21 |         0 |   18 |           0
 ALPINA EST s.r.o.                           | FV     |   45 |        37 |         0 |    8 |           0
 ALPINA EST s.r.o.                           | INT    |  656 |       157 |         0 |  499 |           7
 ALPINA EST s.r.o.                           | OZ     | 1787 |      1327 |         0 |  460 |           0
 ALPINA EST s.r.o.                           | PPD    |   16 |        15 |         0 |    1 |           0
 ALPINA EST s.r.o.                           | VPD    |   86 |        17 |         0 |   69 |           0
 RCI REAL CARGO INDUSTRY s. r. o.            | FP     |  142 |       142 |       142 |    0 |           0
 RCI REAL CARGO INDUSTRY s. r. o.            | FV     |  125 |       125 |       125 |    0 |           0
 RCI REAL CARGO INDUSTRY s. r. o.            | INT    |  189 |       189 |       189 |    0 |           0
 RCI REAL CARGO INDUSTRY s. r. o.            | PPD    |    4 |         4 |         4 |    0 |           0
 RCI REAL CARGO INDUSTRY s. r. o.            | VPD    |   46 |        46 |        46 |    0 |           0
 Recable, s.r.o.                             | FP     |  287 |       287 |       287 |    0 |           0
 Recable, s.r.o.                             | FV     |   56 |        56 |        56 |    0 |           0
 Recable, s.r.o.                             | INT    |  166 |       166 |       166 |    0 |           0
 Recable, s.r.o.                             | PPD    |    6 |         6 |         6 |    0 |           0
 Recable, s.r.o.                             | VPD    |  291 |       291 |       291 |    0 |           0
 SLO SERVICES, s. r. o.                      | FP     | 1230 |       916 |         0 |  314 |           0
 SLO SERVICES, s. r. o.                      | FP-D   |   27 |        24 |         0 |    3 |           0
 SLO SERVICES, s. r. o.                      | FV     |  677 |       677 |         0 |    0 |           0
 SLO SERVICES, s. r. o.                      | FV-D   |    4 |         4 |         0 |    0 |           0
 SLO SERVICES, s. r. o.                      | INT    | 1193 |         9 |         0 | 1184 |          36
 SLO SERVICES, s. r. o.                      | OZ     | 1031 |       438 |         0 |  593 |           0
 SLO SERVICES, s. r. o.                      | PPD    |   14 |        14 |         0 |    0 |           0
 SLO SERVICES, s. r. o.                      | VPD    |   51 |        18 |         0 |   33 |           0
(33 rows)

  source   | rows  | no_suma | no_dph | no_rate | no_centre 
-----------+-------+---------+--------+---------+-----------
 mdb       | 24042 |   14006 |  14006 |   24042 |     24042
 decisions |  1910 |    1910 |   1910 |    1910 |      1910
(2 rows)

 document_type | podtyp | count 
---------------+--------+-------
 FP            | bezna  |    77
 FV            | bezna  |    27
 MZDY          | bezna  |     3
 OZ            | bezna  |    12
 PD            | bezna  |     6
(5 rows)

```

<a id="q23"></a>

### Q23. Структура по agenda; текущие валидационные случаи; ключи extraction result

Вызов: call_5ciDpaYgMZYONW4wo4ieFTM1. Время: 2026-09-09T11:30:22.933Z. Команда завершилась успешно.

```sql
WITH d AS (SELECT organization_id,agenda,doklad_cislo,count(*) FILTER(WHERE riadok_index>0) detail,count(*) FILTER(WHERE riadok_index=0) header FROM ucto_historia WHERE doklad_cislo IS NOT NULL GROUP BY 1,2,3) SELECT agenda,count(*) docs,count(*) FILTER(WHERE detail=0) no_detail,count(*) FILTER(WHERE detail>0) with_detail,count(*) FILTER(WHERE header=0 AND detail=0) no_shape,count(*) FILTER(WHERE detail>15) gt15 FROM d GROUP BY agenda ORDER BY agenda;
SELECT document_type,count(*) FILTER(WHERE document_type IN ('FP','FV') AND coalesce(extracted->>'datumSplatnosti','')='') no_due,count(*) FILTER(WHERE document_type IN ('FP','FV') AND extracted->>'datumSplatnosti'<extracted->>'datumVystavenia') due_before,count(*) FILTER(WHERE document_type IN ('PD','OZ') AND coalesce(extracted->>'cisloFaktury','')='') no_number,count(*) FILTER(WHERE total_amount<0 AND document_type<>'BV') negative FROM documents GROUP BY 1 ORDER BY 1;
SELECT array_agg(DISTINCT k) keys FROM (SELECT jsonb_object_keys(result) k FROM extraction_runs WHERE status='succeeded' AND result IS NOT NULL LIMIT 5000) q;
```

Фактический вывод:

```text
 agenda | docs | no_detail | with_detail | no_shape | gt15 
--------+------+-----------+-------------+----------+------
 FP     | 2744 |      1911 |         833 |      436 |    0
 FP-D   |   72 |        51 |          21 |        0 |    0
 FV     | 1062 |       932 |         130 |      193 |    0
 FV-D   |   13 |        10 |           3 |        0 |    0
 INT    | 2553 |       539 |        2014 |      355 |   43
 OZ     | 2961 |      1821 |        1140 |        0 |    0
 PPD    |   43 |        42 |           1 |       10 |    0
 VPD    |  499 |       378 |         121 |      337 |    0
(8 rows)

 document_type | no_due | due_before | no_number | negative 
---------------+--------+------------+-----------+----------
 FP            |      0 |          0 |         0 |        1
 FV            |      0 |          0 |         0 |        0
 MZDY          |      0 |          0 |         0 |        0
 OZ            |      0 |          0 |         0 |        0
 PD            |      0 |          0 |         0 |        0
(5 rows)

                                                                                                                                                                                          keys                                                                                                                                                                                           
-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 {accountCode,additionalDocuments,buyer,constantSymbol,currency,deliveryNoteNumber,documentSummary,documentType,dueDate,evidence,fieldConfidence,invoiceNumber,issueDate,lineItems,numberSeriesCode,orderNumber,schemaVersion,servicePeriodEnd,supplier,taxDate,totalAmount,totalVat,totalWithoutVat,variableSymbol,vatBreakdown,vatClassificationCode,vatControlStatementCode,warnings}
(1 row)

```

<a id="q24"></a>

### Q24. Пустые položky, summary/DPH и различия raw/normalized

Вызов: call_wObrWeArgmOB2QqfRA50ZExp. Время: 2026-09-09T11:30:55.391Z. Команда завершилась успешно.

```sql
WITH r AS (SELECT DISTINCT ON(document_id) document_id,result FROM extraction_runs WHERE status='succeeded' AND result IS NOT NULL ORDER BY document_id,completed_at DESC),d AS (SELECT x.*,coalesce(jsonb_array_length(extracted->'polozky'),0) n,coalesce(jsonb_array_length(r.result->'lineItems'),0) rn,r.result FROM documents x LEFT JOIN r ON r.document_id=x.id) SELECT document_type,count(*) docs,count(*) FILTER(WHERE n=0 AND coalesce(extracted->>'textPolozky','')<>'') empty_with_summary,count(*) FILTER(WHERE n=0 AND EXISTS(SELECT 1 FROM jsonb_array_elements(extracted->'rozpisDph') v WHERE (v->>'dph')::numeric<>0)) empty_with_vat,count(*) FILTER(WHERE coalesce((extracted->>'cudziaDan')::numeric,0)<>0) foreign_tax,count(*) FILTER(WHERE coalesce((extracted->>'cudziaDan')::numeric,0)<>0 AND n>rn) foreign_more_normalized,count(*) FILTER(WHERE n<>rn AND result IS NOT NULL) different_item_count FROM d GROUP BY 1 ORDER BY 1;
WITH r AS (SELECT DISTINCT ON(document_id) document_id,result FROM extraction_runs WHERE status='succeeded' AND result IS NOT NULL ORDER BY document_id,completed_at DESC) SELECT d.id,d.document_type,jsonb_array_length(r.result->'lineItems') raw_items,jsonb_array_length(d.extracted->'polozky') norm_items,d.extracted->>'cudziaDan' foreign_tax FROM documents d JOIN r ON r.document_id=d.id WHERE coalesce((d.extracted->>'cudziaDan')::numeric,0)<>0 OR d.total_amount<0;
```

Фактический вывод:

```text
 document_type | docs | empty_with_summary | empty_with_vat | foreign_tax | foreign_more_normalized | different_item_count 
---------------+------+--------------------+----------------+-------------+-------------------------+----------------------
 FP            |   77 |                  3 |              1 |           2 |                       1 |                    5
 FV            |   27 |                  0 |              0 |           0 |                       0 |                    0
 MZDY          |    3 |                  2 |              0 |           0 |                       0 |                    0
 OZ            |   12 |                  1 |              0 |           0 |                       0 |                    0
 PD            |    6 |                  3 |              2 |           0 |                       0 |                    0
(5 rows)

                  id                  | document_type | raw_items | norm_items | foreign_tax 
--------------------------------------+---------------+-----------+------------+-------------
 d17d512b-37b1-4d6f-9a67-3ea839e8f6b5 | FP            |         2 |          2 | 
 163d007b-4d99-473b-9b70-8052d60d07c0 | FP            |        17 |         17 | 1194.43
 b23bd6ed-e7a4-4247-ad57-7b34c2b8f2f1 | FP            |        17 |         18 | 1194.43
(3 rows)

```

<a id="q25"></a>

### Q25. Число кандидатов перед cap; ограниченный proxy покрытия категорий

Вызов: call_bdsth6OoQPFNB559pMq2YlI5. Время: 2026-09-09T11:31:51.224Z. Команда завершилась успешно. any_category_form_same_account — лишь совпадение счёта с некоторой категорией. Это не фактическое попадание категории в промпт, не наличие подходящей формы и не измерение точности; в диагнозе как охват отсутствующей формы не используется.

```sql
WITH typ(typ,ag) AS(VALUES('FP',ARRAY['receivedInvoice','receivedAdvanceInvoice']),('FV',ARRAY['issuedInvoice','issuedAdvanceInvoice']),('OZ',ARRAY['commitment','claim']),('PD',ARRAY['cashPaid','cashReceived']),('MZDY',ARRAY['internalDocument'])),c AS(SELECT o.name,t.typ,count(*) all_codes,count(*) FILTER(WHERE coalesce(c.agenda,'')='' OR c.agenda=ANY(t.ag)) matching FROM code_list_items c JOIN organizations o ON o.id=c.organization_id CROSS JOIN typ t WHERE c.active AND c.kind='predkontacie' AND c.code NOT ILIKE 'BEZ%' GROUP BY 1,2) SELECT name,typ,CASE WHEN matching>0 THEN matching ELSE all_codes END before_cap,greatest((CASE WHEN matching>0 THEN matching ELSE all_codes END)-25,0) omitted_by_cap FROM c ORDER BY name,typ;
WITH h AS(SELECT organization_id,agenda,doklad_cislo,bool_or(EXISTS(SELECT 1 FROM ucto_kategorie k WHERE k.organization_id=h.organization_id AND k.active AND jsonb_typeof(k.rozpis)='array' AND jsonb_array_length(k.rozpis)>0 AND k.predkontacia_kod=h.predkontacia_kod)) form_same_account FROM ucto_historia h WHERE doklad_cislo IS NOT NULL GROUP BY 1,2,3) SELECT o.name,count(*) docs,count(*) FILTER(WHERE form_same_account) any_category_form_same_account,count(*) FILTER(WHERE NOT form_same_account) no_category_form_same_account FROM h JOIN organizations o ON o.id=h.organization_id GROUP BY 1 ORDER BY 1;
```

Фактический вывод:

```text
                    name                     | typ  | before_cap | omitted_by_cap 
---------------------------------------------+------+------------+----------------
 AGS Bratislava International Movers, s.r.o. | FP   |        146 |            121
 AGS Bratislava International Movers, s.r.o. | FV   |         24 |              0
 AGS Bratislava International Movers, s.r.o. | MZDY |        315 |            290
 AGS Bratislava International Movers, s.r.o. | OZ   |         77 |             52
 AGS Bratislava International Movers, s.r.o. | PD   |         61 |             36
 ALPINA EST s.r.o.                           | FP   |        138 |            113
 ALPINA EST s.r.o.                           | FV   |         13 |              0
 ALPINA EST s.r.o.                           | MZDY |        402 |            377
 ALPINA EST s.r.o.                           | OZ   |        191 |            166
 ALPINA EST s.r.o.                           | PD   |         89 |             64
 BAJVET s.r.o.                               | FP   |         24 |              0
 BAJVET s.r.o.                               | FV   |          5 |              0
 BAJVET s.r.o.                               | MZDY |         74 |             49
 BAJVET s.r.o.                               | OZ   |         45 |             20
 BAJVET s.r.o.                               | PD   |         28 |              3
 RCI REAL CARGO INDUSTRY s. r. o.            | FP   |          8 |              0
 RCI REAL CARGO INDUSTRY s. r. o.            | FV   |          4 |              0
 RCI REAL CARGO INDUSTRY s. r. o.            | MZDY |         50 |             25
 RCI REAL CARGO INDUSTRY s. r. o.            | OZ   |         38 |             13
 RCI REAL CARGO INDUSTRY s. r. o.            | PD   |         22 |              0
 Recable, s.r.o.                             | FP   |         69 |             44
 Recable, s.r.o.                             | FV   |         15 |              0
 Recable, s.r.o.                             | MZDY |        151 |            126
 Recable, s.r.o.                             | OZ   |         57 |             32
 Recable, s.r.o.                             | PD   |         81 |             56
 SLO SERVICES, s. r. o.                      | FP   |        108 |             83
 SLO SERVICES, s. r. o.                      | FV   |          9 |              0
 SLO SERVICES, s. r. o.                      | MZDY |        288 |            263
 SLO SERVICES, s. r. o.                      | OZ   |        159 |            134
 SLO SERVICES, s. r. o.                      | PD   |         58 |             33
 Shenzhen Import s. r. o.                    | FP   |         22 |              0
 Shenzhen Import s. r. o.                    | FV   |          7 |              0
 Shenzhen Import s. r. o.                    | MZDY |         62 |             37
 Shenzhen Import s. r. o.                    | OZ   |         41 |             16
 Shenzhen Import s. r. o.                    | PD   |         21 |              0
(35 rows)

                    name                     | docs | any_category_form_same_account | no_category_form_same_account 
---------------------------------------------+------+--------------------------------+-------------------------------
 AGS Bratislava International Movers, s.r.o. | 1085 |                            245 |                           840
 ALPINA EST s.r.o.                           | 3323 |                            668 |                          2655
 RCI REAL CARGO INDUSTRY s. r. o.            |  506 |                              0 |                           506
 Recable, s.r.o.                             |  806 |                              0 |                           806
 SLO SERVICES, s. r. o.                      | 4227 |                            637 |                          3590
(5 rows)

```

<a id="q26"></a>

### Q26. Документный охват cap; отрицательный документ; последняя нормализованная строка

Вызов: call_dUDzIIiRKHUSoWMxkNwxI26z. Время: 2026-09-09T11:32:31.623Z. Команда завершилась успешно.

```sql
WITH typ(typ,ag) AS(VALUES('FP',ARRAY['receivedInvoice','receivedAdvanceInvoice']),('FV',ARRAY['issuedInvoice','issuedAdvanceInvoice']),('OZ',ARRAY['commitment','claim']),('PD',ARRAY['cashPaid','cashReceived']),('MZDY',ARRAY['internalDocument'])),c AS(SELECT organization_id,t.typ,count(*) all_codes,count(*) FILTER(WHERE coalesce(c.agenda,'')='' OR c.agenda=ANY(t.ag)) matching FROM code_list_items c CROSS JOIN typ t WHERE c.active AND c.kind='predkontacie' AND c.code NOT ILIKE 'BEZ%' GROUP BY 1,2),d AS(SELECT DISTINCT organization_id,agenda,doklad_cislo,CASE WHEN agenda IN('PPD','VPD','PD') THEN 'PD' WHEN agenda IN('INT','MZDY') THEN 'MZDY' WHEN agenda LIKE 'FP%' THEN 'FP' WHEN agenda LIKE 'FV%' THEN 'FV' ELSE agenda END typ FROM ucto_historia WHERE doklad_cislo IS NOT NULL) SELECT d.typ,count(*) docs,count(*) FILTER(WHERE CASE WHEN c.matching>0 THEN c.matching ELSE c.all_codes END>25) docs_with_cap FROM d JOIN c ON c.organization_id=d.organization_id AND c.typ=d.typ GROUP BY 1 ORDER BY 1;
SELECT document_type,status,count(*) FROM documents WHERE coalesce((extracted->>'sumaSpolu')::numeric,0)<0 GROUP BY 1,2;
SELECT id,jsonb_array_length(extracted->'polozky') n,extracted->'polozky'->-1->>'popis' last_line FROM documents WHERE id='b23bd6ed-e7a4-4247-ad57-7b34c2b8f2f1';
```

Фактический вывод:

```text
 typ  | docs | docs_with_cap 
------+------+---------------
 FP   | 2816 |          2674
 FV   | 1075 |             0
 MZDY | 2553 |          2553
 OZ   | 2961 |          2961
 PD   |  542 |           492
(5 rows)

 document_type |   status    | count 
---------------+-------------+-------
 FP            | na_kontrole |     1
(1 row)

                  id                  | n  |  last_line  
--------------------------------------+----+-------------
 b23bd6ed-e7a4-4247-ad57-7b34c2b8f2f1 | 18 | DPH IT 22 %
(1 row)

```

<a id="c01"></a>

### C01. Доли и суммы из сохранённых Q

Фактически выполнен локальный SELECT в оперативной памяти. В каждой строке source указан первичный Q; числовые литералы перенесены из его сохранённого результата. Это вычисление долей, не повторное чтение production.

```sql
WITH metrics(metric, numerator, denominator, source) AS (VALUES
('history_total',1085+3323+506+806+4227,1085+3323+506+806+4227,'Q14'),
('history_no_details',370+1902+506+806+2100,9947,'Q14'),
('history_rates_missing',9947,9947,'Q14+Q22'),
('candidate_cap',2674+2553+2961+492,9947,'Q26'),
('own_rule_missing',9947-(449+1050+1373),9947,'Q14+Q19'),
('own_rule_present',449+1050+1373,9947,'Q19'),
('passing_rule_not_stored',232+345,9947,'Q19'),
('header_dominance_fail',251+667+118+311+2134,9947,'Q19'),
('header_pred_missing',9+889+10+334,9947,'Q19'),
('min_documents_fail',268+428+146+135+321,9947,'Q19'),
('history_duplicate_headers',763+3296,9947,'Q16'),
('history_conflicting_headers',2+8,9947,'Q16'),
('INT',2553,9947,'Q23'),
('OZ',2961,9947,'Q23'),
('OZ_INT',2961+2553,9947,'Q23'),
('FP_including_D',2744+72,9947,'Q23'),
('FV_including_D',1062+13,9947,'Q23'),
('cash',499+43,9947,'Q23'),
('OZ_with_detail',1140,2961,'Q23'),
('INT_with_detail',2014,2553,'Q23'),
('shape_example_single_or_different',37+196+241+37+533+1446,9947,'Q18'),
('shape_example_single',37+196+241,9947,'Q18'),
('shape_example_different',37+533+1446,9947,'Q18'),
('shape_lost_by_header_group_scope',611+66,9947,'Q21 pipeline'),
('shape_lost_by_header_split_docs',219+15,9947,'Q21 pipeline'),
('DPH_only_shape_excluded',7+42+15,9947,'Q14'),
('historical_detail_over15',7+36,9947,'Q14+Q23'),
('current_documents',77+27+3+12+6,125,'Q05'),
('empty_items_with_summary',3+2+1+3,125,'Q24'),
('empty_items_with_DPH',1+2,125,'Q24'),
('current_raw_over15',2,125,'Q05+Q10'),
('current_receipt_cases',2,125,'Q06'),
('category_forms',4+9+0+0+14,19+59+12+30+56,'Q05'),
('category_vectors',19+59+0+0+56,19+59+12+30+56,'Q05'),
('kv_section_missing',91+91+91+91+91+91+91,91+91+91+91+91+91+91,'Q04'),
('approved_documents',68+24+3+12,125,'Q11'),
('approved_with_applied_run',68+24+1+12,107,'Q13'),
('approved_with_item_array',3+6+1+4,107,'Q13')
)
SELECT metric,numerator,denominator,round(100.0*numerator/denominator,2) AS percent,source FROM metrics;
```

Фактический результат, сериализованный в JSON:

```json
[
  {
    "metric": "history_total",
    "numerator": 9947,
    "denominator": 9947,
    "percent": 100,
    "source": "Q14"
  },
  {
    "metric": "history_no_details",
    "numerator": 5684,
    "denominator": 9947,
    "percent": 57.14,
    "source": "Q14"
  },
  {
    "metric": "history_rates_missing",
    "numerator": 9947,
    "denominator": 9947,
    "percent": 100,
    "source": "Q14+Q22"
  },
  {
    "metric": "candidate_cap",
    "numerator": 8680,
    "denominator": 9947,
    "percent": 87.26,
    "source": "Q26"
  },
  {
    "metric": "own_rule_missing",
    "numerator": 7075,
    "denominator": 9947,
    "percent": 71.13,
    "source": "Q14+Q19"
  },
  {
    "metric": "own_rule_present",
    "numerator": 2872,
    "denominator": 9947,
    "percent": 28.87,
    "source": "Q19"
  },
  {
    "metric": "passing_rule_not_stored",
    "numerator": 577,
    "denominator": 9947,
    "percent": 5.8,
    "source": "Q19"
  },
  {
    "metric": "header_dominance_fail",
    "numerator": 3481,
    "denominator": 9947,
    "percent": 35,
    "source": "Q19"
  },
  {
    "metric": "header_pred_missing",
    "numerator": 1242,
    "denominator": 9947,
    "percent": 12.49,
    "source": "Q19"
  },
  {
    "metric": "min_documents_fail",
    "numerator": 1298,
    "denominator": 9947,
    "percent": 13.05,
    "source": "Q19"
  },
  {
    "metric": "history_duplicate_headers",
    "numerator": 4059,
    "denominator": 9947,
    "percent": 40.81,
    "source": "Q16"
  },
  {
    "metric": "history_conflicting_headers",
    "numerator": 10,
    "denominator": 9947,
    "percent": 0.1,
    "source": "Q16"
  },
  {
    "metric": "INT",
    "numerator": 2553,
    "denominator": 9947,
    "percent": 25.67,
    "source": "Q23"
  },
  {
    "metric": "OZ",
    "numerator": 2961,
    "denominator": 9947,
    "percent": 29.77,
    "source": "Q23"
  },
  {
    "metric": "OZ_INT",
    "numerator": 5514,
    "denominator": 9947,
    "percent": 55.43,
    "source": "Q23"
  },
  {
    "metric": "FP_including_D",
    "numerator": 2816,
    "denominator": 9947,
    "percent": 28.31,
    "source": "Q23"
  },
  {
    "metric": "FV_including_D",
    "numerator": 1075,
    "denominator": 9947,
    "percent": 10.81,
    "source": "Q23"
  },
  {
    "metric": "cash",
    "numerator": 542,
    "denominator": 9947,
    "percent": 5.45,
    "source": "Q23"
  },
  {
    "metric": "OZ_with_detail",
    "numerator": 1140,
    "denominator": 2961,
    "percent": 38.5,
    "source": "Q23"
  },
  {
    "metric": "INT_with_detail",
    "numerator": 2014,
    "denominator": 2553,
    "percent": 78.89,
    "source": "Q23"
  },
  {
    "metric": "shape_example_single_or_different",
    "numerator": 2490,
    "denominator": 9947,
    "percent": 25.03,
    "source": "Q18"
  },
  {
    "metric": "shape_example_single",
    "numerator": 474,
    "denominator": 9947,
    "percent": 4.77,
    "source": "Q18"
  },
  {
    "metric": "shape_example_different",
    "numerator": 2016,
    "denominator": 9947,
    "percent": 20.27,
    "source": "Q18"
  },
  {
    "metric": "shape_lost_by_header_group_scope",
    "numerator": 677,
    "denominator": 9947,
    "percent": 6.81,
    "source": "Q21 pipeline"
  },
  {
    "metric": "shape_lost_by_header_split_docs",
    "numerator": 234,
    "denominator": 9947,
    "percent": 2.35,
    "source": "Q21 pipeline"
  },
  {
    "metric": "DPH_only_shape_excluded",
    "numerator": 64,
    "denominator": 9947,
    "percent": 0.64,
    "source": "Q14"
  },
  {
    "metric": "historical_detail_over15",
    "numerator": 43,
    "denominator": 9947,
    "percent": 0.43,
    "source": "Q14+Q23"
  },
  {
    "metric": "current_documents",
    "numerator": 125,
    "denominator": 125,
    "percent": 100,
    "source": "Q05"
  },
  {
    "metric": "empty_items_with_summary",
    "numerator": 9,
    "denominator": 125,
    "percent": 7.2,
    "source": "Q24"
  },
  {
    "metric": "empty_items_with_DPH",
    "numerator": 3,
    "denominator": 125,
    "percent": 2.4,
    "source": "Q24"
  },
  {
    "metric": "current_raw_over15",
    "numerator": 2,
    "denominator": 125,
    "percent": 1.6,
    "source": "Q05+Q10"
  },
  {
    "metric": "current_receipt_cases",
    "numerator": 2,
    "denominator": 125,
    "percent": 1.6,
    "source": "Q06"
  },
  {
    "metric": "category_forms",
    "numerator": 27,
    "denominator": 176,
    "percent": 15.34,
    "source": "Q05"
  },
  {
    "metric": "category_vectors",
    "numerator": 134,
    "denominator": 176,
    "percent": 76.14,
    "source": "Q05"
  },
  {
    "metric": "kv_section_missing",
    "numerator": 637,
    "denominator": 637,
    "percent": 100,
    "source": "Q04"
  },
  {
    "metric": "approved_documents",
    "numerator": 107,
    "denominator": 125,
    "percent": 85.6,
    "source": "Q11"
  },
  {
    "metric": "approved_with_applied_run",
    "numerator": 105,
    "denominator": 107,
    "percent": 98.13,
    "source": "Q13"
  },
  {
    "metric": "approved_with_item_array",
    "numerator": 14,
    "denominator": 107,
    "percent": 13.08,
    "source": "Q13"
  }
]
```

<a id="c02"></a>

### C02. Суммы групп и категорий

Локальный SELECT в памяти; группы взяты из Q15, потерянные формы из вывода Q21, категории из Q05.

```sql
SELECT 28+192+91 AS groups_with_example, 19+97+38 AS groups_with_two, 9+95+53 AS groups_with_one,16+80+21 AS groups_same_shape,3+17+17 AS groups_different_shape,4+9+8 AS equal_latest_dates,43+1 AS shape_lost_groups,19+59+12+30+56 AS active_categories,4+9+14 AS category_forms,19+59+56 AS category_vectors;
```

Фактический результат:

```json
[
  {
    "groups_with_example": 311,
    "groups_with_two": 154,
    "groups_with_one": 157,
    "groups_same_shape": 117,
    "groups_different_shape": 37,
    "equal_latest_dates": 21,
    "shape_lost_groups": 44,
    "active_categories": 176,
    "category_forms": 27,
    "category_vectors": 134
  }
]
```

### N1. Не выполнено: SSH не достиг PostgreSQL

Время вызова: 2026-09-09T11:46:04.305Z. Это текст попытки, не исполненный сервером SQL; данных он не вернул.

```sql
SELECT current_timestamp,count(*),count(DISTINCT (tenant_id,organization_id,agenda,doklad_cislo)) FILTER(WHERE doklad_cislo IS NOT NULL) FROM ucto_historia;
```

Фактический вывод команды:

```text
No ED25519 host key is known for 162.254.38.225 and you have requested strict checking.
Host key verification failed.
```

### N2. Не выполнено: SSH не достиг PostgreSQL

Время вызова: 2026-09-09T11:43:51.704Z. Это текст попытки, не исполненный сервером SQL; данных он не вернул.

```sql
WITH d AS (
 SELECT tenant_id,organization_id,agenda,doklad_cislo,count(*) rows,
 count(*) FILTER(WHERE riadok_index>0) items,
 count(*) FILTER(WHERE coalesce(riadok_index,0)=0) heads,
 count(DISTINCT predkontacia_kod) FILTER(WHERE riadok_index>0) item_accounts,
 count(DISTINCT(predkontacia_kod,clenenie_dph_kod,clenenie_kv_kod)) FILTER(WHERE riadok_index>0) item_treatments
 FROM ucto_historia GROUP BY 1,2,3,4)
SELECT agenda,sum(rows) history_rows,
 round(100.0*sum(rows)/(SELECT count(*) FROM ucto_historia),2) row_pct,
 count(*) FILTER(WHERE doklad_cislo IS NOT NULL) docs,
 count(*) FILTER(WHERE doklad_cislo IS NOT NULL AND rows>1) raw_multiline,
 count(*) FILTER(WHERE doklad_cislo IS NOT NULL AND items>1) detail_multiline,
 count(*) FILTER(WHERE doklad_cislo IS NOT NULL AND item_accounts>1) account_split,
 count(*) FILTER(WHERE doklad_cislo IS NOT NULL AND item_treatments>1) treatment_split,
 count(*) FILTER(WHERE doklad_cislo IS NOT NULL AND items=0 AND rows>1) multi_without_items,
 max(rows) FILTER(WHERE doklad_cislo IS NOT NULL) max_rows_numbered,
 max(items) FILTER(WHERE doklad_cislo IS NOT NULL) max_detail_numbered,
 sum(rows) FILTER(WHERE doklad_cislo IS NULL) null_number_rows,
 max(rows) FILTER(WHERE doklad_cislo IS NULL) largest_null_group
FROM d GROUP BY agenda ORDER BY history_rows DESC;
```

Фактический вывод команды:

```text
No ED25519 host key is known for 162.254.38.225 and you have requested strict checking.
Host key verification failed.
```

### N3. Не выполнено: SSH не достиг PostgreSQL

Время вызова: 2026-09-09T11:44:12.994Z. Это текст попытки, не исполненный сервером SQL; данных он не вернул.

```sql
SELECT id,document_type,podtyp,status,extracted->>'cisloFaktury' number,extracted->>'textPolozky' text,extracted->>'sumaSpolu' total,extracted->'polozky' items,accounting FROM documents WHERE extracted::text LIKE '%3116668238%' OR extracted::text LIKE '%2604131046667%';
SELECT id,document_id,status,completed_at,result->>'invoiceNumber' number,result->>'documentType' typ,result->>'documentSummary' summary,result->>'totalAmount' total,result->'lineItems' items,result->'additionalDocuments' more FROM extraction_runs WHERE result::text LIKE '%3116668238%' OR result::text LIKE '%2604131046667%' ORDER BY completed_at;
SELECT o.name,date_part('year',datum) rok,count(*) rows,count(DISTINCT (agenda,doklad_cislo)) docs FROM ucto_dennik h JOIN organizations o ON o.id=h.organization_id GROUP BY 1,2 ORDER BY 1,2;
```

Фактический вывод команды:

```text
No ED25519 host key is known for 162.254.38.225 and you have requested strict checking.
Host key verification failed.
```

### N4. Не выполнено: SSH не достиг PostgreSQL

Время вызова: 2026-09-09T11:45:40.565Z. Это текст попытки, не исполненный сервером SQL; данных он не вернул.

```sql
SELECT id,document_type,podtyp,status,extracted->>'cisloFaktury' number,extracted->>'textPolozky' text,extracted->>'sumaSpolu' total,extracted->'polozky' items,accounting FROM documents WHERE extracted::text LIKE '%3116668238%' OR extracted::text LIKE '%2604131046667%';
SELECT id,document_id,status,completed_at,result->>'invoiceNumber' number,result->>'documentType' typ,result->>'documentSummary' summary,result->>'totalAmount' total,result->'lineItems' items,result->'additionalDocuments' more FROM extraction_runs WHERE result::text LIKE '%3116668238%' OR result::text LIKE '%2604131046667%' ORDER BY completed_at;
SELECT o.name,date_part('year',datum) rok,count(*) rows,count(DISTINCT (agenda,doklad_cislo)) docs FROM ucto_dennik h JOIN organizations o ON o.id=h.organization_id GROUP BY 1,2 ORDER BY 1,2;
```

Фактический вывод команды:

```text
Warning: Identity file C:/Users/Mikita Kazlouski/.ssh/id_ed25519 not accessible: Permission denied.
No ED25519 host key is known for 162.254.38.225 and you have requested strict checking.
Host key verification failed.
```

### N5. Не выполнено: контрольный снимок

Команда завершилась с кодом 255; stdout и stderr пустые. SQL не подтверждён как выполненный.

```sql
SELECT jsonb_build_object('snapshot',current_timestamp,'rows',count(*),'numbered_docs',count(DISTINCT (tenant_id,organization_id,agenda,doklad_cislo)) FILTER(WHERE doklad_cislo IS NOT NULL),'numberless_rows',count(*) FILTER(WHERE doklad_cislo IS NULL)) FROM ucto_historia;
```

Фактический результат исполнителя:

```json
{
  "stdout": "",
  "stderr": "",
  "exit_code": 255
}
```

## Приложение B. Чего я НЕ проверил

- Не получен новый снимок PostgreSQL после расширения задания: повторные SSH-попытки не достигли БД. Результаты Q относятся к ранее выполненной части этой же задачи; данные могли измениться между вызовами и после них.
- Не подтверждён deployment незакоммиченного исправления передачи summary и rozpis DPH. Не запускалось повторное извлечение или предложение на текущей версии модели/промпта. Цитаты привязаны к указанному коммиту; перенос выводов на рабочее дерево требует проверки.
- Не сохранён необработанный серверный поток Q20/Q21. Сохранены полный SELECT, программа обработки и фактический вывод программы. Поэтому структурный результат чистой функции доступен, но независимый пересчёт по всем исходным строкам без повторного запроса невозможен. Неизвестные суммы и текст в этой проверке не заменяют реальные значения; корректность podiel и назначения ролей не измерена.
- Не получены отсутствующие результаты Q02 после первого SELECT и Q09 после BEGIN. Они не используются как будто успешно возвращённые таблицы. Первичная ошибочная метрика форм Q04 сохранена и явно заменена Q05.
- Не измерено число незарплатных INT, не классифицированы все INT на mzdy, samozdanenie, zápočet, zaokrúhlenie и прочие основания. Из факта общей agenda нельзя вывести число нуждающихся в DPH audit документов.
- Не подтверждены частоты конкретных лизинговых predkontácie, cestovné/stravné/zúčtovanie, карточных расчётов и прочих примеров OZ/INT из задания. Их названия использованы как постановка сценария, а не как результаты SQL.
- Не измерена доля многокомпонентных OZ/INT по точному экономическому определению. Наличие хотя бы одной detail-строки не равно разделению документа. Историческая бухгалтерская строка не равна напечатанной položka.
- Не выполнено массовое сопоставление числа печатных строк с итоговой проводкой. Поэтому нет доказанного числа документов, требующих merge, новой вычисленной строки или нескольких связанных документов.
- Не просмотрены договоры лизинга, splátkové kalendáre, даты передачи предметов и изменения договоров. Разделение istina/úroky/fin. sl. и DPH описано как проект проверяемого расчёта, а не как подтверждённый пересчёт корпуса.
- Не просмотрены cestovné príkazy, продолжительность поездок, предоставленное питание и полный реестр выданных авансов. Предложенный расчёт stravné/zúčtovanie не подтверждён по первичным документам конкретной фирмы.
- Не проверена пара 3116668238 / 2604131046667, соответствие Provízia и Finančná čiastka и фактический ответ AI по ней. Совпадение номера с W.A.G.-фикстурой не устанавливает тождество документа. Отсутствие claim в основных маршрутах доказано отдельно кодом.
- Не просмотрены оригинальные изображения MANGI/DECATHLON. Цифры сохранённого extraction result показывают, что записала система; они не подтверждают правильность OCR. Реквизиты и разбивка бумаги из постановки не выдаются за проверенный первоисточник.
- Не установлено назначение покупки MANGI или DECATHLON. Из названия продавца нельзя доказать reprezentácia, majetok, обычный náklad или право на odpočet. Выбор конкретной законной проводки остаётся зависимым от этих фактов.
- Не восстановлены фактические prompt payload исторических AI-вызовов целиком. Проверен конструктор payload указанного коммита и сохранённые результаты; реконструкция механизма по коду не равна наблюдению токенов старого запроса.
- Не измерен recall правильной predkontácia после cap на каждом историческом документе. Измерено лишь наличие срабатывающего ограничения по организации/agenda. Внешний объём ponuka не доказывает, что именно правильный счёт был исключён.
- Группы последних форм измерены по нормализованному имени. Runtime использует также IČO и объединение разрешённых agendy; при совпадающих датах выбор может отличаться. Не доказана полная идентичность SQL-аудита runtime-выборке.
- Не подтверждено заявленное распределение форм W.A.G. и ранее приведённые показатели semantic search/огрубления токенов. Эти цифры не используются для вычисления охвата и не повторяются как независимые замеры.
- Не установлена причина отсутствия сохранённых правил у проходящих пороги групп RCI/Recable. Не запускалась пересборка правил, категорий или векторов; предположение о незапущенном анализе остаётся гипотезой.
- Не выполнены повторные полные запуски анализа категорий на одинаковом снимке. Отсутствие ORDER BY и зависимость равенств от порядка выведены из кода; фактическая частота изменения результатов не измерена.
- Не измерено число фактических ошибок, вызванных высоким confidence при неполной форме, поздним удалением split-частей или порогом KATEGORIA_ISTOTA_OD. Найденные программные механизмы не выдаются за статистику ошибочных проводок.
- Не измерены потери Mostík по конкретной фирме/году, не получены исходные контрольные итоги POHODA и полные XML-ответы. Общий размер ucto_dennik не доказывает ни полноту, ни усечение одной выгрузки.
- Не сверена семантика всех členení DPH и KV с первичным POHODA-справочником. Пустота kv_section измерена; заполнение и правильность будущего mapping требуют отдельной проверки.
- Не выполнен сквозной прогон всех пар normalize/validator и frontend/backend XML на корпусе. Наличие расхождения кода не означает наблюдённый production-сбой. Изученный серверный маршрут и текущие SQL-срезы обозначены в диагнозе.
- Не подтверждена точность на всех agendy, полных формах, знаках и связанных документах. Сохранённые ucto_presnost и число подтверждений не являются таким доказательством; возможное влияние будущих категорий/решений на оценку не измерено отдельно.
- Не проведён полный юридический аудит каждого документа и всех специальных режимов. Проверены приведённые официальные источники для принципов DPH, finančný prenájom и cestovné náhrady. Нормативные числа и лимиты не переносились из памяти в расчёт корпуса; конкретный режим зависит от даты и первичных фактов.
- Не запускались предлагаемые проверки исправлений, импорт, экспорт или миграции. Формулировки «проверить до внедрения» — требования к приёмке будущей реализации, а не отчёт об уже пройденных тестах. Новые зависимости и изменения архитектуры не вносились.

Оставшаяся работа после этого аудита: получить недоступные первичные данные и новый read-only снимок, подтвердить экономические группы OZ/INT, затем проверять предложенный исполнитель форм и арбитр на временно отложенных реальных документах. Численного обещания повышения точности на непроверенных сценариях этот отчёт не даёт.
