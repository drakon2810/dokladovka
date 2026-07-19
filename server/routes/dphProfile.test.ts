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

const PROFIL_NEPLATITEL = {
  platitelDph: 'neplatitel',
  obdobieDph: 'mesacne',
  koeficient: [],
  pomerneOdpocitanie: [],
  rezim: 'tuzemsky',
  nakupyZEu: false,
  sluzbyZEu: false,
  prenesenieDp: false,
  pravidlaAut: [],
  bezNaroku: [],
  samozdanenieAktivne: false,
};

async function insertReadyDocument(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
  seeded: { tenantId: string; organizationId: string },
  options: { clenenieKod: string; clenenieNazov: string; polozkyPopis?: string },
): Promise<{ documentId: string; clenenieDphId: string }> {
  const id = randomUUID();
  const clenenieDphId = randomUUID();
  for (const [cid, kind, code, name] of [
    [randomUUID(), 'predkontacie', `518-${id.slice(0, 4)}`, 'Ostatné služby'],
    [clenenieDphId, 'cleneniaDph', options.clenenieKod, options.clenenieNazov],
    [randomUUID(), 'ciselneRady', `PF-${id.slice(0, 4)}`, 'Prijaté faktúry'],
  ] as const) {
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,$4,$5,$6,'manual') ON CONFLICT DO NOTHING`,
      [cid, seeded.tenantId, seeded.organizationId, kind, code, name],
    );
  }
  const lists = await database.query<{ id: string; kind: string } & Record<string, unknown>>(
    'SELECT id, kind FROM code_list_items WHERE tenant_id=$1 AND organization_id=$2 ORDER BY created_at',
    [seeded.tenantId, seeded.organizationId],
  );
  const byKind = (kind: string) => lists.rows.find((row) => row.kind === kind)!.id;
  const total = 123;
  await database.query(
    `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
     VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,$5::jsonb,$6,'EUR')`,
    [id, seeded.tenantId, seeded.organizationId,
      JSON.stringify({
        dodavatel: { nazov: 'Slovnaft a.s.' }, odberatel: {}, cisloFaktury: `F-${id.slice(0, 6)}`,
        datumVystavenia: '2026-07-01', datumDodania: '2026-07-01', datumSplatnosti: '2026-07-20',
        mena: 'EUR', rozpisDph: [{ sadzba: 23, zaklad: 100, dph: 23 }],
        sumaSpolu: total, polozky: [{ id: `${id}-li-0`, popis: options.polozkyPopis ?? 'Služby' }],
      }),
      JSON.stringify({ predkontaciaId: byKind('predkontacie'), clenenieDphId, ciselnyRadId: byKind('ciselneRady') }),
      total],
  );
  return { documentId: id, clenenieDphId };
}

describe('DPH profil klienta', () => {
  it('PUT uloží profil (len admin) a vráti ho v snapshote', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);

    const saved = await app.inject({
      method: 'PUT',
      url: `/api/organizations/${seeded.organizationId}/dph-profile`,
      headers,
      payload: {
        ...PROFIL_NEPLATITEL,
        platitelDph: 'platitel',
        obdobieDph: 'stvrtrocne',
        uzavreteDo: '2026-06-30',
        koeficient: [{ rok: 2026, typ: 'zalohovy', hodnota: 0.87 }],
        pravidlaAut: [{ kategoria: 'PHM osobné auto', percento: 80, klucoveSlova: ['PHM', 'servis'] }],
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().obdobieDph).toBe('stvrtrocne');
    expect(saved.json().koeficient[0].hodnota).toBe(0.87);

    // Upsert: druhé uloženie prepíše hodnoty.
    const updated = await app.inject({
      method: 'PUT',
      url: `/api/organizations/${seeded.organizationId}/dph-profile`,
      headers,
      payload: { ...PROFIL_NEPLATITEL },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().platitelDph).toBe('neplatitel');

    const snapshot = await app.inject({ method: 'GET', url: '/api/data/snapshot', headers: { cookie: headers.cookie } });
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json().dphProfiles).toHaveLength(1);
    expect(snapshot.json().dphProfiles[0].platitelDph).toBe('neplatitel');

    // Účtovník nemá právo meniť profil.
    const uctovnikId = randomUUID();
    await database.query(
      `INSERT INTO users (id,tenant_id,name,email,password_hash,role)
       SELECT $1, tenant_id, 'Účtovník', 'uctovnik@test.sk', password_hash, 'uctovnik' FROM users WHERE id=$2`,
      [uctovnikId, seeded.userId],
    );
    await database.query('INSERT INTO organization_memberships (user_id,organization_id,tenant_id) VALUES ($1,$2,$3)', [uctovnikId, seeded.organizationId, seeded.tenantId]);
    const uctovnikLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'uctovnik@test.sk', password: seeded.password } });
    const forbidden = await app.inject({
      method: 'PUT',
      url: `/api/organizations/${seeded.organizationId}/dph-profile`,
      headers: sessionHeaders(uctovnikLogin),
      payload: { ...PROFIL_NEPLATITEL },
    });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
  }, 120_000);

  it('neplatiteľ so zvoleným odpočtom: approve blokuje 409, s členením bez odpočtu prejde', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);

    await app.inject({
      method: 'PUT',
      url: `/api/organizations/${seeded.organizationId}/dph-profile`,
      headers,
      payload: { ...PROFIL_NEPLATITEL },
    });

    const sOdpoctom = await insertReadyDocument(database, seeded, { clenenieKod: 'PD', clenenieNazov: 'Plný odpočet' });
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/documents/${sOdpoctom.documentId}/approve`,
      headers,
      payload: { expectedVersion: 1 },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('dph_profil_blokacia');

    const bezOdpoctu = await insertReadyDocument(database, seeded, { clenenieKod: 'BO', clenenieNazov: 'Bez nároku na odpočet' });
    const approved = await app.inject({
      method: 'POST',
      url: `/api/documents/${bezOdpoctu.documentId}/approve`,
      headers,
      payload: { expectedVersion: 1 },
    });
    expect(approved.statusCode).toBe(200);
    await app.close();
  }, 120_000);

  it('účtovný profil: PUT uloží obdobie, zaokrúhľovanie, párovanie a rozvrh', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);

    const saved = await app.inject({
      method: 'PUT',
      url: `/api/organizations/${seeded.organizationId}/accounting-profile`,
      headers,
      payload: {
        obdobieUctovania: 'stvrtrocne',
        zaokruhlovanieCelkom: 'pat_centov',
        zaokruhlovanieDph: 'nahor',
        parovanieDodavatelov: ['ic_dph', 'ico', 'nazov'],
        uctovnyRozvrh: [{ ucet: '518', nazov: 'Ostatné služby', analytiky: ['001', '002'] }],
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().obdobieUctovania).toBe('stvrtrocne');
    expect(saved.json().parovanieDodavatelov).toEqual(['ic_dph', 'ico', 'nazov']);
    expect(saved.json().uctovnyRozvrh[0].analytiky).toEqual(['001', '002']);

    const snapshot = await app.inject({ method: 'GET', url: '/api/data/snapshot', headers: { cookie: headers.cookie } });
    expect(snapshot.json().accountingProfiles).toHaveLength(1);
    expect(snapshot.json().accountingProfiles[0].zaokruhlovanieDph).toBe('nahor');

    // Duplicitné kritériá párovania odmietne validácia.
    const invalid = await app.inject({
      method: 'PUT',
      url: `/api/organizations/${seeded.organizationId}/accounting-profile`,
      headers,
      payload: {
        obdobieUctovania: 'mesacne',
        zaokruhlovanieCelkom: 'centy',
        zaokruhlovanieDph: 'matematicky',
        parovanieDodavatelov: ['ico', 'ico'],
        uctovnyRozvrh: [],
      },
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  }, 120_000);

  it('dph-advisor vracia varovanie pri PHM pravidle a návrh bez profilu je prázdny', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);

    const doklad = await insertReadyDocument(database, seeded, {
      clenenieKod: 'PD', clenenieNazov: 'Plný odpočet', polozkyPopis: 'Natural 95 — PHM',
    });

    // Bez profilu: prázdny posudok.
    const prazdny = await app.inject({ method: 'GET', url: `/api/documents/${doklad.documentId}/dph-advisor`, headers: { cookie: headers.cookie } });
    expect(prazdny.statusCode).toBe(200);
    expect(prazdny.json()).toEqual({ navrhy: [], varovania: [], blokacie: [] });

    await app.inject({
      method: 'PUT',
      url: `/api/organizations/${seeded.organizationId}/dph-profile`,
      headers,
      payload: {
        ...PROFIL_NEPLATITEL,
        platitelDph: 'platitel',
        pravidlaAut: [{ kategoria: 'PHM osobné auto', percento: 80, klucoveSlova: ['PHM'] }],
      },
    });

    const posudok = await app.inject({ method: 'GET', url: `/api/documents/${doklad.documentId}/dph-advisor`, headers: { cookie: headers.cookie } });
    expect(posudok.statusCode).toBe(200);
    const varovania = posudok.json().varovania as Array<{ kod: string; sprava: string }>;
    expect(varovania.some((zistenie) => zistenie.kod === 'dph_auto_odpocet')).toBe(true);
    await app.close();
  }, 120_000);
});
