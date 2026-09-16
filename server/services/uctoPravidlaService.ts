import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/database.js';
import { pocetZhodSlov } from './accountingSuggestionService.js';
import { clenenieVyzeraNaOdpocet } from './dphAdvisor.js';
import { loadDphProfil } from './dphProfileService.js';

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
/** Akú prevahu musí mať väčšinová podoba, aby sa zapísala ako pravidlo. */
export const MIN_ZHODA = 0.6;

export interface PravidloRiadok {
  text: string;
  predkontaciaKod?: string;
  clenenieDphKod?: string;
  clenenieKvKod?: string;
  /** Podiel na sume dokladu, keď je ustálený — napr. 0,8 a 0,2 pri PHM. */
  podiel?: number;
}

/** Časť položiek dokladu, ktorá sa od hlavičky líši, s podielom na doklade. */
export interface TvarCast {
  predkontaciaKod?: string;
  clenenieDphKod?: string;
  clenenieKvKod?: string;
  /** Podiel na základe dokladu, zaokrúhlený na 0,05. */
  podiel?: number;
  /** Podiel na dani dokladu, zaokrúhlený na 0,05. */
  podielDph?: number;
}

/**
 * Jedna podoba praxe: hlavička a tvar položiek, ktoré sa v dokladoch
 * vyskytli SPOLU. Nič z nej nie je poskladané z rôznych dokladov.
 */
/**
 * Spor praxí protistrany pre otázku účtovníkovi (R09). Keď sa podoby líšia
 * v členení DPH alebo sekcii KV, mení sa daň a hádať nemá kto — to je otázka.
 * Keď len v účte, stačí ponuka bez predvyplnenia.
 */
export function sporPraxe(
  pravidlo: { konflikt: boolean; varianty: Array<Pick<PraxVariant, 'clenenieDphKod' | 'clenenieKvKod'>> } | undefined,
): 'dph' | 'ucet' | undefined {
  if (!pravidlo?.konflikt) return undefined;
  const dane = new Set(pravidlo.varianty.map((variant) => `${variant.clenenieDphKod ?? ''}|${variant.clenenieKvKod ?? ''}`));
  return dane.size > 1 ? 'dph' : 'ucet';
}

export interface PraxVariant {
  predkontaciaKod?: string;
  clenenieDphKod?: string;
  clenenieKvKod?: string;
  tvar: TvarCast[];
  dokladov: number;
  od: string;
  do: string;
  /** Pri uloženom pravidle: táto podoba je pravidlom. */
  vitaz?: boolean;
  /** Pri uloženom pravidle: podoba vyhrala ako novší režim, nie počtom. */
  zmenaRezimu?: boolean;
}

export interface UctoPravidlo {
  id: string;
  agenda: string;
  protistrana: string;
  protistranaIco?: string;
  dokladov: number;
  /** Doklady víťaznej podoby, pri konflikte najčastejšej. */
  zhoda: number;
  predkontaciaKod?: string;
  clenenieDphKod?: string;
  clenenieKvKod?: string;
  rozpis: PravidloRiadok[];
  /** Žiadna podoba neprevažuje — kódy hlavičky vtedy chýbajú a rozhodujú varianty. */
  konflikt: boolean;
  varianty: PraxVariant[];
  /** Dátum, od ktorého firma protistranu účtuje novým spôsobom. */
  zmenaRezimu?: string;
}

/** Riadok dokladu, z ktorého sa odvodzuje tvar rozpisu. */
export interface RozpisRiadok {
  riadokIndex: number;
  text: string;
  suma?: number;
  sumaDph?: number;
  predkontaciaKod?: string;
  clenenieDphKod?: string;
  clenenieKvKod?: string;
}

/** Doklad korpusu pre výpočet praxe. */
export interface DokladPraxe {
  kluc: string;
  datum: string;
  ico?: string;
  hlavicka?: RozpisRiadok;
  polozky: RozpisRiadok[];
}

export interface Prax {
  dokladov: number;
  varianty: PraxVariant[];
  vitaz?: PraxVariant;
  konflikt: boolean;
  zmenaRezimu?: { od: string };
  /** Ustálený tvar položiek — len z dokladov víťaznej podoby. */
  rozpis: PravidloRiadok[];
}

/**
 * Identita dokladu v SQL nad ucto_historia: natívne id POHODY (jedinečné
 * v databáze a agende), inak (agenda, číslo, dátum) — číslo samo sa opakuje
 * naprieč agendami aj rokmi. Riadok bez čísla (preklopená pamäť) je doklad sám.
 * Tá istá identita ako zoskupDokladyHistorie.
 */
export const DOKLAD_KLUC_SQL = `(CASE
  WHEN pohoda_doklad_id IS NOT NULL
    THEN 'p|' || coalesce(lower(zdroj_databaza), '') || '|' || agenda || '|' || pohoda_doklad_id
  WHEN doklad_cislo IS NOT NULL THEN 'c|' || agenda || '|' || doklad_cislo || '|' || coalesce(datum::text, '')
  ELSE 'h|' || riadok_hash END)`;

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

