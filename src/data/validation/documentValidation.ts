import type { DocumentItem, Organization } from '../types';
import {
  checkVatId,
  isTotalConsistent,
  isVatRowConsistent,
  lineItemEffective,
  VAT_ROW_TOLERANCE,
  validateIBAN,
  validateICO,
} from '../../lib/validate';

export type DocumentValidationCode =
  | 'supplier_name_required'
  | 'invoice_number_required'
  | 'invalid_ico'
  | 'invalid_dic'
  | 'invalid_ic_dph'
  | 'invalid_iban'
  | 'invalid_issue_date'
  | 'invalid_tax_date'
  | 'invalid_due_date'
  | 'tax_date_required'
  | 'due_date_required'
  | 'due_before_issue'
  | 'unsupported_currency'
  | 'vat_breakdown_required'
  | 'invalid_vat_row'
  | 'total_mismatch'
  | 'invalid_total'
  | 'invalid_line_item'
  | 'line_items_vat_mismatch'
  | 'line_items_total_mismatch'
  | 'buyer_ico_mismatch'
  | 'unresolved_duplicate'
  | 'processing_not_ready';

export interface DocumentValidationIssue {
  code: DocumentValidationCode;
  field?: string;
}

/**
 * Zahraničný dodávateľ: IČ DPH alebo DIČ nesie 2-písmenový kód krajiny ≠ SK
 * (napr. rakúske „ATU…", nemecké „DE…"). Slovenské formáty IČO (8 číslic) a DIČ
 * (10 číslic) preň neplatia — zahraničné identifikátory by inak blokovali
 * schválenie faktúry od EÚ dodávateľa.
 */
export function isForeignSupplier(supplier: { ico?: string; dic?: string; icDph?: string }): boolean {
  for (const value of [supplier.icDph, supplier.dic]) {
    if (!value) continue;
    const normalized = value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (/^[A-Z]{2}/.test(normalized) && !normalized.startsWith('SK') && checkVatId(value) !== 'invalid') {
      return true;
    }
  }
  return false;
}

