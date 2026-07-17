import { describe, expect, it } from 'vitest';
import { normalizeExtractionResult, validateNormalizedExtraction } from './normalize.js';

describe('normalizácia SK/CZ faktúr', () => {
  it('spracuje slovenské sadzby 23 %, 19 % a 5 % aj bez variabilného symbolu', () => {
    const normalized = normalizeExtractionResult({
      schemaVersion: '2', documentType: 'FP', supplier: { nazov: 'Dodávateľ SK', ico: '12345678', icDph: 'SK2020123456' },
      buyer: { ico: '87654321' }, invoiceNumber: 'SK-1', issueDate: '2026-07-01', taxDate: '2026-07-01',
      dueDate: '2026-07-15', currency: 'EUR', lineItems: [],
      vatBreakdown: [
        { vatRate: '23', base: '100', vat: '23' },
        { vatRate: '19', base: '100', vat: '19' },
        { vatRate: '5', base: '100', vat: '5' },
      ],
      totalWithoutVat: '300', totalVat: '47', totalAmount: '347', fieldConfidence: {}, evidence: {}, warnings: [],
    }, 'doc-sk', '2026-07-01');
    expect((normalized.extracted as any).variabilnySymbol).toBeUndefined();
    expect((normalized.extracted as any).rozpisDph.map((row: any) => row.sadzba)).toEqual([23, 19, 5]);
    expect(validateNormalizedExtraction(normalized, { ico: '87654321' })).toEqual([]);
  });

  it('zachová české sadzby 21 % a 12 % a overí súčty', () => {
    const normalized = normalizeExtractionResult({
      schemaVersion: '2', documentType: 'FP',
      supplier: { nazov: 'Dodávateľ CZ', ico: '12345678', icDph: 'CZ12345678' },
      buyer: { nazov: 'Odberateľ SK', ico: '87654321' }, invoiceNumber: 'CZ-1',
      issueDate: '2026-07-01', taxDate: '2026-07-01', dueDate: '2026-07-15', currency: 'CZK',
      lineItems: [],
      vatBreakdown: [
        { vatRate: '21', base: '100', vat: '21', total: '121' },
        { vatRate: '12', base: '50', vat: '6', total: '56' },
      ],
      totalWithoutVat: '150', totalVat: '27', totalAmount: '177',
      fieldConfidence: { totalAmount: 0.99 }, evidence: {}, warnings: [],
    }, 'doc-1', '2026-07-01');
    expect((normalized.extracted as any).rozpisDph.map((row: any) => row.sadzba)).toEqual([21, 12]);
    expect(validateNormalizedExtraction(normalized, { ico: '87654321' })).toEqual([]);
  });

  it('zachytí nesúlad organizácie a matematickú chybu bez ohľadu na confidence', () => {
    const normalized = normalizeExtractionResult({
      schemaVersion: '2', documentType: 'FP', supplier: { nazov: 'Dodávateľ' }, buyer: { ico: '11111111' },
      invoiceNumber: '1', issueDate: '2026-07-01', taxDate: '2026-07-01', dueDate: '2026-07-15', currency: 'EUR',
      lineItems: [], vatBreakdown: [{ vatRate: '23', base: '100', vat: '10' }], totalAmount: '110',
      fieldConfidence: { totalAmount: 1, 'buyer.ico': 1 }, evidence: {}, warnings: [],
    }, 'doc-1', '2026-07-01');
    expect(validateNormalizedExtraction(normalized, { ico: '87654321' }).map((issue) => issue.code))
      .toEqual(expect.arrayContaining(['buyer_ico_mismatch', 'invalid_vat_row']));
  });

  it('historickú sadzbu zachová a označí na kontrolu', () => {
    const normalized = normalizeExtractionResult({
      schemaVersion: '2', documentType: 'FP', supplier: { nazov: 'Historický dodávateľ' }, buyer: { ico: '87654321' },
      invoiceNumber: 'H-1', issueDate: '2023-01-01', taxDate: '2023-01-01', dueDate: '2023-01-15', currency: 'EUR',
      lineItems: [], vatBreakdown: [{ vatRate: '20', base: '100', vat: '20' }], totalWithoutVat: '100', totalVat: '20', totalAmount: '120',
      fieldConfidence: {}, evidence: {}, warnings: [],
    }, 'doc-history', '2023-01-01');
    expect((normalized.extracted as any).rozpisDph[0].sadzba).toBe(20);
    expect(validateNormalizedExtraction(normalized, { ico: '87654321' }).map((issue) => issue.code))
      .toContain('historical_or_unknown_vat_rate');
  });
});
