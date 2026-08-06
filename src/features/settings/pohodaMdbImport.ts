// Extrakcia zaúčtovaní priamo z POHODA databázy (.mdb): riadky pre pamäť
// rozhodnutí (len prijaté faktúry) a plná história pre účtovný profil (všetky
// agendy okrem banky). Väzby na číselníky sa rozvíjajú rovnako: predkontácia
// (pPK), členenie DPH (sDPH) a sekcia KV (sKVDPH).
// Čistá logika bez prehliadača/servera — mdb-reader dodá dáta, tu sa len
// spájajú a filtrujú. Autoritatívna validácia kódov beží na serveri pri importe.
import type { AiTrainingRow, UctoHistoryRow } from '../../data/api';
import { CLENENIE_KV_KODY } from '../../data/types';

// Typy dokladov agendy FA, ktoré sú PRIJATÉ faktúry (dodávateľské):
// 11 = prijatá faktúra, 12 = prijatý dobropis, 15 = prijatá zálohová/ostatná.
// Vydané doklady (1,2,5 → uskutočnené plnenia „UD/UN") sa vynechávajú — ich
// „Firma" je odberateľ, do pamäte dodávateľov nepatria.
const PRIJATE_TYPY = new Set([11, 12, 15]);
// Vydané faktúry (1 = faktúra, 2 = dobropis, 5 = zálohová) — do pamäte
// dodávateľov nejdú, ale do histórie pre účtovný profil áno.
const VYDANE_TYPY = new Set([1, 2, 5]);

// Minimálne rozhranie mdb-reader (Node aj browser build) — pre testovateľnosť.
export interface MdbLike {
  getTableNames(): string[];
  getTable(name: string): {
    getColumnNames(): string[];
    getData(options?: { columns?: string[] }): Array<Record<string, unknown>>;
  };
}

export interface PohodaExtractResult {
  rows: AiTrainingRow[];
  summary: { spolu: number; prijate: number; vydane: number; bezUctovania: number; unikatne: number };
}

const KV_KODY = new Set<string>(CLENENIE_KV_KODY);

/** POHODA má rozšírené KV kódy (A2CN, C2B1, B1-0…). Základná zákonná sekcia je
 *  prvé dva znaky (C2B1→C2, B1-0→B1, A2CN→A2); čo nesedí, sa vynechá. */
function zakladnaKvSekcia(kod: unknown): string | undefined {
  const text = String(kod ?? '').trim().toUpperCase();
  if (KV_KODY.has(text)) return text;
  const zaklad = text.slice(0, 2);
  return KV_KODY.has(zaklad) ? zaklad : undefined;
}

function mapaIdNaKod(reader: MdbLike, table: string): Map<unknown, string> {
  const map = new Map<unknown, string>();
  if (!reader.getTableNames().includes(table)) return map;
  for (const row of reader.getTable(table).getData({ columns: ['ID', 'IDS'] })) {
    if (row.ID != null && row.IDS != null) map.set(row.ID, String(row.IDS).trim());
  }
  return map;
}

export function extractPohodaDecisions(reader: MdbLike): PohodaExtractResult {
  const predkontacie = mapaIdNaKod(reader, 'pPK');
  const cleneniaDph = mapaIdNaKod(reader, 'sDPH');
  const kvSekcie = mapaIdNaKod(reader, 'sKVDPH');

  const fa = reader.getTable('FA').getData({
    columns: ['RelTpFak', 'Firma', 'ICO', 'SText', 'RelPk', 'RelTpDPH', 'RelTpKVDPH'],
  });

  let prijate = 0;
  let vydane = 0;
  let bezUctovania = 0;
  const videne = new Set<string>();
  const rows: AiTrainingRow[] = [];

  for (const doklad of fa) {
    if (!PRIJATE_TYPY.has(Number(doklad.RelTpFak))) {
      vydane += 1;
      continue;
    }
    prijate += 1;
    const predkontaciaKod = predkontacie.get(doklad.RelPk);
    const clenenieDphKod = cleneniaDph.get(doklad.RelTpDPH);
    const supplierIco = String(doklad.ICO ?? '').replace(/\D/g, '') || undefined;
    const supplierName = String(doklad.Firma ?? '').trim() || undefined;
    if ((!predkontaciaKod && !clenenieDphKod) || (!supplierIco && !supplierName)) {
      bezUctovania += 1;
      continue;
    }
    const row: AiTrainingRow = {
      supplierIco,
      supplierName,
      lineText: String(doklad.SText ?? '').trim() || undefined,
      predkontaciaKod,
      clenenieDphKod,
      clenenieKvKod: zakladnaKvSekcia(kvSekcie.get(doklad.RelTpKVDPH)),
    };
    // Opakované identické doklady (napr. tá istá preprava) sa zlúčia — pamäť aj
    // tak deduplikuje na serveri, ale menší balík zrýchli náhľad aj prenos.
    const odtlacok = JSON.stringify(row);
    if (videne.has(odtlacok)) continue;
    videne.add(odtlacok);
    rows.push(row);
  }

  return {
    rows,
    summary: { spolu: fa.length, prijate, vydane, bezUctovania, unikatne: rows.length },
  };
}

