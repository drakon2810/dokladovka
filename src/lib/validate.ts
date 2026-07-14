import type { VatBreakdownRow } from '../data/types';

/** IČO: presne 8 číslic (SPEC §6.4). Kontrolná číslica — Fáza 2 (ORSR). */
export function validateICO(ico: string): boolean {
  return /^\d{8}$/.test(ico.trim());
}

/** IBAN formát SK: SK + 2 kontrolné číslice + 20 číslic (SPEC §6.4). */
export function validateIBAN(iban: string): boolean {
  const normalized = iban.replace(/\s+/g, '').toUpperCase();
  if (!/^SK\d{22}$/.test(normalized)) return false;
  // mod-97 kontrola podľa ISO 13616
  const rearranged = normalized.slice(4) + normalized.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of numeric) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export const VAT_ROW_TOLERANCE = 0.02; // € na riadok (SPEC §6.4, §11.14)

/** |základ×sadzba − dph| ≤ 0,02 € (SPEC §6.4). */
export function isVatRowConsistent(row: VatBreakdownRow): boolean {
  const expected = row.zaklad * (row.sadzba / 100);
  return Math.abs(expected - row.dph) <= VAT_ROW_TOLERANCE + 1e-9;
}

export function vatBreakdownTotal(rows: VatBreakdownRow[]): number {
  return round2(rows.reduce((sum, r) => sum + r.zaklad + r.dph, 0));
}

/** Súčet rozpisu DPH sa musí zhodovať so sumaSpolu (SPEC §6.4). */
export function isTotalConsistent(rows: VatBreakdownRow[], sumaSpolu: number): boolean {
  return Math.abs(vatBreakdownTotal(rows) - sumaSpolu) <= VAT_ROW_TOLERANCE + 1e-9;
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