const porovnaj = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const kod = (hodnota?: string) => hodnota?.trim() || undefined;
/** Zaúčtovanie riadku ako JEDNA hodnota — účet, DPH a KV sa nikdy neberú zvlášť. */
const trojica = (riadok: { predkontaciaKod?: string; clenenieDphKod?: string; clenenieKvKod?: string }) =>
  `${kod(riadok.predkontaciaKod) ?? ''}/${kod(riadok.clenenieDphKod) ?? ''}/${kod(riadok.clenenieKvKod) ?? ''}`;
const naPatiny = (podiel: number) => Math.round(podiel * 20) / 20;

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
    // Pozícia sa berie ako celá trojica účet/DPH/KV. Nezávislé väčšiny dali
    // z 40× X/PD/B2, 25× X/PN/KN a 35× Y/PD/KN riadok X/PD/KN, ktorý nebol
    // ani v jednom doklade.
    const zauctovanie = prevaha(rovnake.map((polozky) =>
      (polozky[index].predkontaciaKod ? trojica(polozky[index]) : undefined)));
    // Pozícia bez prevažujúceho zaúčtovania nie je ustálená — celý tvar padá,
    // lebo rozpis s dierou by účtovníka viedol k nesprávnemu riadku.
    if (!zauctovanie.hodnota || zauctovanie.pocet < rovnake.length * MIN_ZHODA) return [];
    const zhodne = rovnake.filter((polozky) => trojica(polozky[index]) === zauctovanie.hodnota);
    const vzor = zhodne[0][index];
    const podiely = zhodne.map((polozky) => {
      const spolu = polozky.reduce((sucet, item) => sucet + Math.abs(item.suma ?? 0), 0);
      return spolu > 0 ? Math.abs(polozky[index].suma ?? 0) / spolu : undefined;
    }).filter((podiel): podiel is number => podiel !== undefined);
    // Podiel sa zapíše, len keď je naozaj stabilný (rozptyl do dvoch percent) —
    // pri obsahovom rozpise sa mení od dokladu k dokladu a číslo by bolo lož.
    const priemer = podiely.length > 0 ? podiely.reduce((a, b) => a + b, 0) / podiely.length : undefined;
    const stabilny = priemer !== undefined && podiely.length >= zhodne.length * MIN_ZHODA
      && podiely.every((podiel) => Math.abs(podiel - priemer) <= 0.02);
    rozpis.push({
      text: prevaha(zhodne.map((polozky) => polozky[index].text)).hodnota ?? '',
      predkontaciaKod: vzor.predkontaciaKod,
      clenenieDphKod: vzor.clenenieDphKod,
      clenenieKvKod: vzor.clenenieKvKod,
      ...(stabilny ? { podiel: Number(priemer!.toFixed(3)) } : {}),
    });
  }
  // Rozpis, kde všetky riadky idú rovnako, nie je rozpis — doklad sa nedelí.
  const prvy = rozpis[0];
  const vsetkyRovnake = rozpis.every((riadok) => trojica(riadok) === trojica(prvy));
  return vsetkyRovnake ? [] : rozpis;
}

/** Jedna ustálená podoba rozpisu a počet dokladov, ktoré ju majú. */
export interface RozpisVariant {
  pocet: number;
  riadky: PravidloRiadok[];
}

/** Viac než toľko podôb do promptu nepatrí — kategória by prerástla dôkazy. */
const MAX_VARIANTOV = 8;
/** Koľko podôb praxe protistrany ide modelu — zvyšok je šum. */
const VARIANTOV_V_PROMPTE = 3;

/**
 * Podoby rozpisu pre množinu dokladov, ktoré nemusia hovoriť o jednej veci.
 *
 * Pravidlo protistrany sa pýta na JEDNÉHO dodávateľa, takže jeden tvar stačí.
 * Kategória je širšia: ALPINA má pod „PHM" 156 dokladov dvoch nezlučiteľných
 * druhov — tuzemská karta Shell (PHM-501200 80 % + PHM-Nadspotreba 20 %) a
 * zahraničné tankovanie kamiónov (PHM + DPH Taliansko / Francúzsko / Rakúsko
 * / Španielsko). Jeden tvar z toho odvodiť NEMOŽNO a odvodRozpis to správne
 * odmietol: na druhej pozícii mal najsilnejší účet 27 % namiesto potrebných
 * 60 %. Kategória tak ostala bez rozpisu a tvrdila PN na celé palivo, hoci
 * nedaňová je pätina — nový dodávateľ PHM by nedostal odpočet vôbec.
 *
 * Doklady sa preto najprv rozdelia podľa PODPISU tvaru (postupnosť zaúčtovaní
 * účet/DPH/KV — dva doklady s rovnakými účtami, ale prehodeným odpočtom sú dve
 * podoby, nie jedna) a tvar sa odvodí v každej skupine zvlášť. Model potom
 * vyberá podobu, ktorej zaúčtovanie sedí na doklad pred ním.
 */
