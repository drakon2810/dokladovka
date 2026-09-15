import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { MemoryObjectStorage } from '../storage.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

// Meranie presnosti vloží na pár sekúnd náhradný doklad do tabuľky dokladov —
// kostru bez rozpisu DPH a sumy. Snapshot ho posielal ďalej, UI na ňom padlo,
// a počas sebakontroly ostala aplikácia biela každému, kto mal firmu v prístupe.
describe('náhradný doklad merania presnosti', () => {
  it('sa nedostane ani do snapshotu, ani do zoznamu dokladov', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password },
    });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };

    const skutocny = randomUUID();
    const nahradny = randomUUID();
    for (const [id, source] of [[skutocny, '{"typ":"upload"}'], [nahradny, '{"meranie":true}']] as const) {
      await database.query(
        `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,
           source,extracted,accounting,total_amount,currency)
         VALUES ($1,$2,$3,'FV','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,'{}'::jsonb,100,'EUR')`,
        [id, seeded.tenantId, seeded.organizationId, source],
      );
    }

    const snapshot = await app.inject({ method: 'GET', url: '/api/data/snapshot', headers });
    expect(snapshot.statusCode, snapshot.body).toBe(200);
    const vSnapshote = (snapshot.json().documents as Array<{ id: string }>).map((doklad) => doklad.id);
    expect(vSnapshote).toContain(skutocny);
    expect(vSnapshote).not.toContain(nahradny);

    const zoznam = await app.inject({ method: 'GET', url: '/api/documents', headers });
    expect(zoznam.statusCode, zoznam.body).toBe(200);
    const vZozname = (zoznam.json() as Array<{ id: string }>).map((doklad) => doklad.id);
    expect(vZozname).toContain(skutocny);
    expect(vZozname).not.toContain(nahradny);
  }, 90_000);
});
