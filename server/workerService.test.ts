import { describe, expect, it } from 'vitest';
import { cisloVPohodeZDokladu, looksLikePdfStructure, retryDelaySeconds } from './workerService.js';

describe('retryDelaySeconds', () => {
  it('gives transient errors tens of seconds, not the old 2s/4s', () => {
    // rand=1 → full base: 20, 40, 80, 160, 320 s pre pokusy 1..5.
    expect(retryDelaySeconds(1, 1)).toBe(20);
    expect(retryDelaySeconds(2, 1)).toBe(40);
    expect(retryDelaySeconds(5, 1)).toBe(320);
  });

  it('applies jitter within [0.5*base, base] and caps at 600 s', () => {
    expect(retryDelaySeconds(1, 0)).toBe(10); // 20 * 0.5
    expect(retryDelaySeconds(6, 1)).toBe(600); // 20*2^5=640 → strop 600
    expect(retryDelaySeconds(6, 0)).toBe(300); // 600 * 0.5
  });

  it('grows monotonically with attempts for a fixed jitter', () => {
    const delays = [1, 2, 3, 4].map((n) => retryDelaySeconds(n, 0.7));
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
  });
});

describe('looksLikePdfStructure', () => {
  it('accepts a real PDF trailer (that pdf-lib may still reject)', () => {
    expect(looksLikePdfStructure(Buffer.from('%PDF-1.4\n...\nstartxref\n1234\n%%EOF'))).toBe(true);
  });

  it('rejects data without any PDF cross-reference structure', () => {
    expect(looksLikePdfStructure(Buffer.from('%PDF-not-a-real-file'))).toBe(false);
  });
});

describe('cisloVPohodeZDokladu', () => {
  it('vydaná faktúra ide do POHODY s vlastným číslom, ostatné agendy nie', () => {
    expect(cisloVPohodeZDokladu('FV', { cisloFaktury: '260704300120' })).toBe('260704300120');
    // Prijatú faktúru čísluje POHODA — číslo dodávateľa ide do variabilného symbolu.
    expect(cisloVPohodeZDokladu('FP', { cisloFaktury: 'FA-225/2026' })).toBeUndefined();
    expect(cisloVPohodeZDokladu('FV', { cisloFaktury: '  ' })).toBeUndefined();
    expect(cisloVPohodeZDokladu('FV', undefined)).toBeUndefined();
    // POHODA berie do čísla dokladu najviac 32 znakov.
    expect(cisloVPohodeZDokladu('FV', { cisloFaktury: '9'.repeat(40) })).toHaveLength(32);
  });
});