export function odvodRozpisVarianty(doklady: RozpisRiadok[][]): RozpisVariant[] {
  const skupiny = new Map<string, RozpisRiadok[][]>();
  for (const polozky of doklady) {
    // Doklad s riadkom bez účtu tvar neurčuje — podpis by bol dierou, nie tvarom.
    if (polozky.length === 0 || polozky.some((polozka) => !polozka.predkontaciaKod)) continue;
    const podpis = polozky.map(trojica).join(' | ');
    const skupina = skupiny.get(podpis) ?? [];
    skupina.push(polozky);
    skupiny.set(podpis, skupina);
  }
  const varianty: RozpisVariant[] = [];
  for (const skupina of [...skupiny.values()].sort((a, b) => b.length - a.length)) {
    if (skupina.length < MIN_DOKLADOV) continue;
    const riadky = odvodRozpis(skupina);
    if (riadky.length === 0) continue;
    varianty.push({ pocet: skupina.length, riadky });
    if (varianty.length >= MAX_VARIANTOV) break;
  }
  return varianty;
}

/**
 * Rozpis kategórie v jednotnom tvare. Uložené profily z čias jedného tvaru
 * nesú plché pole riadkov; prepočet profilu ich prepíše na podoby, dovtedy sa
 * čítajú ako jediná podoba. Bez toho by staršia firma prišla o rozpis úplne.
 */
export function variantyRozpisu(rozpis: unknown): RozpisVariant[] {
  if (!Array.isArray(rozpis) || rozpis.length === 0) return [];
  const prvy = rozpis[0] as Record<string, unknown>;
  if (prvy && typeof prvy === 'object' && Array.isArray(prvy.riadky)) {
    return (rozpis as RozpisVariant[]).filter((variant) => variant.riadky.length > 0);
  }
  return [{ pocet: 0, riadky: rozpis as PravidloRiadok[] }];
}

/**
 * Tvar dokladu: časti položiek, ktoré sa od hlavičky líšia v účte, DPH alebo
 * KV, každá s podielom na základe aj dani dokladu. Položky, ktoré hlavičku
 * len dedia, podobu nedelia — inak by každý iný počet riadkov bol iná prax.
 * Podiel je v kľúči, lebo 80/20 s daňou 50/50 a 80/20 s daňou 80/20 sú dve
 * rôzne rozhodnutia firmy (krátený odpočet proti pomernému).
 */
function tvarDokladu(doklad: DokladPraxe): TvarCast[] {
  const hlavicka = trojica(doklad.hlavicka ?? {});
  const zaklad = doklad.polozky.reduce((sucet, polozka) => sucet + Math.abs(polozka.suma ?? 0), 0);
  const dan = doklad.polozky.reduce((sucet, polozka) => sucet + Math.abs(polozka.sumaDph ?? 0), 0);
  const casti = new Map<string, { riadok: RozpisRiadok; suma: number; sumaDph: number }>();
  for (const polozka of doklad.polozky) {
    const kluc = trojica(polozka);
    if (kluc === hlavicka) continue;
    const cast = casti.get(kluc) ?? { riadok: polozka, suma: 0, sumaDph: 0 };
    cast.suma += Math.abs(polozka.suma ?? 0);
    cast.sumaDph += Math.abs(polozka.sumaDph ?? 0);
    casti.set(kluc, cast);
  }
  return [...casti.entries()].sort(([a], [b]) => porovnaj(a, b)).map(([, cast]) => ({
    predkontaciaKod: kod(cast.riadok.predkontaciaKod),
    clenenieDphKod: kod(cast.riadok.clenenieDphKod),
    clenenieKvKod: kod(cast.riadok.clenenieKvKod),
    ...(zaklad > 0 ? { podiel: naPatiny(cast.suma / zaklad) } : {}),
    ...(dan > 0 ? { podielDph: naPatiny(cast.sumaDph / dan) } : {}),
  }));
}

/**
 * Prax protistrany ako SPOLOČNÉ rozdelenie podôb dokladu, nie tri nezávislé
 * väčšiny. Každá podoba (hlavička + tvar položiek) je doložená dokladmi, v
 * ktorých sa vyskytla celá, takže pravidlo nikdy nevydá kombináciu, ktorú
 * firma nepoužila.
 *
 * Víťaz: podoba s najneskorším začiatkom medzi ustálenými (aspoň MIN_DOKLADOV),
 * keď začala až po konci všetkých ostatných — firma prax zmenila a stará
 * väčšina už neplatí. Inak najčastejšia podoba s prevahou MIN_ZHODA. Inak
 * konflikt a žiadny víťaz: radšej priznať viac praxí než ich zmiešať.
 *
 * Výstup nezávisí od poradia vstupu. S asOf sa berú len doklady pred dátumom;
 * doklad bez dátumu sa nepočíta nikdy — o režime ani o úniku budúcnosti nič nepovie.
 */
