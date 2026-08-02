import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { MemoryObjectStorage } from '../storage.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

describe('DELETE /api/organizations/:id', () => {
  it('zmaže firmu so všetkým, čo k nej patrí, vrátane súborov', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const storage = new MemoryObjectStorage();
    const app = await buildApp({ database, storage, config: testConfig(), logger: false });

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken as string };

    // Druhá firma — poslednú firmu tenanta zmazať nejde.
    const second = await app.inject({
      method: 'POST', url: '/api/organizations', headers,
      payload: { nazov: 'Druhá firma s.r.o.', ico: '87654321', dic: '2020999999', farba: '#0E7A5F' },
    });
    expect(second.statusCode, second.body).toBe(201);

    // Doklad s prílohou (súbor v úložisku), číselník a partner pod mazanou firmou.
    const documentId = randomUUID();
    const emailId = randomUUID();
    const attachmentId = randomUUID();
    const storageKey = `upload/${seeded.tenantId}/${seeded.organizationId}/${attachmentId}.pdf`;
    await storage.put(storageKey, new TextEncoder().encode('%PDF-1.4'), 'application/pdf');
    await database.query(
      `INSERT INTO inbound_emails
        (id,tenant_id,organization_id,alias_id,provider,provider_message_id,envelope_recipients,sender_email,subject,received_at,status,correlation_id)
       VALUES ($1,$2,$3,$4,'imap',$5,'[]'::jsonb,'a@b.sk','Faktúra',now(),'processed',$1)`,
      [emailId, seeded.tenantId, seeded.organizationId, seeded.aliasId, `msg-${emailId}`],
    );
    await database.query(
      `INSERT INTO inbound_attachments
        (id,tenant_id,organization_id,inbound_email_id,original_file_name,safe_file_name,declared_mime_type,byte_size,sha256,storage_key,status)
       VALUES ($1,$2,$3,$4,'faktura.pdf','faktura.pdf','application/pdf',8,$5,$6,'stored')`,
      [attachmentId, seeded.tenantId, seeded.organizationId, emailId, `sha-${attachmentId}`, storageKey],
    );
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,100,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId],
    );
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,'predkontacie','518/321','Služby','manual')`,
      [randomUUID(), seeded.tenantId, seeded.organizationId],
    );
    await database.query(
      `INSERT INTO partners (id,tenant_id,organization_id,name,name_normalized)
       VALUES ($1,$2,$3,'Dodávateľ s.r.o.','dodavatel sro')`,
      [randomUUID(), seeded.tenantId, seeded.organizationId],
    );

    const deleted = await app.inject({ method: 'DELETE', url: `/api/organizations/${seeded.organizationId}`, headers });
    expect(deleted.statusCode, deleted.body).toBe(204);

    // Firma aj všetky jej dáta sú preč; súbor prílohy tiež.
    for (const [table, column] of [
      ['organizations', 'id'], ['documents', 'organization_id'], ['code_list_items', 'organization_id'],
      ['partners', 'organization_id'], ['inbound_attachments', 'organization_id'], ['inbound_emails', 'organization_id'],
      ['organization_email_aliases', 'organization_id'], ['document_queues', 'organization_id'],
      ['pohoda_company_links', 'organization_id'], ['organization_memberships', 'organization_id'],
    ] as const) {
      const rows = await database.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`, [seeded.organizationId]);
      expect(rows.rowCount, `${table} nie je vyčistená`).toBe(0);
    }
    await expect(storage.get(storageKey)).rejects.toThrow();

    // Audit zostáva ako stopa, len odpojený od zmazanej firmy.
    const audit = await database.query<{ action: string } & Record<string, unknown>>(
      "SELECT action FROM audit_logs WHERE tenant_id=$1 AND action='organization.deleted'", [seeded.tenantId],
    );
    expect(audit.rowCount).toBe(1);

    // Poslednú firmu tenanta už zmazať nejde.
    const organizations = await database.query<{ id: string } & Record<string, unknown>>(
      'SELECT id FROM organizations WHERE tenant_id=$1', [seeded.tenantId],
    );
    expect(organizations.rowCount).toBe(1);
    const last = await app.inject({ method: 'DELETE', url: `/api/organizations/${organizations.rows[0].id}`, headers });
    expect(last.statusCode).toBe(409);
    expect(last.json().code).toBe('last_organization');

    await app.close();
  }, 90_000);
});
