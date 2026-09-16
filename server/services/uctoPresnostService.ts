import { createHash, randomUUID } from 'node:crypto';
import type { ServerConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { HttpError } from '../http.js';
import {
  AI_SUGGESTION_INSTRUCTIONS, navrhniZauctovanie, resolveSeriesDefault,
  type AiSuggestionDocumentContext, type NavrhZauctovania,
} from './accountingSuggestionService.js';

/**
 * Koľko z toho, čo účtovník naozaj urobil, by návrh zaúčtovania dal sám.
 *
 * Doklad sa poskladá späť z korpusu (protistrana, texty položiek, sumy, sadzby),
 * pustí sa naň ten istý výpočet ako v produkcii (navrhniZauctovanie) a výsledok
 * sa porovná so skutočným zaúčtovaním. Meranie NIČ nezapisuje — ani doklad, ani
 * návrh; uloží sa len hotový beh, a to iba keď o to volajúci požiada.
 *
 * DELENIE ČASOM. Každý doklad vidí len to, čo firma vedela pred JEHO dátumom
 * (walk-forward ako zmerajRady): denník, pravidlá, príklady, pokyny aj použitie
 * členení. Jedno delítko pre celú vzorku by dokladu z konca okna ukázalo mesiace
 * „budúcnosti" a doklad zo začiatku by mal menej, než mal v praxi.
 * Okná na firmu: validácia [p60, p80), test [p80, dnes] nad rôznymi dokladmi;
 * doklady s dátumom v budúcnosti sa nemerajú — nie sú ešte skutočnosťou.
 *
 * ČO SA NEMERIA. Extrakcia z PDF — doklad sa skladá z korpusu. Položky sú
 * riadky POHODY PO zaúčtovaní, vrátane riadkov, ktoré účtovník pri rozpise
 * vytvoril, takže tvar rozpisu a DPH sú horná hranica. Kategórie profilu nemajú
 * stav ku dňu, preto sa predvolene vynechávajú (dolná hranica); číselníky, DPH
 * profil, predvoľby radov a karty partnerov sú aktuálny stav a manifest to hovorí.
 */

/** Agenda korpusu → druh dokladu, ako ho pozná spracovanie. */
const DRUH_PODLA_AGENDY: Record<string, { typ: string; podtyp?: string; pokladnaTyp?: 'receipt' | 'expense' }> = {
  FP: { typ: 'FP' },
  'FP-D': { typ: 'FP', podtyp: 'dobropis' },
  'FP-T': { typ: 'FP', podtyp: 'tarchopis' },
  'FP-Z': { typ: 'FP', podtyp: 'zalohova' },
  FV: { typ: 'FV' },
  'FV-D': { typ: 'FV', podtyp: 'dobropis' },
  'FV-T': { typ: 'FV', podtyp: 'tarchopis' },
  'FV-Z': { typ: 'FV', podtyp: 'zalohova' },
  OZ: { typ: 'OZ' },
  INT: { typ: 'MZDY' },
  VPD: { typ: 'PD', pokladnaTyp: 'expense' },
  PPD: { typ: 'PD', pokladnaTyp: 'receipt' },
};

export type RezimMerania = 'bez_ai' | 'ai';
export type OknoMerania = 'test' | 'validacia';

interface Kody {
  predkontaciaId?: string;
  clenenieDphId?: string;
  clenenieKvKod?: string;
}

export interface Skutocnost extends Kody {
  agenda: string;
  dokladCislo: string;
  datum: string;
  supplierIco?: string;
  supplierName?: string;
  /** Rad dokladu v POHODE (typ:id) a jeho predpona — staršie importy ho nenesú. */
  radExternalId?: string;
  radKod?: string;
  /** Krajina protistrany — rozhoduje o tuzemskom či zahraničnom rade. */
  krajina?: string;
  /** Položky; prázdne kódy položky dedia hlavičku, rovnako ako v POHODE. */
  polozky: Array<Kody & { popis: string; suma?: number; sumaDph?: number; sadzbaDph?: number }>;
}

export const POLIA = ['predkontacia', 'clenenieDph', 'kv', 'rad', 'tvar'] as const;
export type Pole = typeof POLIA[number];

/** null = skutočnosť nepoznáme, pole sa pre doklad nepočíta vôbec. */
export type Hodnotenie = Record<Pole, { navrhnute: boolean; spravne: boolean } | null>;

export interface PoleSkore {
  spravne: number;
  /** Doklady so známou skutočnosťou — menovateľ presnosti. */
  znamych: number;
  /** Z nich doklady, kde návrh pole vôbec dal (pokrytie). */
  navrhnutych: number;
}

export interface AgendaSkore extends Record<Pole, PoleSkore> {
  dokladov: number;
  /** Návrh sa zdržal (bez predkontácie, blokácia DPH, prázdna odpoveď) — nie je to chyba. */
  zdrzanie: number;
  chyb: number;
  /** Doklady, ktoré účtovník rozpísal (položka iná než hlavička v účte, DPH alebo KV). */
  rozpisanych: number;
  falosnyRozpis: number;
  chybajuciRozpis: number;
}

export interface VysledokDokladu {
  agenda: string;
  doklad: string;
  datum: string;
  protistrana: string | null;
  zdrzanie?: string;
  chyba?: string;
  rozpisany: boolean;
  navrhRozpisany: boolean;
  hodnotenie: Hodnotenie;
  /** Kódy, nie id — rozdiely číta účtovník, nie databáza. */
  skutocne: { predkontacia: string | null; clenenieDph: string | null; kv: string | null; rad: string | null };
  navrh: { predkontacia: string | null; clenenieDph: string | null; kv: string | null; rad: string | null } | null;
  /** Surová odpoveď modelu (len režim ai) — prehodnotenie bez nového volania. */
  odpovedModelu?: unknown;
}

export interface PresnostVysledok {
  /** null = beh sa neukladal (skript, uloz=false). */
  id: string | null;
  metodika: 2;
  rezim: RezimMerania;
  /** Začiatok meraného okna. */
  deliciDatum: string;
  vzorka: number;
  vysledok: Record<string, AgendaSkore>;
  rozdiely: VysledokDokladu[];
  doklady: VysledokDokladu[];
  manifest: Record<string, unknown>;
  trvanieMs: number;
}

/** Kódy položky tak, ako ich POHODA naozaj uplatní: prázdne pole dedí hlavičku. */
function ucinne(polozka: Kody, hlavicka: Kody): Kody {
  return {
    predkontaciaId: polozka.predkontaciaId ?? hlavicka.predkontaciaId,
    clenenieDphId: polozka.clenenieDphId ?? hlavicka.clenenieDphId,
    clenenieKvKod: polozka.clenenieKvKod ?? hlavicka.clenenieKvKod,
  };
}

/**
 * Rozpísaný je doklad, ktorého niektorá položka sa od hlavičky líši v ČOMKOĽVEK
 * — účte, členení DPH alebo sekcii KV. Kým sa pozeral len účet, reprezentácia
 * s tou istou predkontáciou, ale bez odpočtu, vyzerala ako nerozpísaný doklad.
 */
export function jeRozpisany(doklad: Skutocnost): boolean {
  return doklad.polozky.some((polozka) => {
    const kody = ucinne(polozka, doklad);
    return kody.predkontaciaId !== doklad.predkontaciaId || kody.clenenieDphId !== doklad.clenenieDphId
      || kody.clenenieKvKod !== doklad.clenenieKvKod;
  });
}

/**
 * Celý tvar: každá položka musí dostať tie isté účinné kódy ako v POHODE.
 * Porovnávajú sa len kódy, ktoré skutočnosť pozná. Rez položky na časti
 * v korpuse nikdy nesedí — tam sú časti už samostatné riadky.
 */
function tvarSedi(doklad: Skutocnost, navrh: NavrhZauctovania): boolean {
  return doklad.polozky.every((polozka, index) => {
    const casti = (navrh.riadky ?? []).filter((riadok) => riadok.index === index);
    if (casti.length > 1 || casti.some((cast) => cast.podiel !== undefined)) return false;
    const navrhnute = ucinne(casti[0] ?? {}, {
      predkontaciaId: navrh.predkontacia_id, clenenieDphId: navrh.clenenie_dph_id, clenenieKvKod: navrh.clenenie_kv_kod,
    });
    const skutocne = ucinne(polozka, doklad);
    return navrhnute.predkontaciaId === skutocne.predkontaciaId
      && (skutocne.clenenieDphId === undefined || navrhnute.clenenieDphId === skutocne.clenenieDphId)
      && (skutocne.clenenieKvKod === undefined || navrhnute.clenenieKvKod === skutocne.clenenieKvKod);
  });
}

/**
 * Hodnotenie jedného dokladu po poliach. Neznáma skutočnosť NIE JE zhoda:
 * kým sa prázdne DPH/KV rátalo ako správne, percento rástlo s podielom
 * dokladov, o ktorých nevieme nič.
 */
export function ohodnot(
  doklad: Skutocnost,
  navrh: NavrhZauctovania | undefined,
  externeId: Map<string, string | null>,
): Hodnotenie {
  const pole = (znama: unknown, navrhnuta: unknown, sedi: () => boolean) => (znama == null
    ? null
    : { navrhnute: navrhnuta != null, spravne: navrhnuta != null && sedi() });
  return {
    predkontacia: pole(doklad.predkontaciaId, navrh?.predkontacia_id, () => navrh!.predkontacia_id === doklad.predkontaciaId),
    clenenieDph: pole(doklad.clenenieDphId, navrh?.clenenie_dph_id, () => navrh!.clenenie_dph_id === doklad.clenenieDphId),
    kv: pole(doklad.clenenieKvKod, navrh?.clenenie_kv_kod, () => navrh!.clenenie_kv_kod === doklad.clenenieKvKod),
    // Rad sa porovnáva identifikátorom z POHODY, nie id riadku ani kódom: ten istý
    // rad môže mať v číselníku iné id a dva rady rovnakú predponu.
    rad: pole(doklad.radExternalId, navrh?.ciselny_rad_id,
      () => externeId.get(navrh!.ciselny_rad_id!) === doklad.radExternalId),
    tvar: pole(doklad.predkontaciaId, navrh, () => tvarSedi(doklad, navrh!)),
  };
}

function prazdneSkore(): AgendaSkore {
  const pole = (): PoleSkore => ({ spravne: 0, znamych: 0, navrhnutych: 0 });
  return {
    dokladov: 0, zdrzanie: 0, chyb: 0, rozpisanych: 0, falosnyRozpis: 0, chybajuciRozpis: 0,
    predkontacia: pole(), clenenieDph: pole(), kv: pole(), rad: pole(), tvar: pole(),
  };
}

export function scitajPoAgendach(doklady: VysledokDokladu[]): Record<string, AgendaSkore> {
  const vysledok: Record<string, AgendaSkore> = {};
  for (const doklad of doklady) {
    const skore = vysledok[doklad.agenda] ??= prazdneSkore();
    skore.dokladov += 1;
    if (doklad.zdrzanie) skore.zdrzanie += 1;
    if (doklad.chyba) skore.chyb += 1;
    if (doklad.rozpisany) skore.rozpisanych += 1;
    if (doklad.navrh && !doklad.rozpisany && doklad.navrhRozpisany) skore.falosnyRozpis += 1;
    if (doklad.navrh && doklad.rozpisany && !doklad.navrhRozpisany) skore.chybajuciRozpis += 1;
    for (const nazov of POLIA) {
      const hodnota = doklad.hodnotenie[nazov];
      if (!hodnota) continue;
      skore[nazov].znamych += 1;
      if (hodnota.navrhnute) skore[nazov].navrhnutych += 1;
      if (hodnota.spravne) skore[nazov].spravne += 1;
    }
  }
  return vysledok;
}

/**
 * 95 % interval presnosti poľa bootstrapom po dokladoch. Pri desiatkach
 * dokladov je rozdiel dvoch behov často menší než šírka intervalu — bez neho
 * by sa „zlepšenie" z 81 na 84 % čítalo ako fakt.
 * Generátor je pevne nasadený, aby ten istý beh dal ten istý interval.
 */
export function intervalSpolahlivosti(
  doklady: Array<Pick<VysledokDokladu, 'hodnotenie'>>,
  pole: Pole,
  opakovani = 1000,
): [number, number] | null {
  const hodnoty = doklady.map((doklad) => doklad.hodnotenie[pole]).filter((hodnota) => hodnota !== null)
    .map((hodnota) => hodnota!.spravne);
  if (hodnoty.length === 0) return null;
  let stav = 1;
  // mulberry32
  const nahodne = () => {
    stav = (stav + 0x6D2B79F5) | 0;
    let t = Math.imul(stav ^ (stav >>> 15), 1 | stav);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const podiely = Array.from({ length: opakovani }, () => {
    let spravne = 0;
    for (let index = 0; index < hodnoty.length; index += 1) {
      if (hodnoty[Math.floor(nahodne() * hodnoty.length)]) spravne += 1;
    }
    return spravne / hodnoty.length;
  }).sort((a, b) => a - b);
  return [podiely[Math.floor(0.025 * opakovani)], podiely[Math.ceil(0.975 * opakovani) - 1]];
}

/**
 * Vzorka pre režim AI: kvóta po agendách podľa podielu (dolná celá časť, aspoň
 * jeden doklad), zvyšok podľa najväčšieho zvyšku; v agende rozhoduje
 * md5(agenda|doklad_cislo). Poradie tak nezávisí od dátumu importu a nový
 * doklad v korpuse nepremieša celú vzorku. Agenda nevypadne — kým sa
 * vzorka orezávala na konci, malé FV-D či PPD sa do merania nedostali vôbec.
 * Vzorka je však strop platených volaní: keď „aspoň jeden" kvóty prekročí,
 * prebytok vrátia najväčšie agendy; pri viac agendách než miestach vypadnú
 * najmenšie a manifest ich vymenuje.
 */
export function vyberVzorku<T extends { agenda: string; dokladCislo: string }>(doklady: T[], vzorka: number): T[] {
  if (doklady.length <= vzorka) return doklady;
  const podlaAgendy = new Map<string, T[]>();
  for (const doklad of doklady) {
    if (!podlaAgendy.has(doklad.agenda)) podlaAgendy.set(doklad.agenda, []);
    podlaAgendy.get(doklad.agenda)!.push(doklad);
  }
  const kvoty = [...podlaAgendy].map(([agenda, skupina]) => {
    const presne = (skupina.length / doklady.length) * vzorka;
    return { agenda, skupina, kolko: Math.min(skupina.length, Math.max(1, Math.floor(presne))), zvysok: presne % 1 };
  });
  let volne = vzorka - kvoty.reduce((spolu, kvota) => spolu + kvota.kolko, 0);
  while (volne < 0) {
    // Z viacdokladových kvót uberá najväčšia agenda; keď má každá už len jeden
    // doklad, vypadne najmenšia.
    const najvacsia = kvoty.filter((kvota) => kvota.kolko > 0).sort((a, b) => (b.kolko - a.kolko)
      || (a.kolko > 1 ? b.skupina.length - a.skupina.length : a.skupina.length - b.skupina.length)
      || a.agenda.localeCompare(b.agenda))[0];
    najvacsia.kolko -= 1;
    volne += 1;
  }
  for (const kvota of [...kvoty].sort((a, b) => (b.zvysok - a.zvysok) || a.agenda.localeCompare(b.agenda))) {
    if (volne <= 0) break;
    if (kvota.kolko < kvota.skupina.length) {
      kvota.kolko += 1;
      volne -= 1;
    }
  }
  const md5 = (doklad: T) => createHash('md5').update(`${doklad.agenda}|${doklad.dokladCislo}`).digest('hex');
  return kvoty.flatMap((kvota) => kvota.skupina
    .map((doklad) => ({ doklad, kluc: md5(doklad) }))
    .sort((a, b) => a.kluc.localeCompare(b.kluc))
    .slice(0, kvota.kolko)
    .map((polozka) => polozka.doklad));
}

/** Doklady okna: hlavička so zaúčtovaním a jej položky. */
async function nacitajDoklady(
  database: Database,
  input: { tenantId: string; organizationId: string },
  od: string,
  doVylucne: string | null,
): Promise<Skutocnost[]> {
  const rows = (await database.query<Record<string, any>>(
    `SELECT agenda, doklad_cislo, datum::text AS datum, riadok_index, line_text_normalized,
            suma, suma_dph, sadzba_dph, supplier_ico, supplier_name_normalized,
            predkontacia_id, clenenie_dph_id, clenenie_kv_kod, rad_external_id, rad_kod, krajina
       FROM ucto_historia
      WHERE tenant_id=$1 AND organization_id=$2 AND doklad_cislo IS NOT NULL
        AND datum >= $3::date AND ($4::date IS NULL OR datum < $4::date)
        -- Zaúčtované dopredu (leasing, rezervy) sa ešte nestalo — skutočnosťou nie je.
        AND datum <= current_date
      -- NULLS FIRST je nutnosť, nie kozmetika: staršie importy niesli len
      -- hlavičku a riadok_index majú prázdny. Pri predvolenom NULLS LAST prišla
      -- taká hlavička AŽ ZA položkami toho istého dokladu a prepísala ich —
      -- doklad potom vyzeral ako nerozpísaný a model dostal len text hlavičky.
      ORDER BY datum, doklad_cislo, riadok_index NULLS FIRST`,
    [input.tenantId, input.organizationId, od, doVylucne],
  )).rows;

  const cislo = (hodnota: unknown) => (hodnota === null || hodnota === undefined ? undefined : Number(hodnota));
  const podlaDokladu = new Map<string, Skutocnost & { hlavicka: { popis?: string; suma?: number; sumaDph?: number; sadzbaDph?: number } }>();
  for (const row of rows) {
    const kluc = `${row.agenda}|${row.doklad_cislo}|${row.datum}`;
    // DPH na internom doklade (samozdanenie, §69) si vypočítala firma sama —
    // doklad protistrany za ním je bez dane. Podstrčená ako daň dodávateľa
    // vyzerala pri zahraničnej protistrane ako cudzia daň a kontrola DPH každé
    // samozdanenie zablokovala.
    if (row.agenda === 'INT') { row.suma_dph = null; row.sadzba_dph = null; }
    if (Number(row.riadok_index ?? 0) === 0) {
      podlaDokladu.set(kluc, {
        agenda: row.agenda,
        dokladCislo: row.doklad_cislo,
        datum: row.datum,
        supplierIco: row.supplier_ico ?? undefined,
        supplierName: row.supplier_name_normalized ?? undefined,
        predkontaciaId: row.predkontacia_id ?? undefined,
        clenenieDphId: row.clenenie_dph_id ?? undefined,
        clenenieKvKod: row.clenenie_kv_kod ?? undefined,
        radExternalId: row.rad_external_id ?? undefined,
        radKod: row.rad_kod ?? undefined,
        krajina: row.krajina ?? undefined,
        hlavicka: {
          popis: row.line_text_normalized ?? undefined,
          suma: cislo(row.suma), sumaDph: cislo(row.suma_dph), sadzbaDph: cislo(row.sadzba_dph),
        },
        polozky: [],
      });
      continue;
    }
    podlaDokladu.get(kluc)?.polozky.push({
      popis: row.line_text_normalized,
      suma: cislo(row.suma),
      sumaDph: cislo(row.suma_dph),
      sadzbaDph: cislo(row.sadzba_dph),
      predkontaciaId: row.predkontacia_id ?? undefined,
      clenenieDphId: row.clenenie_dph_id ?? undefined,
      clenenieKvKod: row.clenenie_kv_kod ?? undefined,
    });
  }
  const doklady: Skutocnost[] = [];
  for (const { hlavicka, ...doklad } of podlaDokladu.values()) {
    // Doklad bez položiek (staršie importy niesli len hlavičku) dostane text
    // hlavičky ako jedinú položku. Inak by model dostal doklad BEZ AKÉHOKOĽVEK
    // popisu a nemal by sa z čoho rozhodnúť — meranie by netrestalo jeho úsudok,
    // ale prázdny vstup. Presne to sa aj stalo: leasingové splátky ČSOB prišli
    // bez textu a model na ne nevrátil predkontáciu vôbec.
    if (doklad.polozky.length === 0 && hlavicka.popis) doklad.polozky.push({ ...hlavicka, popis: hlavicka.popis });
    // Doklad, o ktorom skutočnosť nevie nič (ani účet, DPH, KV, rad), nie je proti čomu merať.
    const znamy = doklad.predkontaciaId || doklad.clenenieDphId || doklad.clenenieKvKod || doklad.radExternalId;
    if (DRUH_PODLA_AGENDY[doklad.agenda] && doklad.polozky.length > 0 && znamy) doklady.push(doklad);
  }
  return doklady;
}

/**
 * Kontext návrhu tak, ako ho stavia produkcia (kontextNavrhu): sadzby položiek,
 * suma s DPH a celková suma. Bez sadzieb dostal model „sadzbyDphNaDoklade: []",
 * čo inštrukcie čítajú ako „daň sa neúčtovala" — meranie trestalo chýbajúci
 * vstup, nie úsudok.
 */
function kontextZKorpusu(doklad: Skutocnost): AiSuggestionDocumentContext {
  const druh = DRUH_PODLA_AGENDY[doklad.agenda];
  // Položka v produkcii nesie sumu S DPH (sumaSpolu); korpus drží základ a daň zvlášť.
  const polozky = doklad.polozky.map((polozka) => ({
    popis: polozka.popis,
    sadzbaDph: polozka.sadzbaDph,
    suma: polozka.suma === undefined ? undefined : Number((polozka.suma + (polozka.sumaDph ?? 0)).toFixed(2)),
  }));
  const sumy = polozky.map((polozka) => polozka.suma).filter((suma): suma is number => suma !== undefined);
  return {
    documentType: druh.typ,
    podtyp: druh.podtyp,
    pokladnaTyp: druh.pokladnaTyp,
    supplierName: doklad.supplierName,
    supplierIco: doklad.supplierIco,
    // Krajina rozhoduje o tuzemskom či zahraničnom rade (aj o cudzej dani) —
    // v ostrej prevádzke ju doklad nesie, meranie bez nej meralo naslepo.
    supplierKrajina: doklad.krajina,
    // Na vydanej faktúre je protistranou ODBERATEĽ a číta sa z iného poľa.
    // Korpus drží protistranu vždy v supplier_name_normalized — aj pri FV, kde
    // je to zákazník —, takže bez tohto riadku išla každá vydaná faktúra do
    // merania bez protistrany: bez pravidla, denníka, rozúčtovania aj radu.
    ...(druh.typ === 'FV'
      ? { odberatel: { nazov: doklad.supplierName, ico: doklad.supplierIco, krajina: doklad.krajina } }
      : {}),
    datumVystavenia: doklad.datum,
    totalAmount: sumy.length > 0 ? Number(sumy.reduce((spolu, suma) => spolu + suma, 0).toFixed(2)) : undefined,
    // Sumy korpusu sú v domácej mene POHODY.
    currency: 'EUR',
    lineDescriptions: polozky.map((polozka) => polozka.popis),
    polozky,
    historiaDoDatumu: doklad.datum,
  };
}

/**
 * Režim bez AI: odpovedá LEN z dôkazov, ktoré už sú v prompte — pravidlo
 * protistrany (hlavička aj ustálený rozpis), inak najlepší riadok denníka tej
 * istej protistrany, inak nič. Potom ide cez presne to isté dospracovanie ako
 * model. Je to základná čiara zadarmo a opakovateľne, nie presnosť AI.
 */
const lokalnyParser = {
  async create(body: unknown): Promise<{ output: unknown[] }> {
    const prompt = JSON.parse((body as any).input[0].content[0].text);
    const idPodlaKodu = (zoznam: Array<{ id: string; kod: string }>, kod?: string) =>
      (kod ? zoznam.find((item) => item.kod.trim() === kod.trim())?.id ?? null : null);
    const { predkontacie, cleneniaDph } = prompt.ciselniky;
    const pravidlo = prompt.pravidlo;
    const dennik = (prompt.dennik ?? []).find((riadok: any) => riadok.tejProtistrany);
    const rozpis: any[] = pravidlo?.rozpis ?? [];
    // Pravidlo bez účtu je spor praxí (konflikt): protistrana má viac ustálených
    // zaúčtovaní a ani jedno neprevažuje. Základná čiara ho nesmie brať ako
    // odpoveď — inak by sa spor javil ako zdržanie, hoci denník tej istej
    // protistrany odpoveď má.
    const odpoved = pravidlo?.predkontaciaKod ? {
      predkontaciaId: idPodlaKodu(predkontacie, pravidlo.predkontaciaKod),
      clenenieDphId: idPodlaKodu(cleneniaDph, pravidlo.clenenieDphKod),
      clenenieKvKod: pravidlo.clenenieKvKod ?? null,
      confidence: pravidlo.zhoda / pravidlo.dokladov,
      reason: 'pravidlo protistrany',
      // Ustálený tvar sedí po pozíciách, len keď má doklad rovnako položiek.
      riadky: rozpis.length > 0 && rozpis.length === prompt.dokument.polozky.length
        ? rozpis.map((riadok, index) => ({
          index,
          predkontaciaId: idPodlaKodu(predkontacie, riadok.predkontaciaKod),
          clenenieDphId: idPodlaKodu(cleneniaDph, riadok.clenenieDphKod),
          clenenieKvKod: riadok.clenenieKvKod ?? null,
          podiel: null,
          podielDph: null,
        })).filter((riadok) => riadok.predkontaciaId)
        : null,
    } : dennik ? {
      predkontaciaId: dennik.predkontaciaId ?? idPodlaKodu(predkontacie, dennik.predkontaciaKod),
      clenenieDphId: dennik.clenenieDphId ?? idPodlaKodu(cleneniaDph, dennik.clenenieDphKod),
      clenenieKvKod: dennik.clenenieKvKod ?? null,
      confidence: 0.8,
      reason: 'denník protistrany',
      riadky: null,
    } : { predkontaciaId: null, clenenieDphId: null, clenenieKvKod: null, confidence: 0, reason: 'bez dôkazu', riadky: null };
    return {
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: JSON.stringify({ ciselnyRadId: null, ...odpoved }) }],
      }],
    };
  },
};

