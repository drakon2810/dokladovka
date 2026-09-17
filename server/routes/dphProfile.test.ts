import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadDphProfil } from '../services/dphProfileService.js';
import { createTestDatabase, potvrdFakt, seedTestUser, testConfig } from '../testHelpers.js';
import { MemoryObjectStorage } from '../storage.js';

// DPH profil pre engine sa skladá LEN z potvrdených faktov profilu klienta.
// Navrhnuté z histórie ani odpovede z budúcnosti (meranie) doň nesmú vstúpiť.

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

async function pripravApp() {
  const database = await createTestDatabase();
  databases.push(database);
  const seeded = await seedTestUser(database);
  const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
  return { database, seeded, app, headers: sessionHeaders(login) };
}

describe('DPH profil z potvrdených faktov', () => {
  it('skladá len potvrdené fakty, kódy prekladá na aktívne id a fakt spred knownAt', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const kod = async (kind: string, code: string, active = true) => {
      const id = randomUUID();
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,active) VALUES ($1,$2,$3,$4,$5,$5,'pohoda',$6)`,
        [id, seeded.tenantId, seeded.organizationId, kind, code, active],
      );
      return id;
    };
    const [phm, nadspotreba, pn, repre] = [
      await kod('predkontacie', 'PHM-501200'), await kod('predkontacie', 'PHM-Nadspotreba'),
      await kod('cleneniaDph', 'PN'), await kod('predkontacie', '513100'),
    ];
    await kod('predkontacie', 'Stara-karta', false);
    await kod('cleneniaDph', 'DDsl§69');
    await kod('cleneniaDph', 'PDsluz');
    const nacitaj = (knownAt?: string) => loadDphProfil(database, seeded.tenantId, seeded.organizationId, { knownAt });

    // Navrhnutý z histórie engine nevidí — profil stále „chýba".
    await database.query(
      `INSERT INTO profil_fakty (organization_id,tenant_id,kluc,stav,hodnota,zdroj) VALUES ($1,$2,'dph.status','navrhnute','{"status":"platitel"}','historia')`,
      [seeded.organizationId, seeded.tenantId],
    );
    expect(await nacitaj()).toBeUndefined();

    await potvrdFakt(database, seeded, 'dph.status', { status: 'registracia_7' }, '2026-03-01T00:00:00Z');
    await potvrdFakt(database, seeded, 'dph.clenenie_bez_odpoctu', { clenenieKod: 'PN' }, '2026-03-01T00:00:00Z');
    await potvrdFakt(database, seeded, 'vozidla.pravidla', [
      { nazov: 'PHM', klucoveSlova: ['natural 95'], percentoZakladu: 80, percentoDph: 50,
        predkontaciaKod: 'PHM-501200', predkontaciaNedanovaKod: 'PHM-Nadspotreba', clenenieDphNedanoveKod: 'PN' },
      // Neaktívny kód: pravidlo engine nevidí, ostatné áno.
      { nazov: 'Stará karta', klucoveSlova: ['shell'], percentoZakladu: 80, percentoDph: 50,
        predkontaciaKod: 'Stara-karta', predkontaciaNedanovaKod: 'PHM-Nadspotreba' },
    ], '2026-03-01T00:00:00Z');
    await potvrdFakt(database, seeded, 'naklady.bez_naroku', [{ predkontaciaKod: '513100', clenenieKod: 'PN' }], '2026-03-01T00:00:00Z');
    await potvrdFakt(database, seeded, 'samozdanenie.sluzby_eu', {
      faktura: { clenenieKod: 'PN', kv: 'KN' }, interny: { ddKod: 'DDsl§69', pKod: 'PDsluz', kv: 'B1' },
    }, '2026-03-01T00:00:00Z');
    // Nepreložiteľný jednoduchý fakt sa vynechá celý.
    await potvrdFakt(database, seeded, 'zahranicie.vratenie_dph', { uplatnujeme: true, predkontaciaKod: 'neexistuje' }, '2026-03-01T00:00:00Z');
    // Odpoveď z budúcnosti voči meranému dokladu.
    await potvrdFakt(database, seeded, 'zasady.tovar_na_ceste', { pouziva: true }, '2026-06-01T00:00:00Z');

    const profil = await nacitaj();
    expect(profil).toMatchObject({
      platitelDph: 'registracia_7a', clenenieBezOdpoctuId: pn, clenenieBezOdpoctuKod: 'PN', tovarNaCeste: true,
      pravidlaAut: [{
        kategoria: 'PHM', percento: 80, percentoDph: 50, klucoveSlova: ['natural 95'],
        predkontaciaId: phm, predkontaciaNedanovaId: nadspotreba, clenenieDphNedanoveId: pn,
      }],
      bezNarokuUcty: [{ predkontaciaKod: '513100', predkontaciaId: repre, clenenieKod: 'PN', clenenieDphId: pn }],
      samozdanenie: { sluzby_eu: { faktura: { clenenieKod: 'PN', clenenieDphId: pn, kv: 'KN' }, interny: { ddKod: 'DDsl§69' } } },
    });
    expect(profil!.pravidlaAut).toHaveLength(1);
    expect(profil!.vratenieDph).toBeUndefined();

    const vMinulosti = await nacitaj('2026-04-10');
    expect(vMinulosti?.platitelDph).toBe('registracia_7a');
    expect(vMinulosti?.tovarNaCeste).toBeUndefined();
    expect(await nacitaj('2026-02-01')).toBeUndefined();
  }, 90_000);

  it('neplatiteľ z potvrdeného faktu: approve blokuje 409, s členením bez odpočtu prejde', async () => {
    const { database, seeded, app, headers } = await pripravApp();
    await potvrdFakt(database, seeded, 'dph.status', { status: 'neplatitel' });

    const sOdpoctom = await insertReadyDocument(database, seeded, { clenenieKod: 'PD', clenenieNazov: 'Plný odpočet' });
    const blocked = await app.inject({
      method: 'POST', url: `/api/documents/${sOdpoctom.documentId}/approve`, headers, payload: { expectedVersion: 1 },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('dph_profil_blokacia');

    const bezOdpoctu = await insertReadyDocument(database, seeded, { clenenieKod: 'BO', clenenieNazov: 'Bez nároku na odpočet' });
    const approved = await app.inject({
      method: 'POST', url: `/api/documents/${bezOdpoctu.documentId}/approve`, headers, payload: { expectedVersion: 1 },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    await app.close();
  }, 120_000);

  it('dph-advisor: bez profilu prázdny, s potvrdeným pravidlom vozidla varuje daňovým nákladom aj odpočtom', async () => {
    const { database, seeded, app, headers } = await pripravApp();
    const doklad = await insertReadyDocument(database, seeded, {
      clenenieKod: 'PD', clenenieNazov: 'Plný odpočet', polozkyPopis: 'Natural 95 — PHM',
    });
    const posud = async () => {
      const odpoved = await app.inject({ method: 'GET', url: `/api/documents/${doklad.documentId}/dph-advisor`, headers: { cookie: headers.cookie } });
      expect(odpoved.statusCode, odpoved.body).toBe(200);
      return odpoved.json();
    };
    expect(await posud()).toEqual({ navrhy: [], varovania: [], blokacie: [] });

    for (const code of ['PHM-501200', 'PHM-Nadspotreba']) {
      await database.query(
        `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source) VALUES ($1,$2,$3,'predkontacie',$4,$4,'pohoda')`,
        [randomUUID(), seeded.tenantId, seeded.organizationId, code],
      );
    }
    await potvrdFakt(database, seeded, 'dph.status', { status: 'platitel' });
    await potvrdFakt(database, seeded, 'vozidla.pravidla', [{
      nazov: 'PHM osobné auto', klucoveSlova: ['PHM'], percentoZakladu: 80, percentoDph: 50,
      predkontaciaKod: 'PHM-501200', predkontaciaNedanovaKod: 'PHM-Nadspotreba',
    }]);
    expect((await posud()).varovania).toEqual([{
      kod: 'dph_auto_odpocet', kategoria: 'PHM osobné auto', percento: 80,
      sprava: 'Daňový náklad 80 %, odpočet DPH 50 % — PHM osobné auto (nájdené „PHM“).',
    }]);
    await app.close();
  }, 120_000);
});
