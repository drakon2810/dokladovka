import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { MemoryObjectStorage } from '../storage.js';
import { upsertPartnerZDokladu, najdiPartnera } from '../services/partnerService.js';
import { rebuildAccountingSuggestion } from '../services/accountingSuggestionService.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

function sessionHeaders(response: { headers: Record<string, unknown>; json(): any }) {
  const cookie = String(response.headers['set-cookie']).split(';')[0];
  const csrf = response.json().csrfToken as string;
  return { cookie, 'x-csrf-token': csrf };
}

describe('Partneri', () => {
  it('upsert z dokladu: založí partnera, druhý doklad ho len doplní', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);

    const prvy = await upsertPartnerZDokladu(database, {
      tenantId: seeded.tenantId,
      organizationId: seeded.organizationId,
      dodavatel: { nazov: 'Slovnaft a.s.', ico: '31322832' },
    });
    expect(prvy?.source).toBe('auto');

    // Rovnaké IČO: nevznikne duplicita, doplní sa IČ DPH aj IBAN.
    const druhy = await upsertPartnerZDokladu(database, {
      tenantId: seeded.tenantId,
      organizationId: seeded.organizationId,
      dodavatel: { nazov: 'SLOVNAFT, a. s.', ico: '31 322 832', icDph: 'SK2020372640', iban: 'SK11 1100 0000 0026 2601 0002' },
    });
    expect(druhy?.id).toBe(prvy?.id);
    const najdeny = await najdiPartnera(database, seeded.tenantId, seeded.organizationId, { icDph: 'SK2020372640' });
    expect(najdeny?.id).toBe(prvy?.id);

    const vsetci = await database.query('SELECT id FROM partners WHERE tenant_id=$1', [seeded.tenantId]);
    expect(vsetci.rowCount).toBe(1);
  }, 120_000);

  it('predvoľby partnera sú zdrojom návrhu partner_default', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const predkontaciaId = randomUUID();
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,'predkontacie','518','Ostatné služby','manual')`,
      [predkontaciaId, seeded.tenantId, seeded.organizationId],
    );
    const partner = await upsertPartnerZDokladu(database, {
      tenantId: seeded.tenantId,
      organizationId: seeded.organizationId,
      dodavatel: { nazov: 'Orange Slovensko', ico: '35697270' },
    });
    await database.query(
      'UPDATE partners SET default_predkontacia_id=$1 WHERE id=$2',
      [predkontaciaId, partner!.id],
    );

    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,100,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId],
    );
    await rebuildAccountingSuggestion(database, {
      tenantId: seeded.tenantId,
      organizationId: seeded.organizationId,
      documentId,
      supplierIco: '35697270',
      supplierName: 'Orange Slovensko',
    });
    const suggestion = await database.query<{ source: string; predkontacia_id: string } & Record<string, unknown>>(
      'SELECT source, predkontacia_id FROM accounting_suggestions WHERE document_id=$1', [documentId],
    );
    expect(suggestion.rows[0].source).toBe('partner_default');
    expect(suggestion.rows[0].predkontacia_id).toBe(predkontaciaId);
  }, 120_000);

  it('REST: create, update, archive + snapshot', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);

    const created = await app.inject({
      method: 'POST',
      url: `/api/organizations/${seeded.organizationId}/partners`,
      headers,
      payload: { nazov: 'Telekom a.s.', ico: '35763469' },
    });
    expect(created.statusCode).toBe(201);
    const partnerId = created.json().id as string;
    expect(created.json().source).toBe('manual');

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/partners/${partnerId}`,
      headers,
      payload: { icDph: 'SK2020273893', poznamka: 'Telco' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().icDph).toBe('SK2020273893');
    expect(updated.json().nazov).toBe('Telekom a.s.');

    const snapshot = await app.inject({ method: 'GET', url: '/api/data/snapshot', headers: { cookie: headers.cookie } });
    expect(snapshot.json().partners).toHaveLength(1);

    const archived = await app.inject({ method: 'POST', url: `/api/partners/${partnerId}/archive`, headers });
    expect(archived.statusCode).toBe(204);
    const after = await database.query<{ active: boolean } & Record<string, unknown>>(
      'SELECT active FROM partners WHERE id=$1', [partnerId],
    );
    expect(after.rows[0].active).toBe(false);
    await app.close();
  }, 120_000);
});
