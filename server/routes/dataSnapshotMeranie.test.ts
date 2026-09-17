import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { MemoryObjectStorage } from '../storage.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

// Meranie presnosti vloží na pár sekúnd náhradný doklad do tabuľky dokladov —
// kostru bez rozpisu DPH a sumy. Snapshot ho posielal ďalej, UI na ňom padlo,
// a počas sebakontroly ostala aplikácia biela každému, kto mal firmu v prístupe.
describe('náhradný doklad merania presnosti', () => {
  it('sa nedostane ani do snapshotu, ani do zoznamu dokladov', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password },
    });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };

    const skutocny = randomUUID();
    const nahradny = randomUUID();
    for (const [id, source] of [[skutocny, '{"typ":"upload"}'], [nahradny, '{"meranie":true}']] as const) {
      await database.query(
        `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,
           source,extracted,accounting,total_amount,currency)
         VALUES ($1,$2,$3,'FV','na_kontrole','ready_for_review',$4::jsonb,'{}'::jsonb,'{}'::jsonb,100,'EUR')`,
        [id, seeded.tenantId, seeded.organizationId, source],
      );
    }

    const snapshot = await app.inject({ method: 'GET', url: '/api/data/snapshot', headers });
    expect(snapshot.statusCode, snapshot.body).toBe(200);
    const vSnapshote = (snapshot.json().documents as Array<{ id: string }>).map((doklad) => doklad.id);
    expect(vSnapshote).toContain(skutocny);
    expect(vSnapshote).not.toContain(nahradny);

    const zoznam = await app.inject({ method: 'GET', url: '/api/documents', headers });
    expect(zoznam.statusCode, zoznam.body).toBe(200);
    const vZozname = (zoznam.json() as Array<{ id: string }>).map((doklad) => doklad.id);
    expect(vZozname).toContain(skutocny);
    expect(vZozname).not.toContain(nahradny);
  }, 90_000);
});

// Vlastník otvoril doklad, kým na ňom ešte bežala AI. Zoznam o tom nemal ako
// vedieť: stav spracovania hlásil na hotovej extrakcii „ready_for_review", aj
// keď vo fronte stál nový návrh zaúčtovania. Preto snapshot posiela ku každému
// dokladu krok, ktorý na ňom ešte beží — a prázdny znamená „môže sa otvoriť".
describe('prebiehajúci krok spracovania v snapshote', () => {
  it('nesie sa len k dokladu s čakajúcim alebo bežiacim jobom', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password },
    });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0] };

    const doklad = async (status: string, processingStatus: string) => {
      const id = randomUUID();
      await database.query(
        `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,
           source,extracted,accounting,total_amount,currency)
         VALUES ($1,$2,$3,'FP',$4,$5,'{"typ":"email"}'::jsonb,'{}'::jsonb,'{}'::jsonb,100,'EUR')`,
        [id, seeded.tenantId, seeded.organizationId, status, processingStatus],
      );
      return id;
    };
    const job = async (documentId: string, kind: string, jobStatus: string) => database.query(
      `INSERT INTO processing_jobs (id,tenant_id,organization_id,document_id,kind,status,correlation_id)
       VALUES ($1,$2,$3,$4,$5,$6,'test')`,
      [randomUUID(), seeded.tenantId, seeded.organizationId, documentId, kind, jobStatus],
    );

    const extrahuje = await doklad('novy', 'extracting');
    await job(extrahuje, 'extract_document', 'running');
    const navrh = await doklad('na_kontrole', 'ready_for_review');
    await job(navrh, 'navrh_zauctovania', 'queued');
    // Dokončený doklad: job je 'succeeded', takže krok sa už neposiela — aj keď
    // extrakcia nič nenašla, doklad musí ostať otvoriteľný.
    const hotovy = await doklad('extrahovany', 'ready_for_review');
    await job(hotovy, 'extract_document', 'succeeded');
    // Trvalo zlyhaná extrakcia je koncový verdikt: job je 'failed' a účtovník
    // musí mať doklad ako opraviť.
    const zlyhany = await doklad('chyba', 'failed_permanent');
    await job(zlyhany, 'extract_document', 'failed');
    const karantena = await doklad('karantena', 'ready_for_review');

    const snapshot = await app.inject({ method: 'GET', url: '/api/data/snapshot', headers });
    expect(snapshot.statusCode, snapshot.body).toBe(200);
    const kroky = new Map((snapshot.json().documents as Array<{ id: string; prebiehajuciKrok?: string }>)
      .map((row) => [row.id, row.prebiehajuciKrok]));
    expect(kroky.get(extrahuje)).toBe('extrakcia');
    expect(kroky.get(navrh)).toBe('zauctovanie');
    expect(kroky.get(hotovy)).toBeUndefined();
    expect(kroky.get(zlyhany)).toBeUndefined();
    expect(kroky.get(karantena)).toBeUndefined();
    await app.close();
  }, 90_000);
});
