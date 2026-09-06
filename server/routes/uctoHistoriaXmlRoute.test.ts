import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { MemoryObjectStorage } from '../storage.js';

// Export dokladov s položkami má ~4,5 kB na doklad, takže rok firmy sú desiatky
// MB. Predvolený bodyLimit Fastify je pritom 1 MB a nastavuje sa PRE KAŽDÚ
// CESTU zvlášť — presne na tom už raz skončilo nahratie denníka na 413
// „Požiadavku sa nepodarilo spracovať". Test preto posiela telo nad 1 MB.

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

const FIXTURA = readFileSync(
  fileURLToPath(new URL('../services/__fixtures__/pohoda-doklady-s-polozkami.xml', import.meta.url)), 'utf8',
);

describe('nahratie dokladov s položkami', () => {
  it('uloží rozúčtovanie do korpusu a znesie telo nad 1 MB', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = {
      cookie: String(login.headers['set-cookie']).split(';')[0],
      'x-csrf-token': login.json().csrfToken as string,
    };

    // Faktúry sa zopakujú, kým telo neprekročí megabajt. Opakovanie je zároveň
    // kontrola idempotencie — riadok_hash duplicitu zachytí.
    const jedna = FIXTURA.slice(FIXTURA.indexOf('<rsp:responsePackItem'), FIXTURA.lastIndexOf('</rsp:responsePackItem>') + 23);
    const xml = FIXTURA.replace('</rsp:responsePack>', `${jedna.repeat(120)}</rsp:responsePack>`);
    expect(xml.length, 'test musí prekročiť predvolený bodyLimit, inak nič nemeria').toBeGreaterThan(1024 * 1024);

    const nahrate = await app.inject({
      method: 'PUT',
      url: `/api/organizations/${seeded.organizationId}/ucto-historia-xml`,
      headers,
      payload: { xml },
    });
    expect(nahrate.statusCode, nahrate.body.slice(0, 200)).toBe(200);
    // Dva doklady, štyri + dva riadky. Opakovania sú duplicity, nie nové riadky.
    expect(nahrate.json().imported).toBe(6);

    const korpus = await database.query<{ line_text_normalized: string; predkontacia_kod: string; clenenie_dph_kod: string } & Record<string, unknown>>(
      `SELECT line_text_normalized, predkontacia_kod, clenenie_dph_kod FROM ucto_historia
        WHERE organization_id=$1 AND predkontacia_kod='repre' AND clenenie_dph_kod='PN'`,
      [seeded.organizationId],
    );
    // To, kvôli čomu sa doklady s položkami ťahajú: reprezentácia mimo priznania,
    // ktorá má tú istú predkontáciu ako hlavička a v denníku ju nevidno vôbec.
    expect(korpus.rows).toHaveLength(1);

    await app.close();
  }, 120_000);
});
