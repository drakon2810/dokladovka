import { randomUUID } from 'node:crypto';
import type { Database, Queryable } from '../db/database.js';
import { pocetZhodSlov } from './accountingSuggestionService.js';

/**
 * Pravidlá odvodené z korpusu: čo firma s dokladmi tejto protistrany robí.
 *
 * Počíta sa DETERMINISTICKY, bez modelu — je to zhrnutie toho, čo v korpuse
 * naozaj stojí. Model dostane hotové pravidlo namiesto dvoch náhodných minulých
 * dokladov a účtovník si ho môže prečítať.
 *
 * Meranie hovorí, čo od toho čakať: hlavičku model trafí v 94 % a rozpis v 93 %
 * aj bez pravidiel. Nejde teda o presnosť, ale o to, aby to isté vyšlo novej
 * firme na jedno stlačenie a aby bolo vidieť, čo sa naučilo.
 */

/** Od koľkých dokladov sa protistrana považuje za ustálenú prax, nie za náhodu. */
export const MIN_DOKLADOV = 3;
/** Akú prevahu musí mať väčšinová hlavička, aby sa zapísala ako pravidlo. */
const MIN_ZHODA = 0.6;

export interface PravidloRiadok {
  text: string;
  predkontaciaKod?: string;
  clenenieDphKod?: string;
  clenenieKvKod?: string;
  /** Podiel na sume dokladu, keď je ustálený — napr. 0,8 a 0,2 pri PHM. */
  podiel?: number;
}

export interface UctoPravidlo {
  id: string;
  agenda: string;
  protistrana: string;
  protistranaIco?: string;
  dokladov: number;
  zhoda: number;
  predkontaciaKod?: string;
  clenenieDphKod?: string;
  clenenieKvKod?: string;
  rozpis: PravidloRiadok[];
}

/** Riadok dokladu, z ktorého sa odvodzuje tvar rozpisu. */
export interface RozpisRiadok {
  riadokIndex: number;
  text: string;
  suma?: number;
  predkontaciaKod?: string;
  clenenieDphKod?: string;
  clenenieKvKod?: string;
}

interface Riadok extends RozpisRiadok {
  agenda: string;
  dokladCislo: string;
  protistrana: string;
  ico?: string;
}

/** Najčastejšia hodnota a počet jej výskytov. */
function prevaha<T>(hodnoty: Array<T | undefined>): { hodnota?: T; pocet: number } {
  const pocty = new Map<string, { hodnota?: T; pocet: number }>();
  for (const hodnota of hodnoty) {
    const kluc = String(hodnota ?? '');
    const zaznam = pocty.get(kluc) ?? { hodnota, pocet: 0 };
    zaznam.pocet += 1;
    pocty.set(kluc, zaznam);
  }
  return [...pocty.values()].sort((a, b) => b.pocet - a.pocet)[0] ?? { pocet: 0 };
}

/**
 * Ustálený tvar položiek. Berie sa len vtedy, keď má väčšina dokladov protistrany
 * ROVNAKÝ počet položiek a na každej pozícii rovnaké zaúčtovanie — inak to nie je
 * tvar, ale priemer z rôznych dokladov a ten by klamal.
 */
