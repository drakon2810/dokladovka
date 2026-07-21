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

  it('zahodí DIČ skopírované z IČ DPH u zahraničného dodávateľa (ATU…)', () => {
    const normalized = normalizeExtractionResult({
      schemaVersion: '2', documentType: 'FP', supplier: { nazov: 'MUNDUS Spedition', dic: 'ATU42597604', icDph: 'ATU42597604' },
      buyer: { ico: '87654321' }, invoiceNumber: '1039', issueDate: '2026-02-03', taxDate: '2026-02-03',
      dueDate: '2026-07-08', currency: 'EUR', lineItems: [],
      vatBreakdown: [{ vatRate: '0', base: '383.15', vat: '0' }],
      totalAmount: '383.15', fieldConfidence: {}, evidence: {}, warnings: [],
    }, 'doc-at', '2026-02-03');
    expect((normalized.extracted as any).dodavatel.dic).toBeUndefined();
    expect((normalized.extracted as any).dodavatel.icDph).toBe('ATU42597604');
    expect(validateNormalizedExtraction(normalized, { ico: '87654321' }).map((issue) => issue.code))
      .not.toContain('invalid_dic');
  });

  it('zachová platný SK DIČ (nie je kópia IČ DPH)', () => {
    const normalized = normalizeExtractionResult({
      schemaVersion: '2', documentType: 'FP', supplier: { nazov: 'SK Dodávateľ', dic: '2020254170', icDph: 'SK2020254170' },
      buyer: { ico: '87654321' }, invoiceNumber: '1', issueDate: '2026-02-03', taxDate: '2026-02-03',
      dueDate: '2026-02-10', currency: 'EUR', lineItems: [],
      vatBreakdown: [{ vatRate: '0', base: '100', vat: '0' }], totalAmount: '100',
      fieldConfidence: {}, evidence: {}, warnings: [],
    }, 'doc-sk2', '2026-02-03');
    expect((normalized.extracted as any).dodavatel.dic).toBe('2020254170');
  });

  it('kanonizuje menu "EURO" na EUR (mena nezablokuje schválenie)', () => {
    const normalized = normalizeExtractionResult({
      schemaVersion: '2', documentType: 'FP', supplier: { nazov: 'MUNDUS Spedition', icDph: 'ATU42597604' },
      buyer: { ico: '87654321' }, invoiceNumber: '1102', issueDate: '2026-03-11', taxDate: '2026-03-11',
      dueDate: '2026-03-25', currency: 'EURO', lineItems: [],
      vatBreakdown: [{ vatRate: '0', base: '455.38', vat: '0' }],
      totalAmount: '455.38', fieldConfidence: {}, evidence: {}, warnings: [],
    }, 'doc-eur', '2026-03-11');
    expect(normalized.currency).toBe('EUR');
    expect((normalized.extracted as any).mena).toBe('EUR');
    expect(validateNormalizedExtraction(normalized, { ico: '87654321' }).map((issue) => issue.code))
      .not.toContain('unsupported_currency');
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

  it('prijme platné zahraničné IČ DPH dodávateľa (AT, DE, HU)', () => {
    for (const icDph of ['ATU42597604', 'DE811907980', 'HU12345678']) {
      const normalized = normalizeExtractionResult({
        schemaVersion: '2', documentType: 'FP',
        supplier: { nazov: 'Zahraničný dodávateľ', icDph },
        buyer: { ico: '87654321' }, invoiceNumber: 'F-1',
        issueDate: '2026-05-05', taxDate: '2026-05-05', dueDate: '2026-07-15', currency: 'EUR',
        lineItems: [], vatBreakdown: [{ vatRate: '0', base: '140', vat: '0' }],
        totalWithoutVat: '140', totalVat: '0', totalAmount: '140',
        fieldConfidence: {}, evidence: {}, warnings: [],
      }, 'doc-foreign', '2026-05-05');
      expect(validateNormalizedExtraction(normalized, { ico: '87654321' })).toEqual([]);
    }
  });

  it('nesprávny formát známej krajiny je error, neznámy kód krajiny len warning', () => {
    const build = (icDph: string) => normalizeExtractionResult({
      schemaVersion: '2', documentType: 'FP',
      supplier: { nazov: 'Dodávateľ', icDph },
      buyer: { ico: '87654321' }, invoiceNumber: 'F-2',
      issueDate: '2026-05-05', taxDate: '2026-05-05', dueDate: '2026-07-15', currency: 'EUR',
      lineItems: [], vatBreakdown: [], totalAmount: '140',
      fieldConfidence: {}, evidence: {}, warnings: [],
    }, 'doc-vat', '2026-05-05');
    // ATU s nesprávnym počtom číslic — známa krajina, zlý formát.
    expect(validateNormalizedExtraction(build('ATU425976'), { ico: '87654321' }))
      .toEqual([expect.objectContaining({ code: 'invalid_supplier_vat_id', severity: 'error' })]);
    // Hodnota, ktorá nie je IČ DPH vôbec.
    expect(validateNormalizedExtraction(build('12345'), { ico: '87654321' }))
      .toEqual([expect.objectContaining({ code: 'invalid_supplier_vat_id', severity: 'error' })]);
    // Neznámy kód krajiny — schválenie neblokuje, len upozorní.
    expect(validateNormalizedExtraction(build('AE123456789012'), { ico: '87654321' }))
      .toEqual([expect.objectContaining({ code: 'unverified_supplier_vat_id', severity: 'warning' })]);
  });

  it('IČ DPH odberateľa akceptuje zahraničný formát a chybný blokuje', () => {
    const build = (icDph: string) => normalizeExtractionResult({
      schemaVersion: '2', documentType: 'FV',
      supplier: { nazov: 'Naša firma', ico: '87654321', icDph: 'SK2020254170' },
      buyer: { nazov: 'Odberateľ AT', icDph }, invoiceNumber: 'V-1',
      issueDate: '2026-05-05', taxDate: '2026-05-05', dueDate: '2026-07-15', currency: 'EUR',
      lineItems: [], vatBreakdown: [], totalAmount: '140',
      fieldConfidence: {}, evidence: {}, warnings: [],
    }, 'doc-buyer-vat', '2026-05-05');
    expect(validateNormalizedExtraction(build('ATU42597604'), { ico: '87654321' })).toEqual([]);
    expect(validateNormalizedExtraction(build('ATU4259'), { ico: '87654321' }))
      .toEqual([expect.objectContaining({ code: 'invalid_buyer_vat_id', severity: 'error' })]);
  });

  it('položky bez DPH so sadzbou sa dopočítajú a neblokujú súčet', () => {
    // Faktúra uvádza riadky bez DPH (spolu = základ), daň pridáva až v súčte:
    // 478,98 + 95 + 50 = 623,98 základ; 23 % DPH 143,51; spolu 767,49.
    const normalized = normalizeExtractionResult({
      schemaVersion: '2', documentType: 'FP',
      supplier: { nazov: 'Alfa Airlines Services spol. s r.o.', ico: '47167998', dic: '2023775083', icDph: 'SK2023775083' },
      buyer: { ico: '87654321' }, invoiceNumber: '2026006A',
      issueDate: '2026-03-31', taxDate: '2026-03-31', dueDate: '2026-04-21', currency: 'EUR',
      lineItems: [
        { description: 'AWB & labels', vatRate: '23', amountWithoutVat: '478.98', amountTotal: '478.98' },
        { description: 'Handling', vatRate: '23', amountWithoutVat: '95', amountTotal: '95' },
        { description: 'Storage', vatRate: '23', amountWithoutVat: '50', amountTotal: '50' },
      ],
      vatBreakdown: [{ vatRate: '23', base: '623.98', vat: '143.51' }],
      totalWithoutVat: '623.98', totalVat: '143.51', totalAmount: '767.49',
      fieldConfidence: {}, evidence: {}, warnings: [],
    }, 'doc-lines', '2026-03-31');
    expect(validateNormalizedExtraction(normalized, { ico: '87654321' })).toEqual([]);
  });

  it('explicitná DPH položky sa nedopočítava — nesúlad súčtu zostáva chybou', () => {
    const normalized = normalizeExtractionResult({
      schemaVersion: '2', documentType: 'FP',
      supplier: { nazov: 'Dodávateľ SK', ico: '12345678' },
      buyer: { ico: '87654321' }, invoiceNumber: 'X-1',
      issueDate: '2026-03-31', taxDate: '2026-03-31', dueDate: '2026-04-21', currency: 'EUR',
      lineItems: [
        { description: 'Riadok', vatRate: '23', amountWithoutVat: '100', vatAmount: '23', amountTotal: '123' },
      ],
      vatBreakdown: [{ vatRate: '23', base: '623.98', vat: '143.51' }],
      totalWithoutVat: '623.98', totalVat: '143.51', totalAmount: '767.49',
      fieldConfidence: {}, evidence: {}, warnings: [],
    }, 'doc-lines-explicit', '2026-03-31');
    expect(validateNormalizedExtraction(normalized, { ico: '87654321' }).map((issue) => issue.code))
      .toContain('line_items_total_mismatch');
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
