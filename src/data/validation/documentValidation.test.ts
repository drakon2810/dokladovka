import { describe, expect, it } from 'vitest';
import { isForeignSupplier, validateDocument } from './documentValidation';
import { validateDic } from '../../lib/validate';
import type { DocumentItem, Organization } from '../types';

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

// Klientská validácia musí pustiť to, čo pustí server (validDic v
// server/extraction/normalize.ts). Keď sa rozídu, tlačidlo „Schváliť" zhasne
// s generickým tooltipom a účtovník nemá ako zistiť, ktoré pole prekáža.
describe('validateDic — zhoda so serverom', () => {
  it('prijme holé slovenské DIČ aj tvar s prefixom SK', () => {
    expect(validateDic('2020254170')).toBe(true);
    expect(validateDic('SK2020254170')).toBe(true);
  });

  it('prijme zahraničné IČ DPH skopírované do poľa DIČ', () => {
    expect(validateDic('ATU61252600')).toBe(true);
    expect(validateDic('DE813960018')).toBe(true);
    expect(validateDic('CZ12345678')).toBe(true);
  });

  it('odmietne skutočný nezmysel', () => {
    expect(validateDic('abc')).toBe(false);
    expect(validateDic('123')).toBe(false);
    expect(validateDic('SK123')).toBe(false);
  });
});

const organization = { id: 'org-1', tenantId: 't-1', ico: '35761571' } as Organization;

function prijataFaktura(extracted: Record<string, unknown>): DocumentItem {
  return {
    id: 'doc-1',
    tenantId: 't-1',
    orgId: 'org-1',
    typ: 'FP',
    processingStatus: 'ready_for_review',
    extracted: {
      dodavatel: { nazov: 'GESCHWANDTNER GmbH', dic: 'ATU61252600' },
      cisloFaktury: '06-2026-00355',
      datumVystavenia: '2026-07-09',
      datumDodania: '2026-07-09',
      datumSplatnosti: '2026-07-09',
      mena: 'EUR',
      rozpisDph: [{ sadzba: 0, zaklad: 210, dph: 0 }],
      sumaSpolu: 210,
      ...extracted,
    },
  } as unknown as DocumentItem;
}

describe('validateDocument — DIČ s prefixom neblokuje schválenie', () => {
  it('DIČ odberateľa v tvare SK… neblokuje prijatú faktúru', () => {
    expect(validateDocument(
      prijataFaktura({ odberatel: { nazov: 'AGS Bratislava', dic: 'SK2020254170' } }),
      organization,
    )).toEqual([]);
  });

  it('zahraničné DIČ dodávateľa neblokuje', () => {
    expect(validateDocument(prijataFaktura({}), organization)).toEqual([]);
  });

  it('naozaj pokazené DIČ ostáva chybou', () => {
    expect(validateDocument(
      prijataFaktura({ odberatel: { nazov: 'AGS Bratislava', dic: 'xx' } }),
      organization,
    )).toContainEqual({ code: 'invalid_dic', field: 'odberatel.dic' });
  });
});

// Mzdy nemajú DPH: doklad bez rozpisu je bežný a POHODA dá celú sumu do
// priceNone. Porovnanie prázdneho rozpisu s celkovou sumou preto blokovalo
// schválenie mzdového dokladu, hoci mu nič nechýbalo.
describe('validateDocument — mzdy bez rozpisu DPH', () => {
  function mzdy(extracted: Record<string, unknown>): DocumentItem {
    return {
      ...prijataFaktura({}),
      typ: 'MZDY',
      extracted: {
        dodavatel: { nazov: 'AGS BRATISLAVA INTERN.MOVERS' },
        cisloFaktury: '',
        datumVystavenia: '2026-03-31',
        datumDodania: '2026-03-31',
        datumSplatnosti: '2026-03-31',
        mena: 'EUR',
        rozpisDph: [],
        sumaSpolu: 206.54,
        ...extracted,
      },
    } as unknown as DocumentItem;
  }

  it('prázdny rozpis pri mzdách schválenie neblokuje', () => {
    expect(validateDocument(mzdy({}), organization)).toEqual([]);
  });

  it('vyplnený rozpis sa pri mzdách kontroluje ďalej', () => {
    expect(validateDocument(mzdy({ rozpisDph: [{ sadzba: 0, zaklad: 100, dph: 0 }] }), organization))
      .toContainEqual({ code: 'total_mismatch', field: 'sumaSpolu' });
  });

  it('prijatej faktúre prázdny rozpis naďalej chýba', () => {
    const issues = validateDocument(prijataFaktura({ rozpisDph: [] }), organization);
    expect(issues).toContainEqual({ code: 'vat_breakdown_required', field: 'rozpisDph' });
    expect(issues).toContainEqual({ code: 'total_mismatch', field: 'sumaSpolu' });
  });
});

// Reálny prípad: AI prečítala IBAN vlastnej firmy o dve nuly dlhší. Na VYDANEJ
// faktúre je to slepá ulička — IBAN dodávateľa sa do POHODY neposiela a editor
// vydanej faktúry pole ani nezobrazuje, takže sa nedalo opraviť ani schváliť.
describe('validateDocument — pokazený IBAN vlastnej firmy na vydanej faktúre', () => {
  const zlyIban = 'SK313100000000004040272818';

  it('vydanú faktúru neblokuje', () => {
    const doklad = { ...prijataFaktura({ dodavatel: { nazov: 'AGS Bratislava', ico: '35761571', iban: zlyIban } }), typ: 'FV' } as DocumentItem;
    doklad.extracted.odberatel = { nazov: 'KACZYNSKA Sarah' };
    expect(validateDocument(doklad, organization)).toEqual([]);
  });

  it('na prijatej faktúre ostáva chybou — tam sa z IBAN-u platí', () => {
    expect(validateDocument(
      prijataFaktura({ dodavatel: { nazov: 'Dodávateľ', iban: zlyIban } }),
      organization,
    )).toContainEqual({ code: 'invalid_iban', field: 'dodavatel.iban' });
  });
});

// Reálny prípad: americký zákazník na vydanej faktúre má „Client VAT No."
// 2973456 — bez kódu krajiny, takže slovenský formát DIČ ho vyhlásil za chybu
// a faktúra sa nedala schváliť. Krajinu pritom poznáme z adresy.
describe('validateDocument — zahraničný zákazník bez slovenského DIČ', () => {
  const zahranicny = (extra: Record<string, unknown>) => ({
    ...prijataFaktura({
      dodavatel: { nazov: 'AGS Bratislava', ico: '35761571' },
      odberatel: { nazov: 'RAINIER', dic: '2973456', ...extra },
    }),
    typ: 'FV',
  } as DocumentItem);

  it('krajina z adresy zbaví zákazníka slovenských formátových kontrol', () => {
    expect(validateDocument(
      zahranicny({ adresa: '9425, 35th Avenue Northeast, Seattle, 98115, Washington, United States' }),
      organization,
    )).toEqual([]);
  });

  it('slovenský zákazník s pokazeným DIČ ostáva chybou', () => {
    expect(validateDocument(
      zahranicny({ adresa: 'Hlavná 1, 811 07 Bratislava, Slovakia' }),
      organization,
    )).toContainEqual({ code: 'invalid_dic', field: 'odberatel.dic' });
  });
});
