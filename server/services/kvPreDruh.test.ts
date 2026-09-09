import { describe, expect, it } from 'vitest';
import { kvPreDruh, platnyKvKod } from './accountingSuggestionService.js';

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

  // Bloček je zjednodušená faktúra (§74 ods. 3): s odpočtom B3, bez odpočtu KN.
  // Sekciu nesie druh dokladu, nie účet — „501600 Auto" stojí v denníku klientov
  // ako B2 na prijatej faktúre a ako B3 na tom istom nákupe z bločku. Zdroj
  // návrhu prináša sekciu z faktúry, tak sa B1/B2 prepíše; odmietnuť ju by
  // znamenalo prázdne pole a doklad, ktorý sa nedá schváliť.
  it('pokladničný doklad berie B3, nie B2', () => {
    expect(kvPreDruh('B2', { typ: 'PD', podtyp: 'bezna' })).toBe('B3');
    expect(kvPreDruh('B3', { typ: 'PD', podtyp: 'bezna' })).toBe('B3');
    expect(kvPreDruh('KN', { typ: 'PD', podtyp: 'bezna' })).toBe('KN');
    // B1 (prenos daňovej povinnosti) nie je B2 v inej forme — nemlčky sa
    // neprepisuje, pole ostane prázdne a sekciu určí účtovník.
    expect(kvPreDruh('B1', { typ: 'PD', podtyp: 'bezna' })).toBeUndefined();
    // Výstupné sekcie na bloček nepatria — ten je vždy na strane odberateľa.
    for (const kod of ['A1', 'A2', 'C1', 'C2', 'D1', 'D2']) {
      expect(kvPreDruh(kod, { typ: 'PD', podtyp: 'bezna' })).toBeUndefined();
    }
  });
});
