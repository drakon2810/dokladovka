import {
  SUPPORTED_VAT_RATES,
  extractionResultSchema,
  type ExtractionResult,
} from './contract.js';

export type DocumentType = 'FP' | 'FV' | 'BV' | 'MZDY' | 'OZ' | 'PD';

export interface NormalizedExtraction {
  documentType: DocumentType;
  extracted: Record<string, unknown>;
  fieldConfidence: Record<string, number>;
  confidence: number;
  totalAmount: number;
  currency: string;
}

const FIELD_PATHS: Record<string, string> = {
  'supplier.nazov': 'dodavatel.nazov',
  'supplier.ico': 'dodavatel.ico',
  'supplier.dic': 'dodavatel.dic',
  'supplier.icDph': 'dodavatel.icDph',
  'supplier.adresa': 'dodavatel.adresa',
  'supplier.iban': 'dodavatel.iban',
  'supplier.bic': 'dodavatel.bic',
  'buyer.nazov': 'odberatel.nazov',
  'buyer.ico': 'odberatel.ico',
  invoiceNumber: 'cisloFaktury',
  orderNumber: 'cisloObjednavky',
  deliveryNoteNumber: 'cisloDodaciehoListu',
  variableSymbol: 'variabilnySymbol',
  constantSymbol: 'konstantnySymbol',
  specificSymbol: 'specifickySymbol',
  issueDate: 'datumVystavenia',
  taxDate: 'datumDodania',
  dueDate: 'datumSplatnosti',
  totalAmount: 'sumaSpolu',
};

export function parseDecimal(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : undefined;
}

// AI vracia menu v rôznych podobách (EURO, €, Kč, $). Kanonizujeme na ISO kód,
// inak doklad spadne na 'unsupported_currency', hoci mena je reálne EUR.
const CURRENCY_ALIASES: Record<string, string> = {
  EUR: 'EUR', EURO: 'EUR', EUROS: 'EUR', '€': 'EUR',
  CZK: 'CZK', 'KČ': 'CZK', KC: 'CZK',
  USD: 'USD', 'US$': 'USD', '$': 'USD',
};

export function canonicalCurrency(raw: string | undefined): string {
  const key = (raw ?? '').trim().toUpperCase();
  if (!key) return 'EUR';
  return CURRENCY_ALIASES[key] ?? key;
}

