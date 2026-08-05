// Rozdelený súbor ide do POHODY ako viac samostatných zápisov. Keď účtovník
// o ostatných častiach nevie, schváli a vyexportuje len tú, ktorú náhodou
// otvoril — zvyšok rekapitulácie miezd sa nezaúčtuje vôbec.
import { describe, expect, it } from 'vitest';
import type { DocumentItem } from '../../data/types';
import { splitGroup } from './SplitDocumentModal';

const doklad = (id: string, prijateDna: string, splitFromDocumentId?: string): DocumentItem =>
  ({ id, prijateDna, splitFromDocumentId }) as DocumentItem;

const povodny = doklad('a', '2026-08-01T08:00:00.000Z');
const cast1 = doklad('c', '2026-08-01T08:00:02.000Z', 'a');
const cast2 = doklad('b', '2026-08-01T08:00:01.000Z', 'a');
const bezny = doklad('x', '2026-08-02T08:00:00.000Z');
// Poradie v snapshote je náhodné — server doklady neradí.
const vsetky = [cast1, bezny, povodny, cast2];

describe('splitGroup', () => {
  it('bežný doklad nemá časti', () => {
    expect(splitGroup(bezny, vsetky)).toEqual([]);
  });

  it('z pôvodného dokladu vidno všetky tri časti, pôvodný prvý a časti podľa vzniku', () => {
    expect(splitGroup(povodny, vsetky).map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('z ktorejkoľvek časti vidno to isté a v rovnakom poradí', () => {
    // Číslovanie „2/3" by inak skákalo podľa toho, ktorú časť účtovník otvoril.
    expect(splitGroup(cast1, vsetky).map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(splitGroup(cast2, vsetky).map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });
});
