import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { MemoryObjectStorage } from '../storage.js';
import { processNextJob } from '../workerService.js';
import { MockServerDocumentExtractionProvider } from '../extraction/mockProvider.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

function sessionHeaders(response: { headers: Record<string, unknown>; json(): any }) {
  const cookie = String(response.headers['set-cookie']).split(';')[0];
  const csrf = response.json().csrfToken as string;
  return { cookie, 'x-csrf-token': csrf };
}

const PDF = Buffer.from('%PDF-1.7\nmanual upload test').toString('base64');
const PEPPOL = Buffer.from(
  '<?xml version="1.0"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"></Invoice>',
).toString('base64');

async function upload(app: any, headers: any, organizationId: string, files: any[]) {
  return app.inject({ method: 'POST', url: '/api/documents/upload', headers, payload: { organizationId, files } });
}

// 60 s ako ostatné testy s databázou: každý si stavia vlastnú PGlite so
// všetkými migráciami a pri plnom paralelnom behu sa do 30 s nezmestí. Súbor
// samostatne prechádzal, v celej sade padal — a vyzeralo to ako regresia.
describe('POST /api/documents/upload', () => {
  it('zaradí PDF do rovnakej extract_document pipeline ako e-mail', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);

    const response = await upload(app, headers, seeded.organizationId, [
      { fileName: 'faktura.pdf', mimeType: 'application/pdf', contentBase64: PDF },
    ]);
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ queued: 1, results: [{ fileName: 'faktura.pdf', status: 'queued' }] });

    const email = await database.query("SELECT provider, status FROM inbound_emails WHERE organization_id=$1", [seeded.organizationId]);
    expect(email.rows[0]).toMatchObject({ provider: 'manual-upload', status: 'queued' });

    const attachment = await database.query("SELECT status, detected_mime_type, storage_key FROM inbound_attachments WHERE organization_id=$1", [seeded.organizationId]);
    expect(attachment.rows[0]).toMatchObject({ status: 'queued', detected_mime_type: 'application/pdf' });
    expect(attachment.rows[0].storage_key).toContain('upload/');

    const job = await database.query("SELECT kind, status FROM processing_jobs WHERE organization_id=$1", [seeded.organizationId]);
    expect(job.rows[0]).toMatchObject({ kind: 'extract_document', status: 'queued' });
  }, 60000);

  it('prijme PEPPOL BIS XML, odmietne neznámy súbor, deteguje duplicitu', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);

    const peppol = await upload(app, headers, seeded.organizationId, [
      { fileName: 'e-faktura.xml', mimeType: 'application/xml', contentBase64: PEPPOL },
    ]);
    expect(peppol.json().results[0].status).toBe('queued');

    const junk = await upload(app, headers, seeded.organizationId, [
      { fileName: 'note.txt', mimeType: 'text/plain', contentBase64: Buffer.from('len obyčajný text').toString('base64') },
    ]);
    expect(junk.json()).toMatchObject({ queued: 0, results: [{ status: 'quarantine', reason: 'unsupported_or_corrupted_file' }] });

    // Ten istý PDF druhýkrát je technická duplicita.
    await upload(app, headers, seeded.organizationId, [{ fileName: 'a.pdf', mimeType: 'application/pdf', contentBase64: PDF }]);
    const again = await upload(app, headers, seeded.organizationId, [{ fileName: 'a.pdf', mimeType: 'application/pdf', contentBase64: PDF }]);
    expect(again.json().results[0]).toMatchObject({ status: 'duplicate', reason: 'technical_duplicate' });
  }, 60000);

  it('schvaľovateľ nesmie nahrávať doklady', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database, { role: 'schvalovatel' });
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);

    const response = await upload(app, headers, seeded.organizationId, [
      { fileName: 'faktura.pdf', mimeType: 'application/pdf', contentBase64: PDF },
    ]);
    expect(response.statusCode).toBe(403);
  }, 60000);

  it('zamietnutý doklad sa dá nahrať znova (kôš neblokuje ten istý súbor navždy)', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const storage = new MemoryObjectStorage();
    const config = testConfig();
    const app = await buildApp({ database, storage, config, logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);
    const file = { fileName: 'rozhodnutie.pdf', mimeType: 'application/pdf', contentBase64: PDF };

    await upload(app, headers, seeded.organizationId, [file]);
    await processNextJob(database, config, 'w1', {
      storage, provider: new MockServerDocumentExtractionProvider({ documentType: 'OZ', invoiceNumber: 'X-1' }),
    });
    const documentId = (await database.query<{ id: string } & Record<string, unknown>>('SELECT id FROM documents')).rows[0].id;

    // Kým doklad žije, ten istý súbor je duplicita.
    expect((await upload(app, headers, seeded.organizationId, [file])).json().results[0])
      .toMatchObject({ status: 'duplicate', reason: 'technical_duplicate' });

    // Po zamietnutí (kôš) musí prejsť — inak sa zle zaradený doklad nedá opraviť.
    const document = await database.query<{ version: number } & Record<string, unknown>>('SELECT version FROM documents WHERE id=$1', [documentId]);
    const rejected = await app.inject({
      method: 'POST', url: `/api/documents/${documentId}/reject`,
      headers, payload: { expectedVersion: document.rows[0].version, reason: 'nie je to doklad' },
    });
    expect(rejected.statusCode).toBe(200);
    expect((await upload(app, headers, seeded.organizationId, [file])).json().results[0])
      .toMatchObject({ status: 'queued' });
    await app.close();
  }, 60000);

  it('job zaseknutý v behu (spadnutý worker) sa po čase vyzdvihne znova', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const storage = new MemoryObjectStorage();
    const config = testConfig();
    const app = await buildApp({ database, storage, config, logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    await upload(app, sessionHeaders(login), seeded.organizationId, [
      { fileName: 'faktura.pdf', mimeType: 'application/pdf', contentBase64: PDF },
    ]);

    // Simulácia pádu: job ostal 'running' so starým zámkom.
    await database.query(
      "UPDATE processing_jobs SET status='running', locked_at=now() - interval '2 hours', locked_by='mrtvy-worker'",
    );
    expect(await processNextJob(database, config, 'novy-worker', {
      storage, provider: new MockServerDocumentExtractionProvider({ invoiceNumber: 'F-1' }),
    })).toBe(true);
    const job = await database.query<{ status: string } & Record<string, unknown>>('SELECT status FROM processing_jobs');
    expect(job.rows[0].status).toBe('succeeded');
    await app.close();
  }, 60000);

  it('súbor, ktorý nie je účtovný doklad, skončí medzi Inými dokladmi a nie v zozname na kontrolu', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const storage = new MemoryObjectStorage();
    const config = testConfig();
    const app = await buildApp({ database, storage, config, logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);

    await upload(app, headers, seeded.organizationId, [
      { fileName: 'rozhodnutie-danovy-urad.pdf', mimeType: 'application/pdf', contentBase64: PDF },
    ]);
    // AI klasifikuje list z úradu ako INY — nemá sa z neho stať doklad.
    expect(await processNextJob(database, config, 'test-worker', {
      storage,
      provider: new MockServerDocumentExtractionProvider({ documentType: 'INY' }),
    })).toBe(true);

    expect((await database.query('SELECT id FROM documents')).rowCount).toBe(0);
    const stored = await database.query<{ file_name: string; storage_key: string } & Record<string, unknown>>(
      'SELECT file_name, storage_key FROM organization_documents WHERE organization_id=$1',
      [seeded.organizationId],
    );
    expect(stored.rows).toEqual([
      expect.objectContaining({ file_name: 'rozhodnutie-danovy-urad.pdf' }),
    ]);
    // Bajty ostávajú v pôvodnom objekte — dokument sa musí dať stiahnuť.
    expect(await storage.get(String(stored.rows[0].storage_key))).toBeTruthy();

    const attachment = await database.query<{ status: string; document_id: string | null } & Record<string, unknown>>(
      'SELECT status, document_id FROM inbound_attachments WHERE organization_id=$1', [seeded.organizationId],
    );
    expect(attachment.rows[0]).toMatchObject({ status: 'document_created', document_id: null });

    const snapshot = await app.inject({ method: 'GET', url: '/api/data/snapshot', headers: { cookie: headers.cookie } });
    expect(snapshot.json().documents).toHaveLength(0);
    expect(snapshot.json().organizationDocuments).toHaveLength(1);
    await app.close();
  }, 60000);
});
