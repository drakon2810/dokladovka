import { describe, expect, it } from 'vitest';
import { jeUpozornenie, validateDocument } from './documentValidation';

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