export function odvodPrax(doklady: DokladPraxe[], asOf?: string): Prax {
  const platne = doklady
    .filter((doklad) => doklad.hlavicka && doklad.datum && (!asOf || doklad.datum < asOf))
    .sort((a, b) => porovnaj(a.kluc, b.kluc));
  const skupiny = new Map<string, { variant: PraxVariant; doklady: DokladPraxe[] }>();
  for (const doklad of platne) {
    const tvar = tvarDokladu(doklad);
    const kluc = `${trojica(doklad.hlavicka!)}#${tvar.map((cast) =>
      `${trojica(cast)}:${cast.podiel ?? ''}:${cast.podielDph ?? ''}`).join(',')}`;
    let skupina = skupiny.get(kluc);
    if (!skupina) {
      skupiny.set(kluc, skupina = {
        variant: {
          predkontaciaKod: kod(doklad.hlavicka!.predkontaciaKod),
          clenenieDphKod: kod(doklad.hlavicka!.clenenieDphKod),
          clenenieKvKod: kod(doklad.hlavicka!.clenenieKvKod),
          tvar, dokladov: 0, od: doklad.datum, do: doklad.datum,
        },
        doklady: [],
      });
    }
    skupina.doklady.push(doklad);
    skupina.variant.dokladov += 1;
    if (doklad.datum < skupina.variant.od) skupina.variant.od = doklad.datum;
    if (doklad.datum > skupina.variant.do) skupina.variant.do = doklad.datum;
  }
  const zoradene = [...skupiny.entries()]
    .sort(([klucA, a], [klucB, b]) => b.variant.dokladov - a.variant.dokladov
      || porovnaj(b.variant.do, a.variant.do) || porovnaj(klucA, klucB))
    .map(([, skupina]) => skupina);

  const najnovsia = zoradene
    .filter((skupina) => skupina.variant.dokladov >= MIN_DOKLADOV)
    .reduce<typeof zoradene[number] | undefined>((naj, skupina) =>
      (!naj || skupina.variant.od > naj.variant.od ? skupina : naj), undefined);
  const prechod = najnovsia && zoradene.length > 1
    && zoradene.every((skupina) => skupina === najnovsia || skupina.variant.do < najnovsia.variant.od)
    ? najnovsia : undefined;
  const vitaz = prechod
    ?? (zoradene[0] && zoradene[0].variant.dokladov >= platne.length * MIN_ZHODA ? zoradene[0] : undefined);
  const polozky = (vitaz?.doklady ?? []).map((doklad) => doklad.polozky).filter((riadky) => riadky.length > 0);
  return {
    dokladov: platne.length,
    varianty: zoradene.map((skupina) => skupina.variant),
    vitaz: vitaz?.variant,
    konflikt: platne.length > 0 && !vitaz,
    zmenaRezimu: prechod ? { od: prechod.variant.od } : undefined,
    rozpis: polozky.length >= MIN_DOKLADOV ? odvodRozpis(polozky) : [],
  };
}

/**
 * Pravidlo protistrany z jej dokladov. Vydelené z prepočtu, lebo to isté
 * treba spočítať aj na mieru dátumu — pri meraní presnosti, kde uložené
 * pravidlo nesmie hovoriť o budúcnosti.
 */
function odvodPravidlo(
  doklady: DokladPraxe[],
  asOf?: string,
): Omit<UctoPravidlo, 'id' | 'agenda' | 'protistrana'> | undefined {
  const prax = odvodPrax(doklady, asOf);
  if (prax.dokladov < MIN_DOKLADOV) return undefined;
  const { vitaz } = prax;
  const ulozene = prax.varianty.slice(0, MAX_VARIANTOV);
  // Víťaz novším režimom môže mať menej dokladov než osem starších podôb —
  // bez neho by obrazovka nevedela ukázať, od kedy pravidlo platí.
  if (vitaz && !ulozene.includes(vitaz)) ulozene.push(vitaz);
  return {
    protistranaIco: [...doklady].sort((a, b) => porovnaj(a.kluc, b.kluc)).find((doklad) => doklad.ico)?.ico,
    dokladov: prax.dokladov,
    zhoda: (vitaz ?? prax.varianty[0]).dokladov,
    // Kódy hlavičky len z víťaznej podoby — pri konflikte žiadne, nikdy zmes.
    predkontaciaKod: vitaz?.predkontaciaKod,
    clenenieDphKod: vitaz?.clenenieDphKod,
    clenenieKvKod: vitaz?.clenenieKvKod,
    rozpis: prax.rozpis,
    konflikt: prax.konflikt,
    varianty: ulozene.map((variant) => (variant === vitaz
      ? { ...variant, vitaz: true, ...(prax.zmenaRezimu ? { zmenaRezimu: true } : {}) }
      : variant)),
    zmenaRezimu: prax.zmenaRezimu?.od,
  };
}

/**
 * Doklady korpusu po protistranách. JEDEN načítač pre uložené pravidlá aj
 * pravidlo k dátumu: kým mal každý vlastný dopyt (jeden bral doklady bez
 * dátumu, druhý hľadal cez IČO), meranie presnosti meralo iné pravidlo, než
 * aké dostáva produkcia.
 */
