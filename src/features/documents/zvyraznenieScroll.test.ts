import { describe, expect, it } from 'vitest';

// So zapnutým zvýraznením zdroja stránka „zamrzla": pohyb myšou nad dokladom
// nastavil activeSrc, efekt doscrolloval k značke, scroll ju posunul spod
// kurzora, to spustilo ďalší mouseover — a doklad sa pod myšou rozbehol dokola.
// Scrollovať sa smie LEN vtedy, keď zvýraznenie prišlo z formulára.
const maScrollovat = (activeSrc: string | undefined, zDokladu: boolean) =>
  Boolean(activeSrc) && !activeSrc!.startsWith('sec:') && !zDokladu;

describe('scroll k zvýraznenej značke', () => {
  it('zvýraznenie z formulára doklad doscrolluje', () => {
    expect(maScrollovat('extracted.cisloFaktury', false)).toBe(true);
  });

  it('zvýraznenie z dokladu NEscrolluje — inak sa cyklí', () => {
    expect(maScrollovat('extracted.cisloFaktury', true)).toBe(false);
  });

  it('celá sekcia z legendy nescrolluje ani z formulára', () => {
    expect(maScrollovat('sec:2', false)).toBe(false);
  });

  it('bez zvýraznenia sa nescrolluje', () => {
    expect(maScrollovat(undefined, false)).toBe(false);
  });
});
