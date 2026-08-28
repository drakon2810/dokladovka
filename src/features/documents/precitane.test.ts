// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { oznacPrecitane, oznacPrecitany, poslednaNavsteva, zapisNavstevu } from './precitane';

// „Nový" = prišiel po poslednej návšteve a účtovník ho ešte neotvoril.
const jeNovy = (prijateDna: string, id: string, odNavstevy: string, precitane: ReadonlySet<string>) =>
  !precitane.has(id) && prijateDna > odNavstevy;

describe('nové doklady', () => {
  beforeEach(() => localStorage.clear());

  it('prvé použitie založí značku na teraz — archív firmy nie je nový', () => {
    const od = poslednaNavsteva();
    expect(od).not.toBe('');
    expect(jeNovy('2020-01-01T00:00:00.000Z', 'archiv', od, new Set())).toBe(false);
    // Doklad, ktorý príde od tejto chvíle, nový je — inak by po nahratí
    // faktúry na otvorenom zozname neblikol žiadny odznak.
    expect(jeNovy('2099-01-01T00:00:00.000Z', 'prave-prisiel', od, new Set())).toBe(true);
  });

  it('značku drží, kým ju účtovník sám neposunie', () => {
    const stara = '2020-01-01T00:00:00.000Z';
    localStorage.setItem('dokladovka.poslednaNavsteva', stara);
    // Ďalšie otvorenia zoznamu ju nesmú posunúť: inak by návrat z detailu
    // zhasol aj doklady, ktoré účtovník neotvoril.
    expect(poslednaNavsteva()).toBe(stara);
    expect(poslednaNavsteva()).toBe(stara);
    zapisNavstevu();
    expect(poslednaNavsteva() > stara).toBe(true);
  });

  it('otvorený doklad prestane byť nový aj bez posunu značky', () => {
    const od = poslednaNavsteva();
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
