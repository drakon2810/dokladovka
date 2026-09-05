import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { MemoryObjectStorage } from '../storage.js';

// Skutočný ročný denník má megabajty — ALPINA 2026 má 4,9 MB. Predvolený
// bodyLimit Fastify je pritom 1 MB a nastavuje sa PRE KAŽDÚ CESTU zvlášť, takže
// cesta bez neho vráti 413 a účtovník uvidí len „Požiadavku sa nepodarilo
// spracovať". Presne to sa aj stalo. Test preto posiela telo NAD 1 MB.

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

function proviozka(index: number): string {
  return `<act:accountingItem>
    <act:id>${index}</act:id>
    <act:source>Prijaté faktúry</act:source>
    <act:number><typ:numberRequested>26FP${index}</typ:numberRequested></act:number>
    <act:text>Polozka ${index} s dostatocne dlhym textom, aby telo poziadavky preslo cez jeden megabajt a otestovalo skutocnu velkost rocneho dennika</act:text>
    <act:homeCurrency><typ:priceSum>10.00</typ:priceSum></act:homeCurrency>
    <act:accounting><act:credit>501400</act:credit><act:debit>321100</act:debit></act:accounting>
    <act:date>2026-05-31</act:date>
  </act:accountingItem>`;
}

describe('nahratie účtovného denníka', () => {
  it('prijme telo väčšie než 1 MB — ročný denník má megabajty', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = {
      cookie: String(login.headers['set-cookie']).split(';')[0],
      'x-csrf-token': login.json().csrfToken as string,
    };

    const xml = `<?xml version="1.0" encoding="Windows-1250"?>
<rsp:responsePack version="2.0" state="ok"
  xmlns:rsp="http://www.stormware.cz/schema/version_2/response.xsd"
  xmlns:lst="http://www.stormware.cz/schema/version_2/list.xsd"
  xmlns:act="http://www.stormware.cz/schema/version_2/accountancy.xsd"
  xmlns:typ="http://www.stormware.cz/schema/version_2/type.xsd">
  <rsp:responsePackItem version="2.0" state="ok"><lst:listAccountancy version="2.0"><lst:accountancy version="2.0">
    ${Array.from({ length: 2600 }, (_, index) => proviozka(index + 1)).join('\n')}
  </lst:accountancy></lst:listAccountancy></rsp:responsePackItem>
</rsp:responsePack>`;
    expect(xml.length, 'test musí prekročiť predvolený bodyLimit, inak nič nemeria').toBeGreaterThan(1024 * 1024);

    const nahrate = await app.inject({
      method: 'PUT',
      url: `/api/organizations/${seeded.organizationId}/ucto-dennik`,
      headers,
      payload: { xml },
    });
    expect(nahrate.statusCode, nahrate.body.slice(0, 200)).toBe(200);
    expect(nahrate.json().ulozenych).toBe(2600);

    const prehlad = await app.inject({
      method: 'GET', url: `/api/organizations/${seeded.organizationId}/ucto-dennik/prehlad`, headers,
    });
    expect(prehlad.statusCode).toBe(200);
    expect(prehlad.json().proviozok).toBe(2600);

    await app.close();
  }, 120_000);
});
