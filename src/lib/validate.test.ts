import { describe, expect, it } from 'vitest';
import { jeZaokruhlenie } from './validate';

describe('jeZaokruhlenie', () => {
  it('centy sú zaokrúhlenie, zľava z celkovej sumy nie', () => {
    expect(jeZaokruhlenie(-0.02)).toBe(true);
    // Hotovosť sa zaokrúhľuje na 5 centov.
    expect(jeZaokruhlenie(0.05)).toBe(true);
    // ROFA AF260391: 12 % zľava z celkovej sumy, ktorú model nepreniesol do položiek.
    expect(jeZaokruhlenie(-1169.67)).toBe(false);
    expect(jeZaokruhlenie(-0.06)).toBe(false);
  });

  it('korunové meny zaokrúhľujú na jednotku', () => {
    expect(jeZaokruhlenie(-0.4, 'CZK')).toBe(true);
    expect(jeZaokruhlenie(1, 'czk')).toBe(true);
    expect(jeZaokruhlenie(-1.5, 'CZK')).toBe(false);
  });
});
