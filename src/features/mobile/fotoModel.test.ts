import { describe, expect, it } from 'vitest';
import { MAX_HRANA, doklady, iniciality, rozmerPoZmenseni, strany } from './fotoModel';

// Skloňovanie po číslovke drží celú obrazovku: „1 strana", „3 strany",
// „5 strán". Zlé tvary sú prvé, čoho si účtovník na doklade všimne.
describe('slovenské tvary po číslovke', () => {
  it('strany', () => {
    expect([1, 2, 4, 5, 11].map(strany)).toEqual(['strana', 'strany', 'strany', 'strán', 'strán']);
  });

  it('doklady', () => {
    expect([1, 2, 4, 5, 10].map(doklady)).toEqual(['doklad', 'doklady', 'doklady', 'dokladov', 'dokladov']);
  });
});

// Snímka z telefónu má 12 Mpx aj viac. Bez zmenšenia base64 nafúkne o tretinu
// a dávka prekročí limit požiadavky; s prílišným zmenšením zas AI neprečíta
// drobné písmo na bločku.
describe('zmenšenie snímky', () => {
  it('dlhšiu stranu stiahne na strop a pomer zachová', () => {
    expect(rozmerPoZmenseni(4032, 3024)).toEqual({ sirka: MAX_HRANA, vyska: 1500 });
    expect(rozmerPoZmenseni(3024, 4032)).toEqual({ sirka: 1500, vyska: MAX_HRANA });
  });

  it('menšiu snímku nezväčšuje — dorobené pixely nič nepridajú', () => {
    expect(rozmerPoZmenseni(800, 600)).toEqual({ sirka: 800, vyska: 600 });
  });
});

// Dlaždica v zozname firiem. Názvy majú právne formy („s.r.o.", „a.s."),
// ktoré do iniciálok nepatria — inak by z „Alfa Trade s.r.o." vyšlo „AT"
// len náhodou a z „Tatra Bau s. r. o." zas „TB" alebo „TS" podľa medzier.
describe('iniciálky firmy', () => {
  it('berie prvé dve slová názvu', () => {
    expect(iniciality('Alfa Trade s.r.o.')).toBe('AT');
    expect(iniciality('Tatra Bau s. r. o.')).toBe('TB');
    expect(iniciality('Recable, s.r.o.')).toBe('R');
    expect(iniciality('AGS Bratislava International Movers, s.r.o.')).toBe('AB');
  });

  it('jednoslovný názov dá jedno písmeno', () => {
    expect(iniciality('Dokladovka')).toBe('D');
  });
});
