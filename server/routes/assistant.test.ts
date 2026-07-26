// Asistent firmy: dôkazy zbiera server, model dostane len fakty jednej firmy.
// Kritické testy: cross-org izolácia v rámci tenanta, zahodenie zdroja mimo
// bieleho zoznamu a priloženie firemného dokumentu k otázke.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { MemoryObjectStorage } from '../storage.js';
import { zozbierajDokazy } from '../services/assistantService.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

function sessionHeaders(response: { headers: Record<string, unknown>; json(): any }) {
  const cookie = String(response.headers['set-cookie']).split(';')[0];
  const csrf = response.json().csrfToken as string;
  return { cookie, 'x-csrf-token': csrf };
}

/** Pravidlo + potvrdené rozhodnutie, aby mala firma čo „vedieť". */
async function seedZnalosti(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
  scope: { tenantId: string; organizationId: string },
  options: { dodavatel: string; predkontacia: string; dovod?: string },
) {
  const predkontaciaId = randomUUID();
  await database.query(
    `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
     VALUES ($1,$2,$3,'predkontacie',$4,'Testovacia predkontácia','manual')`,
    [predkontaciaId, scope.tenantId, scope.organizationId, options.predkontacia],
  );
  await database.query(
    `INSERT INTO accounting_rules (id,tenant_id,organization_id,supplier_name_normalized,predkontacia_id,origin,dovod,dovod_source)
     VALUES ($1,$2,$3,$4,$5,'manual',$6,CASE WHEN $6::text IS NULL THEN NULL ELSE 'human' END)`,
    [randomUUID(), scope.tenantId, scope.organizationId, options.dodavatel, predkontaciaId, options.dovod ?? null],
  );
  await database.query(
    `INSERT INTO ucto_decisions (id,tenant_id,organization_id,supplier_name_normalized,line_text_normalized,predkontacia_id,source)
     VALUES ($1,$2,$3,$4,$5,$6,'approved')`,
    [randomUUID(), scope.tenantId, scope.organizationId, options.dodavatel, `${options.dodavatel} preprava kontajnera`, predkontaciaId],
  );
  return { predkontaciaId };
}

