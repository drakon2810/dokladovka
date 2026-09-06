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

    // DF260181 Up Déjeuner: rozúčtovanie PHM na 80/20. Doklad je rozúčtovaný,
    // takže sa berú VŠETKY jeho položky — pomer sa číta z dvojice a daňová časť
    // 80 % drží hlavičkové zaúčtovanie, takže by inak vypadla a v korpuse by
    // ostalo len osamotené „13,17 nedaňové", z ktorého pomer nikto nevyčíta.
    const phm = rows.filter((row) => row.dokladCislo === 'DF260181');
    expect(phm.map((row) => [row.riadokIndex, row.lineText, row.predkontaciaKod, row.clenenieDphKod]))
      .toEqual([
        [0, 'PHM', 'PHM-501200', 'PD'],
        [1, 'Nafta', 'PHM-501200', 'PD'],
        [2, 'Natural 95 (daňová časť 80 %)', 'PHM-501200', 'PD'],
        [3, 'Natural 95 (nedaňová časť 20 %)', 'PHM-Nadspotreba', 'PN'],
        [4, 'PHM', 'PHM-501200', 'PD'],
      ]);
    // Sumy sú to podstatné: 52,68 a 13,17 dávajú pomer základu 80/20, kým DPH
    // 7,58 a 7,57 ukazuje, že odpočet je krátený na polovicu (§ 49 ods. 5).
    // Z podielu základu to nijako nevyplýva a bez súm to model len hádal.
    expect(phm.slice(2, 4).map((row) => [row.suma, row.sumaDph])).toEqual([
      [52.68, 7.58],
      [13.17, 7.57],
    ]);
    // Nafta sa nedelí — jedna položka, celá s odpočtom.
    expect([phm[1].suma, phm[1].sumaDph]).toEqual([100.09, 23.02]);
    // Sekcia KV sa dedí z hlavičky, keď ju položka nemá vlastnú.
    expect(phm[3].clenenieKvKod).toBe('B2');
  });

  it('odmietne súbor, ktorý nie je odpoveďou z POHODY', () => {
    expect(() => parseHistoriaXml('<html><body>nie je to XML z POHODY</body></html>')).toThrow(/responsePack/);
  });
});
