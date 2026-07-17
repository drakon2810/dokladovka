import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { createTestDatabase, seedTestUser, testConfig } from './testHelpers.js';
import { MemoryObjectStorage } from './storage.js';
import { processNextJob } from './workerService.js';
import { MockServerDocumentExtractionProvider } from './extraction/mockProvider.js';

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

  it('keeps manual data during reprocessing and applies a selected extraction run explicitly', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    await seedTestUser(database);
    const storage = new MemoryObjectStorage();
    const config = testConfig();
    const app = await buildApp({ database, storage, config, logger: false });
    const pdf = Buffer.from('%PDF-1.4\n% reprocess test');
    const inbound = await app.inject({
      method: 'POST', url: '/api/webhooks/inbound-email/mock',
      headers: { 'x-dokladovka-webhook-secret': 'test-webhook-secret' },
      payload: {
        providerMessageId: 'provider-reprocess-1', envelopeRecipients: ['test-abc234@doklady.test.sk'],
        attachments: [{ fileName: 'invoice.pdf', mimeType: 'application/pdf', contentBase64: pdf.toString('base64'),
          mockExtraction: { invoiceNumber: 'ORIGINAL-1', supplierName: 'Dodávateľ s.r.o.', supplierIco: '11112222', buyerIco: '12345678', totalAmount: 100 } }],
      },
    });
    expect(inbound.statusCode).toBe(202);
    await processNextJob(database, config, 'initial-worker');
    const initial = (await database.query<{ id: string; version: number; extracted: any } & Record<string, unknown>>('SELECT id,version,extracted FROM documents')).rows[0];
    expect(initial.extracted.cisloFaktury).toBe('ORIGINAL-1');

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@test.sk', password: 'Test-password-123!' } });
    const headers = sessionHeaders(login);
    const queued = await app.inject({ method: 'POST', url: `/api/documents/${initial.id}/reprocess`, headers });
    expect(queued.statusCode).toBe(202);
    await processNextJob(database, config, 'reprocess-worker', {
      storage,
      provider: new MockServerDocumentExtractionProvider({
        invoiceNumber: 'NEW-2', supplierName: 'Dodávateľ s.r.o.', supplierIco: '11112222',
        buyerIco: '12345678', totalAmount: 121,
      }),
    });
    const afterReprocess = (await database.query<{ version: number; extracted: any } & Record<string, unknown>>(
      'SELECT version,extracted FROM documents WHERE id=$1', [initial.id],
    )).rows[0];
    expect(afterReprocess.version).toBe(initial.version);
    expect(afterReprocess.extracted.cisloFaktury).toBe('ORIGINAL-1');
    const runs = await database.query<{ id: string; result: any } & Record<string, unknown>>(
      `SELECT id,result FROM extraction_runs WHERE document_id=$1 AND status='succeeded' ORDER BY created_at DESC`, [initial.id],
    );
    expect(runs.rowCount).toBe(2);
    expect(runs.rows[0].result.invoiceNumber).toBe('NEW-2');

    const applied = await app.inject({
      method: 'POST', url: `/api/documents/${initial.id}/extraction-runs/${runs.rows[0].id}/apply`,
      headers, payload: { expectedVersion: initial.version },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ version: initial.version + 1, status: 'na_kontrole' });
    expect(applied.json().extracted.cisloFaktury).toBe('NEW-2');
    const file = await app.inject({ method: 'GET', url: `/api/documents/${initial.id}/file`, headers: { cookie: headers.cookie } });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toContain('application/pdf');
    await app.close();
  }, 90_000);

  it('persists unrouted attachments, lists them for admins, and enqueues extraction on assignment', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const storage = new MemoryObjectStorage();
    const config = testConfig();
    const app = await buildApp({ database, storage, config, logger: false });
    const pdf = Buffer.from('%PDF-1.4\n% unrouted test');
    const inbound = await app.inject({
      method: 'POST', url: '/api/webhooks/inbound-email/mock',
      headers: { 'x-dokladovka-webhook-secret': 'test-webhook-secret' },
      payload: {
        providerMessageId: 'provider-unrouted-1',
        envelopeRecipients: ['neznamy-alias@doklady.test.sk'],
        senderEmail: 'supplier@example.sk',
        subject: 'Faktúra bez aliasu',
        attachments: [{ fileName: 'invoice.pdf', mimeType: 'application/pdf', contentBase64: pdf.toString('base64') }],
      },
    });
    expect(inbound.statusCode).toBe(202);
    expect(inbound.json()).toMatchObject({ status: 'quarantine', queued: 0 });
    const emailId = inbound.json().id as string;
    const stored = (await database.query<{ storage_key: string | null; status: string } & Record<string, unknown>>(
      'SELECT storage_key, status FROM inbound_attachments WHERE inbound_email_id=$1', [emailId],
    )).rows[0];
    expect(stored.status).toBe('quarantine');
    expect(stored.storage_key).toContain('inbound/unassigned/');

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);
    const listed = await app.inject({ method: 'GET', url: '/api/inbound-emails', headers: { cookie: headers.cookie } });
    expect(listed.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: emailId, status: 'quarantine', quarantineReason: 'unknown_alias' }),
    ]));
    const snapshot = await app.inject({ method: 'GET', url: '/api/data/snapshot', headers: { cookie: headers.cookie } });
    expect(snapshot.json().inboundEmails).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: emailId, status: 'quarantine' }),
    ]));
    const detail = await app.inject({ method: 'GET', url: `/api/inbound-emails/${emailId}`, headers: { cookie: headers.cookie } });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().attachments).toHaveLength(1);

    const assigned = await app.inject({
      method: 'POST', url: `/api/inbound-emails/${emailId}/assign-organization`,
      headers, payload: { organizationId: seeded.organizationId },
    });
    expect(assigned.statusCode).toBe(204);
    expect(await processNextJob(database, config, 'assign-worker', {
      storage,
      provider: new MockServerDocumentExtractionProvider({
        invoiceNumber: 'Q-1', supplierName: 'Dodávateľ s.r.o.', supplierIco: '11112222',
        buyerIco: '12345678', totalAmount: 42,
      }),
    })).toBe(true);
    const documents = await database.query<{ status: string; organization_id: string } & Record<string, unknown>>(
      'SELECT status, organization_id FROM documents',
    );
    expect(documents.rows).toEqual([
      expect.objectContaining({ status: 'na_kontrole', organization_id: seeded.organizationId }),
    ]);
    const emailRow = (await database.query<{ status: string; tenant_id: string } & Record<string, unknown>>(
      'SELECT status, tenant_id FROM inbound_emails WHERE id=$1', [emailId],
    )).rows[0];
    expect(emailRow).toMatchObject({ status: 'processed', tenant_id: seeded.tenantId });
    await app.close();
  }, 90_000);

  it('hides unassigned quarantined emails from non-admin roles', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database, { role: 'uctovnik' });
    const storage = new MemoryObjectStorage();
    const config = testConfig();
    const app = await buildApp({ database, storage, config, logger: false });
    const inbound = await app.inject({
      method: 'POST', url: '/api/webhooks/inbound-email/mock',
      headers: { 'x-dokladovka-webhook-secret': 'test-webhook-secret' },
      payload: {
        providerMessageId: 'provider-unrouted-2',
        envelopeRecipients: ['neznamy-alias@doklady.test.sk'],
        attachments: [],
      },
    });
    const emailId = inbound.json().id as string;
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);
    const listed = await app.inject({ method: 'GET', url: '/api/inbound-emails', headers: { cookie: headers.cookie } });
    expect(listed.json()).toEqual([]);
    const snapshot = await app.inject({ method: 'GET', url: '/api/data/snapshot', headers: { cookie: headers.cookie } });
    expect(snapshot.json().inboundEmails).toEqual([]);
    const detail = await app.inject({ method: 'GET', url: `/api/inbound-emails/${emailId}`, headers: { cookie: headers.cookie } });
    expect(detail.statusCode).toBe(403);
    await app.close();
  }, 90_000);

  it('marks a corrupted PDF as a permanent safe failure before calling OpenAI', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    await seedTestUser(database);
    const storage = new MemoryObjectStorage();
    const config = testConfig({
      extractionProvider: 'openai',
      openai: { apiKey: 'test-key', model: 'gpt-test', storeResponses: false, timeoutMs: 5_000, maxRetries: 2 },
    });
    const app = await buildApp({ database, storage, config, logger: false });
    const inbound = await app.inject({
      method: 'POST', url: '/api/webhooks/inbound-email/mock',
      headers: { 'x-dokladovka-webhook-secret': 'test-webhook-secret' },
      payload: {
        providerMessageId: 'provider-corrupt-1', envelopeRecipients: ['test-abc234@doklady.test.sk'],
        attachments: [{ fileName: 'corrupt.pdf', mimeType: 'application/pdf', contentBase64: Buffer.from('%PDF-not-a-real-file').toString('base64') }],
      },
    });
    expect(inbound.statusCode).toBe(202);
    const extract = vi.fn();
    await processNextJob(database, config, 'corrupt-worker', { storage, provider: { name: 'openai', extract } });
    expect(extract).not.toHaveBeenCalled();
    expect((await database.query<{ status: string; processing_status: string } & Record<string, unknown>>('SELECT status,processing_status FROM documents')).rows[0])
      .toMatchObject({ status: 'chyba', processing_status: 'failed_permanent' });
    expect((await database.query<{ status: string; error_code: string } & Record<string, unknown>>('SELECT status,error_code FROM extraction_runs')).rows[0])
      .toMatchObject({ status: 'failed', error_code: 'corrupted_file' });
    expect((await database.query<{ status: string } & Record<string, unknown>>('SELECT status FROM processing_jobs')).rows[0].status).toBe('failed');
    await app.close();
  }, 90_000);
});
