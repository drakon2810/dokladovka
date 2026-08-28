import { describe, expect, it, vi } from 'vitest';
import { kosinus, textPreVektor, vektorZRiadku, vytvorVektory } from './embeddingService.js';
import { testConfig } from '../testHelpers.js';

describe('embeddingService', () => {
  it('kosínus je 1 pre zhodný a 0 pre kolmý vektor', () => {
    expect(kosinus([1, 0, 0], [2, 0, 0])).toBeCloseTo(1);
    expect(kosinus([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
    expect(kosinus([1, 2], [1, 2, 3])).toBe(0);
    expect(kosinus([0, 0], [1, 1])).toBe(0);
  });

  it('text kategórie skladá jedna funkcia — zápis a čítanie sa nesmú rozísť', () => {
    expect(textPreVektor('Asistenčné služby', 'Odťah a pomoc', ['odťah', 'asistencia']))
      .toBe('Asistenčné služby. Odťah a pomoc. odťah, asistencia');
    expect(textPreVektor('Palivo', null, [])).toBe('Palivo');
    expect(textPreVektor('Palivo', undefined, 'nie je pole')).toBe('Palivo');
  });

  // Vektor z iného modelu leží v inom priestore: kosínus by vrátil číslo, nie
  // chybu, a návrh by sa tváril dôveryhodne.
  it('vektor iného modelu sa neberie', () => {
    expect(vektorZRiadku([1, 2], 'text-embedding-3-small', 'text-embedding-3-small')).toEqual([1, 2]);
    expect(vektorZRiadku([1, 2], 'iny-model', 'text-embedding-3-small')).toBeUndefined();
    expect(vektorZRiadku([1, 2], null, 'text-embedding-3-small')).toBeUndefined();
    expect(vektorZRiadku(null, 'text-embedding-3-small', 'text-embedding-3-small')).toBeUndefined();
    expect(vektorZRiadku([1, 'x'], 'text-embedding-3-small', 'text-embedding-3-small')).toBeUndefined();
  });

  it('bez kľúča sa nevolá sieť a vracia undefined', async () => {
    expect(await vytvorVektory(testConfig(), ['nieco'])).toBeUndefined();
  });

  // Sémantika je vylepšenie, nie podmienka: zlyhanie embeddingu nesmie zhodiť
  // návrh zaúčtovania, volajúci musí dostať undefined a ísť lexikálne.
  it('zlyhané volanie nevyhodí výnimku', async () => {
    const embedder = { create: vi.fn().mockRejectedValue(new Error('503')) };
    expect(await vytvorVektory(testConfig(), ['nieco'], embedder)).toBeUndefined();
    expect(embedder.create).toHaveBeenCalledTimes(1);
  });

  it('nesúhlasný počet vektorov sa zahodí — inak by sa páry rozišli', async () => {
    const embedder = { create: vi.fn().mockResolvedValue({ data: [{ embedding: [1, 0] }] }) };
    expect(await vytvorVektory(testConfig(), ['a', 'b'], embedder)).toBeUndefined();
  });

  it('prázdny vstup nevolá sieť', async () => {
    const embedder = { create: vi.fn() };
    expect(await vytvorVektory(testConfig(), ['   ', ''], embedder)).toBeUndefined();
    expect(embedder.create).not.toHaveBeenCalled();
  });
});
