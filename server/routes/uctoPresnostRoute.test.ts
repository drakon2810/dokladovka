import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { MemoryObjectStorage } from '../storage.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

// Tlačidlo merania bez zvoleného režimu kedysi pálilo volania modelu (a bez kľúča
// padlo na 409). Predvolený je režim bez AI: zadarmo, opakovateľný, bez kľúča.
describe('POST ucto-presnost', () => {
  it('predvolene meria bez AI a GET vráti metodiku, režim a manifest bez dokladov', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const predkontacia = randomUUID();
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,'predkontacie','518/321','518/321','pohoda')`,
      [predkontacia, seeded.tenantId, seeded.organizationId],
    );
    for (const [cislo, datum] of [['26FP001', '2026-01-15'], ['26FP002', '2026-02-15'], ['26FP003', '2026-08-20']]) {
      await database.query(
        `INSERT INTO ucto_historia
          (id,tenant_id,organization_id,agenda,doklad_cislo,datum,supplier_name_normalized,
           line_text_normalized,predkontacia_id,riadok_index,source,riadok_hash)
         VALUES ($1,$2,$3,'FP',$4,$5,'preprava s.r.o.','preprava',$6,0,'mdb',$7)`,
        [randomUUID(), seeded.tenantId, seeded.organizationId, cislo, datum, predkontacia, randomUUID()],
      );
    }
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password },
    });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken };
    const url = `/api/organizations/${seeded.organizationId}/ucto-presnost`;

    const meranie = await app.inject({ method: 'POST', url, headers, payload: { vzorka: 10 } });
    expect(meranie.statusCode, meranie.body).toBe(200);
    expect(meranie.json()).toMatchObject({ rezim: 'bez_ai', metodika: 2 });

    const behy = await app.inject({ method: 'GET', url, headers });
    const beh = behy.json().behy[0];
    expect(beh).toMatchObject({ metodika: 2, rezim: 'bez_ai', manifest: expect.objectContaining({ asOf: 'datum_dokladu' }) });
    expect(beh).not.toHaveProperty('doklady');
  }, 90_000);
});
