import { describe, expect, it } from 'vitest';
import { contentDisposition } from './contentDisposition.js';

// Faktúra „FT. 807_16.03.2026_€ 480,00_platené cez gurecard.PDF" sa v prehliadači
// neotvorila: € je mimo latin-1 a Node na takom znaku v hlavičke hodí
// ERR_INVALID_CHAR — nepokazil sa názov, padla celá odpoveď so súborom.
const latin1 = (hodnota: string) => /^[\x20-\xFF]*$/.test(hodnota);

describe('contentDisposition', () => {
  it('hlavička je vždy zapísateľná do HTTP (latin-1)', () => {
    for (const nazov of [
      'FT. 807_16.03.2026_€ 480,00_platené cez gurecard.PDF',
      'faktúra ž ľ š č ť.pdf',
      'счёт-фактура.pdf',
      '発票.pdf',
      'a'.repeat(400),
    ]) {
      expect(latin1(contentDisposition('inline', nazov))).toBe(true);
    }
  });

  it('pôvodný názov ostane čitateľný vo filename*', () => {
    const hlavicka = contentDisposition('inline', 'FT. 807_€ 480,00_platené.PDF');
    const kodovany = hlavicka.split("filename*=UTF-8''")[1];
    expect(decodeURIComponent(kodovany)).toBe('FT. 807_€ 480,00_platené.PDF');
  });

  it('úvodzovky a nové riadky nerozbijú hlavičku', () => {
    const hlavicka = contentDisposition('attachment', 'zl"y\r\nnazov\\.pdf');
    expect(hlavicka).not.toMatch(/[\r\n]/);
    // Presne jedna dvojica úvodzoviek — tá okolo ASCII názvu.
    expect(hlavicka.match(/"/g)).toHaveLength(2);
  });

  it('ASCII varianta nikdy nie je prázdna', () => {
    expect(contentDisposition('inline', '発票')).toContain('filename="__"');
    expect(contentDisposition('inline', '')).toContain('filename="subor"');
  });
});
