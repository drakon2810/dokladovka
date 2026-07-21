import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { MemoryObjectStorage } from '../storage.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

function sessionHeaders(response: { headers: Record<string, unknown>; json(): any }) {
  const cookie = String(response.headers['set-cookie']).split(';')[0];
  const csrf = response.json().csrfToken as string;
  return { cookie, 'x-csrf-token': csrf };
}

function emptyKind() {
  return { nove: [], aktualizovane: [], bezZmeny: 0, vyradene: [] };
}

describe('import číselníkov — posledné číslo a sekcia KV DPH', () => {
  it('uloží topNumber (posledné číslo) a KV sekciu a vráti ich v snapshote', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const headers = sessionHeaders(
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } }),
    );

    const preview = {
      orgId: seeded.organizationId,
      warnings: [],
      perKind: {
        predkontacie: emptyKind(),
        cleneniaDph: {
          nove: [{ kod: 'B2odp', nazov: 'Prijaté faktúry — odpočet DPH', kvSekcia: 'B2' }],
          aktualizovane: [], bezZmeny: 0, vyradene: [],
        },
        ciselneRady: {
          nove: [{ kod: '26PK', nazov: 'Pokladňa príjem', agenda: 'pokladna', uctovnyRok: '2026', posledneCislo: '0042' }],
          aktualizovane: [], bezZmeny: 0, vyradene: [],
        },
        strediska: emptyKind(),
        zakazky: emptyKind(),
        cinnosti: emptyKind(),
        projekty: emptyKind(),
      },
    };

    const imported = await app.inject({
      method: 'PUT',
      url: `/api/organizations/${seeded.organizationId}/code-lists/import`,
      headers,
      payload: preview,
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().perKind.ciselneRady.nove).toBe(1);
    expect(imported.json().perKind.cleneniaDph.nove).toBe(1);

    const snapshot = await app.inject({ method: 'GET', url: '/api/data/snapshot', headers });
    const codeLists = snapshot.json().codeLists;
    const rad = codeLists.ciselneRady.find((item: any) => item.kod === '26PK');
    expect(rad.posledneCislo).toBe('0042');
    expect(rad.agenda).toBe('pokladna');
    const clen = codeLists.cleneniaDph.find((item: any) => item.kod === 'B2odp');
    expect(clen.kvSekcia).toBe('B2');

    // Rovnaký import po druhýkrát je „bez zmeny" — posledné číslo aj KV sekcia
    // sa porovnávajú, takže sa nič nepregeneruje.
    const again = await app.inject({
      method: 'PUT',
      url: `/api/organizations/${seeded.organizationId}/code-lists/import`,
      headers,
      payload: preview,
    });
    expect(again.json().perKind.ciselneRady.bezZmeny).toBe(1);
    expect(again.json().perKind.cleneniaDph.bezZmeny).toBe(1);
    await app.close();
  }, 120_000);
});
