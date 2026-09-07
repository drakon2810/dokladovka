import { describe, expect, it, vi } from 'vitest';

// Analýza čítala prázdny korpus histórie a padala na 409 „primálo riadkov",
// hoci pamäť mala stovky rozhodnutí — sú to dve tabuľky. Krok 5 preto najprv
// preklopí pamäť a až potom analyzuje; nula kategórií nesmie prejsť ako hotovo.
const backfill = vi.fn(async () => ({ imported: 549 }));
const analyze = vi.fn(async () => ({ kategorii: 12, textov: 0, davok: 1, pokrytieRiadkov: 0 }));

vi.mock('../../data/api', () => ({
  backfillUctoHistory: (...args: unknown[]) => backfill(...(args as [])),
  analyzeUctoProfil: (...args: unknown[]) => analyze(...(args as [])),
}));
vi.mock('../../data/mostik/mostikService', () => ({
  requestMostikTrainingSync: vi.fn(),
  requestMostikCodeListSync: vi.fn(),
}));

const { KROKY, stavKrokov } = await import('./PripravaFirmyModal');

const organizacia = { id: 'org-1', nazov: 'Firma', emailAlias: 'a@b.sk' } as never;
const priprava = { organizationId: 'org-1', mostik: true, ciselniky: 40, pamat: 549, kategorie: 0, schranka: true };

describe('príprava firmy', () => {
  it('analýza najprv preklopí pamäť do histórie', async () => {
    const analyza = KROKY.find((krok) => krok.cislo === 5)!;
    await analyza.spustit!('org-1');
    expect(backfill).toHaveBeenCalledWith('org-1');
    expect(backfill.mock.invocationCallOrder[0]).toBeLessThan(analyze.mock.invocationCallOrder[0]);
  });

  // Analýza beží vo workeri, takže spustit() sa vráti hneď a o výsledku nevie
  // nič. Že nula kategórií neprejde ako hotovo, drží odteraz „splneny": krok
  // dobieha, kým sa kategórie naozaj neobjavia — rovnako ako mostík nad ním.
  it('nula kategórií nie je hotovo ani po spustení', async () => {
    const analyza = KROKY.find((krok) => krok.cislo === 5)!;
    await analyza.spustit!('org-1');
    expect(analyza.beziKymNeHotovy).toBe(true);
    expect(analyza.splneny({ ...priprava, kategorie: 0 }, organizacia)).toBe(false);
    expect(analyza.splneny({ ...priprava, kategorie: 12 }, organizacia)).toBe(true);
  });

  it('krok 5 čaká na číselníky aj pamäť', () => {
    const stavy = stavKrokov({ ...priprava, mostik: false, ciselniky: 0, pamat: 0 }, organizacia);
    expect(stavy).toEqual(['hotovy', 'naRade', 'zamknuty', 'zamknuty', 'zamknuty']);
  });

  it('s hotovou pamäťou je analýza na rade', () => {
    expect(stavKrokov(priprava, organizacia)[4]).toBe('naRade');
  });

  it('číselníky si účtovník neklikáva — agent ich ťahá sám', () => {
    const ciselniky = KROKY.find((krok) => krok.cislo === 3)!;
    expect(ciselniky.automaticky).toBe(true);
    expect(ciselniky.cesta).toBeUndefined();
    expect(ciselniky.spustit).toBeTypeOf('function');
  });

  it('automatický je práve jeden krok — inak by sa spúšťali cez seba', () => {
    expect(KROKY.filter((krok) => krok.automaticky)).toHaveLength(1);
  });
});