// ===== Plná história pre účtovný profil =====

export interface PohodaHistoryResult {
  rows: UctoHistoryRow[];
  summary: { spolu: number; bezZauctovania: number; poAgende: Record<string, number> };
}

// Tabuľky dokladových agend v POHODA databáze (názvy podľa dokumentácie
// Stormware „Přehled tabulek"). Agenda FA nesie prijaté aj vydané faktúry a
// ostatné pohľadávky/záväzky — rozlišuje ich RelTpFak. BV (banka) sa zámerne
// vynecháva — banka sa do profilu zatiaľ neučí.
// ponytail: hlavičky dokladov (SText); položkové tabuľky (FApol, HOpol,
// pINTpol) doplniť, až keď bude k dispozícii reálna .mdb na overenie stĺpcov.
const HISTORICKE_TABULKY: Array<{ table: string; agenda?: UctoHistoryRow['agenda'] }> = [
  { table: 'FA' }, // FP / FV / OZ podľa RelTpFak
  { table: 'HO' }, // pokladňa — PPD / VPD podľa smeru dokladu
  { table: 'pINT', agenda: 'INT' }, // interné doklady
];

/**
 * Smer pokladničného dokladu sa v POHODE medzi verziami nesie v rôznych
 * stĺpcoch, preto sa skúša viacero kandidátov a až potom znamienko sumy.
 * ponytail: kandidáti podľa dokumentácie Stormware; overiť na reálnej .mdb —
 * keď nesedí ani jeden, doklady ostanú pri hrubom 'PD' a v profile to bude vidieť.
 */
const SMER_POKLADNE_STLPCE = ['RelTpPok', 'RelTpPr', 'TypDokl', 'Prijem'] as const;
const SUMA_POKLADNE_STLPCE = ['Kc', 'KcCelkem', 'Celkem'] as const;

/** Stĺpce spoločné pre dokladové tabuľky POHODY; chýbajúce sa preskočia. */
const HISTORICKE_STLPCE = [
  'RelTpFak', 'Cislo', 'Datum', 'Firma', 'ICO', 'SText', 'RelPk', 'RelTpDPH', 'RelTpKVDPH',
  ...SMER_POKLADNE_STLPCE, ...SUMA_POKLADNE_STLPCE,
];

