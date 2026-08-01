import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase, seedTestUser } from '../testHelpers.js';
import { TAX_RATIOS, rozpisPolozku, seedTaxRatioDefaults } from './taxRatios.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

describe('seedTaxRatioDefaults', () => {
  // Dlhší timeout: studený PGlite + 26 migrácií trvá aj vyše 5 s.
  it('priradí účty a daňové pomery podľa názvov z reálnych POHODA dát; ručné úpravy neprepíše', { timeout: 30_000 }, async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);

    // Vzory názvov z pilotného MDB extraktu (35761571).
    const rows: Array<{ kod: string; nazov: string; ucetMd?: string; taxRatio?: string }> = [
      { kod: '501100', nazov: '501100 PHM-tuz.' },
      { kod: '501199', nazov: '501199 PHM NEDANOVA' },
      { kod: '1', nazov: 'Reprezentačné', ucetMd: '513100' },
      { kod: '518100', nazov: '518100 nájom Au NE' },
      { kod: '2', nazov: 'Bežné služby', ucetMd: '518000' },
      // Ručne nastavený pomer — seed ho nesmie prepísať.
      { kod: '501300', nazov: '501300 PHM sluzobne', ucetMd: '501300', taxRatio: 'PHM50' },
    ];
    for (const row of rows) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,ucet_md,tax_ratio_kod)
         VALUES ($1,$2,$3,'predkontacie',$4,$5,'pohoda',$6,$7)`,
        [randomUUID(), seeded.tenantId, seeded.organizationId, row.kod, row.nazov, row.ucetMd ?? null, row.taxRatio ?? null],
      );
    }
    // Iný kind nesmie byť dotknutý.
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,'cleneniaDph','PDnedan','PD nedanove','pohoda')`,
      [randomUUID(), seeded.tenantId, seeded.organizationId],
    );

    await seedTaxRatioDefaults(database, seeded.tenantId, seeded.organizationId);
    // Idempotencia — druhé spustenie nič nezmení.
    await seedTaxRatioDefaults(database, seeded.tenantId, seeded.organizationId);

    const result = await database.query<{ code: string; ucet_md?: string; tax_ratio_kod?: string } & Record<string, unknown>>(
      `SELECT code, ucet_md, tax_ratio_kod FROM code_list_items
        WHERE organization_id=$1 AND kind='predkontacie' ORDER BY code`,
      [seeded.organizationId],
    );
    const byCode = new Map(result.rows.map((row) => [row.code, row]));

    // Fallback účtu z prefixu kódu; PHM podľa názvu.
    expect(byCode.get('501100')).toMatchObject({ ucet_md: '501100', tax_ratio_kod: 'PHM80' });
    // „NEDANOVA“ v názve vyhráva nad PHM.
    expect(byCode.get('501199')).toMatchObject({ tax_ratio_kod: 'NEDAN' });
    // Reprezentačné 513 = nedaňové zo zákona (podľa účtu, nie názvu).
    expect(byCode.get('1')).toMatchObject({ ucet_md: '513100', tax_ratio_kod: 'NEDAN' });
    // Prípona „NE“ v názve (konvencia účtovníčky) = nedaňové.
    expect(byCode.get('518100')).toMatchObject({ tax_ratio_kod: 'NEDAN' });
    expect(byCode.get('2')).toMatchObject({ tax_ratio_kod: 'VSEOB' });
    // Ručná úprava zostáva.
    expect(byCode.get('501300')).toMatchObject({ tax_ratio_kod: 'PHM50' });

    const clenenie = await database.query<{ tax_ratio_kod?: string } & Record<string, unknown>>(
      `SELECT tax_ratio_kod FROM code_list_items WHERE organization_id=$1 AND kind='cleneniaDph'`,
      [seeded.organizationId],
    );
    expect(clenenie.rows[0].tax_ratio_kod).toBeNull();
  });

  it('rozpisPolozku: PHM50 na doklade 52 € sedí s referenčným rozkladom (Elektronický účtovník)', () => {
    const zapisy = rozpisPolozku({ sumaBezDph: 42.28, sumaDph: 9.72 }, TAX_RATIOS.PHM50)!;
    expect(zapisy).toEqual([
      { popisSuffix: 'uplatnené 80 %', suma: 33.82, druh: 'zaklad_uplatneny', danovy: true, doKv: true },
      { popisSuffix: 'neuplatnené 20 %', suma: 8.46, druh: 'zaklad_neuplatneny', danovy: false, doKv: true },
      { popisSuffix: 'DPH uplatnené 50 %', suma: 4.86, druh: 'dph_uplatnena', danovy: true, doKv: true },
      { popisSuffix: 'DPH neuplatnené 50 %', suma: 4.86, druh: 'dph_neuplatnena', danovy: true, doKv: false },
    ]);
    // Bilancia: súčet zápisov = celá suma dokladu.
    expect(round2(zapisy.reduce((sum, zapis) => sum + zapis.suma, 0))).toBe(52);
  });

  it('rozpisPolozku: zvyšok znáša neuplatnená časť, bilancia sedí aj pri nedeliteľných sumách', () => {
    const zapisy = rozpisPolozku({ sumaBezDph: 10.01, sumaDph: 2.3 }, TAX_RATIOS.PHM80)!;
    const zaklad = zapisy.filter((zapis) => zapis.druh.startsWith('zaklad'));
    expect(zaklad.map((zapis) => zapis.suma)).toEqual([8.01, 2]);
    expect(round2(zapisy.reduce((sum, zapis) => sum + zapis.suma, 0))).toBe(12.31);
  });

  it('rozpisPolozku: VSEOB nerozkladá; NEDAN dá celý základ aj DPH do nedaňových', () => {
    expect(rozpisPolozku({ sumaBezDph: 100, sumaDph: 23 }, TAX_RATIOS.VSEOB)).toBeNull();
    const nedan = rozpisPolozku({ sumaBezDph: 100, sumaDph: 23 }, TAX_RATIOS.NEDAN)!;
    // Uplatnené časti sú nulové → vypadli; zostáva základ aj DPH ako nedaňové.
    expect(nedan).toEqual([
      { popisSuffix: 'neuplatnené 100 %', suma: 100, druh: 'zaklad_neuplatneny', danovy: false, doKv: true },
      { popisSuffix: 'DPH neuplatnené 100 %', suma: 23, druh: 'dph_neuplatnena', danovy: false, doKv: false },
    ]);
  });

  it('katalóg pomerov: bilancia P/D/K dáva zmysel', () => {
    for (const ratio of Object.values(TAX_RATIOS)) {
      expect(ratio.pNaklad).toBeGreaterThanOrEqual(0);
      expect(ratio.pNaklad).toBeLessThanOrEqual(100);
      expect(ratio.dDph).toBeLessThanOrEqual(100);
      expect(ratio.kKv).toBe(100);
      expect(TAX_RATIOS[ratio.kod]).toBe(ratio);
    }
  });
});
