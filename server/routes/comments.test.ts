import { randomUUID } from 'node:crypto';
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

describe('Komunikácia na doklade', () => {
  it('komentár sa pridá bez zmeny verzie a @-spomenutie sa rozpozná', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    // Druhý používateľ, ktorého možno spomenúť.
    const kolegaId = randomUUID();
    await database.query(
      `INSERT INTO users (id,tenant_id,name,email,password_hash,role)
       SELECT $1, tenant_id, 'Mária Kováčová', 'maria2@test.sk', password_hash, 'uctovnik' FROM users WHERE id=$2`,
      [kolegaId, seeded.userId],
    );
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,100,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId],
    );
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);

    const response = await app.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/comments`,
      headers,
      payload: { text: 'Prosím @Mária Kováčová o kontrolu sadzby DPH.' },
    });
    expect(response.statusCode).toBe(200);
    const row = response.json();
    expect(row.version).toBe(1);
    expect(row.comments).toHaveLength(1);
    expect(row.comments[0].user).toBe('Test Admin');
    expect(row.comments[0].mentions).toEqual([kolegaId]);
    expect(row.history[row.history.length - 1].akcia).toBe('Komentár pridaný');

    // Prázdny komentár neprejde validáciou.
    const empty = await app.inject({
      method: 'POST',
      url: `/api/documents/${documentId}/comments`,
      headers,
      payload: { text: '   ' },
    });
    expect(empty.statusCode).toBe(400);
    await app.close();
  }, 120_000);
});
