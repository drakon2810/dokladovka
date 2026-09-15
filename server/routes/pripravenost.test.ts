import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { MemoryObjectStorage } from '../storage.js';
import { ANALYZA_KIND } from '../workerService.js';

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

// Firma dostane pri založení prázdne prepojenie na POHODU (len IČO). Snapshot
// z neho robil „Mostík spárovaný" a sprievodca hneď sťahoval číselníky z ničoho.
describe('GET /api/organizations/:id/pripravenost', () => {
  it('nová firma nie je pripravená; so živým agentom, databázou a dôkazmi áno', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0], 'x-csrf-token': login.json().csrfToken as string };

    const nova = await app.inject({
      method: 'POST', url: '/api/organizations', headers,
      payload: { nazov: 'Nová firma s.r.o.', ico: '87654321', dic: '2020999999', farba: '#0E7A5F' },
    });
    expect(nova.statusCode, nova.body).toBe(201);
    const novaId = nova.json().organization.id as string;

    const pripravenost = async (organizationId: string) => {
      const odpoved = await app.inject({ method: 'GET', url: `/api/organizations/${organizationId}/pripravenost`, headers });
      expect(odpoved.statusCode, odpoved.body).toBe(200);
      return odpoved.json();
    };
    const mostikVSnapshote = async () => {
      const snapshot = await app.inject({ method: 'GET', url: '/api/data/snapshot', headers });
      expect(snapshot.statusCode, snapshot.body).toBe(200);
      return Object.fromEntries((snapshot.json().pripravaFiriem as Array<{ organizationId: string; mostik: boolean }>)
        .map((riadok) => [riadok.organizationId, riadok.mostik]));
    };

    const novaPripravenost = await pripravenost(novaId);
    expect(novaPripravenost.stav).toBe('nepripravena');
    expect(novaPripravenost.signaly.firma).toMatchObject({ stav: 'caka', dovod: 'caka_na_agenta' });
    expect(await mostikVSnapshote()).toEqual({ [novaId]: false, [seeded.organizationId]: false });

    const scope = [seeded.tenantId, seeded.organizationId];
    const agentId = randomUUID();
    await database.query('UPDATE tenant_integrations SET mostik_enabled=true WHERE tenant_id=$1', [seeded.tenantId]);
    await database.query(
      `INSERT INTO agent_installations (id,tenant_id,name,hostname,token_hash,last_seen_at,agent_version,status)
       VALUES ($1,$2,'Agent','POHODA-SRV',$3,now(),'0.18.0','connected')`, [agentId, seeded.tenantId, randomUUID()],
    );
    // Agent je živý, ale firma ešte nemá databázu — spárovaná nie je.
    expect((await mostikVSnapshote())[seeded.organizationId]).toBe(false);
    expect((await pripravenost(seeded.organizationId)).signaly.firma).toMatchObject({ stav: 'caka', dovod: 'firma_nenajdena' });

    await database.query(
      `UPDATE pohoda_company_links SET db_name='StwPh_12345678_2026', accounting_year='2026', matched_at=now(), match_rule='auto_ico'
        WHERE tenant_id=$1 AND organization_id=$2`, scope,
    );
    for (const kind of ['predkontacie', 'cleneniaDph', 'ciselneRady']) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source) VALUES ($1,$2,$3,$4,'1','Položka','pohoda')`,
        [randomUUID(), ...scope, kind],
      );
      await database.query(
        `INSERT INTO agent_sync_runs (id,tenant_id,organization_id,agent_installation_id,kind,state,item_count)
         VALUES ($1,$2,$3,$4,$5,'ok',1)`, [randomUUID(), ...scope, agentId, kind],
      );
    }
    await database.query(
      `INSERT INTO pohoda_importy (id,tenant_id,organization_id,druh,stav,manifest,created_at,published_at)
       VALUES ($1,$2,$3,'historia','publikovany',$4::jsonb,now() - interval '2 hours',now() - interval '2 hours')`,
      [randomUUID(), ...scope, JSON.stringify({
        databaza: 'StwPh_12345678_2026', rok: 2026,
        agendy: [{ poziadavka: 'receivedInvoice', agenda: 'FP', stav: 'ok', dokladov: 12, poloziek: 30, riadkov: 42, preskocene: {} }],
      })],
    );
    await database.query(
      `INSERT INTO processing_jobs (id,tenant_id,organization_id,kind,status,correlation_id,payload)
       VALUES ($1,$2,$3,$4,'succeeded','test',$5::jsonb)`,
      [randomUUID(), ...scope, ANALYZA_KIND, JSON.stringify({ vysledok: { kategorii: 5, zlyhanychDavok: 0 } })],
    );
    await database.query(
      `INSERT INTO ucto_presnost (id,tenant_id,organization_id,delici_datum,vzorka,vysledok,metodika)
       VALUES ($1,$2,$3,'2026-06-01',12,$4::jsonb,2)`, [randomUUID(), ...scope, JSON.stringify({ FP: { dokladov: 12 } })],
    );

    expect(await mostikVSnapshote()).toEqual({ [novaId]: false, [seeded.organizationId]: true });
    const hotova = await pripravenost(seeded.organizationId);
    expect(hotova.signaly.firma.detail).toMatchObject({ dbName: 'StwPh_12345678_2026', uctovnyRok: '2026' });
    expect(hotova.stav, JSON.stringify(hotova.signaly)).toBe('pripravena');

    const cudzia = await app.inject({ method: 'GET', url: `/api/organizations/${randomUUID()}/pripravenost`, headers });
    expect(cudzia.statusCode).toBe(404);
  }, 90_000);
});