export function odvodRozpis(doklady: RozpisRiadok[][]): PravidloRiadok[] {
  const podlaPoctu = prevaha(doklady.map((polozky) => polozky.length));
  const pocet = podlaPoctu.hodnota ?? 0;
  if (pocet < 2 || podlaPoctu.pocet < Math.max(2, doklady.length * MIN_ZHODA)) return [];
  const rovnake = doklady.filter((polozky) => polozky.length === pocet);

  const rozpis: PravidloRiadok[] = [];
  for (let index = 0; index < pocet; index += 1) {
    const naPozicii = rovnake.map((polozky) => polozky[index]);
    const predkontacia = prevaha(naPozicii.map((polozka) => polozka.predkontaciaKod));
    // Pozícia bez prevažujúcej predkontácie nie je ustálená — celý tvar padá,
    // lebo rozpis s dierou by účtovníka viedol k nesprávnemu riadku.
    if (!predkontacia.hodnota || predkontacia.pocet < rovnake.length * MIN_ZHODA) return [];
    const podiely = naPozicii.map((polozka, poradie) => {
      const spolu = rovnake[poradie].reduce((sucet, item) => sucet + Math.abs(item.suma ?? 0), 0);
      return spolu > 0 ? Math.abs(polozka.suma ?? 0) / spolu : undefined;
    }).filter((podiel): podiel is number => podiel !== undefined);
    // Podiel sa zapíše, len keď je naozaj stabilný (rozptyl do dvoch percent) —
    // pri obsahovom rozpise sa mení od dokladu k dokladu a číslo by bolo lož.
    const priemer = podiely.length > 0 ? podiely.reduce((a, b) => a + b, 0) / podiely.length : undefined;
    const stabilny = priemer !== undefined && podiely.length >= rovnake.length * MIN_ZHODA
      && podiely.every((podiel) => Math.abs(podiel - priemer) <= 0.02);
    rozpis.push({
      text: prevaha(naPozicii.map((polozka) => polozka.text)).hodnota ?? '',
      predkontaciaKod: predkontacia.hodnota,
      clenenieDphKod: prevaha(naPozicii.map((polozka) => polozka.clenenieDphKod)).hodnota,
      clenenieKvKod: prevaha(naPozicii.map((polozka) => polozka.clenenieKvKod)).hodnota,
      ...(stabilny ? { podiel: Number(priemer!.toFixed(3)) } : {}),
    });
  }
  // Rozpis, kde všetky riadky idú rovnako, nie je rozpis — doklad sa nedelí.
  const prvy = rozpis[0];
  const vsetkyRovnake = rozpis.every((riadok) =>
    riadok.predkontaciaKod === prvy.predkontaciaKod
    && riadok.clenenieDphKod === prvy.clenenieDphKod
    && riadok.clenenieKvKod === prvy.clenenieKvKod);
  return vsetkyRovnake ? [] : rozpis;
}

/**
 * Prax jednej protistrany z jej dokladov. Vydelené z prepočtu, lebo to isté
 * treba spočítať aj na mieru dátumu — pri meraní presnosti, kde uložené
 * pravidlo nesmie hovoriť o budúcnosti.
 */
function odvodPravidlo(doklady: Map<string, Riadok[]>): Omit<UctoPravidlo, 'id' | 'agenda' | 'protistrana'> | undefined {
  if (doklady.size < MIN_DOKLADOV) return undefined;
  const hlavicky = [...doklady.values()]
    .map((riadky) => riadky.find((riadok) => riadok.riadokIndex === 0))
    .filter((riadok): riadok is Riadok => Boolean(riadok));
  if (hlavicky.length < MIN_DOKLADOV) return undefined;
  const predkontacia = prevaha(hlavicky.map((riadok) => riadok.predkontaciaKod));
  if (!predkontacia.hodnota || predkontacia.pocet < hlavicky.length * MIN_ZHODA) return undefined;
  const polozky = [...doklady.values()]
    .map((riadky) => riadky.filter((riadok) => riadok.riadokIndex > 0))
    .filter((riadky) => riadky.length > 0);
  return {
    protistranaIco: hlavicky.find((riadok) => riadok.ico)?.ico,
    dokladov: hlavicky.length,
    zhoda: predkontacia.pocet,
    predkontaciaKod: predkontacia.hodnota,
    clenenieDphKod: prevaha(hlavicky.map((riadok) => riadok.clenenieDphKod)).hodnota,
    clenenieKvKod: prevaha(hlavicky.map((riadok) => riadok.clenenieKvKod)).hodnota,
    rozpis: polozky.length >= MIN_DOKLADOV ? odvodRozpis(polozky) : [],
  };
}