async function nacitajDokladyPraxe(
  database: Queryable,
  input: { tenantId: string; organizationId: string },
  filter: { agendy?: readonly string[]; ico?: string; nazov?: string; doDatumu?: string } = {},
): Promise<Array<{ agenda: string; protistrana: string; doklady: DokladPraxe[] }>> {
  // Pri hľadaní jednej protistrany sa berú CELÉ skupiny (agenda, meno), ktoré
  // sa môžu trafiť: meno samo alebo mená, pod ktorými sa vyskytlo IČO. Skupina
  // tak má rovnaké doklady ako v uloženom prepočte.
  const rows = (await database.query<Record<string, any>>(
    `SELECT agenda, supplier_name_normalized, supplier_ico, datum::text AS datum,
            ${DOKLAD_KLUC_SQL} AS doklad_kluc, coalesce(riadok_index, 0) AS riadok_index,
            line_text_normalized, suma, suma_dph, predkontacia_kod, clenenie_dph_kod, clenenie_kv_kod
       FROM ucto_historia
      WHERE tenant_id=$1 AND organization_id=$2
        AND doklad_cislo IS NOT NULL AND supplier_name_normalized IS NOT NULL AND datum IS NOT NULL
        AND ($3::text[] IS NULL OR agenda = ANY($3::text[]))
        AND ($4::date IS NULL OR datum < $4::date)
        AND (($5::text IS NULL AND $6::text IS NULL) OR supplier_name_normalized = $5
          OR supplier_name_normalized IN (SELECT supplier_name_normalized FROM ucto_historia
            WHERE tenant_id=$1 AND organization_id=$2 AND supplier_ico = $6))
      ORDER BY agenda, supplier_name_normalized, doklad_kluc, riadok_index`,
    [input.tenantId, input.organizationId, filter.agendy ? [...filter.agendy] : null, filter.doDatumu ?? null,
      filter.nazov || null, filter.ico || null],
  )).rows;

  const skupiny = new Map<string, { agenda: string; protistrana: string; doklady: Map<string, DokladPraxe> }>();
  for (const row of rows) {
    const klucSkupiny = JSON.stringify([row.agenda, row.supplier_name_normalized]);
    let skupina = skupiny.get(klucSkupiny);
    if (!skupina) {
      skupiny.set(klucSkupiny, skupina = { agenda: row.agenda, protistrana: row.supplier_name_normalized, doklady: new Map() });
    }
    let doklad = skupina.doklady.get(row.doklad_kluc);
    if (!doklad) skupina.doklady.set(row.doklad_kluc, doklad = { kluc: row.doklad_kluc, datum: row.datum, polozky: [] });
    doklad.ico ||= row.supplier_ico || undefined;
    const riadok: RozpisRiadok = {
      riadokIndex: Number(row.riadok_index),
      text: row.line_text_normalized ?? '',
      suma: row.suma === null ? undefined : Number(row.suma),
      sumaDph: row.suma_dph === null ? undefined : Number(row.suma_dph),
      predkontaciaKod: row.predkontacia_kod ?? undefined,
      clenenieDphKod: row.clenenie_dph_kod ?? undefined,
      clenenieKvKod: row.clenenie_kv_kod ?? undefined,
    };
    if (riadok.riadokIndex === 0) doklad.hlavicka = riadok;
    else doklad.polozky.push(riadok);
  }
  return [...skupiny.values()].map((skupina) => ({ ...skupina, doklady: [...skupina.doklady.values()] }));
}

/**
 * Prepočet uložených pravidiel. Transakciu drží volajúci: analýza a prepočet
 * po prenose histórie menia pravidlá spolu s kategóriami v jednom kroku.
 */
export async function prepocitajPravidla(
  database: Queryable,
  input: { tenantId: string; organizationId: string },
): Promise<{ pravidiel: number; sRozpisom: number; konfliktov: number; zmienRezimu: number }> {
  const pravidla: UctoPravidlo[] = [];
  for (const skupina of await nacitajDokladyPraxe(database, input)) {
    const odvodene = odvodPravidlo(skupina.doklady);
    if (odvodene) pravidla.push({ id: randomUUID(), agenda: skupina.agenda, protistrana: skupina.protistrana, ...odvodene });
  }

  // Náhrada celej sady: pravidlo je odvodenina korpusu, nie samostatný záznam.
  // Prírastok by po zmene histórie nechal v tabuľke neplatné pravidlá.
  await database.query('DELETE FROM ucto_pravidla WHERE tenant_id=$1 AND organization_id=$2',
    [input.tenantId, input.organizationId]);
  for (const pravidlo of pravidla) {
    await database.query(
      `INSERT INTO ucto_pravidla
        (id,tenant_id,organization_id,agenda,protistrana,protistrana_ico,dokladov,zhoda,
         predkontacia_kod,clenenie_dph_kod,clenenie_kv_kod,rozpis,varianty,konflikt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14)`,
      [pravidlo.id, input.tenantId, input.organizationId, pravidlo.agenda, pravidlo.protistrana,
        pravidlo.protistranaIco ?? null, pravidlo.dokladov, pravidlo.zhoda,
        pravidlo.predkontaciaKod ?? null, pravidlo.clenenieDphKod ?? null,
        pravidlo.clenenieKvKod ?? null, JSON.stringify(pravidlo.rozpis), JSON.stringify(pravidlo.varianty),
        pravidlo.konflikt],
    );
  }
  return {
    pravidiel: pravidla.length,
    sRozpisom: pravidla.filter((item) => item.rozpis.length > 0).length,
    konfliktov: pravidla.filter((item) => item.konflikt).length,
    zmienRezimu: pravidla.filter((item) => item.zmenaRezimu).length,
  };
}

