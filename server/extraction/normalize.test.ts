import { describe, expect, it } from 'vitest';
import { normalizeExtractionResult, validateNormalizedExtraction } from './normalize.js';
import { splitPostalAddress } from '../pohodaXml.js';

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

  it('IČ DPH odberateľa akceptuje zahraničný formát; chybný len upozorní', () => {
    const build = (icDph: string) => normalizeExtractionResult({
      schemaVersion: '2', documentType: 'FV',
      supplier: { nazov: 'Naša firma', ico: '87654321', icDph: 'SK2020254170' },
      buyer: { nazov: 'Odberateľ AT', icDph }, invoiceNumber: 'V-1',
      issueDate: '2026-05-05', taxDate: '2026-05-05', dueDate: '2026-07-15', currency: 'EUR',
      lineItems: [], vatBreakdown: [], totalAmount: '140',
      fieldConfidence: {}, evidence: {}, warnings: [],
    }, 'doc-buyer-vat', '2026-05-05');
    expect(validateNormalizedExtraction(build('ATU42597604'), { ico: '87654321' })).toEqual([]);
    // Zahraničné číslo schválenie neblokuje ani pri zlom formáte — formátov je
    // priveľa na to, aby zoznam rozhodoval za účtovníka.
    expect(validateNormalizedExtraction(build('ATU4259'), { ico: '87654321' }))
      .toEqual([expect.objectContaining({ code: 'unverified_buyer_vat_id', severity: 'warning' })]);
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

  it('DUZP sa odvodí z dátumu vystavenia, keď na faktúre chýba (neblokuje)', () => {
    const normalized = normalizeExtractionResult({
      schemaVersion: '2', documentType: 'FP', supplier: { nazov: 'Geschwandtner GmbH', icDph: 'ATU12345678' },
      buyer: { ico: '87654321' }, invoiceNumber: '06-2026-00355', issueDate: '2026-06-09',
      dueDate: '2026-07-09', currency: 'EUR', lineItems: [], vatBreakdown: [{ vatRate: '0', base: '210', vat: '0' }], totalAmount: '210',
      fieldConfidence: {}, evidence: {}, warnings: [],
    }, 'doc-noduzp', '2026-06-09');
    expect((normalized.extracted as any).datumDodania).toBe('2026-06-09');
    expect(validateNormalizedExtraction(normalized, { ico: '87654321' }).map((i) => i.code)).not.toContain('tax_date_required');
  });

  it('DIČ odberateľa skopírované z jeho IČ DPH (SK…) sa zahodí a neblokuje schválenie', () => {
    const normalized = normalizeExtractionResult({
      schemaVersion: '2', documentType: 'FP', supplier: { nazov: 'ASECO', ico: '12345678', icDph: 'SK2020123456' },
      buyer: { nazov: 'AGS Bratislava', ico: '87654321', dic: 'SK2020254170', icDph: 'SK2020254170' },
      invoiceNumber: '517655', issueDate: '2026-06-04', taxDate: '2026-06-04', dueDate: '2026-06-18', currency: 'EUR',
      lineItems: [], vatBreakdown: [{ vatRate: '0', base: '500', vat: '0' }], totalAmount: '500',
      fieldConfidence: {}, evidence: {}, warnings: [],
    }, 'doc-buyerdic', '2026-06-04');
    expect((normalized.extracted as any).odberatel.dic).toBeUndefined();
    expect(validateNormalizedExtraction(normalized, { ico: '87654321' }).map((i) => i.code)).not.toContain('invalid_buyer_dic');
  });

  it('na FP je chybný DIČ/IČO odberateľa (naša firma) len varovanie, na FV blokuje', () => {
    const build = (documentType: 'FP' | 'FV') => normalizeExtractionResult({
      schemaVersion: '2', documentType, supplier: { nazov: 'ASECO', ico: '12345678', icDph: 'SK2020123456' },
      buyer: { nazov: 'AGS', ico: '87654321', dic: '4024' }, invoiceNumber: '1', issueDate: '2026-06-04', taxDate: '2026-06-04',
      dueDate: '2026-06-18', currency: 'EUR', lineItems: [], vatBreakdown: [{ vatRate: '0', base: '500', vat: '0' }], totalAmount: '500',
      fieldConfidence: {}, evidence: {}, warnings: [],
    }, 'doc-bd', '2026-06-04');
    expect(validateNormalizedExtraction(build('FP'), { ico: '87654321' }).find((i) => i.code === 'invalid_buyer_dic')?.severity).toBe('warning');
    expect(validateNormalizedExtraction(build('FV'), { ico: '87654321' }).find((i) => i.code === 'invalid_buyer_dic')?.severity).toBe('error');
  });

  it('zahraničný VAT dodávateľa v poli dic (ATU…) sa berie ako zahraničný — IČO len varovanie', () => {
    const normalized = normalizeExtractionResult({
      schemaVersion: '2', documentType: 'FP', supplier: { nazov: 'Geschwandtner GmbH', ico: '252338', dic: 'ATU61252600' },
      buyer: { ico: '87654321' }, invoiceNumber: '391', issueDate: '2026-06-18', taxDate: '2026-06-18', dueDate: '2026-07-18', currency: 'EUR',
      lineItems: [], vatBreakdown: [{ vatRate: '0', base: '210', vat: '0' }], totalAmount: '210',
      fieldConfidence: {}, evidence: {}, warnings: [],
    }, 'doc-gd', '2026-06-18');
    const issues = validateNormalizedExtraction(normalized, { ico: '87654321' });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(issues.find((i) => i.code === 'invalid_supplier_ico')?.severity).toBe('warning');
  });

  it('zahraničný dodávateľ bez SK IČO/DIČ = varovanie; chýbajúca splatnosť sa doplní dňom vystavenia', () => {
    const normalized = normalizeExtractionResult({
      schemaVersion: '2', documentType: 'FP', supplier: { nazov: 'AGS-MUDANÇAS LDA', ico: '123456', dic: 'PT999999', icDph: 'PT501234567' },
      buyer: { ico: '87654321' }, invoiceNumber: 'FT-284', issueDate: '2026-06-10', taxDate: '2026-06-10',
      currency: 'EUR', lineItems: [], vatBreakdown: [{ vatRate: '0', base: '561', vat: '0' }], totalAmount: '561',
      fieldConfidence: {}, evidence: {}, warnings: [],
    }, 'doc-foreign2', '2026-06-10');
    const issues = validateNormalizedExtraction(normalized, { ico: '87654321' });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    // Doklad bez splatnosti je splatný dňom vystavenia — rovnaký fallback má aj export do POHODY.
    expect(normalized.extracted.datumSplatnosti).toBe('2026-06-10');
    expect(issues.find((i) => i.code === 'due_date_required')).toBeUndefined();
    expect(issues.find((i) => i.code === 'invalid_supplier_ico')?.severity).toBe('warning');
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

// Reálny prípad z vydanej faktúry: model vrátil položky so sadzbou aj daňou,
// ale rozpis DPH nechal prázdny. Doklad sa potom nedal schváliť a do POHODY by
// odišiel s nulovým základom — rozpis sa preto dopočíta z položiek.
describe('rozpis DPH sa dopočíta z položiek', () => {
  const doklad = (vatBreakdown: Array<{ vatRate: string; base: string; vat: string }>) =>
    normalizeExtractionResult({
      schemaVersion: '2', documentType: 'FV',
      supplier: { nazov: 'AGS Bratislava', ico: '35761571' },
      buyer: { nazov: 'KACZYNSKA Sarah' }, invoiceNumber: '260704300120',
      issueDate: '2026-07-12', taxDate: '2026-07-12', dueDate: '2026-07-12', currency: 'EUR',
      lineItems: [
        { description: 'Insurance', vatRate: '23', amountWithoutVat: '19.50', vatAmount: '4.49', amountTotal: '23.99' },
        { description: 'Door to door removal service', vatRate: '23', amountWithoutVat: '1850.00', vatAmount: '425.50', amountTotal: '2275.50' },
      ],
      vatBreakdown, totalAmount: '2299.49',
      fieldConfidence: {}, evidence: {}, warnings: [],
    } as never, 'doc-fv', '2026-07-12');

  it('prázdny rozpis sa zloží zo sadzieb položiek', () => {
    expect(doklad([]).extracted.rozpisDph).toEqual([{ sadzba: 23, zaklad: 1869.5, dph: 429.99 }]);
  });

  it('rozpis z dokladu má prednosť pred dopočtom', () => {
    expect(doklad([{ vatRate: '23', base: '1869.50', vat: '429.99' }]).extracted.rozpisDph)
      .toEqual([{ sadzba: 23, zaklad: 1869.5, dph: 429.99 }]);
    // Doklad, kde sa rozpis a položky rozchádzajú, si ponechá svoj rozpis —
    // rozdiel má vyriešiť účtovník, nie tichý prepočet.
    expect(doklad([{ vatRate: '19', base: '1000', vat: '190' }]).extracted.rozpisDph)
      .toEqual([{ sadzba: 19, zaklad: 1000, dph: 190 }]);
  });
});

// Reálny prípad: „Client VAT No.: CH E101237456" z faktúry skončilo v DIČ aj s
// medzerou — slovenský formát ho hlásil ako chybu a do POHODY neodišlo ako
// IČ DPH partnera.
describe('identifikátory strán', () => {
  const doklad = (buyer: Record<string, string>) => normalizeExtractionResult({
    schemaVersion: '2', documentType: 'FV',
    supplier: { nazov: 'AGS Bratislava', ico: '35 761 571', icDph: 'SK 2020254170' },
    buyer: { nazov: 'GOSSELIN SUISSE SA', ...buyer }, invoiceNumber: '260704300124',
    issueDate: '2026-07-12', taxDate: '2026-07-12', dueDate: '2026-08-07', currency: 'EUR',
    lineItems: [], vatBreakdown: [], totalAmount: '940',
    fieldConfidence: {}, evidence: {}, warnings: [],
  } as never, 'doc-vat', '2026-07-12').extracted as {
    dodavatel: Record<string, string>; odberatel: Record<string, string>;
  };

  it('zahraničné IČ DPH z poľa DIČ sa presunie do IČ DPH a stratí medzery', () => {
    expect(doklad({ dic: 'CH E101237456' }).odberatel)
      .toMatchObject({ icDph: 'CHE101237456' });
    expect(doklad({ dic: 'CH E101237456' }).odberatel.dic).toBeUndefined();
  });

  it('medzery padnú aj z IČO a IČ DPH vlastnej firmy', () => {
    expect(doklad({}).dodavatel).toMatchObject({ ico: '35761571', icDph: 'SK2020254170' });
  });

  it('skutočné DIČ ostáva DIČom a duplikát IČ DPH sa zahodí', () => {
    expect(doklad({ dic: '2020254170' }).odberatel).toMatchObject({ dic: '2020254170' });
    expect(doklad({ dic: '2020254170' }).odberatel.icDph).toBeUndefined();
    expect(doklad({ dic: 'ATU42597604', icDph: 'ATU42597604' }).odberatel)
      .toMatchObject({ icDph: 'ATU42597604' });
    expect(doklad({ dic: 'ATU42597604', icDph: 'ATU42597604' }).odberatel.dic).toBeUndefined();
  });
});

// Izraelský zákazník: „Client VAT No.: 511149775" nemá kód krajiny, takže formát
// samotného čísla nič nepovie — krajinu prezradí adresa.
describe('daňové číslo zahraničnej strany bez kódu krajiny', () => {
  const odberatel = (buyer: Record<string, string>) => (normalizeExtractionResult({
    schemaVersion: '2', documentType: 'FV',
    supplier: { nazov: 'AGS Bratislava', ico: '35761571' },
    buyer: { nazov: 'GLOBUS INTERNATIONAL', ...buyer }, invoiceNumber: '260704300126',
    issueDate: '2026-07-16', taxDate: '2026-07-16', dueDate: '2026-08-15', currency: 'EUR',
    lineItems: [], vatBreakdown: [], totalAmount: '5466',
    fieldConfidence: {}, evidence: {}, warnings: [],
  } as never, 'doc-il', '2026-07-16').extracted as { odberatel: Record<string, string> }).odberatel;

  it('podľa krajiny z adresy ide do IČ DPH', () => {
    const strana = odberatel({ dic: '511149775', adresa: '7 Ha-Bosem Street, Ashdod, South District, Israel' });
    expect(strana).toMatchObject({ icDph: '511149775' });
    expect(strana.dic).toBeUndefined();
  });

  it('slovenskej strane sa DIČ neprepisuje', () => {
    const strana = odberatel({ dic: '2020254170', adresa: 'Riazanská 62, 811 01 Bratislava, Slovensko' });
    expect(strana).toMatchObject({ dic: '2020254170' });
    expect(strana.icDph).toBeUndefined();
  });
});

// Izraelský zákazník: krajina stojí v adrese uprostred a jeho VAT number nemá
// kód krajiny — ani jedno nesmie blokovať schválenie.
describe('mimoeurópska strana', () => {
  const odberatel = (buyer: Record<string, string>) => normalizeExtractionResult({
    schemaVersion: '2', documentType: 'FV',
    supplier: { nazov: 'AGS Bratislava', ico: '35761571' },
    buyer: { nazov: 'GLOBUS INTERNATIONAL', ...buyer }, invoiceNumber: '260704300126',
    issueDate: '2026-07-16', taxDate: '2026-07-16', dueDate: '2026-08-15', currency: 'EUR',
    lineItems: [], vatBreakdown: [], totalAmount: '5466',
    fieldConfidence: {}, evidence: {}, warnings: [],
  } as never, 'doc-il2', '2026-07-16');

  const adresa = '7 Ha-Bosem Street, Ashdod, Israel, South District';

  it('krajina sa nájde aj uprostred adresy', () => {
    expect(splitPostalAddress(adresa)).toMatchObject({ country: 'IL' });
  });

  it('izraelské VAT number neblokuje schválenie', () => {
    const normalized = odberatel({ dic: '511149775', adresa });
    expect((normalized.extracted as { odberatel: Record<string, string> }).odberatel)
      .toMatchObject({ icDph: '511149775' });
    expect(validateNormalizedExtraction(normalized, { ico: '35761571' })
      .filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('pokazené IČ DPH cudzinca je upozornenie, schválenie nezastaví', () => {
    const normalized = odberatel({ icDph: 'ATU1', adresa: 'Wagramer Str. 5, 1220 Vienna, Austria' });
    const issues = validateNormalizedExtraction(normalized, { ico: '35761571' });
    expect(issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'unverified_buyer_vat_id', severity: 'warning' }));
  });
});

// Krajinu už neurčuje zoznam názvov v kóde, ale model — pozná aj samotné mesto.
describe('krajina strany od modelu', () => {
  const strana = (buyer: Record<string, string>) => (normalizeExtractionResult({
    schemaVersion: '2', documentType: 'FV',
    supplier: { nazov: 'AGS Bratislava', ico: '35761571' },
    buyer: { nazov: 'GLOBUS INTERNATIONAL', ...buyer }, invoiceNumber: 'F1',
    issueDate: '2026-07-16', taxDate: '2026-07-16', dueDate: '2026-08-15', currency: 'EUR',
    lineItems: [], vatBreakdown: [], totalAmount: '100',
    fieldConfidence: {}, evidence: {}, warnings: [],
  } as never, 'doc-kr', '2026-07-16').extracted as { odberatel: Record<string, string> }).odberatel;

  it('ISO kód z extrakcie sa použije aj pri adrese bez názvu krajiny', () => {
    expect(strana({ adresa: '7 Ha-Bosem Street, Ashdod', krajina: 'IL' })).toMatchObject({ krajina: 'IL' });
    expect(strana({ adresa: 'Wagramer Str. 5, 1220 Vienna', krajina: 'at' })).toMatchObject({ krajina: 'AT' });
  });

  it('nezmyselnú hodnotu zahodí a vráti sa k rozkladu adresy', () => {
    expect(strana({ adresa: 'Ballindamm 25, 20095 Hamburg, Germany', krajina: 'Israel' }))
      .toMatchObject({ krajina: 'DE' });
    expect(strana({ adresa: 'Hlavná 1', krajina: '' }).krajina).toBeUndefined();
  });

  it('krajina od modelu rozhodne aj o tom, že strana je zahraničná', () => {
    const izraelsky = strana({ dic: '511149775', adresa: '7 Ha-Bosem Street, Ashdod', krajina: 'IL' });
    expect(izraelsky).toMatchObject({ icDph: '511149775', krajina: 'IL' });
    expect(izraelsky.dic).toBeUndefined();
  });
});

// Thajský zákazník: rozklad textu dal do mesta „Thailand" a serverová kontrola
// jeho VAT number blokovala, hoci krajinu (TH) model určil správne.
describe('adresa a kontroly podľa krajiny od modelu', () => {
  const doklad = (buyer: Record<string, string>) => normalizeExtractionResult({
    schemaVersion: '2', documentType: 'FV',
    supplier: { nazov: 'AGS Bratislava', ico: '35761571', icDph: 'SK2020254170' },
    buyer: { nazov: 'AGS Four Winds International Moving Limited', ...buyer },
    invoiceNumber: '260704300132',
    issueDate: '2026-07-20', taxDate: '2026-07-20', dueDate: '2026-08-19', currency: 'EUR',
    lineItems: [], vatBreakdown: [], totalAmount: '1980.09',
    fieldConfidence: {}, evidence: {}, warnings: [],
  } as never, 'doc-th', '2026-07-20');

  const thajsky = {
    icDph: '0105541035341',
    adresa: '235/15 Soi Sukhumvit 31 (Sawasdee), Klongton Nua, Watthana, Bangkok, 10110, Thailand',
    ulica: '235/15 Soi Sukhumvit 31 (Sawasdee)', psc: '10110', obec: 'Bangkok', krajina: 'TH',
  };

  it('časti adresy od modelu sa použijú tak, ako prišli', () => {
    expect((doklad(thajsky).extracted as { odberatel: Record<string, string> }).odberatel)
      .toMatchObject({ ulica: '235/15 Soi Sukhumvit 31 (Sawasdee)', psc: '10110', obec: 'Bangkok', krajina: 'TH' });
  });

  it('thajské VAT number neblokuje schválenie', () => {
    expect(validateNormalizedExtraction(doklad(thajsky), { ico: '35761571' })
      .filter((issue) => issue.severity === 'error')).toEqual([]);
  });
});

// Francúzsky zákazník: model zobral do IČ DPH aj slovo „TVA" a formát ho
// vyhlásil za chybu, takže sa faktúra nedala schváliť.
describe('IČ DPH zahraničnej strany neblokuje', () => {
  const doklad = (buyer: Record<string, string>) => normalizeExtractionResult({
    schemaVersion: '2', documentType: 'FV',
    supplier: { nazov: 'AGS Bratislava', ico: '35761571', icDph: 'SK2020254170' },
    buyer: { nazov: 'AGS Rhône-Alpes-Auvergne', ...buyer }, invoiceNumber: '260704300135',
    issueDate: '2026-07-30', taxDate: '2026-07-30', dueDate: '2026-08-29', currency: 'EUR',
    lineItems: [], vatBreakdown: [], totalAmount: '4360',
    fieldConfidence: {}, evidence: {}, warnings: [],
  } as never, 'doc-fr', '2026-07-30');

  it('slovo TVA pred platným číslom sa odstráni', () => {
    expect((doklad({ icDph: 'TVAFR30300823390', krajina: 'FR' }).extracted as { odberatel: Record<string, string> }).odberatel)
      .toMatchObject({ icDph: 'FR30300823390' });
  });

  it('nerozpoznaný zahraničný formát je len upozornenie, nie blokácia', () => {
    const issues = validateNormalizedExtraction(doklad({ icDph: 'XYZ-123/456', krajina: 'FR' }), { ico: '35761571' });
    expect(issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'unverified_buyer_vat_id', severity: 'warning' }));
  });

  it('slovenské VAT bez predpony sa doplní na SK… a naplní DIČ', () => {
    const odberatel = (doklad({ icDph: '2020270780', krajina: 'SK' }).extracted as { odberatel: Record<string, string> }).odberatel;
    expect(odberatel).toMatchObject({ icDph: 'SK2020270780', dic: '2020270780' });
    expect(validateNormalizedExtraction(doklad({ icDph: '2020270780', krajina: 'SK' }), { ico: '35761571' })
      .filter((issue) => issue.severity === 'error')).toEqual([]);
  });

  it('zahraničné číslo bez predpony sa nedopĺňa', () => {
    expect((doklad({ icDph: '0105541035341', krajina: 'TH' }).extracted as { odberatel: Record<string, string> }).odberatel)
      .toMatchObject({ icDph: '0105541035341' });
    expect((doklad({ icDph: '511149775', krajina: 'IL' }).extracted as { odberatel: Record<string, string> }).odberatel)
      .toMatchObject({ icDph: '511149775' });
  });

  // Poľské NIP má tiež 10 číslic. Keby stačilo „nie je zahraničná", strane bez
  // rozpoznanej krajiny by sme vyrobili slovenské IČ DPH, ktoré prejde všetkými
  // kontrolami a v kontrolnom výkaze skončí ako tuzemské plnenie.
  it('bez preukázanej krajiny sa 10 číslic neprepisuje na SK', () => {
    for (const buyer of [{ icDph: '5252248481' }, { icDph: '5252248481', adresa: 'ul. Prosta 51, 00-838 Warszawa, Polska' }]) {
      const doc = doklad(buyer);
      expect((doc.extracted as { odberatel: Record<string, string> }).odberatel).toMatchObject({ icDph: '5252248481' });
      expect((doc.extracted as { odberatel: Record<string, string> }).odberatel.dic).toBeUndefined();
      expect(validateNormalizedExtraction(doc, { ico: '35761571' }))
        .toContainEqual(expect.objectContaining({ code: 'invalid_buyer_vat_id', severity: 'error' }));
    }
  });

  it('slovenskej strane pokazené IČ DPH schválenie naďalej blokuje', () => {
    const normalized = normalizeExtractionResult({
      schemaVersion: '2', documentType: 'FP',
      supplier: { nazov: 'SK Dodávateľ', ico: '35761571', icDph: 'SK123', krajina: 'SK' },
      buyer: { ico: '87654321' }, invoiceNumber: 'F-1',
      issueDate: '2026-07-30', taxDate: '2026-07-30', dueDate: '2026-08-29', currency: 'EUR',
      lineItems: [], vatBreakdown: [], totalAmount: '100',
      fieldConfidence: {}, evidence: {}, warnings: [],
    } as never, 'doc-sk3', '2026-07-30');
    expect(validateNormalizedExtraction(normalized, { ico: '87654321' }))
      .toContainEqual(expect.objectContaining({ code: 'invalid_supplier_vat_id', severity: 'error' }));
  });
});

describe('rozpis DPH pri prenesení daňovej povinnosti', () => {
  // Reálny prípad CMA CGM: reverse charge, na faktúre Total VAT 0,00 a žiadna
  // sadzba. Model k nulovej dani priradil 10 % — taký riadok je matematicky
  // nemožný, validácia ho označí a doklad sa nedá schváliť.
  it('nulová daň pri nenulovom základe znamená nulovú sadzbu', () => {
    const normalized = normalizeExtractionResult({
      schemaVersion: '2', documentType: 'FP',
      supplier: { nazov: 'CMA - CGM', icDph: 'FR72562024422' },
      buyer: { ico: '35761571' }, invoiceNumber: 'DEIC0233844',
      issueDate: '2026-07-28', taxDate: '2026-07-28', dueDate: '2026-08-26',
      currency: 'EUR', lineItems: [],
      vatBreakdown: [{ vatRate: '10', base: '535.00', vat: '0.00' }],
      totalWithoutVat: '535.00', totalVat: '0.00', totalAmount: '535.00',
      fieldConfidence: {}, evidence: {}, warnings: [],
    }, 'doc-cma', '2026-07-28');
    expect((normalized.extracted as any).rozpisDph).toEqual([{ sadzba: 0, zaklad: 535, dph: 0 }]);
    expect(validateNormalizedExtraction(normalized, { ico: '35761571' })).toEqual([]);
  });
});
