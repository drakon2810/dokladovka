import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from './security.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const INY = Buffer.alloc(32, 9).toString('base64');

describe('šifrovanie secretov', () => {
  it('zašifruje a odšifruje', () => {
    expect(decryptSecret(encryptSecret('refresh-token-abc', KEY), KEY)).toBe('refresh-token-abc');
  });

  it('to isté dvakrát dá iný text — inak by sa z databázy dalo čítať, kde sa hodnoty opakujú', () => {
    expect(encryptSecret('rovnake', KEY)).not.toBe(encryptSecret('rovnake', KEY));
  });

  it('cudzí kľúč neprejde', () => {
    expect(() => decryptSecret(encryptSecret('tajne', KEY), INY)).toThrow();
  });

  it('zmenený text neprejde — GCM ho nesmie vrátiť potichu', () => {
    const [v, iv, tag] = encryptSecret('tajne', KEY).split('.');
    expect(() => decryptSecret([v, iv, tag, Buffer.from('podvrh').toString('base64')].join('.'), KEY)).toThrow();
  });

  it('chýbajúci kľúč povie prečo', () => {
    expect(() => encryptSecret('x', undefined)).toThrow(/SECRET_ENCRYPTION_KEY/);
    expect(() => encryptSecret('x', Buffer.alloc(16).toString('base64'))).toThrow(/32 bajtmi/);
  });
});
