// „Prečo?" — provenience zaúčtovania dokladu + dôvod pravidla.
// Kritický test: izolácia organizácií V RÁMCI jedného tenanta — cross-tenant
// prípad chráni requireOrganizationAccess, cross-org v tenante musí chrániť
// tento endpoint sám (DB nemá RLS).
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { MemoryObjectStorage } from '../storage.js';
import { precoVysvetlenie } from '../services/precoVysvetlenieService.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

function sessionHeaders(response: { headers: Record<string, unknown>; json(): any }) {
  const cookie = String(response.headers['set-cookie']).split(';')[0];
  const csrf = response.json().csrfToken as string;
  return { cookie, 'x-csrf-token': csrf };
}

async function seedDocumentWithSuggestion(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
  scope: { tenantId: string; organizationId: string },
  options?: { ruleDovod?: string },
) {
  const predkontaciaId = randomUUID();
  const clenenieDphId = randomUUID();
  const ruleId = randomUUID();
  const documentId = randomUUID();
  await database.query(
    `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
     VALUES ($1,$3,$4,'predkontacie','518200 prepr.','Preprava',      'manual'),
            ($2,$3,$4,'cleneniaDph', 'PZ',           'Samozdanenie',  'manual')`,
    [predkontaciaId, clenenieDphId, scope.tenantId, scope.organizationId],
  );
  await database.query(
    `INSERT INTO accounting_rules (id,tenant_id,organization_id,supplier_ico,supplier_name_normalized,predkontacia_id,clenenie_dph_id,origin,dovod,dovod_source)
     VALUES ($1,$2,$3,'99887766','hapag lloyd',$4,$5,'ai',$6,CASE WHEN $6::text IS NULL THEN NULL ELSE 'ai_draft' END)`,
    [ruleId, scope.tenantId, scope.organizationId, predkontaciaId, clenenieDphId, options?.ruleDovod ?? null],
  );
  await database.query(
    `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
     VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,$4::jsonb,100,'EUR')`,
    [documentId, scope.tenantId, scope.organizationId,
      JSON.stringify({ predkontaciaId, clenenieDphId, clenenieKvKod: 'B1' })],
  );
  await database.query(
    `INSERT INTO accounting_suggestions (document_id,tenant_id,organization_id,predkontacia_id,clenenie_dph_id,clenenie_kv_kod,source,confidence,reason,rule_id)
     VALUES ($1,$2,$3,$4,$5,'B1','manual_rule',1.0,'Zhoda s pravidlom dodávateľa.',$6)`,
    [documentId, scope.tenantId, scope.organizationId, predkontaciaId, clenenieDphId, ruleId],
  );
  return { documentId, ruleId, predkontaciaId, clenenieDphId };
}