/** Embedder bez vektorov: vytvorVektory vráti undefined a kategórie ostanú lexikálne. */
const bezVektorov = { create: async () => ({ data: [] as Array<{ embedding: number[] }> }) };

/** Riadky a posledný import po agendách — beh, počas ktorého agent korpus prepísal, sa pozná. */
async function odtlacokKorpusu(database: Database, input: { tenantId: string; organizationId: string }) {
  return (await database.query<Record<string, unknown>>(
    `SELECT agenda, count(*)::int AS riadkov, max(created_at)::text AS posledny
       FROM ucto_historia WHERE tenant_id=$1 AND organization_id=$2
      GROUP BY agenda ORDER BY agenda`,
    [input.tenantId, input.organizationId],
  )).rows;
}

export async function zmerajPresnost(
  database: Database,
  config: ServerConfig,
  input: { tenantId: string; organizationId: string },
  moznosti: {
    rezim?: RezimMerania;
    okno?: OknoMerania;
    /** Prepíše začiatok testovacieho okna (p80). */
    deliciDatum?: string;
    /** Bez vzorky meria režim bez AI všetky doklady okna. */
    vzorka?: number;
    maxAiVolani?: number;
    /** Kategórie aj pri dátume dokladu — výsledok je horná hranica. */
    kategorie?: boolean;
    /** Zapísať beh do ucto_presnost. Skript nezapisuje nikdy. */
    uloz?: boolean;
  } = {},
  injectedParser?: { create(body: unknown): Promise<{ output?: unknown }> },
): Promise<PresnostVysledok> {
  const rezim = moznosti.rezim ?? 'bez_ai';
  if (rezim === 'ai' && !injectedParser && (config.extractionProvider !== 'openai' || !config.openai.apiKey)) {
    throw new HttpError(409, 'ai_unavailable', 'AI analýza nie je nakonfigurovaná (chýba OpenAI kľúč)');
  }
  const zaciatok = Date.now();
  const maxAiVolani = moznosti.maxAiVolani ?? 100;

  // Okná sú percentily dátumov DOKLADOV, nie „max mínus tri mesiace" —
  // leasingové splátky a rezervy sú zaúčtované dopredu, takže max bol 31. 12.
  // a za delítkom ostali len OZ a INT. Budúce dátumy sa nerátajú vôbec.
  const okna = (await database.query<{ p60: string | null; p80: string | null; dnes: string } & Record<string, unknown>>(
    `SELECT percentile_disc(0.60) WITHIN GROUP (ORDER BY datum)::text AS p60,
            percentile_disc(0.80) WITHIN GROUP (ORDER BY datum)::text AS p80,
            current_date::text AS dnes
       FROM (SELECT DISTINCT agenda, doklad_cislo, datum FROM ucto_historia
              WHERE tenant_id=$1 AND organization_id=$2
                AND doklad_cislo IS NOT NULL AND datum IS NOT NULL AND datum <= current_date) t`,
    [input.tenantId, input.organizationId],
  )).rows[0];
  if (!okna?.p60 || !okna.p80) throw new HttpError(409, 'not_enough_data', 'V korpuse nie sú doklady s dátumom.');
  const hranica = moznosti.deliciDatum ?? okna.p80;
  const okno = moznosti.okno ?? 'test';
  const od = okno === 'validacia' ? okna.p60 : hranica;

  const polozkyCiselnikov = (await database.query<{ id: string; kind: string; code: string; external_id: string | null } & Record<string, unknown>>(
    'SELECT id, kind, code, external_id FROM code_list_items WHERE tenant_id=$1 AND organization_id=$2',
    [input.tenantId, input.organizationId],
  )).rows;
  const kod = new Map(polozkyCiselnikov.map((row) => [row.id, row.code.trim()]));
  const externeId = new Map(polozkyCiselnikov.map((row) => [row.id, row.external_id]));
  const korpusPred = await odtlacokKorpusu(database, input);

  const vsetky = await nacitajDoklady(database, input, od, okno === 'validacia' ? hranica : null);
  if (vsetky.length === 0) {
    throw new HttpError(409, 'not_enough_data', 'V meranom okne nie sú doklady so zaúčtovaním.');
  }
  // Režim AI stojí peniaze za každý doklad: vzorka nikdy neprekročí rozpočet
  // volaní. Bez web searchu je jeden doklad práve jedno volanie, takže strop platí.
  const vzorka = rezim === 'ai'
    ? Math.min(moznosti.vzorka ?? 100, maxAiVolani)
    : moznosti.vzorka ?? vsetky.length;
  const merane = vyberVzorku(vsetky, vzorka);

  const tokeny = { vstup: 0, vystup: 0, spolu: 0 };
  const doklady: VysledokDokladu[] = [];
  // ponytail: každý doklad má vlastný asOf, takže ~15 dotazov na doklad bez
  // cache — pri tisíckach dokladov minúty; na synchrónnu cestu patrí vzorka.
  for (const doklad of merane) {
    let navrh: NavrhZauctovania | undefined;
    let zdrzanie: string | undefined;
    let chyba: string | undefined;
    let odpovedModelu: unknown;
    const kontext = kontextZKorpusu(doklad);
    try {
      const vysledok = await navrhniZauctovanie(database, config, {
        tenantId: input.tenantId, organizationId: input.organizationId,
        documentId: `meranie:${doklad.agenda}|${doklad.dokladCislo}`,
        supplierIco: doklad.supplierIco, supplierName: doklad.supplierName,
      }, kontext, {
        pokladnaTyp: DRUH_PODLA_AGENDY[doklad.agenda].pokladnaTyp,
        datumVystavenia: doklad.datum,
        accounting: {},
        // To, čo z dokladu číta kontrola DPH (cudzia daň, samozdanenie): na FV je
        // dodávateľom vlastná firma, o ktorej korpus nič nenesie.
        extracted: {
          dodavatel: DRUH_PODLA_AGENDY[doklad.agenda].typ === 'FV'
            ? {} : { nazov: doklad.supplierName, ico: doklad.supplierIco, krajina: doklad.krajina },
          polozky: doklad.polozky.map((polozka) => ({ popis: polozka.popis, sadzbaDph: polozka.sadzbaDph })),
          rozpisDph: doklad.polozky.map((polozka) => ({
            sadzba: polozka.sadzbaDph, zaklad: polozka.suma ?? 0, dph: polozka.sumaDph ?? 0,
          })),
          sumaSpolu: kontext.totalAmount ?? 0,
          datumVystavenia: doklad.datum,
        },
      }, {
        parser: rezim === 'ai' ? injectedParser : lokalnyParser,
        // Bez AI nikdy nevolá OpenAI ani pre kategórie: prázdny embedder = len lexikálna zhoda.
        ...(rezim === 'ai' ? {} : { embedder: bezVektorov }),
        bezWebu: true,
        sKategoriami: moznosti.kategorie,
      });
      // Samotné členenie DPH bez účtu nie je zaúčtovanie — zdržanie, nie zlý tvar.
      if ('navrh' in vysledok && vysledok.navrh.predkontacia_id) navrh = vysledok.navrh;
      else zdrzanie = 'zdrzanie' in vysledok ? vysledok.zdrzanie : 'bez_predkontacie';
      for (const [pole, kluc] of [['vstup', 'input_tokens'], ['vystup', 'output_tokens'], ['spolu', 'total_tokens']] as const) {
        tokeny[pole] += Number(vysledok.usage?.[kluc] ?? 0);
      }
      if (rezim === 'ai') odpovedModelu = vysledok.odpovedModelu;
    } catch (cause) {
      chyba = cause instanceof Error ? cause.message : String(cause);
    }
    const kody = (hodnoty: Kody & { rad?: string | null }) => ({
      predkontacia: kod.get(hodnoty.predkontaciaId ?? '') ?? null,
      clenenieDph: kod.get(hodnoty.clenenieDphId ?? '') ?? null,
      kv: hodnoty.clenenieKvKod ?? null,
      rad: hodnoty.rad ?? null,
    });
    doklady.push({
      agenda: doklad.agenda, doklad: doklad.dokladCislo, datum: doklad.datum,
      protistrana: doklad.supplierName ?? doklad.supplierIco ?? null,
      ...(zdrzanie ? { zdrzanie } : {}),
      ...(chyba ? { chyba } : {}),
      rozpisany: jeRozpisany(doklad),
      navrhRozpisany: Boolean(navrh?.riadky?.length),
      hodnotenie: ohodnot(doklad, navrh, externeId),
      skutocne: kody({ ...doklad, rad: doklad.radKod }),
      navrh: navrh ? kody({
        predkontaciaId: navrh.predkontacia_id, clenenieDphId: navrh.clenenie_dph_id,
        clenenieKvKod: navrh.clenenie_kv_kod, rad: kod.get(navrh.ciselny_rad_id ?? ''),
      }) : null,
      ...(odpovedModelu !== undefined ? { odpovedModelu } : {}),
    });
  }

  const korpusPo = await odtlacokKorpusu(database, input);
  const pocetPodlaDruhu = (kind: string) => polozkyCiselnikov.filter((row) => row.kind === kind).length;
  const manifest = {
    commit: process.env.GIT_COMMIT ?? 'unknown',
    rezim,
    model: rezim === 'ai' ? config.openai.accountingModel : null,
    instrukcieSha256: createHash('sha256').update(AI_SUGGESTION_INSTRUCTIONS).digest('hex'),
    okno,
    okna: { validacia: { od: okna.p60, doVylucne: hranica }, test: { od: hranica, doVratane: okna.dnes } },
    asOf: 'datum_dokladu',
    kategorie: moznosti.kategorie ? 'horna_hranica' : 'vylucene',
    // Embeddingy OpenAI len v režime ai s kategóriami; nerátajú sa do maxAiVolani ani do tokenov.
    embeddingy: rezim === 'ai' && moznosti.kategorie ? 'openai' : null,
    vylucene: moznosti.kategorie ? [] : ['ucto_kategorie'],
    // Agendy, na ktoré rozpočet vzorky nestačil (viac agend než miest).
    vynechaneAgendy: [...new Set(vsetky.map((doklad) => doklad.agenda))]
      .filter((agenda) => !merane.some((doklad) => doklad.agenda === agenda)),
    aktualnyStav: ['code_list_items', 'dph_profil', 'organization_series_defaults', 'partners'],
    polozky: 'riadky POHODY po zaúčtovaní — tvar a DPH sú horná hranica',
    webSearch: false,
    vyberVzorky: 'md5(agenda|doklad_cislo), kvóta po agendách, najväčší zvyšok',
    dokladovVOkne: vsetky.length,
    ...(rezim === 'ai' ? { maxAiVolani } : {}),
    korpus: { pred: korpusPred, po: korpusPo, zmeneny: JSON.stringify(korpusPred) !== JSON.stringify(korpusPo) },
    ciselniky: {
      predkontacie: pocetPodlaDruhu('predkontacie'),
      cleneniaDph: pocetPodlaDruhu('cleneniaDph'),
      ciselneRady: pocetPodlaDruhu('ciselneRady'),
    },
    tokeny,
  };

  const vysledok = scitajPoAgendach(doklady);
  const rozdiely = doklady.filter((doklad) => doklad.chyba
    || POLIA.some((pole) => doklad.hodnotenie[pole]?.navrhnute && !doklad.hodnotenie[pole]?.spravne));
  const trvanieMs = Date.now() - zaciatok;
  const id = moznosti.uloz ? randomUUID() : null;
  if (id) {
    await database.query(
      `INSERT INTO ucto_presnost
        (id,tenant_id,organization_id,delici_datum,vzorka,vysledok,rozdiely,trvanie_ms,metodika,rezim,manifest,doklady)
       VALUES ($1,$2,$3,$4::date,$5,$6::jsonb,$7::jsonb,$8,2,$9,$10::jsonb,$11::jsonb)`,
      [id, input.tenantId, input.organizationId, od, merane.length, JSON.stringify(vysledok),
        JSON.stringify(rozdiely.slice(0, 200)), trvanieMs, rezim, JSON.stringify(manifest),
        JSON.stringify(doklady.slice(0, 500))],
    );
  }
  return {
    id, metodika: 2, rezim, deliciDatum: od, vzorka: merane.length, vysledok, rozdiely, doklady, manifest, trvanieMs,
  };
}

