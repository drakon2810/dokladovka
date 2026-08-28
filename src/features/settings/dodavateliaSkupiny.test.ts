import { describe, expect, it } from 'vitest';

// Skupiny podľa frekvencie (maketa „Nastavenia 1c"). Hranice musia zoznam
// rozdeliť BEZ diery a bez prekryvu — inak by dodávateľ s presne 10 alebo 30
// dokladmi buď zmizol, alebo sa ukázal dvakrát.
const patri = {
  caste: (pocet: number) => pocet >= 30,
  obcasne: (pocet: number) => pocet >= 10 && pocet < 30,
  zriedkave: (pocet: number) => pocet < 10,
};

describe('skupiny dodávateľov', () => {
  it('každý počet padne práve do jednej skupiny', () => {
    for (const pocet of [0, 1, 9, 10, 11, 29, 30, 31, 549]) {
      const kolko = Object.values(patri).filter((test) => test(pocet)).length;
      expect(`${pocet}: ${kolko}`).toBe(`${pocet}: 1`);
    }
  });

  it('hranice sedia s popiskami', () => {
    expect(patri.caste(30)).toBe(true);      // „30 a viac"
    expect(patri.obcasne(29)).toBe(true);    // „10 – 29"
    expect(patri.obcasne(10)).toBe(true);
    expect(patri.zriedkave(9)).toBe(true);   // „menej ako 10"
  });
});