/** Pravidlo tak, ako ide návrhu: podôb len toľko, koľko model unesie. */
function preNavrh(pravidlo: UctoPravidlo): UctoPravidlo {
  return { ...pravidlo, varianty: pravidlo.varianty.slice(0, VARIANTOV_V_PROMPTE) };
}

/** Prax protistrany spočítaná len z dokladov spred dátumu — pre meranie presnosti. */
async function pravidloKDatumu(
  database: Queryable,
  input: { tenantId: string; organizationId: string },
  agendy: readonly string[],
  protistrana: { ico: string; nazov: string },
  doDatumu: string,
): Promise<UctoPravidlo | undefined> {
  // Rovnaký výber ako z uloženej tabuľky: zhoda IČO pravidla alebo mena,
  // a vyhrá pravidlo s najviac dokladmi (pri zhode prvé podľa agendy a mena).
  let najlepsie: UctoPravidlo | undefined;
  for (const skupina of await nacitajDokladyPraxe(database, input, { agendy, ...protistrana, doDatumu })) {
    const odvodene = odvodPravidlo(skupina.doklady, doDatumu);
    if (!odvodene) continue;
    const trafene = (protistrana.ico && odvodene.protistranaIco === protistrana.ico)
      || (protistrana.nazov && skupina.protistrana === protistrana.nazov);
    if (!trafene || (najlepsie && odvodene.dokladov <= najlepsie.dokladov)) continue;
    najlepsie = { id: randomUUID(), agenda: skupina.agenda, protistrana: skupina.protistrana, ...odvodene };
  }
  return najlepsie && preNavrh(najlepsie);
}

