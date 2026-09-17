import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDatabase, seedTestUser } from '../testHelpers.js';
import { doplnUcetMdZKodu } from './ucetMdZKodu.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

describe('doplnUcetMdZKodu', () => {
  it('doplní účet z prefixu kódu, účet z POHODY ani iný číselník neprepíše', { timeout: 30_000 }, async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const vloz = (kind: string, kod: string, ucetMd?: string) => database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,ucet_md)
       VALUES ($1,$2,$3,$4,$5,$5,'pohoda',$6)`,
      [randomUUID(), seeded.tenantId, seeded.organizationId, kind, kod, ucetMd ?? null],
    );
    // Vzory kódov z pilotného MDB extraktu (35761571).
    await vloz('predkontacie', '501100 PHM-tuz.');
    await vloz('predkontacie', '1', '513100');
    await vloz('predkontacie', 'repre');
    await vloz('cleneniaDph', '343PD');

    await doplnUcetMdZKodu(database, seeded.tenantId, seeded.organizationId);
    // Idempotencia — druhé spustenie nič nezmení.
    await doplnUcetMdZKodu(database, seeded.tenantId, seeded.organizationId);

    const result = await database.query<{ code: string; ucet_md: string | null } & Record<string, unknown>>(
      `SELECT code, ucet_md FROM code_list_items WHERE organization_id=$1 ORDER BY code`, [seeded.organizationId],
    );
    expect(Object.fromEntries(result.rows.map((row) => [row.code, row.ucet_md]))).toEqual({
      '1': '513100',
      '343PD': null,
      '501100 PHM-tuz.': '501100',
      repre: null,
    });
  });
});
