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

const PDF = Buffer.from('%PDF-1.7\nmanual upload test').toString('base64');
const PEPPOL = Buffer.from(
  '<?xml version="1.0"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"></Invoice>',
).toString('base64');

async function upload(app: any, headers: any, organizationId: string, files: any[]) {
  return app.inject({ method: 'POST', url: '/api/documents/upload', headers, payload: { organizationId, files } });
}

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
  }, 30000);

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
  }, 30000);

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
  }, 30000);
});
