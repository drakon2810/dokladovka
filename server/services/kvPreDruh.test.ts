import { describe, expect, it } from 'vitest';
import { kvNavrhuPreDruh, kvPreDruh, platnyKvKod } from './accountingSuggestionService.js';

// Zámerne dve funkcie, nie jeden nepovinný parameter: druh dokladu potrebujú
// štyri volania z trinástich a pri nepovinnom parametri by sa naň ticho
// zabudlo — presne tak sa DDsl§69 dostalo na prijatú faktúru.
describe('platnyKvKod — iba zákonnosť kódu', () => {
  it('pozná zákonné sekcie a odmietne vymyslené', () => {
    expect(platnyKvKod('b1')).toBe('B1');
    expect(platnyKvKod('A1')).toBe('A1');
    expect(platnyKvKod('X9')).toBeUndefined();
    expect(platnyKvKod(undefined)).toBeUndefined();
  });
});

describe('kvPreDruh — sekcia pre TENTO doklad', () => {
  it('bežná faktúra drží stranu dokladu', () => {
    expect(kvPreDruh('B1', { typ: 'FP', podtyp: 'bezna' })).toBe('B1');
    expect(kvPreDruh('A1', { typ: 'FP', podtyp: 'bezna' })).toBeUndefined();
    expect(kvPreDruh('A1', { typ: 'FV', podtyp: 'bezna' })).toBe('A1');
  });

  it('doklad bez podtypu sa správa ako bežný', () => {
    expect(kvPreDruh('B1', { typ: 'FP' })).toBe('B1');
    expect(kvPreDruh('A1', { typ: 'FP' })).toBeUndefined();
  });

  // Dobropis a ťarchopis su oprava zakladu dane (§25a): C1 vydane, C2 prijate.
  it('dobropis a ťarchopis patria do opravnej sekcie', () => {
    for (const podtyp of ['dobropis', 'tarchopis']) {
      expect(kvPreDruh('C2', { typ: 'FP', podtyp })).toBe('C2');
      expect(kvPreDruh('B1', { typ: 'FP', podtyp })).toBeUndefined();
      expect(kvPreDruh('C1', { typ: 'FV', podtyp })).toBe('C1');
      expect(kvPreDruh('A1', { typ: 'FV', podtyp })).toBeUndefined();
      // KN patrí každému — plnenie mimo výkazu existuje pri oboch stranách.
      expect(kvPreDruh('KN', { typ: 'FP', podtyp })).toBe('KN');
    }
  });

  // Zalohova faktura do vykazu nevstupuje — danovy moment nastane az pri uhrade.
  it('zálohová faktúra berie iba KN', () => {
    expect(kvPreDruh('KN', { typ: 'FP', podtyp: 'zalohova' })).toBe('KN');
    for (const kod of ['B1', 'B2', 'C2', 'A1']) {
      expect(kvPreDruh(kod, { typ: 'FP', podtyp: 'zalohova' })).toBeUndefined();
    }
  });

  it('podtyp na nefaktúrových dokladoch nič nemení', () => {
    expect(kvPreDruh('B1', { typ: 'OZ', podtyp: 'dobropis' })).toBe('B1');
  });

  // Pokladničný doklad je v POHODE AGENDA, nie druh faktúry. Bloček z e-kasy do
  // 1 000 € je zjednodušená faktúra (§74 ods. 3) a patrí do B3; plná faktúra
  // zaplatená v hotovosti však patrí do B2 — sekciu určuje druh faktúry, nie forma
  // úhrady. Kontrola pri schválení preto B2 na pokladni pustí a nič neprepisuje.
  it('pokladničný doklad pustí B2 aj B3, výstupné sekcie nie', () => {
    expect(kvPreDruh('B2', { typ: 'PD', podtyp: 'bezna' })).toBe('B2');
    expect(kvPreDruh('B3', { typ: 'PD', podtyp: 'bezna' })).toBe('B3');
    expect(kvPreDruh('KN', { typ: 'PD', podtyp: 'bezna' })).toBe('KN');
    // B1 (prenos daňovej povinnosti) na bločku nie je — pole ostane prázdne.
    expect(kvPreDruh('B1', { typ: 'PD', podtyp: 'bezna' })).toBeUndefined();
    for (const kod of ['A1', 'A2', 'C1', 'C2', 'D1', 'D2']) {
      expect(kvPreDruh(kod, { typ: 'PD', podtyp: 'bezna' })).toBeUndefined();
    }
  });
});

// Návrh je iná vec než kontrola: zdroj (pravidlo protistrany, denník, model)
// si sekciu prináša z bežných faktúr, a v knihách klientov stojí pokladňa v B3
// na 349 hlavičkách z 350. Do 1 000 € (a keď suma nie je známa) sa preto B2 na
// pokladni navrhne ako B3; nad limitom zjednodušená faktúra byť nemôže, B2 ostáva.
describe('kvNavrhuPreDruh — sekcia v návrhu', () => {
  it('pokladňa do 1 000 € alebo bez sumy dostane B3', () => {
    expect(kvNavrhuPreDruh('B2', { typ: 'PD', podtyp: 'bezna', sumaSpolu: 85.4 })).toBe('B3');
    expect(kvNavrhuPreDruh('B2', { typ: 'PD', podtyp: 'bezna', sumaSpolu: 1000 })).toBe('B3');
    expect(kvNavrhuPreDruh('B2', { typ: 'PD', podtyp: 'bezna' })).toBe('B3');
  });

  it('pokladňa nad 1 000 € si B2 ponechá', () => {
    expect(kvNavrhuPreDruh('B2', { typ: 'PD', podtyp: 'bezna', sumaSpolu: 1480 })).toBe('B2');
  });

  it('ostatné správanie je zhodné s kontrolou', () => {
    expect(kvNavrhuPreDruh('B1', { typ: 'PD', podtyp: 'bezna', sumaSpolu: 50 })).toBeUndefined();
    expect(kvNavrhuPreDruh('B2', { typ: 'FP', podtyp: 'bezna', sumaSpolu: 50 })).toBe('B2');
    expect(kvNavrhuPreDruh('A1', { typ: 'FP', podtyp: 'bezna' })).toBeUndefined();
  });
});
