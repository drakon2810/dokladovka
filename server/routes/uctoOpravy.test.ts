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
  // Ďalší doklad tej istej firmy použije jej číselníky — kód je v nej unikátny.
  kody?: { navrhnuta: string; ina: string; clenenie: string; rad: string },
): Promise<{ documentId: string; navrhnuta: string; ina: string; clenenie: string; rad: string }> {
  const id = randomUUID();
  const { navrhnuta, ina, clenenie, rad } = kody
    ?? { navrhnuta: randomUUID(), ina: randomUUID(), clenenie: randomUUID(), rad: randomUUID() };
  for (const [cid, kind, code] of kody ? [] : [
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
    // Stopa rozhodnutia, z ktorej návrh vzišiel — oprava na ňu musí ukazovať,
    // inak sa zo záznamu opravy nedá povedať, ktoré pravidlo sa pomýlilo.
    await database.query("UPDATE accounting_suggestions SET stopa_id='stopa-1' WHERE document_id=$1", [documentId]);
    const approved = await app.inject({
      method: 'POST', url: `/api/documents/${documentId}/approve`, headers, payload: { expectedVersion: 1 },
    });
    expect(approved.statusCode, approved.body).toBe(200);

    const oprava = await database.query<{
      zmenene: string[]; navrhnute: Record<string, string>; schvalene: Record<string, string>;
      navrh_zdroj: string; supplier_ico: string; stopa_id: string;
    } & Record<string, unknown>>(
      'SELECT zmenene, navrhnute, schvalene, navrh_zdroj, supplier_ico, stopa_id FROM ucto_opravy WHERE document_id=$1',
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
    expect(row.stopa_id).toBe('stopa-1');

    // Záznam musí prežiť zmazanie dokladu: pri accounting_suggestions to tak
    // nie je a s dokladmi odišli aj návrhy, kde bola oprava najpravdepodobnejšia.
    await database.query('DELETE FROM documents WHERE id=$1', [documentId]);
    const poZmazani = await database.query('SELECT 1 FROM ucto_opravy WHERE document_id=$1', [documentId]);
    expect(poZmazani.rowCount).toBe(1);

    await app.close();
  }, 60_000);

  // Zrušené schválenie oprava nepoznala a opätovné schválenie zapísalo druhú —
  // ten istý doklad sa tak rátal dvakrát, aj v samokontrole pravidla: tri
  // schválenia jedného dokladu vypli pravidlo, ktoré sa pomýlilo raz.
  it('zrušené schválenie označí opravu a opätovné schválenie pravidlo nepotrestá druhýkrát', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);

    const { documentId, navrhnuta } = await pripravDoklad(database, seeded);
    const ruleId = randomUUID();
    await database.query(
      `INSERT INTO accounting_rules (id,tenant_id,organization_id,supplier_name_normalized,predkontacia_id,origin)
       VALUES ($1,$2,$3,'rainside',$4,'manual')`,
      [ruleId, seeded.tenantId, seeded.organizationId, navrhnuta],
    );
    await database.query('UPDATE accounting_suggestions SET rule_id=$2 WHERE document_id=$1', [documentId, ruleId]);
    const schval = async () => {
      const verzia = (await database.query<{ version: number }>('SELECT version FROM documents WHERE id=$1', [documentId])).rows[0].version;
      const odpoved = await app.inject({
        method: 'POST', url: `/api/documents/${documentId}/approve`, headers, payload: { expectedVersion: Number(verzia) },
      });
      expect(odpoved.statusCode, odpoved.body).toBe(200);
    };
    const opravy = async () => (await database.query<{ zrusena: boolean }>(
      'SELECT zrusena_at IS NOT NULL AS zrusena FROM ucto_opravy WHERE document_id=$1 ORDER BY created_at', [documentId])).rows;
    const pocetOprav = async () => Number((await database.query<{ corrections_count: number }>(
      'SELECT corrections_count FROM accounting_rules WHERE id=$1', [ruleId])).rows[0].corrections_count);

    await schval();
    expect(await pocetOprav()).toBe(1);
    const verzia = (await database.query<{ version: number }>('SELECT version FROM documents WHERE id=$1', [documentId])).rows[0].version;
    const zamietnutie = await app.inject({
      method: 'POST', url: `/api/documents/${documentId}/reject`, headers,
      payload: { expectedVersion: Number(verzia), reason: 'Zlý dodávateľ' },
    });
    expect(zamietnutie.statusCode, zamietnutie.body).toBe(200);
    expect(await opravy()).toEqual([{ zrusena: true }]);

    await database.query(`UPDATE documents SET status='na_kontrole' WHERE id=$1`, [documentId]);
    await schval();
    expect(await opravy()).toEqual([{ zrusena: true }, { zrusena: false }]);
    expect(await pocetOprav()).toBe(1);

    await app.close();
  }, 60_000);

  // R09 „Vždy pre tohto dodávateľa": podoba, ktorú účtovník vybral, sa stane
  // pravidlom protistrany. Staré pravidlo len pre dodávateľa by inak vyhralo
  // (pravidlá sa skladajú od najstaršieho) — deaktivuje sa, nemaže.
  it('výber podoby praxe vytvorí pravidlo dodávateľa a zruší otázku na jeho dokladoch', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } });
    const headers = sessionHeaders(login);

    const kody = await pripravDoklad(database, seeded);
    const druhy = await pripravDoklad(database, seeded, kody);
    const stare = randomUUID();
    // Staré pravidlo nesie aj rad — nový výber ho nesmie ticho zahodiť.
    await database.query(
      `INSERT INTO accounting_rules (id,tenant_id,organization_id,supplier_ico,predkontacia_id,ciselny_rad_id,origin)
       VALUES ($1,$2,$3,'31386946',$4,$5,'ai')`,
      [stare, seeded.tenantId, seeded.organizationId, kody.navrhnuta, kody.rad],
    );
    const otazka = JSON.stringify({ spor: 'dph', varianty: [] });
    await database.query('UPDATE accounting_suggestions SET otazka=$1::jsonb WHERE document_id = ANY($2::text[])',
      [otazka, [kody.documentId, druhy.documentId]]);

    const zle = await app.inject({
      method: 'POST', url: `/api/documents/${kody.documentId}/pravidlo-protistrany`, headers,
      payload: { predkontaciaId: randomUUID(), clenenieDphId: kody.clenenie, clenenieKvKod: 'B2' },
    });
    expect(zle.statusCode, zle.body).toBe(422);

    const ok = await app.inject({
      method: 'POST', url: `/api/documents/${kody.documentId}/pravidlo-protistrany`, headers,
      payload: { predkontaciaId: kody.ina, clenenieDphId: kody.clenenie, clenenieKvKod: 'B2' },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const pravidla = (await database.query<Record<string, any>>(
      'SELECT id, active, origin, dovod_source, supplier_ico, predkontacia_id, clenenie_dph_id, clenenie_kv_kod, ciselny_rad_id FROM accounting_rules WHERE organization_id=$1',
      [seeded.organizationId],
    )).rows;
    expect(pravidla.find((pravidlo) => pravidlo.id === stare)?.active).toBe(false);
    expect(pravidla.find((pravidlo) => pravidlo.id === ok.json().ruleId)).toMatchObject({
      active: true, origin: 'manual', dovod_source: 'human', supplier_ico: '31386946',
      predkontacia_id: kody.ina, clenenie_dph_id: kody.clenenie, clenenie_kv_kod: 'B2', ciselny_rad_id: kody.rad,
    });
    // Druhý otvorený doklad dodávateľa dostane nový návrh — s pravidlom, nie so starou podobou.
    expect((await database.query(
      "SELECT 1 FROM processing_jobs WHERE document_id=$1 AND kind='navrh_zauctovania' AND status='queued'", [druhy.documentId],
    )).rowCount).toBe(1);
    const otazky = (await database.query<Record<string, any>>(
      'SELECT otazka FROM accounting_suggestions WHERE document_id = ANY($1::text[])', [[kody.documentId, druhy.documentId]],
    )).rows;
    expect(otazky).toEqual([{ otazka: null }, { otazka: null }]);
    expect((await database.query("SELECT 1 FROM audit_logs WHERE action='ucto.pravidlo_z_otazky'")).rowCount).toBe(1);

    // Vydaná faktúra pravidlo dodávateľa nevytvorí: pravidlá nemajú druh
    // dokladu a pravidlo zákazníka by prebilo prijaté faktúry toho istého partnera.
    await database.query("UPDATE documents SET document_type='FV' WHERE id=$1", [druhy.documentId]);
    const fv = await app.inject({
      method: 'POST', url: `/api/documents/${druhy.documentId}/pravidlo-protistrany`, headers,
      payload: { predkontaciaId: kody.ina, clenenieDphId: kody.clenenie },
    });
    expect(fv.statusCode, fv.body).toBe(422);

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

  // Hlavička sedí s návrhom, ale účtovník dal položke iný účet. Kým sa
  // porovnávala len hlavička, zapísala sa taká oprava ako súhlas.
  it('oprava len na položke sa zapíše ako zmena riadkov, rez podľa návrhu ako súhlas', async () => {
    const database = await createTestDatabase();
    databases.push(database);
    const seeded = await seedTestUser(database);
    const app = await buildApp({ database, storage: new MemoryObjectStorage(), config: testConfig(), logger: false });
    const headers = sessionHeaders(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: seeded.email, password: seeded.password } }));
    type Doklad = Awaited<ReturnType<typeof pripravDoklad>>;
    const polozka = (id: string, zaklad: number, dph: number, predkontaciaId: string) => ({
      id, popis: 'Oprava strechy', sadzbaDph: 23, mnozstvo: 1, jednotkovaCenaBezDph: zaklad,
      sumaBezDph: zaklad, sumaDph: dph, sumaSpolu: Math.round((zaklad + dph) * 100) / 100, ucto: { predkontaciaId },
    });
    // Hlavička dokladu ostáva na navrhnutej predkontácii; mení sa len to, čo je na položkách.
    let kody: Doklad | undefined;
    const schval = async (polozky: (doklad: Doklad) => unknown[], riadky: (doklad: Doklad) => unknown[] | null) => {
      const doklad = await pripravDoklad(database, seeded, kody);
      kody ??= doklad;
      await database.query(
        `UPDATE documents SET accounting = accounting || jsonb_build_object('predkontaciaId',$2::text),
                extracted = jsonb_set(extracted, '{polozky}', $3::jsonb) WHERE id=$1`,
        [doklad.documentId, doklad.navrhnuta, JSON.stringify(polozky(doklad))],
      );
      const navrhRiadkov = riadky(doklad);
      await database.query('UPDATE accounting_suggestions SET riadky=$2::jsonb WHERE document_id=$1',
        [doklad.documentId, navrhRiadkov ? JSON.stringify(navrhRiadkov) : null]);
      const approved = await app.inject({
        method: 'POST', url: `/api/documents/${doklad.documentId}/approve`, headers, payload: { expectedVersion: 1 },
      });
      expect(approved.statusCode, approved.body).toBe(200);
      return { doklad, oprava: (await database.query<Record<string, any>>(
        'SELECT zmenene, schvalene FROM ucto_opravy WHERE document_id=$1', [doklad.documentId])).rows[0] };
    };

    const inyUcet = await schval((doklad) => [polozka('d1-li-0', 100, 23, doklad.ina)], () => null);
    expect(inyUcet.oprava.zmenene).toEqual(['riadky']);
    expect(inyUcet.oprava.schvalene.riadky).toEqual([
      expect.objectContaining({ predkontaciaId: inyUcet.doklad.ina, podiel: 1 }),
    ]);

    // Rez 80/20 presne podľa návrhu: časti sa spoja na tlačenú položku a sedia.
    const rez = await schval(
      (doklad) => [polozka('d2-li-0-1', 80, 18.4, doklad.navrhnuta), polozka('d2-li-0-2', 20, 4.6, doklad.ina)],
      (doklad) => [
        { index: 0, popis: 'Oprava strechy', predkontaciaId: doklad.navrhnuta, podiel: 0.8 },
        { index: 0, popis: 'Oprava strechy', predkontaciaId: doklad.ina, podiel: 0.2 },
      ],
    );
    expect(rez.oprava.zmenene).toEqual([]);

    // Dve samostatné položky s rovnakým textom a ich návrhy bez zmeny: každá
    // skupina si dovtedy zobrala OBA návrhy a súhlas vyzeral ako oprava.
    const dvojica = await schval(
      (doklad) => [polozka('d3-li-0', 50, 11.5, doklad.navrhnuta), polozka('d3-li-1', 50, 11.5, doklad.navrhnuta)],
      (doklad) => [
        { index: 0, popis: 'Oprava strechy', predkontaciaId: doklad.navrhnuta },
        { index: 1, popis: 'Oprava strechy', predkontaciaId: doklad.navrhnuta },
      ],
    );
    expect(dvojica.oprava.zmenene).toEqual([]);
    expect(dvojica.oprava.schvalene.riadky).toHaveLength(2);

    // Zmena len podielu dane: návrh 80/20 so základom a DPH 50/50, schválené
    // DPH 80/20. Tie isté kódy aj podiely základu — doteraz to vyšlo ako súhlas.
    const dan = await schval(
      (doklad) => [polozka('d4-li-0-1', 80, 18.4, doklad.navrhnuta), polozka('d4-li-0-2', 20, 4.6, doklad.ina)],
      (doklad) => [
        { index: 0, popis: 'Oprava strechy', predkontaciaId: doklad.navrhnuta, podiel: 0.8, podielDph: 0.5 },
        { index: 0, popis: 'Oprava strechy', predkontaciaId: doklad.ina, podiel: 0.2, podielDph: 0.5 },
      ],
    );
    expect(dan.oprava.zmenene).toEqual(['riadky']);

    // Opakovaný rez časti („-li-0-1-2") patrí stále k tlačenej položke 0.
    const vnoreny = await schval(
      (doklad) => [
        polozka('d5-li-0-1-1', 40, 9.2, doklad.navrhnuta), polozka('d5-li-0-1-2', 40, 9.2, doklad.navrhnuta),
        polozka('d5-li-0-2', 20, 4.6, doklad.navrhnuta),
      ],
      () => null,
    );
    expect(vnoreny.oprava.schvalene.riadky.map((riadok: { podiel: number }) => riadok.podiel).sort())
      .toEqual([0.2, 0.4, 0.4]);

    await app.close();
  }, 180_000);
});
