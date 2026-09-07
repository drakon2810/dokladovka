import { describe, expect, it } from 'vitest';
import { jeUpozornenie, validateDocument } from './documentValidation';
import { round2 } from '../../lib/validate';

/** Doklad, ktorý je v poriadku okrem jedného poľa. */
const doklad = (iban: string) => ({
  typ: 'FP',
  extracted: {
    cisloFaktury: 'FA-1',
    dodavatel: { nazov: 'Dodávateľ s.r.o.', ico: '12345678', iban },
    odberatel: { nazov: 'Odberateľ s.r.o.' },
    datumVystavenia: '2026-08-01',
    datumDanovejPovinnosti: '2026-08-01',
    datumSplatnosti: '2026-08-15',
    mena: 'EUR',
    sumaSpolu: 122.47,
    rozpisDph: [{ sadzba: 23, zaklad: 99.57, dan: 22.9, spolu: 122.47 }],
    polozky: [],
  },
  processingStatus: 'ready_for_review',
}) as never;

describe('chybný IBAN je upozornenie, nie prekážka', () => {
  it('nájde sa, ale neblokuje', () => {
    const nalezy = validateDocument(doklad('SK9999999999999999999999'), undefined);
    const iban = nalezy.find((n) => n.code === 'invalid_iban');
    // Preklep v čísle účtu nemá vplyv na zaúčtovanie ani na daň — blokovať
    // kvôli nemu inak správnu faktúru znamenalo, že sa nedala schváliť vôbec.
    expect(iban).toBeDefined();
    expect(jeUpozornenie('invalid_iban')).toBe(true);
  });

  it('správny IBAN nehlási nič', () => {
    expect(validateDocument(doklad('SK3509000000000179562184'), undefined)
      .some((n) => n.code === 'invalid_iban')).toBe(false);
  });

  it('ostatné nálezy zostávajú blokujúce', () => {
    for (const code of ['invalid_ico', 'total_mismatch', 'invoice_number_required'] as const) {
      expect(jeUpozornenie(code)).toBe(false);
    }
  });
});

// Ostrý prípad PACCAR 26002838: desať splátok vozidiel, každá 1 391,19 + 23 %.
// 1 391,19 × 0,23 = 319,9737, dodávateľ účtuje 319,97 — desaťkrát to dá
// 3 199,70, kým sadzba zo súčtu základov dá 3 199,74. Faktúra je správna,
// rozdiel štyri centy z riadkového zaokrúhľovania, a doklad sa pri pevnej
// dvojcentovej tolerancii nedal schváliť.
describe('riadkové zaokrúhľovanie dane neblokuje schválenie', () => {
  const paccar = (dph: number) => ({
    typ: 'FP',
    extracted: {
      cisloFaktury: '26002838',
      dodavatel: { nazov: 'PACCAR Financial', ico: '12345678' },
      odberatel: { nazov: 'ALPINA EST s.r.o.' },
      datumVystavenia: '2026-09-01',
      datumDanovejPovinnosti: '2026-09-01',
      datumSplatnosti: '2026-09-15',
      mena: 'EUR',
      sumaSpolu: 17_111.60,
      rozpisDph: [{ sadzba: 23, zaklad: 13_911.90, dph, spolu: round2(13_911.90 + dph) }],
      polozky: Array.from({ length: 10 }, (_, index) => ({
        id: `li-${index}`, popis: `Zmluva ${index}`,
        sadzbaDph: 23, sumaBezDph: 1_391.19, sumaDph: 319.97, sumaSpolu: 1_711.16,
      })),
    },
    processingStatus: 'ready_for_review',
  }) as never;

  it('štyri centy z desiatich riadkov prejdú', () => {
    expect(validateDocument(paccar(3_199.70), undefined)
      .some((n) => n.code === 'invalid_vat_row')).toBe(false);
  });

  it('skutočne zlá daň blokuje ďalej', () => {
    // Pol eura sa riadkovým zaokrúhľovaním desiatich položiek vysvetliť nedá.
    expect(validateDocument(paccar(3_150.00), undefined)
      .some((n) => n.code === 'invalid_vat_row')).toBe(true);
  });
});

/** Ten istý doklad, ale s IČ DPH odberateľa — teda NAŠEJ firmy. */
const sOdberatelom = (typ: string, icDph: string) => ({
  typ,
  extracted: {
    cisloFaktury: '001111',
    dodavatel: { nazov: 'FARESIN S.r.l.', icDph: 'IT02738070248' },
    odberatel: { nazov: 'ALPINA EST S.R.O.', icDph },
    datumVystavenia: '2026-08-31',
    datumDanovejPovinnosti: '2026-08-31',
    datumSplatnosti: '2026-10-31',
    mena: 'EUR',
    sumaSpolu: 15_615.64,
    rozpisDph: [{ sadzba: 0, zaklad: 15_615.64, dan: 0, spolu: 15_615.64 }],
    polozky: [],
  },
  processingStatus: 'ready_for_review',
}) as never;

describe('identifikátory odberateľa na prijatom doklade neblokujú', () => {
  // Ostrý prípad: talianska faktúra FARESIN tlačí „SK 2022145466", extrakcia
  // zdvojila poslednú číslicu na SK20221454666. Je to IČ DPH NAŠEJ firmy —
  // správnu hodnotu máme v profile, do POHODY z dokladu nejde a schválenie
  // blokovať nemá. Server to tak vyhodnocoval už dlhšie (buyerSeverity),
  // klient nie — a rozhodovalo to prísnejšie z dvojice.
  it('zle prečítané IČ DPH odberateľa je len upozornenie', () => {
    const nalezy = validateDocument(sOdberatelom('FP', 'SK20221454666'), undefined);
    const nalez = nalezy.find((n) => n.code === 'invalid_buyer_vat_id');
    expect(nalez?.field).toBe('odberatel.icDph');
    expect(jeUpozornenie('invalid_buyer_vat_id')).toBe(true);
  });

  it('na vydanej faktúre je odberateľ zákazník — tam blokuje ďalej', () => {
    const nalezy = validateDocument(sOdberatelom('FV', 'SK20221454666'), undefined);
    expect(nalezy.some((n) => n.code === 'invalid_ic_dph' && n.field === 'odberatel.icDph')).toBe(true);
    expect(nalezy.some((n) => n.code === 'invalid_buyer_vat_id')).toBe(false);
  });

  it('IČ DPH dodávateľa blokuje aj naďalej — to do priznania ide', () => {
    const nalezy = validateDocument(sOdberatelom('FP', 'SK2022145466'), undefined);
    expect(nalezy.some((n) => n.code === 'invalid_buyer_vat_id')).toBe(false);
    expect(jeUpozornenie('invalid_ic_dph')).toBe(false);
  });
});