export interface RadyVysledok {
  /** Od akého dátumu sa meralo; null = história rad dokladu nenesie vôbec. */
  od: string | null;
  podlaAgendy: Record<string, { dokladov: number; spravne: number; prazdne: number }>;
  rozdiely: Array<{
    doklad: string; agenda: string; datum: string; protistrana: string | null;
    skutocne: string | null; navrh: string | null;
  }>;
}

/**
 * Presnosť výberu číselného radu — bez AI. Rad je výpočet z histórie, nie
 * úsudok modelu, takže sa dá premerať na KAŽDOM doklade zadarmo, nie na vzorke
 * zo zmerajPresnost. Doklad dostane rad len z toho, čo firma vedela pred jeho
 * dátumom, a porovná sa s radom, do ktorého ho účtovník v POHODE naozaj dal.
 * ponytail: história roka sa číta pre každý doklad znova (n²) — pri firmách
 * s desaťtisícmi dokladov ročne načítať rok raz a filtrovať v pamäti.
 */
export async function zmerajRady(
  database: Database,
  input: { tenantId: string; organizationId: string },
  moznosti: {
    od?: string;
    /** Skupina podľa predkontácie hlavičky so SKUTOČNOU predkontáciou z histórie
     *  — horná hranica; v produkcii ju dáva kandidát či model. */
    predkontacia?: boolean;
  } = {},
): Promise<RadyVysledok> {
  // Predvolene od 1. januára posledného roka, ktorý rad dokladu nesie: staršie
  // roky majú v POHODE iné rady a výber by sa meral na tom, čo firma nerobí.
  const od = moznosti.od ?? (await database.query<{ od: string | null } & Record<string, unknown>>(
    `SELECT make_date(max(extract(year FROM datum))::int, 1, 1)::text AS od
       FROM ucto_historia
      WHERE tenant_id=$1 AND organization_id=$2 AND rad_external_id IS NOT NULL`,
    [input.tenantId, input.organizationId],
  )).rows[0]?.od ?? null;
  const vysledok: RadyVysledok = { od, podlaAgendy: {}, rozdiely: [] };
  if (!od) return vysledok;

  const doklady = (await database.query<Record<string, any>>(
    `SELECT DISTINCT ON (agenda, doklad_cislo)
            agenda, doklad_cislo, datum::text AS datum, supplier_ico, supplier_name_normalized,
            krajina, rad_external_id, rad_kod, btrim(predkontacia_kod) AS predkontacia_kod
       FROM ucto_historia
      WHERE tenant_id=$1 AND organization_id=$2 AND rad_external_id IS NOT NULL
        AND doklad_cislo IS NOT NULL AND datum >= $3::date AND agenda=ANY($4::text[])
      ORDER BY agenda, doklad_cislo, coalesce(riadok_index, 0)`,
    [input.tenantId, input.organizationId, od, Object.keys(DRUH_PODLA_AGENDY)],
  )).rows.sort((prvy, druhy) => prvy.datum.localeCompare(druhy.datum));
  const rady = new Map((await database.query<{ id: string; code: string; external_id: string | null } & Record<string, unknown>>(
    `SELECT id, code, external_id FROM code_list_items
      WHERE tenant_id=$1 AND organization_id=$2 AND kind='ciselneRady'`,
    [input.tenantId, input.organizationId],
  )).rows.map((row) => [row.id, row]));

  for (const doklad of doklady) {
    const druh = DRUH_PODLA_AGENDY[doklad.agenda];
    const navrh = await resolveSeriesDefault(
      database, input, druh.typ, doklad.datum, druh.podtyp,
      { ico: doklad.supplier_ico ?? undefined, nazov: doklad.supplier_name_normalized ?? undefined, krajina: doklad.krajina ?? undefined },
      doklad.datum, druh.pokladnaTyp, moznosti.predkontacia ? doklad.predkontacia_kod ?? undefined : undefined,
    );
    const skore = vysledok.podlaAgendy[doklad.agenda] ??= { dokladov: 0, spravne: 0, prazdne: 0 };
    skore.dokladov += 1;
    const rad = navrh ? rady.get(navrh) : undefined;
    if (!rad) skore.prazdne += 1;
    if (rad && rad.external_id === doklad.rad_external_id) {
      skore.spravne += 1;
    } else if (vysledok.rozdiely.length < 50) {
      vysledok.rozdiely.push({
        doklad: doklad.doklad_cislo, agenda: doklad.agenda, datum: doklad.datum,
        protistrana: doklad.supplier_name_normalized ?? doklad.supplier_ico ?? null,
        skutocne: doklad.rad_kod ?? null, navrh: rad?.code.trim() ?? null,
      });
    }
  }
  return vysledok;
}