describe('Prečo? — provenience zaúčtovania', () => {
  it('vráti zdroj, istotu, pravidlo aj názvy kódov; dôvod po zápise človekom', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);
    const { documentId, ruleId, predkontaciaId } = await seedDocumentWithSuggestion(database, seeded, { ruleDovod: 'AI: zahraničný prepravca — samozdanenie.' });

    const preco = await app.inject({ method: 'GET', url: `/api/documents/${documentId}/preco`, headers });
    expect(preco.statusCode).toBe(200);
    const body = preco.json();
    expect(body.source).toBe('manual_rule');
    expect(body.confidence).toBe(1);
    expect(body.reason).toContain('pravidlom');
    expect(body.polozky[predkontaciaId].kod).toBe('518200 prepr.');
    expect(body.pravidlo.id).toBe(ruleId);
    expect(body.pravidlo.dovodSource).toBe('ai_draft');
    expect(body.pravidlo.navrhnutePre).toBe(1);
    expect(body.navrh.predkontaciaId).toBe(predkontaciaId);
    expect(body.aktualne.predkontaciaId).toBe(predkontaciaId);

    // Účtovník dôvod prepíše — stane sa praxou firmy (human).
    const save = await app.inject({
      method: 'POST',
      url: `/api/organizations/${seeded.organizationId}/ai-training/rules/${ruleId}/dovod`,
      headers,
      payload: { dovod: 'Zahraniční prepravcovia na 518200 §69, nie -tuz.' },
    });
    expect(save.statusCode).toBe(200);
    const after = (await app.inject({ method: 'GET', url: `/api/documents/${documentId}/preco`, headers })).json();
    expect(after.pravidlo.dovod).toContain('518200');
    expect(after.pravidlo.dovodSource).toBe('human');
  }, 120_000);

  it('izolácia: doklad cudzej organizácie v tom istom tenante → 404', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    // Organizácia B v TOM ISTOM tenante, používateľ v nej nemá členstvo.
    const orgB = randomUUID();
    await database.query(
      `INSERT INTO organizations (id,tenant_id,name,ico,dic,color) VALUES ($1,$2,'Cudzia s.r.o.','87654321','2020654321','#333333')`,
      [orgB, seeded.tenantId],
    );
    const cudzi = await seedDocumentWithSuggestion(database, { tenantId: seeded.tenantId, organizationId: orgB });

    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);

    const preco = await app.inject({ method: 'GET', url: `/api/documents/${cudzi.documentId}/preco`, headers });
    expect(preco.statusCode).toBe(404);
    const dovod = await app.inject({
      method: 'POST',
      url: `/api/organizations/${orgB}/ai-training/rules/${cudzi.ruleId}/dovod`,
      headers,
      payload: { dovod: 'pokus o zápis' },
    });
    expect(dovod.statusCode).toBe(404);
  }, 120_000);

  it('doklad bez návrhu → source none, bez pravidla', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const documentId = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review','{}'::jsonb,'{}'::jsonb,50,'EUR')`,
      [documentId, seeded.tenantId, seeded.organizationId],
    );
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);
    const preco = await app.inject({ method: 'GET', url: `/api/documents/${documentId}/preco`, headers });
    expect(preco.statusCode).toBe(200);
    expect(preco.json().source).toBe('none');
    expect(preco.json().pravidlo).toBeNull();
  }, 120_000);
});

describe('Prečo? — AI vysvetlenie', () => {
  it('vygeneruje raz, kešuje, účtuje spotrebu; prepočet návrhu kešu nuluje', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const { documentId } = await seedDocumentWithSuggestion(database, seeded, { ruleDovod: 'Zahraniční prepravcovia — samozdanenie.' });
    const scope = { tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId };

    let calls = 0;
    const parser = {
      parse: async () => {
        calls += 1;
        return { output_parsed: { vysvetlenie: 'Návrh vychádza z pravidla pre Hapag-Lloyd.' }, usage: { input_tokens: 900, output_tokens: 60 } };
      },
    };

    const first = await precoVysvetlenie(database, testConfig(), scope, parser);
    expect(first).toContain('pravidla');
    // Druhé volanie ide z keše — parser sa už nevolá.
    const second = await precoVysvetlenie(database, testConfig(), scope, parser);
    expect(second).toBe(first);
    expect(calls).toBe(1);

    const run = await database.query<{ prompt_version: string } & Record<string, unknown>>(
      `SELECT prompt_version FROM extraction_runs WHERE document_id=$1 AND prompt_version='preco-vysvetlenie-v1'`,
      [documentId],
    );
    expect(run.rowCount).toBe(1);

    // Prepočet návrhu (upsert) kešované vysvetlenie nuluje.
    await database.query(
      `INSERT INTO accounting_suggestions (document_id,tenant_id,organization_id,source,confidence,reason)
       VALUES ($1,$2,$3,'organization_default',0.5,'Predvoľba organizácie.')
       ON CONFLICT (document_id) DO UPDATE SET
         source=excluded.source, confidence=excluded.confidence, reason=excluded.reason,
         vysvetlenie=NULL, updated_at=now()`,
      [documentId, seeded.tenantId, seeded.organizationId],
    );
    await precoVysvetlenie(database, testConfig(), scope, parser);
    expect(calls).toBe(2);
  }, 120_000);

  it('bez API kľúča a bez injected parsera vráti null (best-effort)', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const { documentId } = await seedDocumentWithSuggestion(database, seeded);
    const result = await precoVysvetlenie(database, testConfig(), {
      tenantId: seeded.tenantId, organizationId: seeded.organizationId, documentId,
    });
    expect(result).toBeNull();
  }, 120_000);
});