/** mdb-reader vracia dátumy ako Date; história ich chce ako yyyy-mm-dd. */
function isoDatum(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    // mdb-reader stavia dátum ako UTC polnoc — lokálne gettery by západne od
    // UTC posunuli každý doklad o deň (a rozbili dedup odtlačok na serveri).
    const rok = value.getUTCFullYear();
    if (rok > 9999) return undefined; // preklep v Accesse; nepadnúť kvôli nemu celou dávkou
    const pad = (part: number, len = 2) => String(part).padStart(len, '0');
    return `${pad(rok, 4)}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }
  return /^\d{4}-\d{2}-\d{2}/.exec(String(value ?? ''))?.[0];
}

function agendaFaktury(relTpFak: unknown): UctoHistoryRow['agenda'] {
  const typ = Number(relTpFak);
  if (PRIJATE_TYPY.has(typ)) return 'FP';
  if (VYDANE_TYPY.has(typ)) return 'FV';
  // Zvyšok agendy FA sú ostatné pohľadávky/záväzky (RelTpFak 16 a spol.) —
  // v POHODE je to agenda „Ostatné záväzky", tak ju tak aj pomenujme.
  return 'OZ';
}

export function smerPokladne(doklad: Record<string, unknown>): 'PPD' | 'VPD' | undefined {
  for (const stlpec of SMER_POKLADNE_STLPCE) {
    const hodnota = doklad[stlpec];
    if (hodnota === undefined || hodnota === null || hodnota === '') continue;
    if (typeof hodnota === 'boolean') return hodnota ? 'PPD' : 'VPD';
    const cislo = Number(hodnota);
    // POHODA číseluje typy pokladničného dokladu 1 = príjem, 2 = výdaj.
    if (cislo === 1) return 'PPD';
    if (cislo === 2) return 'VPD';
  }
  for (const stlpec of SUMA_POKLADNE_STLPCE) {
    const suma = Number(doklad[stlpec]);
    if (Number.isFinite(suma) && suma !== 0) return suma > 0 ? 'PPD' : 'VPD';
  }
  return undefined;
}

/**
 * Prejde všetky dokladové agendy databázy (okrem banky) a vráti riadky pre
 * korpus histórie (ucto_historia). Na rozdiel od extractPohodaDecisions sa
 * neduplikuje — početnosť je pre analýzu hlavný signál a dedup rieši server
 * cez odtlačok (agenda + číslo dokladu + dátum).
 */
export function extractPohodaHistory(reader: MdbLike): PohodaHistoryResult {
  const predkontacie = mapaIdNaKod(reader, 'pPK');
  const cleneniaDph = mapaIdNaKod(reader, 'sDPH');
  const kvSekcie = mapaIdNaKod(reader, 'sKVDPH');
  const nazvyTabuliek = reader.getTableNames();

  const rows: UctoHistoryRow[] = [];
  const poAgende: Record<string, number> = {};
  let spolu = 0;
  let bezZauctovania = 0;

  for (const { table, agenda } of HISTORICKE_TABULKY) {
    if (!nazvyTabuliek.includes(table)) continue;
    const tabulka = reader.getTable(table);
    const dostupne = new Set(tabulka.getColumnNames());
    const columns = HISTORICKE_STLPCE.filter((stlpec) => dostupne.has(stlpec));
    if (!columns.includes('SText')) continue; // bez textu nemá riadok pre analýzu signál
    for (const doklad of tabulka.getData({ columns })) {
      spolu += 1;
      const lineText = String(doklad.SText ?? '').trim().slice(0, 2000);
      const predkontaciaKod = predkontacie.get(doklad.RelPk);
      const clenenieDphKod = cleneniaDph.get(doklad.RelTpDPH);
      if (!lineText || (!predkontaciaKod && !clenenieDphKod)) {
        bezZauctovania += 1;
        continue;
      }
      const riadokAgenda = agenda
        ?? (table === 'HO' ? smerPokladne(doklad) ?? 'PD' : agendaFaktury(doklad.RelTpFak));
      rows.push({
        agenda: riadokAgenda,
        // Jedna hlavička = jeden riadok; pevná nula drží serverový odtlačok
        // (agenda + číslo + dátum + poradie) stabilný pri opakovanom importe.
        riadokIndex: 0,
        dokladCislo: String(doklad.Cislo ?? '').trim().slice(0, 60) || undefined,
        datum: isoDatum(doklad.Datum),
        supplierIco: String(doklad.ICO ?? '').replace(/\D/g, '').slice(0, 20) || undefined,
        supplierName: String(doklad.Firma ?? '').trim().slice(0, 300) || undefined,
        lineText,
        predkontaciaKod,
        clenenieDphKod,
        clenenieKvKod: zakladnaKvSekcia(kvSekcie.get(doklad.RelTpKVDPH)),
      });
      poAgende[riadokAgenda] = (poAgende[riadokAgenda] ?? 0) + 1;
    }
  }

  return { rows, summary: { spolu, bezZauctovania, poAgende } };
}
