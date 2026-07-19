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

async function insertReadyDocument(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
  seeded: { tenantId: string; organizationId: string },
  total: number,
): Promise<string> {
  const id = randomUUID();
  const pred = randomUUID();
  for (const [cid, kind, code] of [[pred, 'predkontacie', '518'], [randomUUID(), 'cleneniaDph', 'PD'], [randomUUID(), 'ciselneRady', 'PF']] as const) {
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,$4,$5,$5,'manual') ON CONFLICT DO NOTHING`,
      [cid, seeded.tenantId, seeded.organizationId, kind, `${code}-${id.slice(0, 4)}`],
    );
  }
  const lists = await database.query<{ id: string; kind: string } & Record<string, unknown>>(
    'SELECT id, kind FROM code_list_items WHERE tenant_id=$1 AND organization_id=$2',
    [seeded.tenantId, seeded.organizationId],
  );
  const byKind = (kind: string) => lists.rows.find((row) => row.kind === kind)!.id;
  await database.query(
    `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
     VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,$5::jsonb,$6,'EUR')`,
    [id, seeded.tenantId, seeded.organizationId,
      JSON.stringify({
        dodavatel: { nazov: 'Dodávateľ s.r.o.' }, odberatel: {}, cisloFaktury: `F-${id.slice(0, 6)}`,
        datumVystavenia: '2026-07-01', datumDodania: '2026-07-01', datumSplatnosti: '2026-07-20',
        mena: 'EUR', rozpisDph: [{ sadzba: 23, zaklad: Math.round((total / 1.23) * 100) / 100, dph: Math.round((total - total / 1.23) * 100) / 100 }],
        sumaSpolu: total, polozky: [],
      }),
      JSON.stringify({ predkontaciaId: byKind('predkontacie'), clenenieDphId: byKind('cleneniaDph'), ciselnyRadId: byKind('ciselneRady') }),
      total],
  );
  return id;
}

describe('schvaľovanie podľa sumy', () => {
  it('účtovník nesmie schváliť doklad nad prahom; schvaľovateľ áno; admin vždy', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const adminLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const adminHeaders = sessionHeaders(adminLogin);

    // Admin nastaví pravidlo: od 1000 € schvaľuje schvaľovateľ.
    const ruleSaved = await app.inject({
      method: 'PUT',
      url: `/api/organizations/${seeded.organizationId}/approval-rule`,
      headers: adminHeaders,
      payload: { minAmount: 1000, requiredRole: 'schvalovatel', active: true },
    });
    expect(ruleSaved.statusCode).toBe(200);

    // Účtovník: pod prahom prejde, nad prahom 403 approval_threshold.
    const uctovnikId = randomUUID();
    await database.query(
      `INSERT INTO users (id,tenant_id,name,email,password_hash,role)
       SELECT $1, tenant_id, 'Účtovník', 'uctovnik@test.sk', password_hash, 'uctovnik' FROM users WHERE id=$2`,
      [uctovnikId, seeded.userId],
    );
    await database.query('INSERT INTO organization_memberships (user_id,organization_id,tenant_id) VALUES ($1,$2,$3)', [uctovnikId, seeded.organizationId, seeded.tenantId]);
    const uctovnikLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'uctovnik@test.sk', password: seeded.password } });
    const uctovnikHeaders = sessionHeaders(uctovnikLogin);

    const small = await insertReadyDocument(database, seeded, 500);
    const smallApprove = await app.inject({ method: 'POST', url: `/api/documents/${small}/approve`, headers: uctovnikHeaders, payload: { expectedVersion: 1 } });
    expect(smallApprove.statusCode).toBe(200);

    const big = await insertReadyDocument(database, seeded, 2500);
    const bigBlocked = await app.inject({ method: 'POST', url: `/api/documents/${big}/approve`, headers: uctovnikHeaders, payload: { expectedVersion: 1 } });
    expect(bigBlocked.statusCode).toBe(403);
    expect(bigBlocked.json().code).toBe('approval_threshold');

    // Schvaľovateľ nad prahom prejde.
    const schvalovatelId = randomUUID();
    await database.query(
      `INSERT INTO users (id,tenant_id,name,email,password_hash,role)
       SELECT $1, tenant_id, 'Schvaľovateľ', 'schvalovatel@test.sk', password_hash, 'schvalovatel' FROM users WHERE id=$2`,
      [schvalovatelId, seeded.userId],
    );
    await database.query('INSERT INTO organization_memberships (user_id,organization_id,tenant_id) VALUES ($1,$2,$3)', [schvalovatelId, seeded.organizationId, seeded.tenantId]);
    const schvalovatelLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'schvalovatel@test.sk', password: seeded.password } });
    const bigApproved = await app.inject({ method: 'POST', url: `/api/documents/${big}/approve`, headers: sessionHeaders(schvalovatelLogin), payload: { expectedVersion: 1 } });
    expect(bigApproved.statusCode).toBe(200);

    // Admin vždy: ďalší veľký doklad schváli aj admin sám.
    const big2 = await insertReadyDocument(database, seeded, 9999);
    const adminApproved = await app.inject({ method: 'POST', url: `/api/documents/${big2}/approve`, headers: adminHeaders, payload: { expectedVersion: 1 } });
    expect(adminApproved.statusCode).toBe(200);
    await app.close();
  }, 120_000);
});
