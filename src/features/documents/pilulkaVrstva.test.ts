import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Pilulka bola vidieť, ale so zapnutým zvýraznením sa nedala kliknúť: textová
// vrstva PDF má z-index:2, rozprestiera sa cez celú stranu ako priehľadná
// plocha na výber textu a pilulka s z-index:auto skončila pod ňou. Bez
// zvýraznenia sa vrstva nevykresľuje, takže chyba bola vidieť len s ním.
/** Komentáre preč: text pravidla ich spomína a regex by chytil číslo z nich. */
const bezKomentarov = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const textLayerZ = () => {
  const css = bezKomentarov(readFileSync('node_modules/react-pdf/dist/esm/Page/TextLayer.css', 'utf8'));
  const blok = css.slice(css.indexOf('.textLayer {'));
  return Number(/z-index:\s*(\d+)/.exec(blok.slice(0, blok.indexOf('}')))?.[1]);
};
const pilulkaZ = () => {
  const css = bezKomentarov(readFileSync('src/features/documents/invoicePanel.css', 'utf8'));
  const blok = css.slice(css.indexOf('.dv-pilulka {'));
  return Number(/z-index:\s*(\d+)/.exec(blok.slice(0, blok.indexOf('}')))?.[1]);
};

describe('vrstvenie plávajúcej pilulky', () => {
  it('pilulka je nad textovou vrstvou PDF', () => {
    const text = textLayerZ();
    expect(text).toBeGreaterThan(0);
    expect(pilulkaZ()).toBeGreaterThan(text);
  });
});