export function isValidIsoDate(value: string | undefined): boolean {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseDecimalString(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Deterministická kontrola má vždy prioritu pred AI confidence. */
export function validateDocument(
  doc: DocumentItem,
  organization?: Organization,
): DocumentValidationIssue[] {
  const issues: DocumentValidationIssue[] = [];
  const extracted = doc.extracted;
  const supplier = extracted.dodavatel;
  const invoiceType = doc.typ === 'FP' || doc.typ === 'FV';

  if (!supplier.nazov.trim()) {
    issues.push({ code: 'supplier_name_required', field: 'dodavatel.nazov' });
  }
  if (!extracted.cisloFaktury.trim() && !['BV', 'MZDY'].includes(doc.typ)) {
    issues.push({ code: 'invoice_number_required', field: 'cisloFaktury' });
  }
  // Zahraničný dodávateľ nemá slovenské IČO/DIČ — formátové kontroly by falošne
  // blokovali schválenie; IČ DPH sa aj tak overuje cez checkVatId nižšie.
  const foreignSupplier = isForeignSupplier(supplier);
  if (!foreignSupplier && supplier.ico && !validateICO(supplier.ico)) {
    issues.push({ code: 'invalid_ico', field: 'dodavatel.ico' });
  }
  if (!foreignSupplier && supplier.dic && !/^(?:\d{8,10}|CZ[A-Z0-9]{8,12})$/.test(supplier.dic.replace(/\s/g, '').toUpperCase())) {
    issues.push({ code: 'invalid_dic', field: 'dodavatel.dic' });
  }
  // Neznámy kód krajiny schválenie neblokuje (server ho hlási len ako
  // warning) — issue vzniká iba pre hodnotu s preukázateľne zlým formátom.
  if (supplier.icDph && checkVatId(supplier.icDph) === 'invalid') {
    issues.push({ code: 'invalid_ic_dph', field: 'dodavatel.icDph' });
  }
  if (supplier.iban && !validateIBAN(supplier.iban)) {
    issues.push({ code: 'invalid_iban', field: 'dodavatel.iban' });
  }
  if (!isValidIsoDate(extracted.datumVystavenia)) {
    issues.push({ code: 'invalid_issue_date', field: 'datumVystavenia' });
  }
  if (invoiceType && !extracted.datumDodania) {
    issues.push({ code: 'tax_date_required', field: 'datumDodania' });
  }
  if (extracted.datumDodania && !isValidIsoDate(extracted.datumDodania)) {
    issues.push({ code: 'invalid_tax_date', field: 'datumDodania' });
  }
  if (invoiceType && !extracted.datumSplatnosti) {
    issues.push({ code: 'due_date_required', field: 'datumSplatnosti' });
  }
  if (extracted.datumSplatnosti && !isValidIsoDate(extracted.datumSplatnosti)) {
    issues.push({ code: 'invalid_due_date', field: 'datumSplatnosti' });
  } else if (
    extracted.datumSplatnosti &&
    isValidIsoDate(extracted.datumVystavenia) &&
    extracted.datumSplatnosti < extracted.datumVystavenia
  ) {
    issues.push({ code: 'due_before_issue', field: 'datumSplatnosti' });
  }
  if (!['EUR', 'CZK', 'USD'].includes(extracted.mena)) {
    issues.push({ code: 'unsupported_currency', field: 'mena' });
  }
  if (!['BV', 'MZDY'].includes(doc.typ) && extracted.rozpisDph.length === 0) {
    issues.push({ code: 'vat_breakdown_required', field: 'rozpisDph' });
  }
  if (extracted.rozpisDph.some((row) => !isVatRowConsistent(row))) {
    issues.push({ code: 'invalid_vat_row', field: 'rozpisDph' });
  }
  if (!isTotalConsistent(extracted.rozpisDph, extracted.sumaSpolu)) {
    issues.push({ code: 'total_mismatch', field: 'sumaSpolu' });
  }
  if (!Number.isFinite(extracted.sumaSpolu)) {
    issues.push({ code: 'invalid_total', field: 'sumaSpolu' });
  }

  const lineItems = extracted.polozky ?? [];
  for (const [index, item] of lineItems.entries()) {
    if (
      item.mnozstvo !== undefined &&
      item.jednotkovaCenaBezDph !== undefined &&
      item.sumaBezDph !== undefined &&
      Math.abs(item.mnozstvo * item.jednotkovaCenaBezDph - item.sumaBezDph) >
        VAT_ROW_TOLERANCE
    ) {
      issues.push({ code: 'invalid_line_item', field: `polozky.${index}.sumaBezDph` });
    }
    if (
      item.sumaBezDph !== undefined &&
      item.sumaDph !== undefined &&
      item.sumaSpolu !== undefined &&
      Math.abs(item.sumaBezDph + item.sumaDph - item.sumaSpolu) > VAT_ROW_TOLERANCE
    ) {
      issues.push({ code: 'invalid_line_item', field: `polozky.${index}.sumaSpolu` });
    }
  }
  // Prázdna DPH položky pri vyplnenej sadzbe sa dopočítava (lineItemEffective) —
  // súčtové kontroly pracujú s efektívnymi sumami, nie s literálnym poľom.
  const effectiveItems = lineItems.map(lineItemEffective);
  if (
    effectiveItems.length > 0 &&
    effectiveItems.every(
      (item) =>
        item.bezDph !== undefined &&
        item.dph !== undefined &&
        item.spolu !== undefined,
    )
  ) {
    const lineBase = effectiveItems.reduce((sum, item) => sum + (item.bezDph ?? 0), 0);
    const lineVat = effectiveItems.reduce((sum, item) => sum + (item.dph ?? 0), 0);
    const lineTotal = effectiveItems.reduce((sum, item) => sum + (item.spolu ?? 0), 0);
    const vatBase = extracted.rozpisDph.reduce((sum, row) => sum + row.zaklad, 0);
    const vatAmount = extracted.rozpisDph.reduce((sum, row) => sum + row.dph, 0);
    if (
      Math.abs(lineBase - vatBase) > VAT_ROW_TOLERANCE ||
      Math.abs(lineVat - vatAmount) > VAT_ROW_TOLERANCE
    ) {
      issues.push({ code: 'line_items_vat_mismatch', field: 'polozky' });
    }
    if (Math.abs(lineTotal - extracted.sumaSpolu) > VAT_ROW_TOLERANCE) {
      issues.push({ code: 'line_items_total_mismatch', field: 'polozky' });
    }
  }

  const buyer = extracted.odberatel;
  if (buyer?.ico && !validateICO(buyer.ico)) {
    issues.push({ code: 'invalid_ico', field: 'odberatel.ico' });
  }
  if (buyer?.dic && !/^(?:\d{8,10}|CZ[A-Z0-9]{8,12})$/.test(buyer.dic.replace(/\s/g, '').toUpperCase())) {
    issues.push({ code: 'invalid_dic', field: 'odberatel.dic' });
  }
  if (buyer?.icDph && checkVatId(buyer.icDph) === 'invalid') {
    issues.push({ code: 'invalid_ic_dph', field: 'odberatel.icDph' });
  }
  if (
    organization &&
    extracted.odberatel?.ico &&
    extracted.odberatel.ico !== organization.ico
  ) {
    issues.push({ code: 'buyer_ico_mismatch', field: 'odberatel.ico' });
  }
  if (doc.duplicateOfDocumentId && !doc.notDuplicate) {
    issues.push({ code: 'unresolved_duplicate' });
  }
  if (doc.processingStatus !== 'ready_for_review') {
    issues.push({ code: 'processing_not_ready' });
  }

  return issues;
}
