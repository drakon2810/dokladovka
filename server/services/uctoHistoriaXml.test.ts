import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseHistoriaXml } from './uctoHistoriaXml.js';

// Fixtúra je VÝREZ skutočnej odpovede POHODY z databázy ALPINY (dve faktúry
// z exportu, ktorý mal 45 dokladov štyroch dodávateľov). Ten istý súbor číta aj
// test agenta v C# — dva parsery jedného formátu sa inak rozídu a korpus by mal
// dva rôzne tvary toho istého dokladu.
const FIXTURA = readFileSync(
  fileURLToPath(new URL('./__fixtures__/pohoda-doklady-s-polozkami.xml', import.meta.url)), 'utf8',
);

describe('doklady s položkami z POHODY', () => {
  it('vytiahne rozúčtovanie, ktoré hlavička ani denník neukážu', () => {
    const { rows } = parseHistoriaXml(FIXTURA);

    // DF260169 Print-Office: hlavička „repre / PD / B2" a tri položky, z toho
    // dve BEZ textu. Práve jedna z nich je „repre / PN / KN" — tá istá
    // predkontácia ako hlavička, ale mimo priznania aj mimo kontrolného výkazu.
    const printOffice = rows.filter((row) => row.dokladCislo === 'DF260169');
    expect(printOffice.map((row) => [row.riadokIndex, row.predkontaciaKod, row.clenenieDphKod, row.clenenieKvKod]))
      .toEqual([
        [0, 'repre', 'PD', 'B2'],
        [1, 'kancelár.potreby', 'PD', 'B2'],
        [2, 'repre', 'PN', 'KN'],
        [3, '548-vratný obal', 'PN', 'KN'],
      ]);
    // Položka bez textu si berie text hlavičky — inak by z korpusu vypadla.
    expect(printOffice[2].lineText).toBe('spese di rappres./repre');
    expect(printOffice[3].lineText).toBe('vratný obal');
    expect(printOffice[0]).toMatchObject({
      agenda: 'FP', supplierIco: '54085292', supplierName: 'Print-Office s.r.o.', datum: '2026-07-16',
    });

    // DF260181 Up Déjeuner: rozúčtovanie PHM na 80/20. „Nafta" sa nedelí vôbec
    // a daňová časť má to isté zaúčtovanie ako hlavička — do korpusu ide len
    // nedaňová časť, teda to jediné, čo je rozhodnutím účtovníka.
    const phm = rows.filter((row) => row.dokladCislo === 'DF260181');
    expect(phm.map((row) => [row.riadokIndex, row.lineText, row.predkontaciaKod, row.clenenieDphKod]))
      .toEqual([
        [0, 'PHM', 'PHM-501200', 'PD'],
        [3, 'Natural 95 (nedaňová časť 20 %)', 'PHM-Nadspotreba', 'PN'],
      ]);
    // Sekcia KV sa dedí z hlavičky, keď ju položka nemá vlastnú.
    expect(phm[1].clenenieKvKod).toBe('B2');
  });

  it('odmietne súbor, ktorý nie je odpoveďou z POHODY', () => {
    expect(() => parseHistoriaXml('<html><body>nie je to XML z POHODY</body></html>')).toThrow(/responsePack/);
  });
});
