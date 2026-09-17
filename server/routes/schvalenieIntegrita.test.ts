import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createTestDatabase, potvrdFakt, seedTestUser, testConfig } from '../testHelpers.js';
import { MemoryObjectStorage } from '../storage.js';

// Schválenie je posledná brána pred POHODOU. Overovalo len, či id z hlavičky
// existujú — nie z akého sú číselníka, rad ktorej agendy a roka, ani odkazy na
// položkách (export ich potom ticho nahradil hlavičkou). A zápisy po uložení
// stavu bežali mimo transakcie: zlyhanie pamäte nechalo doklad schválený.

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

function sessionHeaders(response: { headers: Record<string, unknown>; json(): any }) {
  return { cookie: String(response.headers['set-cookie']).split(';')[0], 'x-csrf-token': response.json().csrfToken as string };
}

async function priprav() {
  const database = await createTestDatabase();
  databases.push(database);
  const seeded = await seedTestUser(database);
  const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
  const headers = sessionHeaders(login);
  const kody: Record<string, string> = {};
  for (const [nazov, kind, code, agenda, rok] of [
    ['predkontacia', 'predkontacie', '518/321', null, null],
    ['clenenie', 'cleneniaDph', 'PD', null, null],
    ['clenenieUN', 'cleneniaDph', 'UN', null, null],
    ['rad', 'ciselneRady', '26FP', 'prijate_faktury', '2026'],
    ['radMinulyRok', 'ciselneRady', '25FP', 'prijate_faktury', '2025'],
    ['radInejAgendy', 'ciselneRady', '26OZ', 'ostatni_zavazky', null],
    ['stredisko', 'strediska', 'HL', null, null],
  ] as const) {
    kody[nazov] = randomUUID();
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source,agenda,accounting_year)
       VALUES ($1,$2,$3,$4,$5,$5,'manual',$6,$7)`,
      [kody[nazov], seeded.tenantId, seeded.organizationId, kind, code, agenda, rok],
    );
  }
  const vlozDoklad = async (accounting: Record<string, string>, uctoPolozky: Record<string, string> = {}) => {
    const id = randomUUID();
    await database.query(
      `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
       VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,$5::jsonb,123,'EUR')`,
      [id, seeded.tenantId, seeded.organizationId,
        JSON.stringify({
          dodavatel: { nazov: 'RAINSIDE s.r.o.', ico: '31386946' }, odberatel: {}, cisloFaktury: 'F-1',
          datumVystavenia: '2026-07-01', datumDodania: '2026-07-01', datumSplatnosti: '2026-07-20',
          mena: 'EUR', rozpisDph: [{ sadzba: 23, zaklad: 100, dph: 23 }], sumaSpolu: 123,
          polozky: [{ id: 'p1', popis: 'Tovar', sadzbaDph: 23, sumaBezDph: 100, sumaDph: 23, sumaSpolu: 123, ucto: uctoPolozky }],
        }),
        JSON.stringify(accounting)],
    );
    return id;
  };
  const schval = (id: string) => app.inject({
    method: 'POST', url: `/api/documents/${id}/approve`, headers, payload: { expectedVersion: 1 },
  });
  const zaklad = { predkontaciaId: kody.predkontacia, clenenieDphId: kody.clenenie, ciselnyRadId: kody.rad };
  return { database, seeded, app, kody, zaklad, vlozDoklad, schval };
}

describe('integrita schválenia', () => {
  it('odmietne odkaz z iného číselníka, rad inej agendy či roka aj neplatné pole položky', async () => {
    const { database, seeded, app, kody, zaklad, vlozDoklad, schval } = await priprav();

    const pripady: Array<[string, Record<string, string>, Record<string, string>]> = [
      ['ucto.predkontaciaId', { ...zaklad, predkontaciaId: kody.clenenie }, {}],
      ['ucto.ciselnyRadId', { ...zaklad, ciselnyRadId: kody.radInejAgendy }, {}],
      ['ucto.ciselnyRadId', { ...zaklad, ciselnyRadId: kody.radMinulyRok }, {}],
      ['ucto.clenenieKvKod', { ...zaklad, clenenieKvKod: 'A1' }, {}],
      ['polozky.0.ucto.predkontaciaId', zaklad, { predkontaciaId: randomUUID() }],
      ['polozky.0.ucto.strediskoId', zaklad, { strediskoId: kody.predkontacia }],
      ['polozky.0.ucto.clenenieKvKod', zaklad, { clenenieKvKod: 'A1' }],
    ];
    for (const [pole, accounting, uctoPolozky] of pripady) {
      const odpoved = await schval(await vlozDoklad(accounting, uctoPolozky));
      expect(odpoved.statusCode, `${pole}: ${odpoved.body}`).toBe(409);
      expect(odpoved.body).toContain(pole);
    }

    // Platné vlastné zaúčtovanie položky aj prázdne pole (dedí hlavičku) prejdú.
    const dobry = await schval(await vlozDoklad(
      { ...zaklad, clenenieKvKod: 'B2' }, { predkontaciaId: kody.predkontacia, strediskoId: kody.stredisko }));
    expect(dobry.statusCode, dobry.body).toBe(200);

    // R1 z auditu cez server: neplatiteľ, hlavička bez odpočtu, položka s odpočtom.
    await potvrdFakt(database, seeded, 'dph.status', { status: 'neplatitel' });
    const r1 = await schval(await vlozDoklad({ ...zaklad, clenenieDphId: kody.clenenieUN }, { clenenieDphId: kody.clenenie }));
    expect(r1.statusCode, r1.body).toBe(409);
    expect(r1.json().code).toBe('dph_profil_blokacia');

    await app.close();
  }, 90_000);

  it('zlyhanie zápisu po uložení stavu vráti celé schválenie späť', async () => {
    const { database, app, zaklad, vlozDoklad, schval } = await priprav();
    const id = await vlozDoklad(zaklad);
    // Audit je posledný zápis schválenia — keď padne on, nesmie ostať nič pred ním.
    await database.exec(`ALTER TABLE audit_logs ADD CONSTRAINT test_zlyhanie_auditu CHECK (action <> 'document.approved') NOT VALID`);

    const zlyhane = await schval(id);
    expect(zlyhane.statusCode).toBeGreaterThanOrEqual(500);
    const doklad = await database.query<{ status: string; version: number; approved_snapshot: unknown } & Record<string, unknown>>(
      'SELECT status, version, approved_snapshot FROM documents WHERE id=$1', [id]);
    expect(doklad.rows[0]).toMatchObject({ status: 'na_kontrole', version: 1, approved_snapshot: null });
    expect((await database.query('SELECT 1 FROM ucto_decisions WHERE document_id=$1', [id])).rows).toHaveLength(0);
    expect((await database.query('SELECT 1 FROM ucto_opravy WHERE document_id=$1', [id])).rows).toHaveLength(0);

    // Po odstránení poruchy sa ten istý doklad schváli na tej istej verzii.
    await database.exec('ALTER TABLE audit_logs DROP CONSTRAINT test_zlyhanie_auditu');
    const schvalene = await schval(id);
    expect(schvalene.statusCode, schvalene.body).toBe(200);

    await app.close();
  }, 90_000);
});
