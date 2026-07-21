import { describe, expect, it } from 'vitest';
import { parseTrainingRows } from './treningImport';

const kody = {
  predkontacie: new Set(['518/321', '501/321']),
  cleneniaDph: new Set(['19Ušt', 'PN']),
  ciselneRady: new Set(['PF']),
  strediska: new Set(['VOZIDLO']),
};

describe('parseTrainingRows', () => {
  it('mapuje slovenské hlavičky (s diakritikou aj bez) a validuje kódy', () => {
    const rows = parseTrainingRows([
      {
        'IČO': 35763469, 'Dodávateľ': 'Slovak Telekom', 'Text': 'Mesačný poplatok',
        'Predkontácia': '518/321', 'Členenie DPH': '19Ušt', 'Členenie KV': 'B2', 'Číselný rad': 'PF',
      },
      { ico: '12345678', nazov: 'Slovnaft', popis: 'Nafta', predkontacia: '501/321', 'clenenie dph': 'PN', stredisko: 'VOZIDLO' },
      { 'Dodávateľ': 'Neznámy kód', 'Predkontácia': '999' },
      { 'Text': 'bez dodávateľa', 'Predkontácia': '518/321' },
      { 'Dodávateľ': 'Zlé KV', 'Predkontácia': '518/321', 'KV': 'X9' },
      { '': '', 'Suma': '' },
    ], kody);

    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({
      supplierIco: '35763469', supplierName: 'Slovak Telekom', lineText: 'Mesačný poplatok',
      predkontaciaKod: '518/321', clenenieDphKod: '19Ušt', clenenieKvKod: 'B2', ciselnyRadKod: 'PF',
    });
    expect(rows[0].chyba).toBeUndefined();
    expect(rows[1]).toMatchObject({ supplierName: 'Slovnaft', strediskoKod: 'VOZIDLO' });
    expect(rows[1].chyba).toBeUndefined();
    expect(rows[2].chyba).toContain('999');
    expect(rows[3].chyba).toContain('dodávateľ');
    expect(rows[4].chyba).toContain('X9');
  });

  it('rozumie stĺpcom priameho exportu agendy z POHODY (Firma, ČlDPH, ČlKV DPH)', () => {
    const rows = parseTrainingRows([
      {
        'X': false, 'Číslo': '2025039', 'Doklad': '250135700064', 'Dátum': 45688,
        'Predkontácia': '501/321', 'ČlDPH': 'PN', 'Obdobie DPH': '', 'ČlKV DPH': 'KN',
        'Firma': 'CMA - CGM', 'Celkom': 900, 'Text': 'transport', 'IČ DPH': 'FR72562024422',
        'Poznámka': 'DPH vymerané.', 'Vytvorené': 45980.5,
      },
    ], kody);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      supplierName: 'CMA - CGM', lineText: 'transport',
      predkontaciaKod: '501/321', clenenieDphKod: 'PN', clenenieKvKod: 'KN',
    });
    expect(rows[0].supplierIco).toBeUndefined();
    expect(rows[0].chyba).toBeUndefined();
  });
});
