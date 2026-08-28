// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { oznacPrecitane, oznacPrecitany, poslednaNavsteva, zapisNavstevu } from './precitane';

// „Nový" = prišiel po poslednej návšteve a účtovník ho ešte neotvoril. Obe
// polovice musia platiť naraz, inak pás klame — a pri prvom otvorení, keď
// niet voči čomu porovnávať, nesmie byť nový nikto.
const jeNovy = (prijateDna: string, id: string, odNavstevy: string, precitane: ReadonlySet<string>) =>
  odNavstevy !== '' && !precitane.has(id) && prijateDna > odNavstevy;

describe('nové doklady', () => {
  beforeEach(() => localStorage.clear());

  it('pri prvej návšteve nie je nový nikto', () => {
    expect(poslednaNavsteva()).toBe('');
    expect(jeNovy('2026-08-28T10:00:00.000Z', 'a', poslednaNavsteva(), new Set())).toBe(false);
  });

  it('po návšteve je nový len ten, čo prišiel neskôr a nebol otvorený', () => {
    zapisNavstevu();
    const od = poslednaNavsteva();
    expect(od).not.toBe('');
    expect(jeNovy('2020-01-01T00:00:00.000Z', 'stary', od, new Set())).toBe(false);
    expect(jeNovy('2099-01-01T00:00:00.000Z', 'novy', od, new Set())).toBe(true);
    oznacPrecitany('novy');
    expect(jeNovy('2099-01-01T00:00:00.000Z', 'novy', od, new Set(['novy']))).toBe(false);
  });

  it('prečítané prežijú reload — sú v localStorage', () => {
    oznacPrecitane(['a', 'b']);
    // Store je modulový, takže tu môžu byť aj id z predchádzajúceho testu;
    // podstatné je, že zápis do localStorage naozaj prebehol.
    expect(JSON.parse(localStorage.getItem('dokladovka.precitaneDoklady')!)).toEqual(expect.arrayContaining(['a', 'b']));
  });
});
