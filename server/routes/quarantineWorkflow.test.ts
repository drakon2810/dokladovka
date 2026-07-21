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

async function insertProblemDocument(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
  seeded: { tenantId: string; organizationId: string },
  status: 'karantena' | 'duplicita' | 'chyba',
  quarantineReason: string | null,
): Promise<string> {
  const id = randomUUID();
  for (const [kind, code] of [['predkontacie', '518'], ['cleneniaDph', 'PD'], ['ciselneRady', 'PF']] as const) {
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,$4,$5,$5,'manual') ON CONFLICT DO NOTHING`,
      [randomUUID(), seeded.tenantId, seeded.organizationId, kind, `${code}-${id.slice(0, 4)}`],
    );
  }
  const lists = await database.query<{ id: string; kind: string } & Record<string, unknown>>(
    'SELECT id, kind FROM code_list_items WHERE tenant_id=$1 AND organization_id=$2',
    [seeded.tenantId, seeded.organizationId],
  );
  const byKind = (kind: string) => lists.rows.find((row) => row.kind === kind)!.id;
  await database.query(
    `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency,quarantine_reason)
     VALUES ($1,$2,$3,'FP',$4,'ready_for_review',$5::jsonb,$6::jsonb,$7,'EUR',$8)`,
    [id, seeded.tenantId, seeded.organizationId, status,
      JSON.stringify({
        dodavatel: { nazov: 'Dodávateľ s.r.o.' }, odberatel: {}, cisloFaktury: `F-${id.slice(0, 6)}`,
        // Splatnosť pred vystavením — po novom len varovanie, schválenie neblokuje.
        datumVystavenia: '2026-07-10', datumDodania: '2026-07-10', datumSplatnosti: '2026-07-05',
        mena: 'EUR', rozpisDph: [{ sadzba: 23, zaklad: 100, dph: 23 }],
        sumaSpolu: 123, polozky: [],
      }),
      JSON.stringify({ predkontaciaId: byKind('predkontacie'), clenenieDphId: byKind('cleneniaDph'), ciselnyRadId: byKind('ciselneRady') }),
      123, quarantineReason],
  );
  return id;
}

describe('schvaľovanie problémových dokladov', () => {
  it('karanténny doklad: priama Schváliť zlyhá, po Spracovať ručne prejde', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const adminHeaders = sessionHeaders(
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } }),
    );

    const id = await insertProblemDocument(database, seeded, 'karantena', 'buyer_ico_mismatch');

    // Priame schválenie karanténneho dokladu je zablokované stavom.
    const blocked = await app.inject({ method: 'POST', url: `/api/documents/${id}/approve`, headers: adminHeaders, payload: { expectedVersion: 1 } });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('document_not_ready');

    // Spracovať ručne → na_kontrole (a vyčistí sa dôvod karantény).
    const manual = await app.inject({ method: 'POST', url: `/api/documents/${id}/process-manually`, headers: adminHeaders });
    expect(manual.statusCode).toBe(200);
    expect(manual.json().status).toBe('na_kontrole');
    expect(manual.json().quarantine_reason).toBeNull();

    // Teraz Schváliť prejde — splatnosť pred vystavením je len varovanie.
    const approved = await app.inject({ method: 'POST', url: `/api/documents/${id}/approve`, headers: adminHeaders, payload: { expectedVersion: manual.json().version } });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe('schvaleny');
    await app.close();
  }, 120_000);

  it('duplicita: „Nie je duplicita" nastaví príznak a presunie na kontrolu', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const adminHeaders = sessionHeaders(
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } }),
    );

    const id = await insertProblemDocument(database, seeded, 'duplicita', null);
    const decision = await app.inject({ method: 'POST', url: `/api/documents/${id}/not-duplicate`, headers: adminHeaders });
    expect(decision.statusCode).toBe(200);
    expect(decision.json().status).toBe('na_kontrole');
    expect(decision.json().not_duplicate).toBe(true);
    await app.close();
  }, 120_000);

  it('schvaľovateľ nemá právo prevziať doklad na ručné spracovanie', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });

    const schvalovatelId = randomUUID();
    await database.query(
      `INSERT INTO users (id,tenant_id,name,email,password_hash,role)
       SELECT $1, tenant_id, 'Schvaľovateľ', 'schvalovatel@test.sk', password_hash, 'schvalovatel' FROM users WHERE id=$2`,
      [schvalovatelId, seeded.userId],
    );
    await database.query('INSERT INTO organization_memberships (user_id,organization_id,tenant_id) VALUES ($1,$2,$3)', [schvalovatelId, seeded.organizationId, seeded.tenantId]);
    const headers = sessionHeaders(
      await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'schvalovatel@test.sk', password: seeded.password } }),
    );

    const id = await insertProblemDocument(database, seeded, 'karantena', 'buyer_ico_mismatch');
    const manual = await app.inject({ method: 'POST', url: `/api/documents/${id}/process-manually`, headers });
    expect(manual.statusCode).toBe(403);
    await app.close();
  }, 120_000);
});