// AI občas skopíruje zahraničné IČ DPH aj do poľa DIČ (napr. ATU… u rakúskeho
// dodávateľa). DIČ je SK/CZ identifikátor; keď sa zhoduje s IČ DPH, je to
// duplikát — zhodíme ho, inak doklad spadne na invalid_dic pri schvaľovaní.
function withoutForeignDicCopy(supplier: ExtractionResult['supplier']): ExtractionResult['supplier'] {
  if (supplier.dic && supplier.icDph
    && supplier.dic.replace(/\s/g, '').toUpperCase() === supplier.icDph.replace(/\s/g, '').toUpperCase()) {
    return { ...supplier, dic: undefined };
  }
  return supplier;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isValidVatRate(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

function isCurrentSupportedVatRate(value: number): boolean {
  return (SUPPORTED_VAT_RATES as readonly number[]).includes(value);
}

function confidence(fieldConfidence: Record<string, number>): number {
  const values = Object.values(fieldConfidence).filter(Number.isFinite);
  if (values.length === 0) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10_000) / 10_000;
}

export function normalizeExtractionResult(
  raw: unknown,
  documentId: string,
  fallbackDate: string,
): NormalizedExtraction {
  const result = extractionResultSchema.parse(raw);
  const totalAmount = round2(parseDecimal(result.totalAmount) ?? 0);
  const currency = canonicalCurrency(result.currency);
  const mappedConfidence = Object.fromEntries(Object.entries(result.fieldConfidence).map(([path, value]) => [
    FIELD_PATHS[path] ?? path
      .replace(/^supplier\./, 'dodavatel.')
      .replace(/^buyer\./, 'odberatel.')
      .replace(/^vatBreakdown/, 'rozpisDph')
      .replace(/^lineItems/, 'polozky'),
    value,
  ]));

  return {
    documentType: result.documentType === 'UNKNOWN' ? 'FP' : result.documentType,
    extracted: {
      dodavatel: { ...withoutForeignDicCopy(result.supplier), nazov: result.supplier.nazov ?? '' },
      odberatel: { ...result.buyer },
      cisloFaktury: result.invoiceNumber ?? '',
      cisloObjednavky: result.orderNumber,
      cisloDodaciehoListu: result.deliveryNoteNumber,
      variabilnySymbol: result.variableSymbol,
      konstantnySymbol: result.constantSymbol,
      specifickySymbol: result.specificSymbol,
      datumVystavenia: result.issueDate ?? fallbackDate,
      datumSplatnosti: result.dueDate,
      datumDodania: result.taxDate,
      mena: currency,
      rozpisDph: result.vatBreakdown.flatMap((row) => {
        const sadzba = Number(row.vatRate.replace(',', '.'));
        const zaklad = parseDecimal(row.base);
        const dph = parseDecimal(row.vat);
        return isValidVatRate(sadzba) && zaklad !== undefined && dph !== undefined
          ? [{ sadzba, zaklad: round2(zaklad), dph: round2(dph) }]
          : [];
      }),
      sumaSpolu: totalAmount,
      polozky: result.lineItems.map((item, index) => {
        const rate = Number(item.vatRate?.replace(',', '.'));
        return {
          id: `${documentId}-li-${index}`,
          popis: item.description ?? '',
          mnozstvo: parseDecimal(item.quantity),
          jednotka: item.unit,
          jednotkovaCenaBezDph: parseDecimal(item.unitPriceWithoutVat),
          sadzbaDph: isValidVatRate(rate) ? rate : undefined,
          sumaBezDph: parseDecimal(item.amountWithoutVat),
          sumaDph: parseDecimal(item.vatAmount),
          sumaSpolu: parseDecimal(item.amountTotal),
        };
      }),
    },
    fieldConfidence: mappedConfidence,
    confidence: confidence(result.fieldConfidence),
    totalAmount,
    currency,
  };
}

export interface ValidationIssue {
  code: string;
  field?: string;
  severity: 'warning' | 'error';
  message: string;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function normalizedIdentifier(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[^A-Za-z0-9]/g, '').toUpperCase() : '';
}

function validDic(value: unknown): boolean {
  return /^(?:\d{8,10}|CZ[A-Z0-9]{8,12})$/.test(normalizedIdentifier(value));
}

// IČ DPH podľa krajín: EÚ formáty podľa VIES + XI/GB/CH/NO, ktoré sa na
// faktúrach zahraničných dodávateľov bežne vyskytujú. CZ zostáva zámerne
// voľnejšie než oficiálny formát (spätná kompatibilita s existujúcimi dokladmi).
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

/**
 * Efektívne sumy položky: prázdna DPH pri vyplnenej sadzbe znamená
 * „dopočítaj zo základu“. Ak extrahované „spolu“ zodpovedá základu (faktúry
 * uvádzajú riadky bez DPH a daň pridávajú až v súčte), efektívne spolu je
 * základ + dopočítaná DPH. Musí zostať v zhode s klientom (src/lib/validate.ts).
 */
function lineItemEffective(item: {
  sadzbaDph?: number;
  sumaBezDph?: number;
  sumaDph?: number;
  sumaSpolu?: number;
}): { bezDph?: number; dph?: number; spolu?: number } {
  const bezDph = item.sumaBezDph;
  let dph = item.sumaDph;
  let spolu = item.sumaSpolu;
  if (dph === undefined && item.sadzbaDph !== undefined && bezDph !== undefined) {
    dph = round2((bezDph * item.sadzbaDph) / 100);
    if (spolu === undefined || Math.abs(spolu - bezDph) <= 0.02) {
      spolu = round2(bezDph + dph);
    }
  }
  if (spolu === undefined && bezDph !== undefined && dph !== undefined) {
    spolu = round2(bezDph + dph);
  }
  return { bezDph, dph, spolu };
}

type VatIdCheck = 'valid' | 'invalid' | 'unknown_country';

function checkVatId(value: unknown): VatIdCheck {
  const normalized = normalizedIdentifier(value);
  const format = VAT_ID_FORMATS[normalized.slice(0, 2)];
  if (format) return format.test(normalized) ? 'valid' : 'invalid';
  // Neznámy kód krajiny nesmie blokovať schválenie — o zahraničnom doklade
  // rozhoduje človek; error je len pre hodnoty, ktoré nie sú IČ DPH vôbec.
  return /^[A-Z]{2}[A-Z0-9]{2,13}$/.test(normalized) ? 'unknown_country' : 'invalid';
}

function validIban(value: string): boolean {
  const iban = value.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const lengths: Record<string, number> = { SK: 24, CZ: 24 };
  if (lengths[iban.slice(0, 2)] && iban.length !== lengths[iban.slice(0, 2)]) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const digits = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export function validateNormalizedExtraction(
  normalized: NormalizedExtraction,
  organization: { ico: string; dic?: string; icDph?: string },
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const extracted = normalized.extracted as any;
  const supplier = extracted.dodavatel ?? {};
  const buyer = extracted.odberatel ?? {};
  const invoiceType = normalized.documentType === 'FP' || normalized.documentType === 'FV';
  if (!String(supplier.nazov ?? '').trim()) issues.push({ code: 'supplier_name_required', field: 'dodavatel.nazov', severity: 'error', message: 'Chýba názov dodávateľa' });
  if (invoiceType && !String(extracted.cisloFaktury ?? '').trim()) issues.push({ code: 'invoice_number_required', field: 'cisloFaktury', severity: 'error', message: 'Chýba číslo faktúry' });
  if (!isIsoDate(extracted.datumVystavenia)) issues.push({ code: 'invalid_issue_date', field: 'datumVystavenia', severity: 'error', message: 'Dátum vystavenia nie je platný' });
  if (invoiceType && !isIsoDate(extracted.datumDodania)) issues.push({ code: 'tax_date_required', field: 'datumDodania', severity: 'error', message: 'Chýba platný dátum dodania' });
  if (invoiceType && !isIsoDate(extracted.datumSplatnosti)) issues.push({ code: 'due_date_required', field: 'datumSplatnosti', severity: 'error', message: 'Chýba platný dátum splatnosti' });
  // Splatnosť pred vystavením je nezvyčajná, ale legitímna (napr. zálohové
  // faktúry) — varovanie, o schválení rozhoduje človek.
  if (isIsoDate(extracted.datumSplatnosti) && isIsoDate(extracted.datumVystavenia) && extracted.datumSplatnosti < extracted.datumVystavenia) {
    issues.push({ code: 'due_before_issue', field: 'datumSplatnosti', severity: 'warning', message: 'Dátum splatnosti je pred dátumom vystavenia' });
  }
  if (supplier.icDph) {
    const supplierVat = checkVatId(supplier.icDph);
    if (supplierVat === 'invalid') {
      issues.push({ code: 'invalid_supplier_vat_id', field: 'dodavatel.icDph', severity: 'error', message: 'IČ DPH dodávateľa nemá platný formát' });
    } else if (supplierVat === 'unknown_country') {
      issues.push({ code: 'unverified_supplier_vat_id', field: 'dodavatel.icDph', severity: 'warning', message: 'IČ DPH dodávateľa má neznámy kód krajiny — skontrolujte podľa originálu' });
    }
  }
  if (supplier.ico && !/^\d{8}$/.test(normalizedIdentifier(supplier.ico))) issues.push({ code: 'invalid_supplier_ico', field: 'dodavatel.ico', severity: 'error', message: 'IČO dodávateľa nemá 8 číslic' });
  if (supplier.dic && !validDic(supplier.dic)) issues.push({ code: 'invalid_supplier_dic', field: 'dodavatel.dic', severity: 'error', message: 'DIČ dodávateľa nemá platný formát' });
  if (supplier.iban && !validIban(supplier.iban)) issues.push({ code: 'invalid_iban', field: 'dodavatel.iban', severity: 'error', message: 'IBAN dodávateľa nie je platný' });
  const buyerIco = normalizedIdentifier(buyer.ico);
  const orgIco = normalizedIdentifier(organization.ico);
  // Nesúlad IČO odberateľa posiela doklad do karantény; samotné schválenie po
  // ľudskom rozhodnutí neblokuje (varovanie zostáva viditeľné v detaile).
  if (buyerIco && buyerIco !== orgIco) issues.push({ code: 'buyer_ico_mismatch', field: 'odberatel.ico', severity: 'warning', message: 'IČO odberateľa sa nezhoduje s organizáciou' });
  if (buyerIco && !/^\d{8}$/.test(buyerIco)) issues.push({ code: 'invalid_buyer_ico', field: 'odberatel.ico', severity: 'error', message: 'IČO odberateľa nemá 8 číslic' });
  if (buyer.dic && !validDic(buyer.dic)) issues.push({ code: 'invalid_buyer_dic', field: 'odberatel.dic', severity: 'error', message: 'DIČ odberateľa nemá platný formát' });
  if (buyer.icDph) {
    const buyerVat = checkVatId(buyer.icDph);
    if (buyerVat === 'invalid') {
      issues.push({ code: 'invalid_buyer_vat_id', field: 'odberatel.icDph', severity: 'error', message: 'IČ DPH odberateľa nemá platný formát' });
    } else if (buyerVat === 'unknown_country') {
      issues.push({ code: 'unverified_buyer_vat_id', field: 'odberatel.icDph', severity: 'warning', message: 'IČ DPH odberateľa má neznámy kód krajiny — skontrolujte podľa originálu' });
    }
  }
  if (normalizedIdentifier(supplier.ico) === orgIco && buyerIco && buyerIco !== orgIco) {
    issues.push({ code: 'supplier_buyer_may_be_inverted', severity: 'warning', message: 'Dodávateľ a odberateľ môžu byť zamenení' });
  }
  if (!Number.isFinite(normalized.totalAmount) || normalized.totalAmount < 0) issues.push({ code: 'invalid_total', field: 'sumaSpolu', severity: 'error', message: 'Celková suma nie je platná' });
  const rows = extracted.rozpisDph as Array<{ sadzba: number; zaklad: number; dph: number }>;
  for (const [index, row] of rows.entries()) {
    if (!isValidVatRate(row.sadzba) || Math.abs(round2(row.zaklad * row.sadzba / 100) - row.dph) > 0.02) {
      issues.push({ code: 'invalid_vat_row', field: `rozpisDph.${index}`, severity: 'error', message: 'Rozpis DPH matematicky nesedí' });
    }
    if (isValidVatRate(row.sadzba) && !isCurrentSupportedVatRate(row.sadzba)) {
      issues.push({ code: 'historical_or_unknown_vat_rate', field: `rozpisDph.${index}.sadzba`, severity: 'warning', message: 'Sadzba DPH nie je v aktuálnom zozname; skontrolujte historickú sadzbu' });
    }
  }
  if (rows.length > 0) {
    const rowsTotal = round2(rows.reduce((sum, row) => sum + row.zaklad + row.dph, 0));
    if (Math.abs(rowsTotal - normalized.totalAmount) > 0.02) issues.push({ code: 'total_mismatch', field: 'sumaSpolu', severity: 'error', message: 'Celková suma nesedí s rozpisom DPH' });
  }
  const items = extracted.polozky as Array<any>;
  for (const [index, item] of items.entries()) {
    if (item.mnozstvo !== undefined && item.jednotkovaCenaBezDph !== undefined && item.sumaBezDph !== undefined
      && Math.abs(round2(item.mnozstvo * item.jednotkovaCenaBezDph) - item.sumaBezDph) > 0.02) {
      issues.push({ code: 'invalid_line_item', field: `polozky.${index}.sumaBezDph`, severity: 'error', message: 'Množstvo a jednotková cena nesedia so sumou položky' });
    }
    if (item.sumaBezDph !== undefined && item.sumaDph !== undefined && item.sumaSpolu !== undefined
      && Math.abs(round2(item.sumaBezDph + item.sumaDph) - item.sumaSpolu) > 0.02) {
      issues.push({ code: 'invalid_line_item_total', field: `polozky.${index}.sumaSpolu`, severity: 'error', message: 'Súčet základu a DPH nesedí so sumou položky' });
    }
  }
  // Súčet položiek pracuje s efektívnymi sumami — prázdna DPH pri vyplnenej
  // sadzbe sa dopočíta, aby faktúry s riadkami bez DPH neblokovali schválenie.
  const effectiveItems = items.map(lineItemEffective);
  if (effectiveItems.length > 0 && effectiveItems.every((item) => item.spolu !== undefined)) {
    const itemTotal = round2(effectiveItems.reduce((sum, item) => sum + (item.spolu ?? 0), 0));
    if (Math.abs(itemTotal - normalized.totalAmount) > 0.02) issues.push({ code: 'line_items_total_mismatch', field: 'polozky', severity: 'error', message: 'Súčet položiek nesedí s celkovou sumou' });
  }
  return issues;
}

/** Kontroly hodnôt, ktoré zostávajú v presných decimal strings pred normalizáciou. */
export function validateExtractionResult(
  result: ExtractionResult,
  normalized: NormalizedExtraction,
  organization: { ico: string; dic?: string; icDph?: string },
): ValidationIssue[] {
  const issues = validateNormalizedExtraction(normalized, organization);
  if (!result.totalAmount || parseDecimal(result.totalAmount) === undefined) {
    issues.push({ code: 'total_required', field: 'sumaSpolu', severity: 'error', message: 'Chýba platná celková suma' });
  }
  if (!result.currency || !['EUR', 'CZK', 'USD'].includes(result.currency.trim().toUpperCase())) {
    issues.push({ code: 'unsupported_currency', field: 'mena', severity: 'error', message: 'Mena dokladu nie je podporovaná' });
  }
  const totalWithoutVat = parseDecimal(result.totalWithoutVat);
  const totalVat = parseDecimal(result.totalVat);
  const totalAmount = parseDecimal(result.totalAmount);
  if (totalWithoutVat !== undefined && totalVat !== undefined && totalAmount !== undefined
    && Math.abs(round2(totalWithoutVat + totalVat) - totalAmount) > 0.02) {
    issues.push({ code: 'declared_totals_mismatch', field: 'sumaSpolu', severity: 'error', message: 'Deklarovaný základ a DPH nesedia s celkovou sumou' });
  }
  const rawBase = result.vatBreakdown.reduce((sum, row) => sum + (parseDecimal(row.base) ?? 0), 0);
  const rawVat = result.vatBreakdown.reduce((sum, row) => sum + (parseDecimal(row.vat) ?? 0), 0);
  if (totalWithoutVat !== undefined && Math.abs(round2(rawBase) - totalWithoutVat) > 0.02) {
    issues.push({ code: 'vat_base_total_mismatch', field: 'rozpisDph', severity: 'error', message: 'Súčet základov DPH nesedí s deklarovaným základom' });
  }
  if (totalVat !== undefined && Math.abs(round2(rawVat) - totalVat) > 0.02) {
    issues.push({ code: 'vat_total_mismatch', field: 'rozpisDph', severity: 'error', message: 'Súčet DPH nesedí s deklarovanou DPH' });
  }
  return issues;
}