/** Pravidlo pre protistranu dokladu — ide modelu do promptu a účtovníkovi na obrazovku. */
export async function najdiPravidlo(
  database: Queryable,
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
      ORDER BY dokladov DESC, agenda, protistrana LIMIT 1`,
    [input.tenantId, input.organizationId, agendy, ico, nazov],
  )).rows[0];
  if (!row) return undefined;
  const varianty = (row.varianty ?? []) as PraxVariant[];
  return preNavrh({
    id: row.id, agenda: row.agenda, protistrana: row.protistrana,
    protistranaIco: row.protistrana_ico ?? undefined,
    dokladov: Number(row.dokladov), zhoda: Number(row.zhoda),
    predkontaciaKod: row.predkontacia_kod ?? undefined,
    clenenieDphKod: row.clenenie_dph_kod ?? undefined,
    clenenieKvKod: row.clenenie_kv_kod ?? undefined,
    rozpis: (row.rozpis ?? []) as PravidloRiadok[],
    konflikt: row.konflikt === true,
    varianty,
    zmenaRezimu: varianty.find((variant) => variant.vitaz && variant.zmenaRezimu)?.od,
  });
}

/** Riadok položky pre hľadanie ustáleného delenia. */
export interface RiadokDelenia {
  text: string;
  suma?: number;
  sumaDph?: number;
  predkontaciaId?: string;
  clenenieDphId?: string;
  /** Kód a názov členenia — rozhodujú, ktorá časť je nedaňová. */
  clenenieDphKod?: string;
  clenenieDphNazov?: string;
}

export interface DokladDelenia {
  kluc: string;
  cislo: string;
  datum: string;
  polozky: RiadokDelenia[];
}

/** Návrh pravidla delenia položky v tvare pravidla auta z DPH profilu. */
export interface NavrhDelenia {
  klucoveSlova: string[];
  percento: number;
  percentoDph?: number;
  predkontaciaId: string;
  predkontaciaNedanovaId: string;
  clenenieDphNedanoveId?: string;
  dokladov: number;
  priklady: Array<{ cislo: string; datum: string }>;
}

const bezDiakritiky = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('sk');
const slovaTextu = (text: string) => bezDiakritiky(text).match(/\p{L}{3,}/gu) ?? [];

/**
 * Ustálené delenie jednej položky na daňovú a nedaňovú časť — napr. PHM 80 %
 * na účet paliva a 20 % na nadspotrebu, s daňou 50/50. Hľadá sa všeobecne:
 * dva riadky toho istého druhu v jednom doklade na dvoch predkontáciách, z nich
 * práve jeden s členením bez odpočtu, a ten istý pomer základu aj dane naprieč
 * aspoň MIN_DOKLADOV dokladmi s prevahou MIN_ZHODA.
 *
 * ponytail: „ten istý druh" = prvé slovo textu („natural 95 danova cast" /
 * „natural 95 nedanova cast"). Delenie, ktorého časti sa volajú celkom inak,
 * sa nenájde; ďalší krok je priradenie textu ku kategórii cez jej slovník.
 */
export function odvodNavrhyDelenia(doklady: DokladDelenia[]): NavrhDelenia[] {
  const skupiny = new Map<string, {
    danova: string; nedanova: string; clenenie?: string;
    podlaPomeru: Map<string, Array<{ doklad: DokladDelenia; slova: Set<string> }>>; dokladov: number;
    riadky: Set<RiadokDelenia>;
  }>();
  for (const doklad of [...doklady].sort((a, b) => porovnaj(a.kluc, b.kluc))) {
    const druhy = new Map<string, RiadokDelenia[]>();
    for (const polozka of doklad.polozky) {
      const druh = slovaTextu(polozka.text)[0];
      if (!druh || !polozka.predkontaciaId) continue;
      druhy.set(druh, [...(druhy.get(druh) ?? []), polozka]);
    }
    const videne = new Set<string>();
    for (const [druh, riadky] of [...druhy.entries()].sort(([a], [b]) => porovnaj(a, b))) {
      const ucty = [...new Set(riadky.map((riadok) => riadok.predkontaciaId!))];
      if (ucty.length !== 2) continue;
      const casti = ucty.map((ucet) => {
        const jeho = riadky.filter((riadok) => riadok.predkontaciaId === ucet);
        return {
          ucet,
          clenenie: jeho[0].clenenieDphId,
          bezOdpoctu: jeho.every((riadok) => riadok.clenenieDphKod
            && !clenenieVyzeraNaOdpocet({ kod: riadok.clenenieDphKod, nazov: riadok.clenenieDphNazov ?? '' })),
          suma: jeho.reduce((sucet, riadok) => sucet + Math.abs(riadok.suma ?? 0), 0),
          sumaDph: jeho.reduce((sucet, riadok) => sucet + Math.abs(riadok.sumaDph ?? 0), 0),
        };
      });
      // Delenie pre odpočet: práve jedna časť daň neodpočítava. Dve bežné
      // služby od jedného dodávateľa nie sú rez jednej položky.
      const nedanova = casti.filter((cast) => cast.bezOdpoctu);
      const danova = casti.filter((cast) => !cast.bezOdpoctu);
      if (nedanova.length !== 1 || danova.length !== 1) continue;
      const zaklad = danova[0].suma + nedanova[0].suma;
      if (zaklad <= 0) continue;
      const dan = danova[0].sumaDph + nedanova[0].sumaDph;
      const percento = Math.round(naPatiny(danova[0].suma / zaklad) * 100);
      // Časť, ktorá sa zaokrúhli na nič, nie je rez — návrh zaúčtovania by také pravidlo aj tak nepoužil.
      if (percento <= 0 || percento >= 100) continue;
      const percentoDph = dan > 0 ? Math.round(naPatiny(danova[0].sumaDph / dan) * 100) : undefined;
      const kluc = JSON.stringify([druh, danova[0].ucet, nedanova[0].ucet, nedanova[0].clenenie ?? '']);
      if (videne.has(kluc)) continue;
      videne.add(kluc);
      let skupina = skupiny.get(kluc);
      if (!skupina) {
        skupiny.set(kluc, skupina = {
          danova: danova[0].ucet, nedanova: nedanova[0].ucet, clenenie: nedanova[0].clenenie,
          podlaPomeru: new Map(), dokladov: 0, riadky: new Set(),
        });
      }
      skupina.dokladov += 1;
      for (const riadok of riadky) skupina.riadky.add(riadok);
      const pomer = `${percento}:${percentoDph ?? ''}`;
      // Kľúčové slová z oboch častí naraz: slovo len jednej časti („danova",
      // „nedanova") hovorí o reze, nie o tom, čo sa kupuje, a pravidlo by ním
      // rezalo cudzie položky.
      const slovaCasti = (ucet: string) => new Set(riadky
        .filter((riadok) => riadok.predkontaciaId === ucet).flatMap((riadok) => slovaTextu(riadok.text)));
      const nedanoveSlova = slovaCasti(nedanova[0].ucet);
      skupina.podlaPomeru.set(pomer, [...(skupina.podlaPomeru.get(pomer) ?? []),
        { doklad, slova: new Set([...slovaCasti(danova[0].ucet)].filter((slovo) => nedanoveSlova.has(slovo))) }]);
    }
  }

  const vsetkyRiadky = doklady.flatMap((doklad) => doklad.polozky)
    .map((riadok) => ({ riadok, text: bezDiakritiky(riadok.text) }));
  const navrhy: NavrhDelenia[] = [];
  for (const skupina of skupiny.values()) {
    const [pomer, vyskyty] = [...skupina.podlaPomeru.entries()]
      .sort(([a, x], [b, y]) => y.length - x.length || porovnaj(a, b))[0];
    if (vyskyty.length < MIN_DOKLADOV || vyskyty.length < skupina.dokladov * MIN_ZHODA) continue;
    const [percento, percentoDph] = pomer.split(':');
    const pocetSlov = new Map<string, number>();
    for (const vyskyt of vyskyty) for (const slovo of vyskyt.slova) pocetSlov.set(slovo, (pocetSlov.get(slovo) ?? 0) + 1);
    // Pravidlo auta reže položku, ktorej text slovo len OBSAHUJE (najdiKlucoveSlovo).
    // Slovo, ktoré sa vyskytne aj mimo tohto rezu — „cast" v inom delení,
    // „Castrol olej" —, by rozrezalo cudzie položky na účty paliva.
    const klucoveSlova = [...pocetSlov.entries()].sort(([a, x], [b, y]) => y - x || porovnaj(a, b))
      .map(([slovo]) => slovo)
      .filter((slovo) => !vsetkyRiadky.some(({ riadok, text }) => !skupina.riadky.has(riadok) && text.includes(slovo)))
      .slice(0, 5);
    // Bez slova sa pravidlo auta nepoužije nikdy — taký návrh by len mátol.
    if (klucoveSlova.length === 0) continue;
    navrhy.push({
      klucoveSlova,
      percento: Number(percento),
      ...(percentoDph ? { percentoDph: Number(percentoDph) } : {}),
      predkontaciaId: skupina.danova,
      predkontaciaNedanovaId: skupina.nedanova,
      ...(skupina.clenenie ? { clenenieDphNedanoveId: skupina.clenenie } : {}),
      dokladov: vyskyty.length,
      priklady: [...vyskyty].sort((a, b) => porovnaj(b.doklad.datum, a.doklad.datum)).slice(0, 3)
        .map(({ doklad }) => ({ cislo: doklad.cislo, datum: doklad.datum })),
    });
  }
  return navrhy.sort((a, b) => b.dokladov - a.dokladov || porovnaj(a.predkontaciaId, b.predkontaciaId));
}

/**
 * Návrhy pravidiel delenia pre obrazovku profilu. Delenie, ktoré DPH profil
 * klienta už reže na tie isté dva účty, sa nenavrhuje znova. Nič sa neukladá —
 * pravidlo pridá až účtovník.
 */
export async function navrhyPravidielDelenia(
  database: Queryable,
  input: { tenantId: string; organizationId: string },
): Promise<NavrhDelenia[]> {
  const nazvyCleneni = new Map((await database.query<{ id: string; code: string; name: string } & Record<string, unknown>>(
    `SELECT id, code, name FROM code_list_items WHERE tenant_id=$1 AND organization_id=$2 AND kind='cleneniaDph'`,
    [input.tenantId, input.organizationId],
  )).rows.map((row) => [row.id, row]));
  const rows = (await database.query<Record<string, any>>(
    `SELECT ${DOKLAD_KLUC_SQL} AS doklad_kluc, doklad_cislo, datum::text AS datum, line_text_normalized,
            suma, suma_dph, predkontacia_id, clenenie_dph_id, clenenie_dph_kod
       FROM ucto_historia
      WHERE tenant_id=$1 AND organization_id=$2 AND coalesce(riadok_index, 0) > 0
        AND doklad_cislo IS NOT NULL
      ORDER BY doklad_kluc, riadok_index`,
    [input.tenantId, input.organizationId],
  )).rows;
  const doklady = new Map<string, DokladDelenia>();
  for (const row of rows) {
    let doklad = doklady.get(row.doklad_kluc);
    if (!doklad) doklady.set(row.doklad_kluc, doklad = { kluc: row.doklad_kluc, cislo: row.doklad_cislo, datum: row.datum ?? '', polozky: [] });
    const clenenie = row.clenenie_dph_id ? nazvyCleneni.get(row.clenenie_dph_id) : undefined;
    doklad.polozky.push({
      text: row.line_text_normalized ?? '',
      suma: row.suma === null ? undefined : Number(row.suma),
      sumaDph: row.suma_dph === null ? undefined : Number(row.suma_dph),
      // Riadok bez účtu rez neurčí, ale kľúčové slovo by ho rezalo tiež.
      predkontaciaId: row.predkontacia_id ?? undefined,
      clenenieDphId: row.clenenie_dph_id ?? undefined,
      clenenieDphKod: clenenie?.code ?? row.clenenie_dph_kod ?? undefined,
      clenenieDphNazov: clenenie?.name,
    });
  }
  const pravidlaAut = (await loadDphProfil(database, input.tenantId, input.organizationId))?.pravidlaAut ?? [];
  return odvodNavrhyDelenia([...doklady.values()]).filter((navrh) => !pravidlaAut.some((pravidlo) =>
    pravidlo.predkontaciaId === navrh.predkontaciaId && pravidlo.predkontaciaNedanovaId === navrh.predkontaciaNedanovaId));
}
