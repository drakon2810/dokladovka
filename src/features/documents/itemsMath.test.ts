// Peňažná matematika položiek dokladu. Chyba tu neurobí zle vykreslenú
// obrazovku — pošle do POHODY nesprávne zaúčtovanú DPH, preto sú tu aj prípady,
// ktoré účtovník bežne nevidí (položka bez sadzby, bločok len so sumou s DPH).
import { describe, expect, it } from 'vitest';
import type { DocumentLineItem } from '../../data/types';
import { recalcItem, rozpisZPoloziek } from './ItemsSection';

const item = (patch: Partial<DocumentLineItem>): DocumentLineItem => ({ id: 'i1', popis: 'Položka', ...patch });

describe('recalcItem', () => {
  it('zo sumy s DPH odvodí základ, daň aj jednotkovú cenu', () => {
    const next = recalcItem(item({ sadzbaDph: 23, mnozstvo: 2, sumaSpolu: 135.3 }), 'sumaSpolu');
    expect(next.sumaBezDph).toBe(110);
    expect(next.sumaDph).toBe(25.3);
    // Bez prepočtu jednotkovej ceny by validácia riadok označila za nekonzistentný.
    expect(next.jednotkovaCenaBezDph).toBe(55);
  });

  it('zmena základu dopočíta daň, sumu spolu aj jednotkovú cenu', () => {
    const next = recalcItem(item({ sadzbaDph: 23, mnozstvo: 4, sumaBezDph: 100 }), 'sumaBezDph');
    expect(next).toMatchObject({ sumaDph: 23, sumaSpolu: 123, jednotkovaCenaBezDph: 25 });
  });

  it('bez zadanej sadzby nechá daň tak, ako ju zadal účtovník', () => {
    const next = recalcItem(item({ sumaBezDph: 100, sumaDph: 7 }), 'sumaBezDph');
    expect(next.sumaDph).toBe(7);
    expect(next.sumaSpolu).toBe(107);
    // A z celkovej sumy sa bez sadzby základ neodvodzuje.
    expect(recalcItem(item({ sumaSpolu: 50, sumaBezDph: 40, sumaDph: 10 }), 'sumaSpolu').sumaBezDph).toBe(40);
  });

  it('vymazanie základu vyprázdni aj odvodené sumy', () => {
    const next = recalcItem(item({ sadzbaDph: 23, sumaBezDph: undefined, sumaDph: 25.3, sumaSpolu: 135.3 }), 'sumaBezDph');
    expect(next.sumaDph).toBeUndefined();
    expect(next.sumaSpolu).toBeUndefined();
  });

  it('záporná položka (zľava) ostáva záporná', () => {
    const next = recalcItem(item({ sadzbaDph: 23, sumaBezDph: -3 }), 'sumaBezDph');
    expect(next).toMatchObject({ sumaDph: -0.69, sumaSpolu: -3.69 });
  });
});

describe('rozpisZPoloziek', () => {
  it('zoskupí položky po sadzbách zostupne', () => {
    expect(rozpisZPoloziek([
      item({ sadzbaDph: 23, sumaBezDph: 110, sumaDph: 25.3 }),
      item({ id: 'i2', sadzbaDph: 23, sumaBezDph: -3, sumaDph: -0.69 }),
      item({ id: 'i3', sadzbaDph: 5, sumaBezDph: 20, sumaDph: 1 }),
    ])).toEqual([
      { sadzba: 23, zaklad: 107, dph: 24.61 },
      { sadzba: 5, zaklad: 20, dph: 1 },
    ]);
  });

  it('položke, ktorá nesie len sumu s DPH, dopočíta základ zo sadzby', () => {
    // Bločky z AI často nemajú rozpad na základ a daň — bez dopočtu by rozpis
    // vyšiel nulový a doklad by sa nedal schváliť.
    expect(rozpisZPoloziek([item({ sadzbaDph: 23, sumaSpolu: 123 })]))
      .toEqual([{ sadzba: 23, zaklad: 100, dph: 23 }]);
  });

  it('položka bez akejkoľvek sumy rozpis nerozbije', () => {
    expect(rozpisZPoloziek([item({ sadzbaDph: 23 })])).toEqual([{ sadzba: 23, zaklad: 0, dph: 0 }]);
  });

  it('položke bez sadzby dopočíta sadzbu zo základu a dane', () => {
    // AI vráti sumu dane, sadzbu nie. Bez dopočtu by riadok skončil ako
    // „0 % so sumou dane" — nemožný rozpis, ktorý blokuje schválenie.
    expect(rozpisZPoloziek([
      item({ sadzbaDph: 23, sumaBezDph: 100, sumaDph: 23 }),
      item({ id: 'i2', sumaBezDph: 50, sumaDph: 11.5 }),
    ])).toEqual([{ sadzba: 23, zaklad: 150, dph: 34.5 }]);
  });

  it('položka bez sadzby aj bez dane ostáva v nulovej sadzbe', () => {
    expect(rozpisZPoloziek([item({ sumaBezDph: 40, sumaDph: 0 })]))
      .toEqual([{ sadzba: 0, zaklad: 40, dph: 0 }]);
  });
});

describe('rozpisZPoloziek — zhoda s faktúrou dodávateľa', () => {
  // Reálna faktúra Magic Print (11 položiek, 23 %). Dodávateľ tlačí základ
  // 241,82 a daň 55,62. Delenie sumy s DPH po riadkoch dávalo 241,82/55,61,
  // po sčítaní bez zaokrúhľovania zase 241,81/55,62 — ani jedno nesedelo
  // s papierom, a rozpis DPH ide do kontrolného výkazu.
  const faktura: Array<[number, number]> = [
    [5, 3.95], [1, 5.49], [1, 2.84], [2, 22], [20, 1.19], [10, 0.4],
    [3, 0.72], [3, 4.3], [3, 1.86], [2, 2.43], [2, 58.22],
  ];

  it('základ počíta z ceny × množstva, presne ako dodávateľ', () => {
    const polozky = faktura.map(([mnozstvo, cena], index) => item({
      id: `i${index}`, sadzbaDph: 23, mnozstvo, jednotkovaCenaBezDph: cena,
    }));
    const rozpis = rozpisZPoloziek(polozky);
    expect(rozpis).toEqual([{ sadzba: 23, zaklad: 241.82, dph: 55.62 }]);
  });

  it('bez jednotkovej ceny sa základ odvodí zo sumy s DPH', () => {
    const rozpis = rozpisZPoloziek([item({ sadzbaDph: 23, sumaSpolu: 123 })]);
    expect(rozpis).toEqual([{ sadzba: 23, zaklad: 100, dph: 23 }]);
  });
});
