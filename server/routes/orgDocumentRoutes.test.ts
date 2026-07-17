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

describe('organization documents (schránka)', () => {
  it('nahrá, vylistuje, stiahne a vymaže dokument; odmieta cudzie typy', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);

    const uploaded = await app.inject({
      method: 'POST',
      url: `/api/organizations/${seeded.organizationId}/documents`,
      headers,
      payload: {
        fileName: 'Zmluva o spolupráci.pdf',
        mimeType: 'application/pdf',
        contentBase64: Buffer.from('%PDF-1.4 test').toString('base64'),
        note: 'zmluva',
      },
    });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json()).toMatchObject({ fileName: 'Zmluva o spolupráci.pdf', mimeType: 'application/pdf' });
    const documentId = uploaded.json().id as string;

    const list = await app.inject({
      method: 'GET',
      url: `/api/organizations/${seeded.organizationId}/documents`,
      headers: { cookie: headers.cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0]).toMatchObject({ fileName: 'Zmluva o spolupráci.pdf', uploadedByName: 'Test Admin' });

    const file = await app.inject({
      method: 'GET',
      url: `/api/organizations/${seeded.organizationId}/documents/${documentId}/file`,
      headers: { cookie: headers.cookie },
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.body).toContain('%PDF-1.4');

    const rejected = await app.inject({
      method: 'POST',
      url: `/api/organizations/${seeded.organizationId}/documents`,
      headers,
      payload: { fileName: 'virus.exe', mimeType: 'application/exe', contentBase64: 'TVqQAAMAAAAEAAAA' },
    });
    expect(rejected.statusCode).toBe(415);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/organizations/${seeded.organizationId}/documents/${documentId}`,
      headers,
    });
    expect(deleted.statusCode).toBe(204);
    const emptyList = await app.inject({
      method: 'GET',
      url: `/api/organizations/${seeded.organizationId}/documents`,
      headers: { cookie: headers.cookie },
    });
    expect(emptyList.json()).toHaveLength(0);
    await app.close();
  }, 90_000);
});
