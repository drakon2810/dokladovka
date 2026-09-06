import { describe, expect, it } from 'vitest';
import { navrhPreRiadky, rozrezPolozku } from './ItemsSection';
import type { CodeListItem, DocumentLineItem } from '../../data/types';
import { round2 } from '../../lib/validate';

// Rozdelený doklad sa zámerne nepredvyplňuje sám (istota ostáva pod 0,9), takže
// predloha v prázdnej bunke je JEDINÉ miesto, kde účtovník uvidí, že AI
// rozdelenie navrhla. Bez nej sa to dalo zistiť až kliknutím na „Použiť návrh"
// — a keď návrh nebol, neudialo sa nič a nedalo sa rozoznať od chyby.

const kod = (id: string, kodText: string): CodeListItem => ({
  id, kod: kodText, nazov: kodText,
} as CodeListItem);

const codeLists = {
  predkontacie: [kod('p-501', '501400'), kod('p-513', '513/321')],
  cleneniaDph: [kod('d-pd', 'PD'), kod('d-un', 'UNodp')],
};

const polozka = (popis: string, ucto?: DocumentLineItem['ucto']): DocumentLineItem =>
  ({ id: popis, popis, ucto } as DocumentLineItem);

describe('predloha návrhu v položkách', () => {
  it('ukáže kódy návrhu do prázdnych buniek', () => {
    const mapa = navrhPreRiadky(
      [{ index: 1, popis: 'Káva pre klientov', predkontaciaId: 'p-513', clenenieDphId: 'd-un' }],
      [polozka('Toner do tlačiarne'), polozka('Káva pre klientov')],
      codeLists,
    );
    expect(mapa).toEqual({ 1: { predkontacia: '513/321', clenenieDph: 'UNodp' } });
  });

  it('mlčí tam, kde účtovník už rozhodol — predloha neprekrýva rozhodnutie', () => {
    const mapa = navrhPreRiadky(
      [{ index: 0, popis: 'Káva', predkontaciaId: 'p-513', clenenieDphId: 'd-un' }],
      [polozka('Káva', { predkontaciaId: 'p-501', clenenieDphId: 'd-pd' })],
      codeLists,
    );
    expect(mapa).toEqual({ 0: { predkontacia: undefined, clenenieDph: undefined } });
  });

  it('vynechá riadok, ktorého položku účtovník medzitým prepísal', () => {
    const mapa = navrhPreRiadky(
      [{ index: 0, popis: 'Káva pre klientov', predkontaciaId: 'p-513' }],
      [polozka('Niečo úplne iné')],
      codeLists,
    );
    expect(mapa).toEqual({});
  });

  it('nevymyslí kód, ktorý v číselníku nie je', () => {
    const mapa = navrhPreRiadky(
      [{ index: 0, popis: 'Káva', predkontaciaId: 'zmazana-predkontacia' }],
      [polozka('Káva')],
      codeLists,
    );
    expect(mapa[0].predkontacia).toBeUndefined();
  });

  it('bez návrhu nevráti nič — bunka ostane na kóde z hlavičky', () => {
    expect(navrhPreRiadky(undefined, [polozka('Káva')], codeLists)).toEqual({});
  });
});

