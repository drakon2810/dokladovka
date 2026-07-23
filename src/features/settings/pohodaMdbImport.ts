// Extrakcia zaúčtovaní priamo z POHODA databázy (.mdb) do riadkov pre pamäť
// rozhodnutí. Číta agendu prijatých faktúr (FA) a rozvíja jej väzby na
// číselníky: predkontácia (pPK), členenie DPH (sDPH) a sekcia KV (sKVDPH).
// Čistá logika bez prehliadača/servera — mdb-reader dodá dáta, tu sa len
// spájajú a filtrujú. Autoritatívna validácia kódov beží na serveri pri importe.
import type { AiTrainingRow } from '../../data/api';
import { CLENENIE_KV_KODY } from '../../data/types';

// Typy dokladov agendy FA, ktoré sú PRIJATÉ faktúry (dodávateľské):
// 11 = prijatá faktúra, 12 = prijatý dobropis, 15 = prijatá zálohová/ostatná.
// Vydané doklady (1,2,5 → uskutočnené plnenia „UD/UN") sa vynechávajú — ich
// „Firma" je odberateľ, do pamäte dodávateľov nepatria.
const PRIJATE_TYPY = new Set([11, 12, 15]);

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
