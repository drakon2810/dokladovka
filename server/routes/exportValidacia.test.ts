import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { MemoryObjectStorage } from '../storage.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';

// Kontroly dátového balíka POHODY hádžu obyčajný Error so slovenskou hláškou —
// a tá k účtovníkovi prišla ako HTTP 500 „neočakávaná chyba" bez dokladu.
const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

describe('export do POHODY — neplatný doklad', () => {
  it('chyba kontroly je 409 s hláškou a dokladom, vnútorná chyba ostáva 500', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken as string };

    const schvaleny = async (snapshot: unknown) => {
      const id = randomUUID();
      await database.query(
        `INSERT INTO documents
          (id,tenant_id,organization_id,document_type,status,processing_status,source,extracted,accounting,
           confidence,total_amount,currency,version,approved_version,approved_snapshot)
         VALUES ($1,$2,$3,'FP','schvaleny','ready_for_review','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,1,123,'EUR',1,1,$4::jsonb)`,
        [id, seeded.tenantId, seeded.organizationId, JSON.stringify(snapshot)],
      );
      return id;
    };
    const exportuj = (documentId: string) => app.inject({
      method: 'POST', url: '/api/exports/pohoda/xml', headers,
      payload: { organizationId: seeded.organizationId, documentIds: [documentId] },
    });

    const bezCiselnikov = await schvaleny({ version: 1, typ: 'FP', extracted: { datumVystavenia: '2026-07-01' }, ucto: {} });
    const neplatny = await exportuj(bezCiselnikov);
    expect(neplatny.statusCode, neplatny.body).toBe(409);
    expect(neplatny.json()).toEqual({
      code: 'export_neplatny_doklad',
      message: `Doklad ${bezCiselnikov} nemá platné aktívne číselníky organizácie`,
      details: { documentId: bezCiselnikov },
    });

    // Chyba v kóde nie je chyba dokladu — účtovník ju opraviť nevie.
    const pokazeny = await schvaleny({ version: 1, typ: 'FP', extracted: null, ucto: {} });
    expect((await exportuj(pokazeny)).statusCode).toBe(500);

    await app.close();
  }, 60_000);
});