// Rozrezanie položky. Faktúra Up Déjeuner 4226039726 má jediný riadok
// „Natural 95" za 65,85 a v POHODE z neho účtovník robí dva: daňovú časť 80 %
// (52,68) a nedaňovú 20 % (13,17) na PHM-Nadspotreba s členením PN. Daň sa
// pritom delí POLOVICOU, nie v pomere základu — auto sa používa aj súkromne
// a odpočet je krátený (§ 49 ods. 5), takže 15,15 ide ako 7,58 a 7,57.
describe('rozrezanie položky na daňovú a nedaňovú časť', () => {
  const natural = {
    id: 'li-2', popis: 'Natural 95', mnozstvo: 45.79,
    sadzbaDph: 23, sumaBezDph: 65.85, sumaDph: 15.15, sumaSpolu: 81,
  } as DocumentLineItem;

  it('rozdelí základ 80/20 a daň 50/50 presne ako POHODA', () => {
    const casti = rozrezPolozku(natural, [
      { podiel: 0.8, podielDph: 0.5, predkontaciaId: 'p-501' },
      { podiel: 0.2, podielDph: 0.5, predkontaciaId: 'p-513', clenenieDphId: 'd-un', clenenieKvKod: 'KN' },
    ]);
    expect(casti.map((cast) => [cast.sumaBezDph, cast.sumaDph, cast.sumaSpolu])).toEqual([
      [52.68, 7.58, 60.26],
      [13.17, 7.57, 20.74],
    ]);
    // Súčet musí sedieť s pôvodnou položkou do haliera, inak sa doklad rozíde.
    expect(casti.reduce((spolu, cast) => spolu + (cast.sumaBezDph ?? 0), 0)).toBeCloseTo(65.85, 2);
    expect(casti.reduce((spolu, cast) => spolu + (cast.sumaDph ?? 0), 0)).toBeCloseTo(15.15, 2);
    // Množstvo 1 a jednotková cena = základ časti: validácia kontroluje ich súčin.
    expect(casti.map((cast) => [cast.mnozstvo, cast.jednotkovaCenaBezDph])).toEqual([[1, 52.68], [1, 13.17]]);
    expect(casti[1].ucto).toEqual({ predkontaciaId: 'p-513', clenenieDphId: 'd-un', clenenieKvKod: 'KN' });
  });

  // Faktúra 4226036911 (v POHODE DF260177) nesie jediné palivo a k nemu zľavu.
  // Účtovník ju rozrezal CELÚ: 59,99 − 0,44 = 59,55 a až to delil 80/20, takže
  // 501200 dostalo 47,64 a 501201 11,91. Keby zľava ostala celá vo vratnej
  // časti, vyšlo by 47,55 a 12,00 — o deväť halierov vedľa. Rez preto musí
  // prejsť aj cez zápornú položku.
  it('rozreže aj zľavu, takže súčty sedia s POHODOU do haliera', () => {
    const pomer = [
      { podiel: 0.8, podielDph: 0.5, predkontaciaId: 'p-501' },
      { podiel: 0.2, podielDph: 0.5, predkontaciaId: 'p-513', clenenieDphId: 'd-un' },
    ];
    const palivo = rozrezPolozku(
      { ...natural, sumaBezDph: 59.99, sumaDph: 13.8, sumaSpolu: 73.79 }, pomer,
    );
    const zlava = rozrezPolozku(
      { id: 'li-3', popis: 'Zľava PH', mnozstvo: 1, sadzbaDph: 23,
        sumaBezDph: -0.44, sumaDph: -0.1, sumaSpolu: -0.54 } as DocumentLineItem,
      pomer,
    );
    const naUcte = (index: number, pole: 'sumaBezDph' | 'sumaDph') =>
      round2((palivo[index][pole] ?? 0) + (zlava[index][pole] ?? 0));
    expect([naUcte(0, 'sumaBezDph'), naUcte(1, 'sumaBezDph')]).toEqual([47.64, 11.91]);
    expect([naUcte(0, 'sumaDph'), naUcte(1, 'sumaDph')]).toEqual([6.85, 6.85]);
  });

  it('zvyšok berie posledná časť — tretina by inak o halier ušla', () => {
    const casti = rozrezPolozku(
      { ...natural, sumaBezDph: 100, sumaDph: 0, sumaSpolu: 100 },
      [1, 2, 3].map(() => ({ podiel: 1 / 3, predkontaciaId: 'p-501' })),
    );
    expect(casti.map((cast) => cast.sumaBezDph)).toEqual([33.33, 33.33, 33.34]);
  });

  it('bez základu alebo s jedinou časťou položku nechá tak', () => {
    expect(rozrezPolozku(natural, [{ podiel: 1, predkontaciaId: 'p-501' }])).toEqual([natural]);
    const bezSum = { id: 'x', popis: 'Bez súm' } as DocumentLineItem;
    expect(rozrezPolozku(bezSum, [
      { podiel: 0.5, predkontaciaId: 'p-501' }, { podiel: 0.5, predkontaciaId: 'p-513' },
    ])).toEqual([bezSum]);
  });

  it('predloha ukáže pomer, nie kód — riadok sa rozpadne na viac riadkov', () => {
    const mapa = navrhPreRiadky(
      [
        { index: 0, popis: 'Natural 95', predkontaciaId: 'p-501', podiel: 0.8 },
        { index: 0, popis: 'Natural 95', predkontaciaId: 'p-513', podiel: 0.2 },
      ],
      [natural],
      codeLists,
    );
    expect(mapa[0].predkontacia).toBe('rozdeliť 80 %/20 %');
  });
});
