import { describe, expect, it } from 'vitest';
import { POHODA_DPH_KODY, kodyPreDoklad, popisKodu } from './pohodaDphKody.js';

// Tabuľka je jediné miesto, kde je zapísané, čo kód naozaj spraví. Testy držia
// práve tie riadky, na ktorých sa kontrola pomýlila — a pomýlila sa preto, že
// videla len názov.

describe('popisKodu', () => {
  // Toto je celý prípad Moldavska v jednom riadku: názov sľubuje „miesto
  // plnenia v zahraničí", ale kód zapisuje sumu do riadku 13 priznania.
  it('UDzahr zapisuje do riadku 13, UN nikam', () => {
    expect(popisKodu('UDzahr')).toMatchObject({ strana: 'U', riadky: ['13'], sv: null });
    expect(popisKodu('UN')).toMatchObject({ strana: 'U', riadky: [], sv: null });
  });

  // Dva kódy s doslova rovnakým názvom a iným správaním — bez tabuľky sa
  // nedali odlíšiť. UDzahrSl je ten pre služby do EÚ, so súhrnným výkazom.
  it('rovnaký názov, iné správanie', () => {
    expect(popisKodu('UDzahr')?.nazov).toBe(popisKodu('UDzahrSl')?.nazov);
    expect(popisKodu('UDzahrSl')).toMatchObject({ riadky: [], sv: '2' });
  });

  it('vymeranie dane stojí na strane DD, odpočet na strane P', () => {
    expect(popisKodu('DDsl§69')).toMatchObject({ strana: 'DD', riadky: ['09', '10'] });
    expect(popisKodu('PDsluz')).toMatchObject({ strana: 'P', riadky: ['18', '18a', '19'] });
    expect(popisKodu('PN')).toMatchObject({ strana: 'P', riadky: [] });
  });

  it('kód mimo referenčného zoznamu nemá popis', () => {
    expect(popisKodu('VYMYSLENY')).toBeUndefined();
    expect(popisKodu(undefined)).toBeUndefined();
    expect(popisKodu('')).toBeUndefined();
  });

  it('zoznam nesie skutočné kódy POHODY a každý má stranu', () => {
    expect(POHODA_DPH_KODY.length).toBeGreaterThan(60);
    for (const polozka of POHODA_DPH_KODY) {
      expect(['U', 'P', 'DD']).toContain(polozka.strana);
      expect(polozka.kod).not.toBe('');
    }
  });
});

describe('kodyPreDoklad', () => {
  // Číselník RCI v malom: obe strany plus vymeranie dane.
  const ciselnik = ['PN', 'PNnevymer', 'PD', 'PDsluz', 'PKsluz', 'DDsl§69', 'UN', 'UDzahr', 'UDzahrSl', 'VLASTNY'];

  // Presne tento filter chýbal, keď kontrola prijatej faktúre od moldavského
  // dopravcu ponúkla DDsl§69 — vymeranie dane patrí na interný doklad.
  it('prijatá faktúra nevidí vydanú stranu ani vymeranie dane', () => {
    const kody = kodyPreDoklad('FP', ciselnik);
    expect(kody).toEqual(['PN', 'PD', 'PDsluz']);
  });

  it('vydaná faktúra nevidí prijatú stranu ani vymeranie dane', () => {
    const kody = kodyPreDoklad('FV', ciselnik);
    expect(kody).toEqual(['UN', 'UDzahr', 'UDzahrSl']);
  });


  // POHODA má na prijatej strane tridsaťjeden kódov a ponúka z nich dvanásť.
  // Zvyšok sú režimy, ktoré firma nepoužíva — model medzi nimi predtým
  // vyberal ako medzi rovnocennými a raz siahol práve po PNnevymer.
  it('kód, ktorý POHODA neponúka, sa modelu vôbec nedostane', () => {
    const kody = kodyPreDoklad('FP', ciselnik);
    expect(kody).not.toContain('PNnevymer');
    expect(kody).not.toContain('PKsluz');
    expect(kody).toContain('PN');
  });

  it('ponúkaných kódov prijatej strany je výrazne menej než všetkých', () => {
    const vsetky = POHODA_DPH_KODY.filter((polozka) => polozka.strana === 'P');
    const ponukane = vsetky.filter((polozka) => polozka.ponukat !== false);
    expect(ponukane.length).toBeLessThan(vsetky.length / 2);
  });
  // Vlastný kód firmy nevieme posúdiť, tak ho neponúkame ani na jednej strane.
  it('kód mimo zoznamu vypadne z oboch strán', () => {
    expect(kodyPreDoklad('FP', ciselnik)).not.toContain('VLASTNY');
    expect(kodyPreDoklad('FV', ciselnik)).not.toContain('VLASTNY');
  });

  // Interný doklad a pokladnica stoja na oboch stranách — nefiltrujeme.
  it('ostatné agendy dostanú celý číselník', () => {
    expect(kodyPreDoklad('INT', ciselnik)).toEqual(ciselnik);
  });
});
