import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { createTestDatabase, seedTestUser, testConfig } from './testHelpers.js';
import { MemoryObjectStorage } from './storage.js';
import { processNextJob } from './workerService.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

function sessionHeaders(response: { headers: Record<string, unknown>; json(): any }) {
  const cookie = String(response.headers['set-cookie']).split(';')[0];
  const csrf = response.json().csrfToken as string;
  return { cookie, 'x-csrf-token': csrf };
}

describe('backend foundation', () => {
  it('applies migrations and exposes database health', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', database: 'ok', databaseKind: 'pglite' });
    await app.close();
  }, 90_000);

  it('creates a session and organization with a server-generated alias', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    expect(login.statusCode).toBe(200);
    const headers = sessionHeaders(login);
    const created = await app.inject({
      method: 'POST',
      url: '/api/organizations',
      headers,
      payload: { nazov: 'Nová Firma s.r.o.', ico: '87654321', dic: '2020999999', farba: '#123456' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().primaryEmailAlias.address).toMatch(/^nova-firma-[a-z0-9]+@doklady\.test\.sk$/);
    const organizationId = created.json().organization.id as string;
    const emptyKind = { nove: [], aktualizovane: [], bezZmeny: 0, vyradene: [] };
    const imported = await app.inject({
      method: 'PUT',
      url: `/api/organizations/${organizationId}/code-lists/import`,
      headers,
      payload: {
        orgId: organizationId,
        warnings: [],
        perKind: {
          predkontacie: { ...emptyKind, nove: [{ kod: '518/321', nazov: 'Služby' }] },
          cleneniaDph: emptyKind,
          ciselneRady: emptyKind,
          strediska: emptyKind,
        },
      },
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()).toMatchObject({ nove: 1, totalChanges: 1 });
    const snapshot = await app.inject({ method: 'GET', url: '/api/data/snapshot', headers: { cookie: headers.cookie } });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json().organizations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: seeded.organizationId, tenantId: seeded.tenantId }),
      expect.objectContaining({ id: created.json().organization.id, tenantId: seeded.tenantId }),
    ]));
    expect(snapshot.json().codeLists.predkontacie).toEqual(expect.arrayContaining([
      expect.objectContaining({ orgId: organizationId, kod: '518/321', source: 'pohoda', active: true }),
    ]));
    await app.close();
  }, 90_000);

  it('accepts an idempotent inbound webhook and processes a durable job', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const storage = new MemoryObjectStorage();
    const config = testConfig();
    const app = await buildApp({ database, storage, config, logger: false });
    const pdf = Buffer.from('%PDF-1.4\n% test');
    const payload = {
      providerMessageId: 'provider-message-1',
      envelopeRecipients: ['test-abc234@doklady.test.sk'],
      senderEmail: 'supplier@example.sk',
      attachments: [{ fileName: 'invoice.pdf', mimeType: 'application/pdf', contentBase64: pdf.toString('base64'), mockExtraction: { invoiceNumber: 'FV-1', buyerIco: '12345678', totalAmount: 12.3 } }],
    };
    const first = await app.inject({ method: 'POST', url: '/api/webhooks/inbound-email/mock', headers: { 'x-dokladovka-webhook-secret': 'test-webhook-secret' }, payload });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ duplicate: false, queued: 1 });
    const duplicate = await app.inject({ method: 'POST', url: '/api/webhooks/inbound-email/mock', headers: { 'x-dokladovka-webhook-secret': 'test-webhook-secret' }, payload });
    expect(duplicate.json()).toMatchObject({ duplicate: true });
    expect(await processNextJob(database, config, 'test-worker')).toBe(true);
    const documents = await database.query<{
      id: string; status: string; organization_id: string; version: number;
    } & Record<string, unknown>>('SELECT id, status, organization_id, version FROM documents');
    expect(documents.rows).toEqual([expect.objectContaining({ status: 'na_kontrole', organization_id: seeded.organizationId })]);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/documents/${documents.rows[0].id}/reject`,
      headers: sessionHeaders(login),
      payload: { expectedVersion: documents.rows[0].version, reason: 'Doklad nie je úplný' },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({ status: 'zamietnuty' });
    expect(rejected.json().history.at(-1).akcia).toContain('Doklad nie je úplný');
    await app.close();
  }, 90_000);
});