export async function prepocitajPravidla(
  database: Database,
  input: { tenantId: string; organizationId: string },
): Promise<{ pravidiel: number; sRozpisom: number }> {
  const rows = (await database.query<Record<string, any>>(
    `SELECT agenda, doklad_cislo, supplier_name_normalized, supplier_ico,
            coalesce(riadok_index, 0) AS riadok_index, line_text_normalized, suma,
            predkontacia_kod, clenenie_dph_kod, clenenie_kv_kod
       FROM ucto_historia
      WHERE tenant_id=$1 AND organization_id=$2
        AND doklad_cislo IS NOT NULL AND supplier_name_normalized IS NOT NULL
      ORDER BY agenda, supplier_name_normalized, doklad_cislo, coalesce(riadok_index, 0)`,
    [input.tenantId, input.organizationId],
  )).rows.map((row): Riadok => ({
    agenda: row.agenda,
    dokladCislo: row.doklad_cislo,
    protistrana: row.supplier_name_normalized,
    ico: row.supplier_ico ?? undefined,
    riadokIndex: Number(row.riadok_index),
    text: row.line_text_normalized ?? '',
    suma: row.suma === null ? undefined : Number(row.suma),
    predkontaciaKod: row.predkontacia_kod ?? undefined,
    clenenieDphKod: row.clenenie_dph_kod ?? undefined,
    clenenieKvKod: row.clenenie_kv_kod ?? undefined,
  }));

  // (agenda, protistrana) → doklad → riadky
  const skupiny = new Map<string, Map<string, Riadok[]>>();
  for (const riadok of rows) {
    const kluc = `${riadok.agenda}|${riadok.protistrana}`;
    let doklady = skupiny.get(kluc);
    if (!doklady) skupiny.set(kluc, doklady = new Map());
    const zoznam = doklady.get(riadok.dokladCislo) ?? [];
    zoznam.push(riadok);
    doklady.set(riadok.dokladCislo, zoznam);
  }

  const pravidla: UctoPravidlo[] = [];
  for (const [kluc, doklady] of skupiny) {
    const odvodene = odvodPravidlo(doklady);
    if (!odvodene) continue;
    const [agenda, protistrana] = kluc.split('|');
    pravidla.push({ id: randomUUID(), agenda, protistrana, ...odvodene });
  }

  // Náhrada celej sady: pravidlo je odvodenina korpusu, nie samostatný záznam.
  // Prírastok by po zmene histórie nechal v tabuľke neplatné pravidlá.
  await database.transaction(async (tx: Queryable) => {
    await tx.query('DELETE FROM ucto_pravidla WHERE tenant_id=$1 AND organization_id=$2',
      [input.tenantId, input.organizationId]);
    for (const pravidlo of pravidla) {
      await tx.query(
        `INSERT INTO ucto_pravidla
          (id,tenant_id,organization_id,agenda,protistrana,protistrana_ico,dokladov,zhoda,
           predkontacia_kod,clenenie_dph_kod,clenenie_kv_kod,rozpis)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [pravidlo.id, input.tenantId, input.organizationId, pravidlo.agenda, pravidlo.protistrana,
          pravidlo.protistranaIco ?? null, pravidlo.dokladov, pravidlo.zhoda,
          pravidlo.predkontaciaKod ?? null, pravidlo.clenenieDphKod ?? null,
          pravidlo.clenenieKvKod ?? null, JSON.stringify(pravidlo.rozpis)],
      );
    }
  });
  return { pravidiel: pravidla.length, sRozpisom: pravidla.filter((item) => item.rozpis.length > 0).length };
}

/** Prax protistrany spočítaná len z dokladov spred dátumu — pre meranie presnosti. */
async function pravidloKDatumu(
  database: Database,
  input: { tenantId: string; organizationId: string },
  agendy: readonly string[],
  protistrana: { ico: string; nazov: string },
  doDatumu: string,
): Promise<UctoPravidlo | undefined> {
  const rows = (await database.query<Record<string, any>>(
    `SELECT agenda, doklad_cislo, supplier_name_normalized, supplier_ico,
            coalesce(riadok_index, 0) AS riadok_index, line_text_normalized, suma,
            predkontacia_kod, clenenie_dph_kod, clenenie_kv_kod
       FROM ucto_historia
      WHERE tenant_id=$1 AND organization_id=$2 AND agenda=ANY($3::text[])
        AND doklad_cislo IS NOT NULL AND datum < $6::date
        AND (($4::text <> '' AND supplier_ico=$4) OR ($5::text <> '' AND supplier_name_normalized=$5))
      ORDER BY agenda, doklad_cislo, coalesce(riadok_index, 0)`,
    [input.tenantId, input.organizationId, agendy, protistrana.ico, protistrana.nazov, doDatumu],
  )).rows.map((row): Riadok => ({
    agenda: row.agenda,
    dokladCislo: row.doklad_cislo,
    protistrana: row.supplier_name_normalized,
    ico: row.supplier_ico ?? undefined,
    riadokIndex: Number(row.riadok_index),
    text: row.line_text_normalized ?? '',
    suma: row.suma === null ? undefined : Number(row.suma),
    predkontaciaKod: row.predkontacia_kod ?? undefined,
    clenenieDphKod: row.clenenie_dph_kod ?? undefined,
    clenenieKvKod: row.clenenie_kv_kod ?? undefined,
  }));
  // Podľa agendy zvlášť a vyhrá tá s najviac dokladmi — presne ako výber
  // z uloženej tabuľky (ORDER BY dokladov DESC).
  const podlaAgendy = new Map<string, Map<string, Riadok[]>>();
  for (const riadok of rows) {
    let doklady = podlaAgendy.get(riadok.agenda);
    if (!doklady) podlaAgendy.set(riadok.agenda, doklady = new Map());
    doklady.set(riadok.dokladCislo, [...(doklady.get(riadok.dokladCislo) ?? []), riadok]);
  }
  let najlepsie: UctoPravidlo | undefined;
  for (const [agenda, doklady] of podlaAgendy) {
    const odvodene = odvodPravidlo(doklady);
    if (!odvodene || (najlepsie && odvodene.dokladov <= najlepsie.dokladov)) continue;
    najlepsie = { id: randomUUID(), agenda, protistrana: protistrana.nazov, ...odvodene };
  }
  return najlepsie;
}

/** Pravidlo pre protistranu dokladu — ide modelu do promptu a účtovníkovi na obrazovku. */
export async function najdiPravidlo(
  database: Database,
  input: { tenantId: string; organizationId: string },
  agendy: readonly string[],
  protistrana: { nazov?: string; ico?: string },
  doDatumu?: string,
): Promise<UctoPravidlo | undefined> {
  const ico = String(protistrana.ico ?? '').replace(/\D/g, '');
  const nazov = (protistrana.nazov ?? '').trim().toLocaleLowerCase('sk').replace(/\s+/g, ' ');
  if (agendy.length === 0 || (!ico && !nazov)) return undefined;
  // Uložené pravidlo zhŕňa CELÝ korpus, teda aj doklady, ktoré sa v meranom
  // období ešte nestali — vrátane toho meraného. Pri meraní by teda model
  // dostal do promptu zhrnutie vlastnej odpovede a číslo by chválilo samo
  // seba; pri protistrane s troma dokladmi je meraný doklad tretina dôkazu.
  // S dátumom sa preto prax dopočíta priamo z histórie, rovnako ako denník
  // a príklady, ktoré deliaci dátum rešpektujú od začiatku.
  if (doDatumu) return pravidloKDatumu(database, input, agendy, { ico, nazov }, doDatumu);
  const row = (await database.query<Record<string, any>>(
    `SELECT * FROM ucto_pravidla
      WHERE tenant_id=$1 AND organization_id=$2 AND agenda=ANY($3::text[])
        AND (($4::text <> '' AND protistrana_ico=$4) OR ($5::text <> '' AND protistrana=$5))
      ORDER BY dokladov DESC LIMIT 1`,
    [input.tenantId, input.organizationId, agendy, ico, nazov],
  )).rows[0];
  if (!row) return undefined;
  return {
    id: row.id, agenda: row.agenda, protistrana: row.protistrana,
    protistranaIco: row.protistrana_ico ?? undefined,
    dokladov: Number(row.dokladov), zhoda: Number(row.zhoda),
    predkontaciaKod: row.predkontacia_kod ?? undefined,
    clenenieDphKod: row.clenenie_dph_kod ?? undefined,
    clenenieKvKod: row.clenenie_kv_kod ?? undefined,
    rozpis: (row.rozpis ?? []) as PravidloRiadok[],
  };
}
