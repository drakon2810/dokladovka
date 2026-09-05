import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createTestDatabase, seedTestUser, testConfig } from '../testHelpers.js';
import { MemoryObjectStorage } from '../storage.js';

// Čo účtovník oproti návrhu zmenil. Doteraz to systém nikde nedržal a preto sa
// nedalo zmerať, či je návrh dobrý: databáza nevedela odlíšiť „účtovník
// súhlasil" od „účtovník sa nepozrel". Bez tohto merania nemá zmysel meniť
// spôsob navrhovania — nebolo by voči čomu porovnávať.

const databases: Awaited<ReturnType<typeof createTestDatabase>>[] = [];
afterEach(async () => Promise.all(databases.splice(0).map((database) => database.close())));

function sessionHeaders(response: { headers: Record<string, unknown>; json(): any }) {
  return { cookie: String(response.headers['set-cookie']).split(';')[0], 'x-csrf-token': response.json().csrfToken as string };
}

async function pripravDoklad(
  database: Awaited<ReturnType<typeof createTestDatabase>>,
  seeded: { tenantId: string; organizationId: string },
): Promise<{ documentId: string; navrhnuta: string; ina: string; clenenie: string; rad: string }> {
  const id = randomUUID();
  const navrhnuta = randomUUID();
  const ina = randomUUID();
  const clenenie = randomUUID();
  const rad = randomUUID();
  for (const [cid, kind, code] of [
    [navrhnuta, 'predkontacie', '518/321'], [ina, 'predkontacie', '501/321'],
    [clenenie, 'cleneniaDph', 'PD'], [rad, 'ciselneRady', '26FP'],
  ] as const) {
    await database.query(
      `INSERT INTO code_list_items (id,tenant_id,organization_id,kind,code,name,source)
       VALUES ($1,$2,$3,$4,$5,$5,'manual')`,
      [cid, seeded.tenantId, seeded.organizationId, kind, code],
    );
  }
  await database.query(
    `INSERT INTO documents (id,tenant_id,organization_id,document_type,status,processing_status,extracted,accounting,total_amount,currency)
     VALUES ($1,$2,$3,'FP','na_kontrole','ready_for_review',$4::jsonb,$5::jsonb,123,'EUR')`,
    [id, seeded.tenantId, seeded.organizationId,
      JSON.stringify({
        dodavatel: { nazov: 'RAINSIDE s.r.o.', ico: '31386946' }, odberatel: {}, cisloFaktury: 'F-1',
        datumVystavenia: '2026-07-01', datumDodania: '2026-07-01', datumSplatnosti: '2026-07-20',
        mena: 'EUR', rozpisDph: [{ sadzba: 23, zaklad: 100, dph: 23 }], sumaSpolu: 123, polozky: [],
      }),
      // Doklad ide do schválenia s INOU predkontáciou, než ktorú navrhol systém.
      JSON.stringify({ predkontaciaId: ina, clenenieDphId: clenenie, ciselnyRadId: rad })],
  );
  // Návrh systému — to, čo účtovník uvidel pred svojou zmenou.
  await database.query(
    `INSERT INTO accounting_suggestions
      (document_id,tenant_id,organization_id,predkontacia_id,clenenie_dph_id,ciselny_rad_id,source,confidence,reason)
     VALUES ($1,$2,$3,$4,$5,$6,'ai',0.8,'test')`,
    [id, seeded.tenantId, seeded.organizationId, navrhnuta, clenenie, rad],
  );
  return { documentId: id, navrhnuta, ina, clenenie, rad };
}

describe('záznam opráv účtovníka', () => {
  it('zapíše, ktoré pole účtovník oproti návrhu zmenil, a prežije zmazanie dokladu', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);

    const { documentId, navrhnuta, ina } = await pripravDoklad(database, seeded);
    const approved = await app.inject({
      method: 'POST', url: `/api/documents/${documentId}/approve`, headers, payload: { expectedVersion: 1 },
    });
    expect(approved.statusCode, approved.body).toBe(200);

    const oprava = await database.query<{
      zmenene: string[]; navrhnute: Record<string, string>; schvalene: Record<string, string>;
      navrh_zdroj: string; supplier_ico: string;
    } & Record<string, unknown>>(
      'SELECT zmenene, navrhnute, schvalene, navrh_zdroj, supplier_ico FROM ucto_opravy WHERE document_id=$1',
      [documentId],
    );
    const row = oprava.rows[0];
    expect(row, 'oprava sa nezapísala').toBeDefined();
    // Zmenila sa práve predkontácia — členenie a rad účtovník ponechal.
    expect(row.zmenene).toEqual(['predkontaciaId']);
    expect(row.navrhnute.predkontaciaId).toBe(navrhnuta);
    expect(row.schvalene.predkontaciaId).toBe(ina);
    // Zdroj návrhu sa drží spolu s opravou — inak sa nedá povedať, ktorý
    // spôsob navrhovania sa mýli.
    expect(row.navrh_zdroj).toBe('ai');
    expect(row.supplier_ico).toBe('31386946');

    // Záznam musí prežiť zmazanie dokladu: pri accounting_suggestions to tak
    // nie je a s dokladmi odišli aj návrhy, kde bola oprava najpravdepodobnejšia.
    await database.query('DELETE FROM documents WHERE id=$1', [documentId]);
    const poZmazani = await database.query('SELECT 1 FROM ucto_opravy WHERE document_id=$1', [documentId]);
    expect(poZmazani.rowCount).toBe(1);

    await app.close();
  }, 60_000);

  it('súhlas s návrhom sa zapíše ako prázdny zoznam zmien, nie ako chýbajúci záznam', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);

    const { documentId, navrhnuta } = await pripravDoklad(database, seeded);
    // Účtovník sa vráti k návrhu — teda s ním súhlasí.
    await database.query(
      `UPDATE documents SET accounting = accounting || jsonb_build_object('predkontaciaId',$2::text) WHERE id=$1`,
      [documentId, navrhnuta],
    );
    const approved = await app.inject({
      method: 'POST', url: `/api/documents/${documentId}/approve`, headers, payload: { expectedVersion: 1 },
    });
    expect(approved.statusCode, approved.body).toBe(200);

    const oprava = await database.query<{ zmenene: string[] } & Record<string, unknown>>(
      'SELECT zmenene FROM ucto_opravy WHERE document_id=$1', [documentId]);
    // Rozdiel medzi „súhlasil" a „nepozrel sa" je práve to, čo databáza doteraz
    // nevedela: súhlas musí byť zapísaný, nie odvodený z ticha.
    expect(oprava.rows[0]?.zmenene).toEqual([]);

    await app.close();
  }, 60_000);
});