describe('Asistent — zber dôkazov', () => {
  it('dôkazy obsahujú iba dáta vlastnej organizácie (cudzia org v tom istom tenante)', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const orgB = randomUUID();
    await database.query(
      `INSERT INTO organizations (id,tenant_id,name,ico,dic,color) VALUES ($1,$2,'Cudzia s.r.o.','87654321','2020654321','#333')`,
      [orgB, seeded.tenantId],
    );
    await seedZnalosti(database, seeded, { dodavatel: 'hapag lloyd', predkontacia: '518200', dovod: 'Zahraničná preprava.' });
    await seedZnalosti(database, { tenantId: seeded.tenantId, organizationId: orgB }, { dodavatel: 'tajny dodavatel b', predkontacia: '501999' });

    const dokazy = await zozbierajDokazy(database, { tenantId: seeded.tenantId, organizationId: seeded.organizationId }, { otazka: 'preprava' });
    const serialized = JSON.stringify(dokazy);
    expect(serialized).toContain('hapag lloyd');
    expect(serialized).not.toContain('tajny dodavatel b');
    expect(serialized).not.toContain('501999');
    expect(dokazy.pravidla[0].dovodZdroj).toBe('human');
    expect(dokazy.pouzivanePredkontacie.map((p) => p.kod)).toEqual(['518200']);
  }, 120_000);

  it('doklad cudzej organizácie sa do dôkazov nedostane', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const orgB = randomUUID();
    await database.query(
      `INSERT INTO organizations (id,tenant_id,name,ico,dic,color) VALUES ($1,$2,'Cudzia s.r.o.','87654321','2020654321','#333')`,
      [orgB, seeded.tenantId],
    );
    const cudziDoklad = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,999,'EUR')`,
      [cudziDoklad, seeded.tenantId, orgB, JSON.stringify({ dodavatel: { nazov: 'CUDZI DODAVATEL' } })],
    );
    const dokazy = await zozbierajDokazy(
      database,
      { tenantId: seeded.tenantId, organizationId: seeded.organizationId },
      { otazka: 'čo je toto', documentId: cudziDoklad },
    );
    expect(dokazy.otvorenyDoklad).toBeUndefined();
    expect(JSON.stringify(dokazy)).not.toContain('CUDZI DODAVATEL');
  }, 120_000);
});

describe('Asistent — odpoveď', () => {
  it('odpovie, zahodí zdroj mimo bieleho zoznamu a zaloguje spotrebu', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    await seedZnalosti(database, seeded, { dodavatel: 'hapag lloyd', predkontacia: '518200', dovod: 'Zahraničná preprava — samozdanenie.' });

    let videnyVstup: any;
    const assistantParser = {
      parse: async (payload: any) => {
        videnyVstup = payload;
        return {
          output_parsed: {
            odpoved: 'Tohto dodávateľa účtujete na 518200.',
            answerability: 'grounded',
            istota: 'vysoka',
            zdroje: [
              { nazov: 'Finančná správa', url: 'https://www.financnasprava.sk/sk/metodicke-pokyny' },
              { nazov: 'Podvrh', url: 'https://evil.example.com/x' },
            ],
          },
          usage: { input_tokens: 1200, output_tokens: 90 },
        };
      },
    };
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false, assistantParser });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);

    const response = await app.inject({
      method: 'POST',
      url: `/api/organizations/${seeded.organizationId}/assistant/ask`,
      headers,
      payload: { otazka: 'Ako účtujeme Hapag-Lloyd?' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.odpoved).toContain('518200');
    expect(body.threadId).toBeTruthy();
    expect(body.answerability).toBe('grounded');
    expect(body.zdroje).toHaveLength(1);
    expect(body.zdroje[0].url).toContain('financnasprava.sk');

    // Model dostal dôkazy firmy a hľadá len na povolených doménach.
    const poslane = JSON.parse(videnyVstup.input[0].content.at(-1).text);
    expect(poslane.dokazy.pravidla[0].dovod).toContain('samozdanenie');
    expect(videnyVstup.tools[0].filters.allowed_domains).toContain('financnasprava.sk');

    const run = await database.query(
      `SELECT id FROM extraction_runs WHERE prompt_version='assistant-v1' AND organization_id=$1`,
      [seeded.organizationId],
    );
    expect(run.rowCount).toBe(1);
  }, 120_000);

  it('otázka na cudziu organizáciu → 404 (bez prezradenia existencie)', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const orgB = randomUUID();
    await database.query(
      `INSERT INTO organizations (id,tenant_id,name,ico,dic,color) VALUES ($1,$2,'Cudzia s.r.o.','87654321','2020654321','#333')`,
      [orgB, seeded.tenantId],
    );
    const app = await buildApp({
      database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false,
      assistantParser: { parse: async () => ({ output_parsed: { odpoved: 'x', answerability: 'grounded', istota: 'vysoka', zdroje: [] } }) },
    });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const response = await app.inject({
      method: 'POST',
      url: `/api/organizations/${orgB}/assistant/ask`,
      headers: sessionHeaders(login),
      payload: { otazka: 'Ako účtuje táto firma?' },
    });
    expect(response.statusCode).toBe(404);
  }, 120_000);

  it('história: prvá otázka založí vlákno, druhá doň pribudne a model dostane predošlé správy', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    await seedZnalosti(database, seeded, { dodavatel: 'hapag lloyd', predkontacia: '518200' });

    const videneHistorie: unknown[] = [];
    let poradie = 0;
    const app = await buildApp({
      database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false,
      assistantParser: {
        parse: async (payload: any) => {
          videneHistorie.push(JSON.parse(payload.input[0].content.at(-1).text).historia);
          poradie += 1;
          return {
            output_parsed: { odpoved: `odpoveď ${poradie}`, answerability: 'grounded', istota: 'vysoka', zdroje: [] },
          };
        },
      },
    });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);
    const url = `/api/organizations/${seeded.organizationId}/assistant/ask`;

    const prva = await app.inject({ method: 'POST', url, headers, payload: { otazka: 'Prvá otázka o preprave?' } });
    const threadId = prva.json().threadId;
    expect(videneHistorie[0]).toEqual([]);

    const druha = await app.inject({ method: 'POST', url, headers, payload: { otazka: 'A druhá otázka?', threadId } });
    expect(druha.json().threadId).toBe(threadId);
    // Históriu berie server z vlákna, nie od klienta.
    expect(videneHistorie[1]).toEqual([
      { rola: 'pouzivatel', text: 'Prvá otázka o preprave?' },
      { rola: 'asistent', text: 'odpoveď 1' },
    ]);

    const zoznam = await app.inject({ method: 'GET', url: `/api/organizations/${seeded.organizationId}/assistant/threads`, headers });
    expect(zoznam.json()).toHaveLength(1);
    expect(zoznam.json()[0].title).toBe('Prvá otázka o preprave?');
    expect(zoznam.json()[0].pocetSprav).toBe(4);

    const detail = await app.inject({ method: 'GET', url: `/api/organizations/${seeded.organizationId}/assistant/threads/${threadId}`, headers });
    expect(detail.json().spravy.map((s: any) => s.text)).toEqual(['Prvá otázka o preprave?', 'odpoveď 1', 'A druhá otázka?', 'odpoveď 2']);

    const zmazanie = await app.inject({ method: 'DELETE', url: `/api/organizations/${seeded.organizationId}/assistant/threads/${threadId}`, headers });
    expect(zmazanie.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/organizations/${seeded.organizationId}/assistant/threads`, headers })).json()).toHaveLength(0);
  }, 120_000);

  it('história: vlákno cudzej organizácie sa nedá otvoriť ani použiť', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const orgB = randomUUID();
    await database.query(
      `INSERT INTO organizations (id,tenant_id,name,ico,dic,color) VALUES ($1,$2,'Cudzia s.r.o.','87654321','2020654321','#333')`,
      [orgB, seeded.tenantId],
    );
    const cudzieVlakno = randomUUID();
    await database.query(
      `INSERT INTO assistant_threads (id,tenant_id,organization_id,title,messages)
       VALUES ($1,$2,$3,'Cudzi chat','[{"rola":"pouzivatel","text":"TAJNE"}]'::jsonb)`,
      [cudzieVlakno, seeded.tenantId, orgB],
    );
    const app = await buildApp({
      database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false,
      assistantParser: { parse: async () => ({ output_parsed: { odpoved: 'x', answerability: 'grounded', istota: 'vysoka', zdroje: [] } }) },
    });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);

    // Cez vlastnú (dostupnú) organizáciu sa cudzie vlákno nenájde.
    const detail = await app.inject({
      method: 'GET',
      url: `/api/organizations/${seeded.organizationId}/assistant/threads/${cudzieVlakno}`,
      headers,
    });
    expect(detail.statusCode).toBe(404);
    const pouzitie = await app.inject({
      method: 'POST',
      url: `/api/organizations/${seeded.organizationId}/assistant/ask`,
      headers,
      payload: { otazka: 'Pokračuj', threadId: cudzieVlakno },
    });
    expect(pouzitie.statusCode).toBe(404);
  }, 120_000);

  it('priložený firemný dokument ide modelu ako input_file', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const storage = new MemoryObjectStorage();
    const storageKey = `org-docs/${randomUUID()}.pdf`;
    await storage.put(storageKey, new TextEncoder().encode('%PDF-1.4 usmernenie'), 'application/pdf');
    const prilohaId = randomUUID();
    await database.query(
      `INSERT INTO organization_documents (id,tenant_id,organization_id,file_name,mime_type,byte_size,sha256,storage_key)
       VALUES ($1,$2,$3,'usmernenie.pdf','application/pdf',19,'abc',$4)`,
      [prilohaId, seeded.tenantId, seeded.organizationId, storageKey],
    );

    let videnyVstup: any;
    const app = await buildApp({
      database, storage, config: testConfig(), logger: false,
      assistantParser: {
        parse: async (payload: any) => {
          videnyVstup = payload;
          return { output_parsed: { odpoved: 'Podľa priloženého dokumentu…', answerability: 'grounded', istota: 'vysoka', zdroje: [] } };
        },
      },
    });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const response = await app.inject({
      method: 'POST',
      url: `/api/organizations/${seeded.organizationId}/assistant/ask`,
      headers: sessionHeaders(login),
      payload: { otazka: 'Čo hovorí toto usmernenie?', prilohaId },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().pouzitaPriloha).toBe('usmernenie.pdf');
    const priloha = videnyVstup.input[0].content[0];
    expect(priloha.type).toBe('input_file');
    expect(priloha.filename).toBe('usmernenie.pdf');
    expect(String(priloha.file_data)).toContain('data:application/pdf;base64,');
  }, 120_000);
});
