import { describe, expect, it } from 'vitest';
import { isForeignSupplier } from './documentValidation';

describe('isForeignSupplier', () => {
  it('rozpozná zahraničného dodávateľa podľa IČ DPH / DIČ (krajina ≠ SK)', () => {
    expect(isForeignSupplier({ dic: 'ATU61252600' })).toBe(true); // rakúsky
    expect(isForeignSupplier({ icDph: 'DE811193231' })).toBe(true); // nemecký
    expect(isForeignSupplier({ ico: 'FN 253283h', dic: 'ATU61252600' })).toBe(true);
  });

  it('slovenský dodávateľ nie je zahraničný', () => {
    expect(isForeignSupplier({ ico: '35705671', dic: '2020249275', icDph: 'SK2020249275' })).toBe(false);
    expect(isForeignSupplier({})).toBe(false);
    expect(isForeignSupplier({ dic: '2020249275' })).toBe(false); // len číslice = SK formát
  });

  it('nezmyselná hodnota (invalid VAT) neurobí dodávateľa zahraničným', () => {
    expect(isForeignSupplier({ dic: 'XX' })).toBe(false);
  });
});
