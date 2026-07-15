import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { MemoryObjectStorage } from './storage.js';
import { createTestDatabase, seedTestUser, testConfig } from './testHelpers.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

describe('agent backend contour', () => {
  it('pairs once, syncs code lists and confirms an export idempotently', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });

    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    const csrf = login.json().csrfToken as string;
    const browserHeaders = { cookie, 'x-csrf-token': csrf };

    const enabled = await app.inject({ method: 'PUT', url: '/api/mostik/settings', headers: browserHeaders, payload: { enabled: true } });
    expect(enabled.statusCode).toBe(200);
    const pairing = await app.inject({ method: 'POST', url: '/api/mostik/pairing-codes', headers: browserHeaders });
    expect(pairing.statusCode).toBe(201);
    const code = pairing.json().code as string;
    const paired = await app.inject({ method: 'POST', url: '/api/agent/pair', payload: { pairingCode: code, hostname: 'POHODA-SRV', agentVersion: '1.0.0' } });
    expect(paired.statusCode).toBe(201);
    const agentHeaders = { authorization: `Bearer ${paired.json().agentToken as string}` };
    const replay = await app.inject({ method: 'POST', url: '/api/agent/pair', payload: { pairingCode: code, hostname: 'OTHER', agentVersion: '1.0.0' } });
    expect(replay.statusCode).toBe(400);

    const heartbeat = await app.inject({
      method: 'POST',
      url: '/api/agent/heartbeat',
      headers: agentHeaders,
      payload: { companies: [{ ico: '12345678', dbName: 'StwPh_12345678_2026', uctovnyRok: '2026' }], agentVersion: '1.0.1' },
    });
    expect(heartbeat.statusCode).toBe(200);
    const organizations = await app.inject({ method: 'GET', url: '/api/agent/organizations', headers: agentHeaders });
    expect(organizations.statusCode, organizations.body).toBe(200);
    expect(organizations.json()).toContainEqual(expect.objectContaining({ organizationId: seeded.organizationId }));

    const syncedIds: Record<string, string> = {};
    for (const [kind, kod] of [['predkontacie', '518/321'], ['cleneniaDph', 'PD'], ['ciselneRady', '26FP']] as const) {
      const synced = await app.inject({
        method: 'PUT',
        url: `/api/agent/organizations/${seeded.organizationId}/code-lists`,
        headers: agentHeaders,
        payload: { kind, items: [{ kod, nazov: kod }] },
      });
      expect(synced.statusCode, synced.body).toBe(200);
      const row = await database.query<{ id: string } & Record<string, unknown>>(
        'SELECT id FROM code_list_items WHERE tenant_id=$1 AND organization_id=$2 AND kind=$3 AND code=$4',
        [seeded.tenantId, seeded.organizationId, kind, kod],
      );
      syncedIds[kind] = row.rows[0].id;
    }

    const documentId = randomUUID();
    const snapshot = {
      version: 1,
      approvedAt: new Date().toISOString(),
      typ: 'FP',
      extracted: {
        dodavatel: { nazov: 'Dodávateľ s.r.o.', ico: '87654321', dic: '2020999999' },
        cisloFaktury: 'FV-2026-1',
        variabilnySymbol: '20260001',
        datumVystavenia: '2026-07-01',
        datumDodania: '2026-07-01',
        datumSplatnosti: '2026-07-15',
        mena: 'EUR',
        rozpisDph: [{ sadzba: 23, zaklad: 100, dph: 23 }],
        sumaSpolu: 123,
      },
      ucto: {
        predkontaciaId: syncedIds.predkontacie,
        clenenieDphId: syncedIds.cleneniaDph,
        ciselnyRadId: syncedIds.ciselneRady,
      },
    };
    await database.query(
      `INSERT INTO documents
        (id,tenant_id,organization_id,document_type,status,processing_status,source,extracted,accounting,
         confidence,total_amount,currency,version,approved_version,approved_snapshot)
       VALUES ($1,$2,$3,'FP','schvaleny','ready_for_review','{}'::jsonb,$4::jsonb,$5::jsonb,1,123,'EUR',1,1,$6::jsonb)`,
      [documentId, seeded.tenantId, seeded.organizationId, JSON.stringify(snapshot.extracted), JSON.stringify(snapshot.ucto), JSON.stringify(snapshot)],
    );

    const created = await app.inject({
      method: 'POST',
      url: '/api/mostik/export-jobs',
      headers: browserHeaders,
      payload: { organizationId: seeded.organizationId, documentIds: [documentId], idempotencyKey: 'test-export-1' },
    });
    expect(created.statusCode).toBe(201);
    const exportJobId = created.json().id as string;
    const queue = await app.inject({ method: 'GET', url: `/api/agent/export-queue?organizationId=${seeded.organizationId}`, headers: agentHeaders });
    expect(queue.statusCode).toBe(200);
    expect(queue.json()[0]).toMatchObject({ exportJobId, idempotencyKey: 'test-export-1' });
    expect(queue.json()[0].dataPackXml).toContain('ico="12345678"');

    const resultPayload = { exportJobId, perDocument: [{ documentId, state: 'ok', pohodaNumber: 'FP260001' }], rawResponseMeta: { responsePackState: 'ok' } };
    const result = await app.inject({ method: 'POST', url: '/api/agent/export-results', headers: agentHeaders, payload: resultPayload });
    expect(result.json()).toMatchObject({ accepted: true, idempotent: false, status: 'confirmed' });
    const repeated = await app.inject({ method: 'POST', url: '/api/agent/export-results', headers: agentHeaders, payload: resultPayload });
    expect(repeated.json()).toMatchObject({ accepted: true, idempotent: true, status: 'confirmed' });
    const document = await database.query<{ status: string; export_id: string } & Record<string, unknown>>('SELECT status, export_id FROM documents WHERE id=$1', [documentId]);
    expect(document.rows[0]).toEqual({ status: 'exportovany', export_id: exportJobId });

    await app.close();
  }, 90_000);
});
