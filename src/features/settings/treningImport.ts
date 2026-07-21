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

export function parseTrainingRows(
  raw: Array<Record<string, unknown>>,
  kody: TrainingKody,
): ParsedTrainingRow[] {
  return raw
    .map((cells) => {
      const row: ParsedTrainingRow = {};
      for (const [rawHeader, value] of Object.entries(cells)) {
        const header = bezDiakritiky(rawHeader);
        const field = HEADER_FIELDS.find(([, aliases]) => aliases.includes(header))?.[0];
        const text = String(value ?? '').trim();
        if (field && text) row[field] = text;
      }
      if (!row.supplierIco && !row.supplierName) row.chyba = 'Chýba dodávateľ (IČO alebo názov)';
      else if (!row.predkontaciaKod && !row.clenenieDphKod) row.chyba = 'Chýba predkontácia aj členenie DPH';
      else if (row.predkontaciaKod && !kody.predkontacie.has(row.predkontaciaKod)) row.chyba = `Predkontácia „${row.predkontaciaKod}" nie je v číselníku`;
      else if (row.clenenieDphKod && !kody.cleneniaDph.has(row.clenenieDphKod)) row.chyba = `Členenie DPH „${row.clenenieDphKod}" nie je v číselníku`;
      else if (row.ciselnyRadKod && !kody.ciselneRady.has(row.ciselnyRadKod)) row.chyba = `Číselný rad „${row.ciselnyRadKod}" nie je v číselníku`;
      else if (row.strediskoKod && !kody.strediska.has(row.strediskoKod)) row.chyba = `Stredisko „${row.strediskoKod}" nie je v číselníku`;
      else if (row.clenenieKvKod && !CLENENIE_KV_KODY.includes(row.clenenieKvKod.toUpperCase() as (typeof CLENENIE_KV_KODY)[number])) {
        row.chyba = `Neplatné členenie KV „${row.clenenieKvKod}"`;
      }
      return row;
    })
    .filter((row) => Object.keys(row).some((key) => key !== 'chyba'));
}
