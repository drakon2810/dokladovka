import type { VatBreakdownRow } from '../data/types';

/** IČO: presne 8 číslic (SPEC §6.4). Kontrolná číslica — Fáza 2 (ORSR). */
export function validateICO(ico: string): boolean {
  return /^\d{8}$/.test(ico.trim());
}

/** IBAN podľa ISO 13616; podporuje aj slovenských a českých dodávateľov. */
export function validateIBAN(iban: string): boolean {
  const normalized = iban.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(normalized)) return false;
  const knownLengths: Record<string, number> = { SK: 24, CZ: 24 };
  const knownLength = knownLengths[normalized.slice(0, 2)];
  if (knownLength && normalized.length !== knownLength) return false;
  // mod-97 kontrola podľa ISO 13616
  const rearranged = normalized.slice(4) + normalized.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const digits = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

// IČ DPH podľa krajín: EÚ formáty podľa VIES + XI/GB/CH/NO. Musí zostať
// v zhode so serverovou tabuľkou v server/extraction/normalize.ts.
const VAT_ID_FORMATS: Record<string, RegExp> = {
  AT: /^ATU\d{8}$/,
  BE: /^BE[01]\d{9}$/,
  BG: /^BG\d{9,10}$/,
  CH: /^CHE\d{9}(?:MWST|TVA|IVA)?$/,
  CY: /^CY\d{8}[A-Z]$/,
  CZ: /^CZ[A-Z0-9]{8,12}$/,
  DE: /^DE\d{9}$/,
  DK: /^DK\d{8}$/,
  EE: /^EE\d{9}$/,
  EL: /^EL\d{9}$/,
  ES: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/,
  FI: /^FI\d{8}$/,
  FR: /^FR[A-Z0-9]{2}\d{9}$/,
  GB: /^GB(?:\d{9}|\d{12}|(?:GD|HA)\d{3})$/,
  GR: /^GR\d{9}$/,
  HR: /^HR\d{11}$/,
  HU: /^HU\d{8}$/,
  IE: /^IE(?:\d{7}[A-Z]{1,2}|\d[A-Z0-9]\d{5}[A-Z])$/,
  IT: /^IT\d{11}$/,
  LT: /^LT(?:\d{9}|\d{12})$/,
  LU: /^LU\d{8}$/,
  LV: /^LV\d{11}$/,
  MT: /^MT\d{8}$/,
  NL: /^NL[A-Z0-9]{9}B\d{2}$/,
  NO: /^NO\d{9}(?:MVA)?$/,
  PL: /^PL\d{10}$/,
  PT: /^PT\d{9}$/,
  RO: /^RO\d{2,10}$/,
  SE: /^SE\d{12}$/,
  SI: /^SI\d{8}$/,
  SK: /^SK\d{10}$/,
  XI: /^XI(?:\d{9}|\d{12}|(?:GD|HA)\d{3})$/,
};

export type VatIdCheck = 'valid' | 'invalid' | 'unknown_country';

/** IČ DPH: známa krajina sa overí formátom, neznámy kód krajiny neblokuje. */
export function checkVatId(value: string): VatIdCheck {
  const normalized = value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const format = VAT_ID_FORMATS[normalized.slice(0, 2)];
  if (format) return format.test(normalized) ? 'valid' : 'invalid';
  return /^[A-Z]{2}[A-Z0-9]{2,13}$/.test(normalized) ? 'unknown_country' : 'invalid';
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

export interface LineItemAmounts {
  sadzbaDph?: number;
  sumaBezDph?: number;
  sumaDph?: number;
  sumaSpolu?: number;
}

/**
 * Efektívne sumy položky: prázdna DPH pri vyplnenej sadzbe znamená
 * „dopočítaj zo základu“. Ak extrahované „spolu“ zodpovedá základu (faktúry
 * uvádzajú riadky bez DPH a daň pridávajú až v súčte), efektívne spolu je
 * základ + dopočítaná DPH. Musí zostať v zhode so serverom (normalize.ts).
 */
export function lineItemEffective(item: LineItemAmounts): {
  bezDph?: number;
  dph?: number;
  spolu?: number;
} {
  const bezDph = item.sumaBezDph;
  let dph = item.sumaDph;
  let spolu = item.sumaSpolu;
  if (dph === undefined && item.sadzbaDph !== undefined && bezDph !== undefined) {
    dph = round2((bezDph * item.sadzbaDph) / 100);
    if (spolu === undefined || Math.abs(spolu - bezDph) <= VAT_ROW_TOLERANCE) {
      spolu = round2(bezDph + dph);
    }
  }
  if (spolu === undefined && bezDph !== undefined && dph !== undefined) {
    spolu = round2(bezDph + dph);
  }
  return { bezDph, dph, spolu };
}
