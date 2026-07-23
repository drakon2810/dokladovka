// Tréning AI — mapovanie riadkov z Excelu (výstup sheet_to_json) na riadky
// importu + validácia proti číselníkom firmy. Čistá logika bez React/API,
// autoritatívna validácia beží aj tak na serveri.
import type { AiTrainingRow } from '../../data/api';
import { CLENENIE_KV_KODY } from '../../data/types';

export interface ParsedTrainingRow extends AiTrainingRow {
  chyba?: string;
}

export interface TrainingKody {
  predkontacie: Set<string>;
  cleneniaDph: Set<string>;
  ciselneRady: Set<string>;
  strediska: Set<string>;
}

function bezDiakritiky(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('sk').trim();
}

// Aliasy pokrývajú aj stĺpce priameho exportu agendy z POHODY
// (Firma, ČlDPH, ČlKV DPH) — súbor netreba pred nahratím upravovať.
const HEADER_FIELDS: Array<[keyof AiTrainingRow, string[]]> = [
  ['supplierIco', ['ico']],
  ['supplierName', ['dodavatel', 'nazov', 'firma', 'partner']],
  ['lineText', ['text', 'popis', 'text/popis']],
  ['predkontaciaKod', ['predkontacia']],
  ['clenenieDphKod', ['clenenie dph', 'cldph', 'cl dph']],
  ['clenenieKvKod', ['clenenie kv', 'kv', 'clkv dph', 'clkv']],
  ['ciselnyRadKod', ['ciselny rad', 'rad']],
  ['strediskoKod', ['stredisko']],
];

/** Validácia typovaného riadku proti číselníkom firmy — spoločná pre Excel aj
 *  priamy import POHODA .mdb (obidve cesty končia rovnakým náhľadom + importom). */
export function validateTrainingRow(row: ParsedTrainingRow, kody: TrainingKody): ParsedTrainingRow {
  const validated = { ...row };
  delete validated.chyba;
  if (!validated.supplierIco && !validated.supplierName) validated.chyba = 'Chýba dodávateľ (IČO alebo názov)';
  else if (!validated.predkontaciaKod && !validated.clenenieDphKod) validated.chyba = 'Chýba predkontácia aj členenie DPH';
  else if (validated.predkontaciaKod && !kody.predkontacie.has(validated.predkontaciaKod)) validated.chyba = `Predkontácia „${validated.predkontaciaKod}" nie je v číselníku`;
  else if (validated.clenenieDphKod && !kody.cleneniaDph.has(validated.clenenieDphKod)) validated.chyba = `Členenie DPH „${validated.clenenieDphKod}" nie je v číselníku`;
  else if (validated.ciselnyRadKod && !kody.ciselneRady.has(validated.ciselnyRadKod)) validated.chyba = `Číselný rad „${validated.ciselnyRadKod}" nie je v číselníku`;
  else if (validated.strediskoKod && !kody.strediska.has(validated.strediskoKod)) validated.chyba = `Stredisko „${validated.strediskoKod}" nie je v číselníku`;
  else if (validated.clenenieKvKod && !CLENENIE_KV_KODY.includes(validated.clenenieKvKod.toUpperCase() as (typeof CLENENIE_KV_KODY)[number])) {
    validated.chyba = `Neplatné členenie KV „${validated.clenenieKvKod}"`;
  }
  return validated;
}

export function validateTrainingRows(rows: ParsedTrainingRow[], kody: TrainingKody): ParsedTrainingRow[] {
  return rows.map((row) => validateTrainingRow(row, kody));
}

export function parseTrainingRows(
  raw: Array<Record<string, unknown>>,
  kody: TrainingKody,
): ParsedTrainingRow[] {
  const mapped = raw
    .map((cells) => {
      const row: ParsedTrainingRow = {};
      for (const [rawHeader, value] of Object.entries(cells)) {
        const header = bezDiakritiky(rawHeader);
        const field = HEADER_FIELDS.find(([, aliases]) => aliases.includes(header))?.[0];
        const text = String(value ?? '').trim();
        if (field && text) row[field] = text;
      }
      return row;
    })
    .filter((row) => Object.keys(row).length > 0);
  return validateTrainingRows(mapped, kody);
}
