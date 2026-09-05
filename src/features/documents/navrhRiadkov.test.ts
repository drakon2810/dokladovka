import { describe, expect, it } from 'vitest';
import { navrhPreRiadky } from './ItemsSection';
import type { CodeListItem, DocumentLineItem } from '../../data/types';

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
